// BookMyShow organizer data (HostMyShow DIY, diy.hostmyshow.com), ported from tools/ticket-sync/collectors/bms.py.
// API: in.bookmyshow.com/api/le-diy, Bearer access token (24h JWT, no refresh grant) + two fixed app headers.
// Cloudflare refuses non-browser clients and headless Chrome, so every call goes through `ApiCall`, which browser.ts
// runs as a fetch inside a real page on the dashboard's own origin.
// Login grants seen in the dashboard's code: "password", then "mfa_otp" with an mfaToken when BMS asks for an OTP.
import { listingKey, type TicketBooking, type TicketListing } from "@spot/shared";

export const BMS_ORIGIN = "https://diy.hostmyshow.com";
export const BMS_API = "https://in.bookmyshow.com/api/le-diy";
export const BMS_HEADERS: Record<string, string> = { "x-app-code": "WEB", "x-bms-le-app-code": "DIY", accept: "application/json, text/plain, */*" };

export type ApiCall = (method: "GET" | "POST", path: string, token: string | null, body?: unknown) => Promise<{ status: number; data: unknown }>;

export class TicketAuthError extends Error {
  constructor(readonly kind: "needs_otp" | "needs_login", message: string, readonly mfaToken?: string) {
    super(message);
  }
}

/** Seconds the JWT has left (0 when unreadable). */
export function tokenSecondsLeft(token: string | null | undefined, now = Date.now()): number {
  try {
    const part = String(token).replace(/^bearer\s+/i, "").split(".")[1];
    const json = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return Math.max(0, json.exp - now / 1000);
  } catch {
    return 0;
  }
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** Depth-first search for a key anywhere in a JSON response (BMS nests auth fields differently per flow). */
export function findKey(v: unknown, key: string, depth = 0): string | null {
  if (depth > 5 || !v || typeof v !== "object") return null;
  for (const [k, x] of Object.entries(v)) {
    if (k === key && typeof x === "string" && x) return x;
    const deeper = findKey(x, key, depth + 1);
    if (deeper) return deeper;
  }
  return null;
}

/**
 * Read a token response. A token means logged in. An mfaToken (or an OTP-ish error) means BMS wants an OTP. Anything
 * else means the login was refused. Never puts a credential or token in the error text.
 */
export function readAuthResponse(status: number, data: unknown): string {
  const token = findKey(obj(data).data, "accessToken");
  if (status === 200 && token) return token;
  const mfaToken = findKey(data, "mfaToken");
  const err = obj(obj(data).errors);
  const code = typeof err.code === "string" ? err.code : "";
  const msg = typeof err.message === "string" ? err.message : "";
  if (mfaToken || /otp|mfa|2fa|challenge/i.test(code + " " + msg)) {
    throw new TicketAuthError("needs_otp", "BookMyShow sent an OTP to the account's phone or email. Enter it to finish connecting.", mfaToken ?? undefined);
  }
  throw new TicketAuthError("needs_login", `BookMyShow refused the login${code ? ` (${code}${msg ? `: ${msg}` : ""})` : ` (HTTP ${status})`}. Check the login and password.`);
}

export async function loginPassword(call: ApiCall, username: string, password: string): Promise<string> {
  const r = await call("POST", "/v1/auth/token", null, { username, password, grantType: "password" });
  return readAuthResponse(r.status, r.data);
}

export async function loginOtp(call: ApiCall, otp: string, mfaToken: string | undefined, username: string): Promise<string> {
  const field = /[a-zA-Z.]/.test(username) ? "username" : "mobileNumber";
  const body = mfaToken ? { otp, grantType: "mfa_otp", mfaToken, isLoginWithOtp: true } : { otp, grantType: "login_otp", [field]: username, isLoginWithOtp: true };
  const r = await call("POST", "/v1/auth/token", null, body);
  return readAuthResponse(r.status, r.data);
}

/** "2026-11-09 20:30:00" (venue local time, IST) → parts. */
export function splitLocal(s: string): { date: string; time: string; iso: string } {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?/.exec(s);
  if (!m) throw new Error(`unexpected BookMyShow time "${s}"`);
  return { date: m[1], time: m[2], iso: `${m[1]}T${m[2]}:${m[3] ?? "00"}+05:30` };
}

interface BmsEvent { eventCode: string; eventName: string; eventUrl?: string; venueName?: string; status?: string }
interface BmsSession { sessionId: number | string; vnuCode?: string; vnuName?: string; sessionTime: string; ticketsSold: number; totalInventory: number }

export function toBookings(raw: unknown): TicketBooking[] {
  const list = Array.isArray(obj(obj(raw).bookingSummary).bookings) ? (obj(obj(raw).bookingSummary).bookings as Record<string, unknown>[]) : [];
  return list.map((b) => ({
    id: String(b.bookingId),
    bookedAt: splitLocal(String(b.bookingTimeStamp)).iso,
    qty: Number(b.ticketQuantity) || 0,
    category: (b.ticketCatName as string) ?? null,
    amount: typeof b.ticketAmount === "number" ? b.ticketAmount : null,
    status: (b.bookingStatus as string) ?? null,
  }));
}

export function toListing(accountId: string, ev: BmsEvent, sess: BmsSession, detail: unknown, syncedAt: number): TicketListing {
  const d = obj(detail);
  const when = splitLocal(sess.sessionTime);
  const raw = obj(d.bookingSummary).bookings;
  const total = d.totalRowsCount;
  return {
    key: listingKey("bms", ev.eventCode, String(sess.sessionId)),
    accountId,
    platform: "bms",
    listingId: ev.eventCode,
    sessionId: String(sess.sessionId),
    eventName: ev.eventName,
    venue: sess.vnuName ?? ev.venueName ?? null,
    publicUrl: ev.eventUrl ?? (d.eventUrl as string) ?? null,
    showDate: when.date,
    showTime: when.time,
    sold: Number(sess.ticketsSold) || 0,
    capacity: Number(sess.totalInventory) || 0,
    remaining: typeof obj(d.sessionWiseSummary).remainingTickets === "number" ? (obj(d.sessionWiseSummary).remainingTickets as number) : null,
    state: "live",
    bookings: toBookings(d),
    bookingsTruncated: typeof total === "number" && Array.isArray(raw) && total > raw.length,
    syncedAt,
  };
}

async function get(call: ApiCall, path: string, token: string): Promise<Record<string, unknown>> {
  const r = await call("GET", path, token);
  if (r.status === 401) throw new TicketAuthError("needs_login", "BookMyShow signed this account out. Connect it again.");
  if (r.status !== 200 || !r.data) throw new Error(`BookMyShow ${path.split("?")[0]} answered HTTP ${r.status}${r.data ? "" : " without data (blocked?)"}`);
  return obj(obj(r.data).data);
}

/** Every session of every live listing on the account, with its bookings. */
export async function collectBms(call: ApiCall, token: string, accountId: string, now = Date.now): Promise<TicketListing[]> {
  const out: TicketListing[] = [];
  const events: BmsEvent[] = [];
  for (let start = 0; ; start += 100) {
    const page = await get(call, `/diy-event-creation/event-list?listType=live&start=${start}&limit=100&searchKey=`, token);
    const list = (page.list as BmsEvent[]) ?? [];
    events.push(...list);
    if (list.length < 100 || events.length >= Number(page.total ?? 0)) break;
  }
  for (const ev of events) {
    const rep = await get(call, `/v1/reports/event-wise/event/${encodeURIComponent(ev.eventCode)}/live`, token);
    const sessions = (obj(rep.sessionWiseSummary).sessions as BmsSession[]) ?? [];
    for (const s of sessions) {
      const q = s.vnuCode ? `?vnuCode=${encodeURIComponent(s.vnuCode)}` : "";
      const detail = await get(call, `/v1/reports/session-wise/event/${encodeURIComponent(ev.eventCode)}/session/${encodeURIComponent(String(s.sessionId))}${q}`, token);
      out.push(toListing(accountId, ev, s, detail, now()));
    }
  }
  return out;
}
