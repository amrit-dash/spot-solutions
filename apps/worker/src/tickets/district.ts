// District (publish.district.in) organizer data. Plain HTTPS from the worker: no browser needed (tested from a plain
// client; no bot check on api.edition.in for these calls).
// Auth is the dashboard's own scheme: POST /track with a device id issues an api_key + secret; every request carries
// `authorization: Hmac username="<api_key>",algorithm="hmac-sha1",headers="x-date",signature=base64(hmacSha1(secret,
// "x-date: <date>"))`. sendOTP + loginViaOTP (signed with that key) tie it to the organizer. Login is OTP-only.
import { createHmac, randomUUID } from "node:crypto";
import { listingKey, type TicketListing } from "@spot/shared";
import { TicketAuthError } from "./bms.ts";

export const DISTRICT_API = "https://api.edition.in";
const ORIGIN = "https://publish.district.in";

export interface DistrictKey {
  apiKey: string;
  secret: string;
  deviceId: string;
}

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; json(): Promise<unknown> }>;

export function signHeaders(key: Pick<DistrictKey, "apiKey" | "secret">, now = new Date()): Record<string, string> {
  const date = now.toUTCString();
  const signature = createHmac("sha1", key.secret).update(`x-date: ${date}`).digest("base64");
  return { "x-date": date, authorization: `Hmac username="${key.apiKey}",algorithm="hmac-sha1",headers="x-date",signature="${signature}"` };
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

async function call(f: Fetch, key: DistrictKey | null, method: "GET" | "POST", path: string, body?: unknown): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { accept: "application/json", origin: ORIGIN, referer: `${ORIGIN}/`, ...(key ? signHeaders(key) : {}) };
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await f(DISTRICT_API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data: unknown = null;
  try {
    data = await r.json();
  } catch {
    /* not JSON */
  }
  if (r.status === 401 || r.status === 403) throw new TicketAuthError("needs_login", "District signed this account out. Connect it again (it sends a new OTP).");
  if (r.status !== 200) throw new Error(`District ${path.split("?")[0]} answered HTTP ${r.status}`);
  return obj(data);
}

/** A fresh device key, the way the dashboard gets one before login. */
export async function newDistrictKey(f: Fetch): Promise<DistrictKey> {
  const deviceId = randomUUID();
  const d = obj((await call(f, null, "POST", "/mgw/events/v1/track", { device_id: deviceId })).data);
  if (typeof d.api_key !== "string" || typeof d.secret !== "string") throw new Error("District didn't issue a device key.");
  return { apiKey: d.api_key, secret: d.secret, deviceId };
}

/** "+91 98765 43210", "9876543210" → "+919876543210". */
export function normalisePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  throw new Error("Enter the phone number used on District, e.g. 98765 43210.");
}

export async function sendDistrictOtp(f: Fetch, key: DistrictKey, phone: string) {
  const r = await call(f, key, "POST", "/mgw/events/v1/user/sendOTP", { key: "phone_number", value: phone, delivery_channel: "sms" });
  if (r.result !== "ok") throw new Error(String(r.message ?? "District didn't send the OTP."));
}

export async function loginDistrictOtp(f: Fetch, key: DistrictKey, phone: string, otp: string) {
  const r = await call(f, key, "POST", "/mgw/events/v1/user/loginViaOTP", { otp, key: "phone_number", value: phone, source: "publisher" });
  if (r.result !== "ok") throw new TicketAuthError("needs_otp", "That OTP didn't work. Check it, or connect again for a new one.");
}

interface DItem { finite_amount_sold?: number; finite_amount_available?: number; is_hidden?: boolean }
interface DShow { _id: string; start_utc_timestamp: number; is_hidden?: boolean; items_for_sale?: { items?: DItem[] }[] }
interface DEvent { _id: string; name: string; slug?: string; max_show_end_utc_timestamp?: number }

/** UTC seconds → venue-local (IST) date and time. */
export function istParts(utcSeconds: number): { date: string; time: string } {
  const d = new Date((utcSeconds + 5.5 * 3600) * 1000).toISOString();
  return { date: d.slice(0, 10), time: d.slice(11, 16) };
}

export function showToListing(accountId: string, ev: DEvent, venue: string | null, s: DShow, syncedAt: number): TicketListing {
  const items = (s.items_for_sale ?? []).flatMap((g) => g.items ?? []);
  const when = istParts(s.start_utc_timestamp);
  const sold = items.reduce((n, it) => n + (Number(it.finite_amount_sold) || 0), 0);
  // finite_amount_available is each ticket type's inventory (it stays put as tickets sell).
  const capacity = items.reduce((n, it) => n + (Number(it.finite_amount_available) || 0), 0);
  return {
    key: listingKey("district", ev._id, s._id),
    accountId,
    platform: "district",
    listingId: ev._id,
    sessionId: s._id,
    eventName: ev.name,
    venue,
    publicUrl: ev.slug ? `https://www.district.in/events/${ev.slug}` : null,
    showDate: when.date,
    showTime: when.time,
    sold,
    capacity,
    remaining: capacity ? Math.max(0, capacity - sold) : null,
    state: "live",
    bookings: [],
    bookingsTruncated: false,
    syncedAt,
  };
}

/** Upcoming shows (from yesterday on) of every event on the account. */
export async function collectDistrict(f: Fetch, key: DistrictKey, accountId: string, now = Date.now): Promise<TicketListing[]> {
  const since = Math.floor(now() / 1000) - 86400;
  const events: DEvent[] = [];
  let offset: unknown = undefined;
  for (let page = 0; page < 20; page++) {
    const d = obj((await call(f, key, "POST", "/mgw/events/v1/event-search/search", offset === undefined ? {} : { offset })).data);
    events.push(...((d.events as DEvent[]) ?? []));
    offset = d.next_offset;
    if (offset === undefined || offset === null || offset === "" || !(d.events as unknown[])?.length) break;
    // Results come newest first; stop once a page is entirely in the past.
    if (((d.events as DEvent[]) ?? []).every((e) => (e.max_show_end_utc_timestamp ?? 0) < since)) break;
  }
  const out: TicketListing[] = [];
  for (const ev of events.filter((e) => (e.max_show_end_utc_timestamp ?? 0) >= since)) {
    const q = new URLSearchParams({ id: ev._id, isSummaryView: "true", excludeItems: "true", date: String(now()), page: "0", includeCancelledShow: "false" });
    const d = obj((await call(f, key, "GET", `/mgw/events/v1/event?${q}`)).data);
    for (const v of (d.venues as { name?: string; shows?: DShow[] }[]) ?? []) {
      for (const s of v.shows ?? []) {
        if (s.start_utc_timestamp < since) continue;
        const row = showToListing(accountId, ev, v.name ?? null, s, now());
        // A show hidden from the public page can still hold real sales (one did in the capture); keep it when it has any.
        if (s.is_hidden && row.sold === 0) continue;
        out.push(row);
      }
    }
  }
  return out;
}

export const nodeFetch: Fetch = (url, init) => fetch(url, init);
