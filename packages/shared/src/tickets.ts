// Ticket sales from organizer accounts on BookMyShow (later District, Swiggy Scenes), tied to the curator's shows.
// The worker pulls listings per connected account (apps/worker/src/tickets); the curator links each listing to a show by
// hand (no fuzzy matching). Totals per show night are computed here so the app and the worker agree.
import { isShowOn } from "./rules.ts";
import type { Show } from "./types.ts";

export type TicketPlatform = "bms";
export const TICKET_PLATFORM_NAMES: Record<TicketPlatform, string> = { bms: "BookMyShow" };

export type TicketAccountStatus = "connecting" | "connected" | "needs_otp" | "needs_login" | "error";

/** users/{uid}/ticketAccounts/{accountId}. Written by the worker; never holds a password or token. */
export interface TicketAccount {
  id: string;
  platform: TicketPlatform;
  /** Whose account it is ("Us", "Rahul's productions"). */
  label: string;
  /** Login shown masked ("ra•••@gm•••.com"). */
  loginHint: string;
  status: TicketAccountStatus;
  /** What the curator or producer should do next, in words. */
  statusText?: string | null;
  connectedAt: number;
  lastSyncedAt?: number | null;
  lastError?: string | null;
  tokenExpiresAt?: number | null;
}

export interface TicketBooking {
  id: string;
  /** ISO with the venue's offset. */
  bookedAt: string;
  qty: number;
  category?: string | null;
  amount?: number | null;
  status?: string | null;
}

/** users/{uid}/ticketListings/{listingKey}: one session (one date) of one platform listing. Written by the worker. */
export interface TicketListing {
  key: string;
  accountId: string;
  platform: TicketPlatform;
  listingId: string;
  sessionId: string;
  eventName: string;
  venue?: string | null;
  publicUrl?: string | null;
  /** Local date and time of the session at the venue (YYYY-MM-DD, HH:MM). */
  showDate: string;
  showTime: string;
  sold: number;
  capacity: number;
  remaining?: number | null;
  /** "live" while the platform lists it; "ended" once it drops off the live list. */
  state: "live" | "ended";
  bookings: TicketBooking[];
  /** The platform capped the bookings list, so some are missing (counts are still right). */
  bookingsTruncated: boolean;
  /** When this row was last read from the platform (ms). Every count shown carries it. */
  syncedAt: number;
}

/** users/{uid}/ticketLinks/{linkId}: which show a platform listing belongs to. Written by the curator. */
export interface TicketLink {
  platform: TicketPlatform;
  accountId: string;
  listingId: string;
  /** Every session of the listing counts toward this show's night on the same date. null = not linked. */
  showId: string | null;
  /** Per-session exceptions: another show, or null to leave that session out. */
  sessionOverrides?: Record<string, string | null>;
  updatedAt: number;
}

/** users/{uid}/ticketPublic/key: the public half of the key the browser seals credentials to. */
export interface TicketPublicKey {
  /** Raw X25519 public key, base64. */
  x25519: string;
  createdAt: number;
}

export const listingKey = (platform: TicketPlatform, listingId: string, sessionId: string) => `${platform}:${listingId}:${sessionId}`;
export const linkId = (platform: TicketPlatform, accountId: string, listingId: string) => `${platform}:${accountId}:${listingId}`;

/** Data older than this gets a stale badge. */
export const TICKET_STALE_MS = 30 * 60_000;

/** The show a listing session counts toward, or null. */
export function ticketShowFor(listing: Pick<TicketListing, "platform" | "accountId" | "listingId" | "sessionId">, links: ReadonlyMap<string, TicketLink>): string | null {
  const link = links.get(linkId(listing.platform, listing.accountId, listing.listingId));
  if (!link) return null;
  if (link.sessionOverrides && listing.sessionId in link.sessionOverrides) return link.sessionOverrides[listing.sessionId] ?? null;
  return link.showId ?? null;
}

export interface ShowTicketLine {
  key: string;
  accountId: string;
  platform: TicketPlatform;
  eventName: string;
  publicUrl?: string | null;
  showTime: string;
  sold: number;
  capacity: number;
  syncedAt: number;
}

export interface ShowTickets {
  date: string;
  lines: ShowTicketLine[];
  totalSold: number;
  totalCapacity: number;
  /** The oldest data behind the total (ms), so a stale platform shows through. null when nothing is linked. */
  oldestSyncedAt: number | null;
}

/** Ticket totals for one show night, across every linked account and platform. */
export function showTicketTotals(showId: string, date: string, listings: readonly TicketListing[], links: ReadonlyMap<string, TicketLink>): ShowTickets {
  const lines: ShowTicketLine[] = [];
  for (const l of listings) {
    if (l.showDate !== date || ticketShowFor(l, links) !== showId) continue;
    lines.push({ key: l.key, accountId: l.accountId, platform: l.platform, eventName: l.eventName, publicUrl: l.publicUrl, showTime: l.showTime, sold: l.sold, capacity: l.capacity, syncedAt: l.syncedAt });
  }
  lines.sort((a, b) => a.showTime.localeCompare(b.showTime) || a.key.localeCompare(b.key));
  return {
    date,
    lines,
    totalSold: lines.reduce((n, x) => n + x.sold, 0),
    totalCapacity: lines.reduce((n, x) => n + x.capacity, 0),
    oldestSyncedAt: lines.length ? Math.min(...lines.map((x) => x.syncedAt)) : null,
  };
}

/** A linked session whose date is not a night of its show (wrong weekday, paused, show inactive): shown, never counted silently. */
export function ticketMismatch(listing: Pick<TicketListing, "platform" | "accountId" | "listingId" | "sessionId" | "showDate">, links: ReadonlyMap<string, TicketLink>, shows: readonly Pick<Show, "id" | "active" | "weekday" | "activeDates" | "pausedDates">[]): "no_show" | "not_show_day" | null {
  const id = ticketShowFor(listing, links);
  if (!id) return null;
  const show = shows.find((s) => s.id === id);
  if (!show) return "no_show";
  return isShowOn(show, listing.showDate) ? null : "not_show_day";
}

/** "ra•••@gm•••.com", "98•••••210". Never the whole login. */
export function maskLogin(login: string): string {
  const s = login.trim();
  const at = s.indexOf("@");
  if (at > 0) {
    const [user, domain] = [s.slice(0, at), s.slice(at + 1)];
    const dot = domain.lastIndexOf(".");
    const host = dot > 0 ? domain.slice(0, dot) : domain;
    return `${user.slice(0, 2)}•••@${host.slice(0, 2)}•••${dot > 0 ? domain.slice(dot) : ""}`;
  }
  return s.length <= 5 ? "•••" : `${s.slice(0, 2)}${"•".repeat(Math.max(3, s.length - 5))}${s.slice(-3)}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Sealing credentials in the browser for the worker (X25519 + HKDF-SHA256 + AES-256-GCM, WebCrypto only).
// The app seals {login, password} to the account's ticket public key; only a server holding the private key can open
// it, so the password is never readable in Firestore or the command doc.

export interface SealedBox {
  v: 1;
  /** Ephemeral public key, base64. */
  epk: string;
  iv: string;
  ct: string;
}

const INFO = new TextEncoder().encode("spot-tickets-seal-v1");
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const subtle = () => globalThis.crypto.subtle;

async function sealKey(shared: ArrayBuffer, epk: Uint8Array, rpk: Uint8Array) {
  const ikm = await subtle().importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const salt = new Uint8Array(epk.length + rpk.length);
  salt.set(epk, 0);
  salt.set(rpk, epk.length);
  return subtle().deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: INFO }, ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function sealTo(recipientX25519B64: string, plaintext: string): Promise<SealedBox> {
  const rpk = unb64(recipientX25519B64);
  const recipient = await subtle().importKey("raw", rpk, { name: "X25519" }, false, []);
  const eph = (await subtle().generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  const epk = new Uint8Array(await subtle().exportKey("raw", eph.publicKey));
  const shared = await subtle().deriveBits({ name: "X25519", public: recipient }, eph.privateKey, 256);
  const key = await sealKey(shared, epk, rpk);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv, additionalData: epk }, key, new TextEncoder().encode(plaintext)));
  return { v: 1, epk: b64(epk), iv: b64(iv), ct: b64(ct) };
}

/** Worker side. `privatePkcs8` is the recipient's private key; `publicRawB64` its public key. Throws on any tampering. */
export async function openSealed(box: SealedBox, privatePkcs8: Uint8Array<ArrayBuffer>, publicRawB64: string): Promise<string> {
  if (box?.v !== 1) throw new Error("unsupported sealed box");
  const priv = await subtle().importKey("pkcs8", privatePkcs8, { name: "X25519" }, false, ["deriveBits"]);
  const epk = unb64(box.epk);
  const ephPub = await subtle().importKey("raw", epk, { name: "X25519" }, false, []);
  const shared = await subtle().deriveBits({ name: "X25519", public: ephPub }, priv, 256);
  const key = await sealKey(shared, epk, unb64(publicRawB64));
  const pt = await subtle().decrypt({ name: "AES-GCM", iv: unb64(box.iv), additionalData: epk }, key, unb64(box.ct));
  return new TextDecoder().decode(pt);
}

/** Worker side: a new key pair. Returns the raw public key (base64) and the private key (pkcs8 bytes). */
export async function newSealKeyPair(): Promise<{ publicRawB64: string; privatePkcs8: Uint8Array<ArrayBuffer> }> {
  const kp = (await subtle().generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  return {
    publicRawB64: b64(new Uint8Array(await subtle().exportKey("raw", kp.publicKey))),
    privatePkcs8: new Uint8Array(await subtle().exportKey("pkcs8", kp.privateKey)),
  };
}
