// Ticket accounts: connect (password, then OTP when BookMyShow asks), keep the 24h session alive, and pull listings on a
// cadence. Runs only on the server holding the account's lease (commands are gated by fleet.gate; the tick is called
// from scheduler.ts for held accounts only). One account failing never stops the others or the worker.
import { randomBytes } from "node:crypto";
import { maskLogin, TICKET_PLATFORM_NAMES, type SealedBox, type TicketAccount, type TicketAccountStatus, type TicketLink, type TicketListing, type TicketPlatform } from "@spot/shared";
import { col, db, expireAt, FieldValue } from "../firebase.ts";
import { TTL_DAYS } from "@spot/shared";
import { TicketAuthError, collectBms, loginOtp, loginPassword, tokenSecondsLeft, type ApiCall } from "./bms.ts";
import { withTicketBrowser } from "./browser.ts";
import { collectDistrict, loginDistrictOtp, newDistrictKey, nodeFetch, normalisePhone, sendDistrictOtp } from "./district.ts";
import { deleteSecret, ensureSealKey, loadSecret, openFromApp, saveSecret } from "./store.ts";
import { collectSwiggy, loginSwiggyOtp, refreshSwiggy, sendSwiggyOtp, swiggyTokenSecondsLeft } from "./swiggy.ts";

/** Log in again when the token has less than this left, so an OTP request lands at a calm moment, not mid-show. */
const RENEW_BEFORE_S = 3 * 3600;
const EVERY_MS = 15 * 60_000;
const NEAR_SHOW_EVERY_MS = 5 * 60_000;
const NEAR_SHOW_MS = 6 * 3600_000;
/** Swiggy tokens last ~5 days; renew with 2 left. Each renewal spends the refresh token, so it isn't done every tick. */
const SWIGGY_RENEW_BEFORE_S = 2 * 86400;

/** Only BookMyShow needs the ticket browser (Cloudflare); the others are plain HTTPS. */
const needsBrowser = (a: Pick<TicketAccount, "platform">) => a.platform === "bms";

/** mfaTokens waiting for an OTP, per account. In memory: an OTP is only good for minutes anyway. */
const pendingOtp = new Map<string, { mfaToken?: string; at: number }>();
const lastRun = new Map<string, number>();
const running = new Set<string>();

const accounts = (uid: string) => col(uid, "ticketAccounts");

async function setStatus(uid: string, id: string, status: TicketAccountStatus, statusText: string | null, extra: Partial<TicketAccount> = {}) {
  await accounts(uid).doc(id).set({ status, statusText, ...extra }, { merge: true });
}

async function warn(uid: string, text: string) {
  await col(uid, "notices").add({ level: "warn", text, createdAt: Date.now(), read: false, expireAt: expireAt(TTL_DAYS.notices), link: "/tickets", linkLabel: "Open Tickets" });
}

/** Put a token-rejection or OTP request on the account card (and once in Updates). */
async function onAuthError(uid: string, acc: Pick<TicketAccount, "id" | "label">, e: TicketAuthError, notify: boolean) {
  if (e.kind === "needs_otp") pendingOtp.set(`${uid}/${acc.id}`, { mfaToken: e.mfaToken, at: Date.now() });
  await setStatus(uid, acc.id, e.kind, e.message);
  if (notify) await warn(uid, `Tickets: ${acc.label} ${e.kind === "needs_otp" ? "needs an OTP to stay connected" : "needs to be connected again"}. Counts for its shows stop updating until then.`);
}

/** Write this account's listings; sessions that dropped off the live list become "ended" (kept for history). */
async function saveListings(uid: string, accountId: string, rows: TicketListing[]) {
  const ref = col(uid, "ticketListings");
  const seen = new Set(rows.map((r) => r.key));
  const prev = await ref.where("accountId", "==", accountId).where("state", "==", "live").get();
  const ops: [FirebaseFirestore.DocumentReference, Record<string, unknown>][] = rows.map((r) => [ref.doc(r.key), r as unknown as Record<string, unknown>]);
  for (const d of prev.docs) if (!seen.has(d.id)) ops.push([d.ref, { state: "ended" }]);
  for (let i = 0; i < ops.length; i += 400) {
    const b = db.batch();
    for (const [r, data] of ops.slice(i, i + 400)) b.set(r, data, { merge: true });
    await b.commit();
  }
}

/** A fresh token for the account, logging in again with the saved password when it is near expiry. */
async function freshToken(call: ApiCall, uid: string, accountId: string): Promise<string> {
  const s = await loadSecret(uid, accountId);
  if (!s) throw new TicketAuthError("needs_login", "This account's login isn't saved on the servers any more. Connect it again.");
  if (s.token && tokenSecondsLeft(s.token) > RENEW_BEFORE_S) return s.token;
  const token = await loginPassword(call, s.login, s.password);
  await saveSecret(uid, accountId, { ...s, token });
  return token;
}

/** Swiggy: the saved access token, renewed (and the new pair saved at once) when it is near expiry. */
async function freshSwiggyToken(uid: string, accountId: string): Promise<string> {
  const s = await loadSecret(uid, accountId);
  if (!s?.swiggy) throw new TicketAuthError("needs_login", "This account's Swiggy login isn't saved on the servers any more. Connect it again.");
  if (swiggyTokenSecondsLeft(s.swiggy.accessToken) > SWIGGY_RENEW_BEFORE_S) return s.swiggy.accessToken;
  const next = await refreshSwiggy(nodeFetch, s.swiggy);
  await saveSecret(uid, accountId, { ...s, swiggy: next });
  return next.accessToken;
}

/** Pull one account. `call` is the ticket browser (BookMyShow); District and Swiggy need none and ignore it. */
async function syncOne(call: ApiCall | null, uid: string, acc: TicketAccount, notifyOnAuth: boolean) {
  try {
    if (acc.platform === "swiggy") {
      const token = await freshSwiggyToken(uid, acc.id);
      const rows = await collectSwiggy(nodeFetch, token, acc.id);
      await saveListings(uid, acc.id, rows);
      await setStatus(uid, acc.id, "connected", null, { lastSyncedAt: Date.now(), lastError: null, tokenExpiresAt: Date.now() + swiggyTokenSecondsLeft(token) * 1000 });
      return rows.length;
    }
    if (acc.platform === "district") {
      const s = await loadSecret(uid, acc.id);
      if (!s?.district) throw new TicketAuthError("needs_login", "This account's District login isn't saved on the servers any more. Connect it again.");
      const rows = await collectDistrict(nodeFetch, s.district, acc.id);
      await saveListings(uid, acc.id, rows);
      await setStatus(uid, acc.id, "connected", null, { lastSyncedAt: Date.now(), lastError: null });
      return rows.length;
    }
    if (!call) throw new Error("BookMyShow needs the ticket browser");
    const token = await freshToken(call, uid, acc.id);
    const rows = await collectBms(call, token, acc.id);
    await saveListings(uid, acc.id, rows);
    await setStatus(uid, acc.id, "connected", null, { lastSyncedAt: Date.now(), lastError: null, tokenExpiresAt: Date.now() + tokenSecondsLeft(token) * 1000 });
    return rows.length;
  } catch (e) {
    if (e instanceof TicketAuthError) {
      // Tell the curator once per change, not on every tick.
      await onAuthError(uid, acc, e, notifyOnAuth && acc.status !== e.kind);
      return 0;
    }
    console.error(`[tickets] ${uid} ${acc.id} sync failed:`, (e as Error).message);
    await accounts(uid).doc(acc.id).set({ lastError: (e as Error).message }, { merge: true });
    return 0;
  }
}

/** Sync every connected account of the curator (or just one). Accounts waiting for an OTP or a reconnect are skipped. */
export async function syncTickets(uid: string, onlyId?: string, opts: { notify?: boolean } = {}): Promise<{ accounts: number; listings: number }> {
  const snap = await accounts(uid).get();
  const list = snap.docs.map((d) => ({ ...(d.data() as TicketAccount), id: d.id })).filter((a) => (onlyId ? a.id === onlyId : a.status === "connected" || a.status === "error"));
  if (!list.length) return { accounts: 0, listings: 0 };
  lastRun.set(uid, Date.now());
  let listings = 0;
  // District and Swiggy are plain HTTPS; only BookMyShow accounts open the ticket browser.
  for (const acc of list.filter((a) => !needsBrowser(a))) listings += await syncOne(null, uid, acc, opts.notify ?? true);
  const bms = list.filter(needsBrowser);
  if (bms.length) {
    await withTicketBrowser(async (call) => {
      for (const acc of bms) listings += await syncOne(call, uid, acc, opts.notify ?? true);
    });
  }
  return { accounts: list.length, listings };
}

/** Called every scheduler tick for accounts held here: every 15 min, every 5 within 6h of a linked show. */
export async function maybeSyncTickets(uid: string, now = Date.now()) {
  if (running.has(uid)) return;
  const accs = await accounts(uid).where("status", "in", ["connected", "error"]).limit(1).get();
  if (accs.empty) return;
  const since = now - (lastRun.get(uid) ?? 0);
  if (since < NEAR_SHOW_EVERY_MS) return;
  if (since < EVERY_MS && !(await showSoon(uid, now))) return;
  running.add(uid);
  try {
    await syncTickets(uid);
  } finally {
    running.delete(uid);
  }
}

/** Is a linked, live session within the next 6 hours? (Session times are venue-local IST.) */
async function showSoon(uid: string, now: number) {
  const links = await col(uid, "ticketLinks").where("showId", "!=", null).limit(50).get();
  if (links.empty) return false;
  const linked = new Set(links.docs.map((d) => (d.data() as TicketLink).listingId));
  const live = await col(uid, "ticketListings").where("state", "==", "live").get();
  return live.docs.some((d) => {
    const l = d.data() as TicketListing;
    const at = Date.parse(`${l.showDate}T${l.showTime}:00+05:30`);
    return linked.has(l.listingId) && at > now && at - now < NEAR_SHOW_MS;
  });
}

// ---- commands from the app ----

export async function ticketKey(uid: string) {
  return ensureSealKey(uid);
}

/** Connect a new account (or reconnect one): log in, save the encrypted login, pull its listings. */
export async function ticketConnect(uid: string, payload: Record<string, unknown>, commandId?: string) {
  // The sealed login is useless without the private key, but it still doesn't stay on the command doc.
  if (commandId) await col(uid, "commands").doc(commandId).update({ payload: FieldValue.delete() }).catch(() => undefined);
  const box = payload.sealed as SealedBox;
  const platform: TicketPlatform = payload.platform === "district" || payload.platform === "swiggy" ? payload.platform : "bms";
  const label = String(payload.label ?? "").trim().slice(0, 60) || `${TICKET_PLATFORM_NAMES[platform]} account`;
  const id = typeof payload.accountId === "string" && payload.accountId ? payload.accountId : randomBytes(6).toString("hex");
  const { login, password } = await openFromApp(uid, box, { needPassword: platform === "bms" });
  const existing = (await accounts(uid).doc(id).get()).data() as TicketAccount | undefined;
  if (platform === "district") return connectDistrict(uid, id, label, login, existing);
  if (platform === "swiggy") return connectSwiggy(uid, id, label, login, existing);
  const acc: TicketAccount = { id, platform: "bms", label, loginHint: maskLogin(login), status: "connecting", statusText: "Signing in to BookMyShow…", connectedAt: existing?.connectedAt ?? Date.now() };
  await accounts(uid).doc(id).set(acc, { merge: true });
  await saveSecret(uid, id, { login, password, token: null });
  return withTicketBrowser(async (call) => {
    try {
      const token = await loginPassword(call, login, password);
      await saveSecret(uid, id, { login, password, token });
      const n = await syncOne(call, uid, { ...acc, status: "connected" }, false);
      return { accountId: id, status: "connected", listings: n };
    } catch (e) {
      if (!(e instanceof TicketAuthError)) {
        await setStatus(uid, id, "error", (e as Error).message);
        throw e;
      }
      await onAuthError(uid, acc, e, false);
      // A wrong password isn't kept.
      if (e.kind === "needs_login") await deleteSecret(uid, id);
      return { accountId: id, status: e.kind, message: e.message };
    }
  });
}

/** District: a fresh device key, then District texts an OTP to the phone. The card asks for it (ticket_otp). */
async function connectDistrict(uid: string, id: string, label: string, rawPhone: string, existing?: TicketAccount) {
  const phone = normalisePhone(rawPhone);
  const acc: TicketAccount = { id, platform: "district", label, loginHint: maskLogin(phone), status: "connecting", statusText: "Asking District for an OTP…", connectedAt: existing?.connectedAt ?? Date.now() };
  await accounts(uid).doc(id).set(acc, { merge: true });
  try {
    const key = await newDistrictKey(nodeFetch);
    await sendDistrictOtp(nodeFetch, key, phone);
    await saveSecret(uid, id, { login: phone, password: "", district: key });
    await setStatus(uid, id, "needs_otp", `District sent an OTP by SMS to ${maskLogin(phone)}. Enter it to finish connecting.`);
    return { accountId: id, status: "needs_otp", message: "District sent an OTP." };
  } catch (e) {
    await setStatus(uid, id, "error", (e as Error).message);
    throw e;
  }
}

/** Swiggy: Swiggy texts an OTP; the session it returns waits in the vault until the card sends the code. */
async function connectSwiggy(uid: string, id: string, label: string, rawPhone: string, existing?: TicketAccount) {
  const phone = normalisePhone(rawPhone);
  const acc: TicketAccount = { id, platform: "swiggy", label, loginHint: maskLogin(phone), status: "connecting", statusText: "Asking Swiggy for an OTP…", connectedAt: existing?.connectedAt ?? Date.now() };
  await accounts(uid).doc(id).set(acc, { merge: true });
  try {
    const otpSession = await sendSwiggyOtp(nodeFetch, phone);
    await saveSecret(uid, id, { login: phone, password: "", swiggyOtp: otpSession });
    await setStatus(uid, id, "needs_otp", `Swiggy sent an OTP by SMS to ${maskLogin(phone)}. Enter it to finish connecting.`);
    return { accountId: id, status: "needs_otp", message: "Swiggy sent an OTP." };
  } catch (e) {
    await setStatus(uid, id, "error", (e as Error).message);
    throw e;
  }
}

export async function ticketOtp(uid: string, payload: Record<string, unknown>, commandId?: string) {
  if (commandId) await col(uid, "commands").doc(commandId).update({ payload: FieldValue.delete() }).catch(() => undefined);
  const id = String(payload.accountId ?? "");
  const otp = String(payload.otp ?? "").replace(/\s+/g, "");
  if (!/^\d{4,8}$/.test(otp)) throw new Error("The OTP is the 4 to 8 digit code sent by SMS.");
  const s = await loadSecret(uid, id);
  const acc = (await accounts(uid).doc(id).get()).data() as TicketAccount | undefined;
  if (!s || !acc) throw new Error("This account isn't connecting any more. Start again with Connect.");
  if (acc.platform === "swiggy") {
    if (!s.swiggyOtp) throw new Error("This account isn't connecting any more. Start again with Connect.");
    try {
      const tokens = await loginSwiggyOtp(nodeFetch, s.swiggyOtp, otp);
      await saveSecret(uid, id, { login: s.login, password: "", swiggy: tokens });
      const n = await syncOne(null, uid, { ...acc, status: "connected" }, false);
      return { accountId: id, status: "connected", listings: n };
    } catch (e) {
      if (!(e instanceof TicketAuthError)) throw e;
      await setStatus(uid, id, "needs_otp", e.message);
      return { accountId: id, status: e.kind, message: e.message };
    }
  }
  if (acc.platform === "district") {
    if (!s.district) throw new Error("This account isn't connecting any more. Start again with Connect.");
    try {
      await loginDistrictOtp(nodeFetch, s.district, s.login, otp);
      const n = await syncOne(null, uid, { ...acc, status: "connected" }, false);
      return { accountId: id, status: "connected", listings: n };
    } catch (e) {
      if (!(e instanceof TicketAuthError)) throw e;
      await setStatus(uid, id, "needs_otp", e.message);
      return { accountId: id, status: e.kind, message: e.message };
    }
  }
  const pending = pendingOtp.get(`${uid}/${id}`);
  return withTicketBrowser(async (call) => {
    try {
      const token = await loginOtp(call, otp, pending?.mfaToken, s.login);
      pendingOtp.delete(`${uid}/${id}`);
      await saveSecret(uid, id, { ...s, token });
      const n = await syncOne(call, uid, { ...acc, status: "connected" }, false);
      return { accountId: id, status: "connected", listings: n };
    } catch (e) {
      if (!(e instanceof TicketAuthError)) throw e;
      await setStatus(uid, id, e.kind === "needs_otp" ? "needs_otp" : "needs_login", e.kind === "needs_otp" ? "That OTP didn't work. Check it, or ask for a new one by connecting again." : e.message);
      return { accountId: id, status: e.kind, message: e.message };
    }
  });
}

/** Remove the account, its saved login, its listings and its links. */
export async function ticketDisconnect(uid: string, payload: Record<string, unknown>) {
  const id = String(payload.accountId ?? "");
  if (!id) throw new Error("No account given.");
  await deleteSecret(uid, id);
  pendingOtp.delete(`${uid}/${id}`);
  const [listings, links] = await Promise.all([col(uid, "ticketListings").where("accountId", "==", id).get(), col(uid, "ticketLinks").where("accountId", "==", id).get()]);
  const refs = [...listings.docs, ...links.docs].map((d) => d.ref);
  for (let i = 0; i < refs.length; i += 400) {
    const b = db.batch();
    for (const r of refs.slice(i, i + 400)) b.delete(r);
    await b.commit();
  }
  await accounts(uid).doc(id).delete();
  return { removed: refs.length };
}

export async function ticketSyncNow(uid: string, payload: Record<string, unknown>) {
  return syncTickets(uid, typeof payload.accountId === "string" ? payload.accountId : undefined, { notify: false });
}
