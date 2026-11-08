// Ticket-platform logins, encrypted. Everything sensitive lives in users/{uid}/ticketVault (no client rule: the app can
// neither read nor write it), encrypted with AES-256-GCM (vault-crypto.ts) under a key of its own in
// vaultKeys/{uid}_tickets, so whichever server holds the account's lease can use it, and a WhatsApp logout (which wipes
// the WhatsApp vault key) leaves ticket logins alone.
// The browser never sends a password in the clear: it seals it to ticketPublic/key (X25519), and only this side holds
// the private half (also in ticketVault, encrypted).
import { newSealKeyPair, openSealed, type SealedBox, type TicketPublicKey } from "@spot/shared";
import { db, col } from "../firebase.ts";
import { decrypt, encrypt, newKey } from "../vault-crypto.ts";

export interface TicketSecret {
  /** BookMyShow: email or username. District: the phone number (+91…). */
  login: string;
  /** BookMyShow only; District has no password (OTP login). */
  password: string;
  token?: string | null;
  /** District's device key, tied to the organizer by the OTP login. */
  district?: { apiKey: string; secret: string; deviceId: string };
}

const keyRef = (uid: string) => db.collection("vaultKeys").doc(`${uid}_tickets`);
const vaultRef = (uid: string, id: string) => col(uid, "ticketVault").doc(id);
const SEAL_DOC = "_seal";

async function vaultKey(uid: string): Promise<Buffer> {
  return db.runTransaction(async (tx) => {
    const s = await tx.get(keyRef(uid));
    if (s.exists) return Buffer.from(s.data()!.key as string, "base64");
    const k = newKey();
    tx.set(keyRef(uid), { key: k.toString("base64"), createdAt: Date.now(), purpose: "tickets" });
    return k;
  });
}

const aadId = (uid: string, id: string) => `${uid}/tickets/${id}`;

async function seal(uid: string, id: string, plain: Buffer): Promise<string> {
  const key = await vaultKey(uid);
  return (await encrypt((async function* () { yield plain; })(), key, aadId(uid, id))).toString("base64");
}

async function unseal(uid: string, id: string, blob: string): Promise<Buffer> {
  return decrypt(Buffer.from(blob, "base64"), await vaultKey(uid), aadId(uid, id));
}

/** The account's seal key: creates it on first use and publishes the public half for the app. */
export async function ensureSealKey(uid: string): Promise<TicketPublicKey> {
  const pub = await col(uid, "ticketPublic").doc("key").get();
  const priv = await vaultRef(uid, SEAL_DOC).get();
  if (pub.exists && priv.exists) return pub.data() as TicketPublicKey;
  const kp = await newSealKeyPair();
  const doc: TicketPublicKey = { x25519: kp.publicRawB64, createdAt: Date.now() };
  await vaultRef(uid, SEAL_DOC).set({ blob: await seal(uid, SEAL_DOC, Buffer.from(kp.privatePkcs8)), updatedAt: Date.now() });
  await col(uid, "ticketPublic").doc("key").set(doc);
  return doc;
}

/** Open what the app sealed. Throws when the box was sealed to an older key or tampered with. */
export async function openFromApp(uid: string, box: SealedBox, opts: { needPassword?: boolean } = {}): Promise<{ login: string; password: string }> {
  const pub = (await col(uid, "ticketPublic").doc("key").get()).data() as TicketPublicKey | undefined;
  const priv = (await vaultRef(uid, SEAL_DOC).get()).data();
  if (!pub || !priv) throw new Error("The ticket key isn't set up yet. Reload the page and try again.");
  const pkcs8 = await unseal(uid, SEAL_DOC, priv.blob as string);
  const parsed = JSON.parse(await openSealed(box, new Uint8Array(pkcs8), pub.x25519)) as { login?: unknown; password?: unknown };
  const needPassword = opts.needPassword ?? true;
  if (typeof parsed.login !== "string" || !parsed.login.trim()) throw new Error("The login is needed.");
  if (needPassword && (typeof parsed.password !== "string" || !parsed.password)) throw new Error("Login and password are both needed.");
  return { login: parsed.login.trim(), password: typeof parsed.password === "string" ? parsed.password : "" };
}

export async function saveSecret(uid: string, accountId: string, s: TicketSecret): Promise<void> {
  await vaultRef(uid, accountId).set({ blob: await seal(uid, accountId, Buffer.from(JSON.stringify(s))), updatedAt: Date.now() });
}

export async function loadSecret(uid: string, accountId: string): Promise<TicketSecret | null> {
  const d = (await vaultRef(uid, accountId).get()).data();
  if (!d?.blob) return null;
  return JSON.parse((await unseal(uid, accountId, d.blob as string)).toString("utf8")) as TicketSecret;
}

export async function deleteSecret(uid: string, accountId: string): Promise<void> {
  await vaultRef(uid, accountId).delete();
}
