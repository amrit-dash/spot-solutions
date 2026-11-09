// Swiggy Scenes (listonscenes.swiggy.com) organizer data. Plain HTTPS from the worker to events-proxy.swiggy.com: no
// bot check on these calls, so no browser.
// Auth: sendVerificationCode texts an OTP; signInWithOTP returns an access token (JWT, ~5 days) and a refresh token.
// token/refresh issues a new pair and the old refresh token stops working, so the new pair is saved every time.
// Data: event/list → each event's shows (show/list, per venue) with per-ticket-type inventory (the total, it doesn't drop
// as tickets sell) → the bookings report per event, summed per show. Only counts, ticket type, amount and status are
// kept from bookings: names, phones and emails are dropped here.
import { randomBytes } from "node:crypto";
import { listingKey, type TicketBooking, type TicketListing } from "@spot/shared";
import { TicketAuthError } from "./bms.ts";
import type { Fetch } from "./district.ts";

export const SWIGGY_API = "https://events-proxy.swiggy.com/scenes";
const ORIGIN = "https://listonscenes.swiggy.com";
/** The dashboard's own client ids (public, in its page code). */
const OZONE_CLIENT = "scenes-3574aa93ef-a545e7c16d6f9-eea1";
const REQUEST_CLIENT = "Scenes-Dashboard-Client";
const MARKETPLACE = { business_line_id: "BUSINESS_LINE_SCENES", marketplace_id: "BUSINESS_LINE_DINEOUT" };

export interface SwiggyTokens {
  accessToken: string;
  refreshToken: string;
  /** JWT `sub`: the organizer user id token/refresh asks for. */
  userId: string;
}

/** What sendVerificationCode returns; signInWithOTP needs it back with the code. */
export interface SwiggyOtpSession {
  userId: string;
  sessionInfo: string;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

async function call(f: Fetch, token: string | null, method: "GET" | "POST", path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { accept: "application/json", origin: ORIGIN, referer: `${ORIGIN}/`, ...extra };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await f(SWIGGY_API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data: unknown = null;
  try {
    data = await r.json();
  } catch {
    /* not JSON */
  }
  if (r.status === 401 || r.status === 403) throw new TicketAuthError("needs_login", "Swiggy signed this account out. Connect it again (it sends a new OTP).");
  if (r.status !== 200) throw new Error(`Swiggy ${path.split("?")[0]} answered HTTP ${r.status}`);
  return obj(data);
}

const requestContext = () => ({ request_id: randomBytes(7).toString("hex").slice(0, 13), client_id: REQUEST_CLIENT, request_time: new Date().toISOString() });

/** Seconds until the JWT expires (0 when unreadable). */
export function swiggyTokenSecondsLeft(token: string, now = Date.now()): number {
  try {
    const p = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as { exp?: number };
    return Math.max(0, (p.exp ?? 0) - Math.floor(now / 1000));
  } catch {
    return 0;
  }
}

function jwtSub(token: string): string {
  try {
    return String((JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as { sub?: unknown }).sub ?? "");
  } catch {
    return "";
  }
}

export async function sendSwiggyOtp(f: Fetch, phone: string): Promise<SwiggyOtpSession> {
  const r = await call(f, null, "POST", "/ozone/v1/accounts/sendVerificationCode", { phoneNumber: phone });
  if (typeof r.user_id !== "string" || typeof r.session_info !== "string") throw new Error(String(r.message ?? "Swiggy didn't send the OTP. Check the number is the one used on Scenes."));
  return { userId: r.user_id, sessionInfo: r.session_info };
}

export async function loginSwiggyOtp(f: Fetch, s: SwiggyOtpSession, otp: string): Promise<SwiggyTokens> {
  let r: Record<string, unknown>;
  try {
    r = await call(f, null, "POST", "/ozone/v1/accounts/signInWithOTP", { otp, user_id: s.userId, session_info: s.sessionInfo });
  } catch (e) {
    if (e instanceof TicketAuthError) throw new TicketAuthError("needs_otp", "That OTP didn't work. Check it, or connect again for a new one.");
    throw e;
  }
  if (typeof r.access_token !== "string" || typeof r.refresh_token !== "string") throw new TicketAuthError("needs_otp", "That OTP didn't work. Check it, or connect again for a new one.");
  return { accessToken: r.access_token, refreshToken: r.refresh_token, userId: jwtSub(r.access_token) };
}

/** A new token pair. The old refresh token is spent, so the caller must save the result before anything else. */
export async function refreshSwiggy(f: Fetch, t: SwiggyTokens): Promise<SwiggyTokens> {
  const r = await call(f, t.accessToken, "POST", "/ozone/v1/token/refresh", { user_id: t.userId, refresh_token: t.refreshToken, client_id: OZONE_CLIENT }, { "x-ozone-user": "external" });
  if (typeof r.access_token !== "string" || typeof r.refresh_token !== "string") throw new TicketAuthError("needs_login", "Swiggy wouldn't renew this account's session. Connect it again.");
  return { accessToken: r.access_token, refreshToken: r.refresh_token, userId: jwtSub(r.access_token) || t.userId };
}

interface STicket { name?: string; inventory?: number; state?: string }
interface SShow { id: string | number; startTime: string; state?: string; tickets?: STicket[] }
interface SVenue { venueId?: string; name?: string; locality?: string }
interface SEvent { id: string | number; title: string; state?: string; startTime?: string; endTime?: string; venues?: SVenue[] }
export interface SBooking {
  booking_id?: string | number;
  booking_date?: string;
  diner_count?: number;
  reservation_status?: string;
  transaction_amount?: string | number;
  show_id?: string | number;
  variants?: { variant_name?: string; quantity?: number }[];
}

/** UTC ISO → venue-local (IST) date and time. */
export function istFromIso(iso: string): { date: string; time: string } {
  const d = new Date(Date.parse(iso) + 5.5 * 3600_000).toISOString();
  return { date: d.slice(0, 10), time: d.slice(11, 16) };
}

/** "08/11/2026 14:12:36" (IST) → "2026-11-08T14:12:36+05:30". */
export function istStamp(s: string | undefined): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}:\d{2}(?::\d{2})?)$/.exec(s ?? "");
  return m ? `${m[3]}-${m[2]}-${m[1]}T${m[4].length === 5 ? `${m[4]}:00` : m[4]}+05:30` : (s ?? "");
}

const cancelled = (b: SBooking) => /cancel|refund|fail/i.test(b.reservation_status ?? "");

/** One booking with the buyer's details left out. */
export function toBooking(b: SBooking): TicketBooking {
  const cats = (b.variants ?? []).map((v) => v.variant_name).filter(Boolean);
  const amount = Number(b.transaction_amount);
  return {
    id: String(b.booking_id ?? ""),
    bookedAt: istStamp(b.booking_date),
    qty: Number(b.diner_count) || 0,
    category: cats.length ? cats.join(", ") : null,
    amount: Number.isFinite(amount) ? amount : null,
    status: b.reservation_status ?? null,
  };
}

const BOOKINGS_KEPT = 200;

export function showToListing(accountId: string, ev: SEvent, venue: string | null, s: SShow, bookings: SBooking[], syncedAt: number): TicketListing {
  const when = istFromIso(s.startTime);
  const capacity = (s.tickets ?? []).reduce((n, t) => n + (Number(t.inventory) || 0), 0);
  const live = bookings.filter((b) => !cancelled(b));
  const sold = live.reduce((n, b) => n + (Number(b.diner_count) || 0), 0);
  return {
    key: listingKey("swiggy", String(ev.id), String(s.id)),
    accountId,
    platform: "swiggy",
    listingId: String(ev.id),
    sessionId: String(s.id),
    eventName: ev.title,
    venue,
    publicUrl: null,
    showDate: when.date,
    showTime: when.time,
    sold,
    capacity,
    remaining: capacity ? Math.max(0, capacity - sold) : null,
    state: "live",
    bookings: bookings.slice(0, BOOKINGS_KEPT).map(toBooking),
    bookingsTruncated: bookings.length > BOOKINGS_KEPT,
    syncedAt,
  };
}

async function eventBookings(f: Fetch, token: string, eventId: string): Promise<SBooking[]> {
  const out = new Map<string, SBooking>();
  const limit = 100;
  for (let page = 1; page <= 50; page++) {
    const q = new URLSearchParams({ limit: String(limit), page: String(page), startDate: "", endDate: "", vendorId: "", eventId });
    const d = obj(obj(obj((await call(f, token, "GET", `/dashboard/auth/v1/report?${q}`)).data).output_params).data);
    const rows = (d.result_set as SBooking[]) ?? [];
    // The same booking can show up twice across pages; count it once.
    for (const r of rows) out.set(String(r.booking_id ?? `${page}:${out.size}`), r);
    const total = Number(obj(d.pagination).record_count) || 0;
    if (rows.length < limit || out.size >= total) break;
  }
  return [...out.values()];
}

async function venueShows(f: Fetch, token: string, eventId: string, venueId: string): Promise<SShow[]> {
  const shows: SShow[] = [];
  let offset = "0";
  for (let page = 0; page < 20; page++) {
    const d = await call(f, token, "POST", "/dashboard/auth/v1/show/list", {
      request_context: requestContext(),
      marketplace_context: MARKETPLACE,
      include_archived: false,
      pagination_context: { offset, size: 50 },
      list_mask: "tickets,attributes",
      on_event_venue: { event_id: eventId, venue_id: venueId },
    });
    shows.push(...((d.shows as SShow[]) ?? []));
    offset = String(d.nextPageOffset ?? "");
    if (!offset || !(d.shows as unknown[])?.length) break;
  }
  return shows;
}

/** Shows from yesterday on, of every live event on the account. */
export async function collectSwiggy(f: Fetch, token: string, accountId: string, now = Date.now): Promise<TicketListing[]> {
  const since = now() - 86400_000;
  const events: SEvent[] = [];
  let offset = "0";
  for (let page = 0; page < 20; page++) {
    const d = await call(f, token, "POST", "/dashboard/auth/v1/event/list", {
      request_context: requestContext(),
      marketplace_context: MARKETPLACE,
      pagination_context: { offset, size: 50 },
      sort_criteria: [{ field: "FIELD_START_TIME", order: "SORT_ORDER_DESCENDING" }],
      list_mask: "venues,reviews,venues.name",
    });
    const page_ = (d.events as SEvent[]) ?? [];
    events.push(...page_);
    offset = String(d.nextPageOffset ?? "");
    if (!offset || !page_.length) break;
  }
  const out: TicketListing[] = [];
  // Drafts aren't on sale; an event whose run ended before yesterday has nothing to count.
  for (const ev of events.filter((e) => e.state === "EVENT_ENTITY_STATE_LIVE" && (!e.endTime || Date.parse(e.endTime) >= since))) {
    const id = String(ev.id);
    const shows: { s: SShow; venue: string | null }[] = [];
    for (const v of ev.venues ?? []) {
      if (!v.venueId) continue;
      const name = [v.name, v.locality].filter(Boolean).join(", ") || null;
      for (const s of await venueShows(f, token, id, v.venueId)) if (Date.parse(s.startTime) >= since) shows.push({ s, venue: name });
    }
    if (!shows.length) continue;
    const bookings = await eventBookings(f, token, id);
    const byShow = new Map<string, SBooking[]>();
    for (const b of bookings) {
      const k = String(b.show_id ?? "");
      byShow.set(k, [...(byShow.get(k) ?? []), b]);
    }
    for (const { s, venue } of shows) out.push(showToListing(accountId, ev, venue, s, byShow.get(String(s.id)) ?? [], now()));
  }
  return out;
}
