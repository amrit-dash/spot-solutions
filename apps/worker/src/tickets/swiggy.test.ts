import { describe, expect, it } from "vitest";
import type { Fetch } from "./district.ts";
import { collectSwiggy, istFromIso, istStamp, refreshSwiggy, swiggyTokenSecondsLeft, toBooking } from "./swiggy.ts";

const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

describe("time helpers", () => {
  it("turns UTC show times into IST", () => {
    expect(istFromIso("2026-11-08T14:30:00Z")).toEqual({ date: "2026-11-08", time: "20:00" });
  });
  it("reads the report's dd/mm/yyyy IST stamps", () => {
    expect(istStamp("08/11/2026 14:12:36")).toBe("2026-11-08T14:12:36+05:30");
  });
  it("reads token expiry", () => {
    expect(swiggyTokenSecondsLeft(jwt({ exp: 1000 }), 400_000)).toBe(600);
    expect(swiggyTokenSecondsLeft("garbage")).toBe(0);
  });
});

describe("toBooking", () => {
  it("keeps counts and drops the buyer's details", () => {
    const b = toBooking({ booking_id: 1, booking_date: "08/11/2026 14:12:36", diner_count: 2, reservation_status: "Confirmed", transaction_amount: "398", variants: [{ variant_name: "Early Bird Pass", quantity: 2 }], ...{ diner_name: "X", phone_no: "9", email_id: "e" } } as never);
    expect(b).toEqual({ id: "1", bookedAt: "2026-11-08T14:12:36+05:30", qty: 2, category: "Early Bird Pass", amount: 398, status: "Confirmed" });
    expect(JSON.stringify(b)).not.toMatch(/diner_name|phone|email/);
  });
});

describe("refreshSwiggy", () => {
  it("sends the dashboard's refresh call and takes the new pair", async () => {
    let seen: { url: string; headers: Record<string, string>; body?: string } | null = null;
    const f: Fetch = async (url, init) => {
      seen = { url, headers: init.headers, body: init.body };
      return { status: 200, json: async () => ({ access_token: jwt({ sub: "U1", exp: 9 }), refresh_token: "R2" }) };
    };
    const n = await refreshSwiggy(f, { accessToken: "A1", refreshToken: "R1", userId: "U1" });
    expect(n).toMatchObject({ refreshToken: "R2", userId: "U1" });
    expect(seen!.url).toMatch(/\/ozone\/v1\/token\/refresh$/);
    expect(seen!.headers["x-ozone-user"]).toBe("external");
    expect(seen!.headers.authorization).toBe("Bearer A1");
    expect(JSON.parse(seen!.body!)).toMatchObject({ user_id: "U1", refresh_token: "R1" });
  });
  it("asks for a reconnect when Swiggy refuses", async () => {
    const f: Fetch = async () => ({ status: 401, json: async () => ({}) });
    await expect(refreshSwiggy(f, { accessToken: "A", refreshToken: "R", userId: "U" })).rejects.toMatchObject({ kind: "needs_login" });
  });
});

describe("collectSwiggy", () => {
  const now = () => Date.parse("2026-11-08T10:00:00Z");
  const f: Fetch = async (url, init) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : null;
    let data: unknown = {};
    if (path.endsWith("/event/list"))
      data = {
        events: [
          { id: 1, title: "Pitcher of Jokes", state: "EVENT_ENTITY_STATE_LIVE", endTime: "2026-11-30T16:30:00Z", venues: [{ venueId: "V1", name: "Big Pitcher", locality: "Indiranagar" }] },
          { id: 2, title: "Draft", state: "EVENT_ENTITY_STATE_DRAFT", endTime: "2026-11-30T16:30:00Z", venues: [{ venueId: "V1" }] },
          { id: 3, title: "Old", state: "EVENT_ENTITY_STATE_LIVE", endTime: "2026-10-01T16:30:00Z", venues: [{ venueId: "V1" }] },
        ],
        nextPageOffset: "",
      };
    if (path.endsWith("/show/list")) {
      expect(body.on_event_venue).toEqual({ event_id: "1", venue_id: "V1" });
      data = {
        shows: [
          { id: 11, startTime: "2026-11-08T14:30:00Z", tickets: [{ inventory: 5 }, { inventory: 10 }] },
          { id: 12, startTime: "2026-11-15T14:30:00Z", tickets: [{ inventory: 20 }] },
          { id: 10, startTime: "2026-11-01T14:30:00Z", tickets: [{ inventory: 20 }] },
        ],
        nextPageOffset: "",
      };
    }
    if (path.endsWith("/report")) {
      expect(new URL(url).searchParams.get("eventId")).toBe("1");
      data = {
        data: {
          output_params: {
            data: {
              pagination: { record_count: 3 },
              result_set: [
                { booking_id: "B1", diner_count: 2, reservation_status: "Confirmed", show_id: 11 },
                { booking_id: "B2", diner_count: 3, reservation_status: "Cancelled", show_id: 11 },
                { booking_id: "B3", diner_count: 1, reservation_status: "Confirmed", show_id: 10 },
              ],
            },
          },
        },
      };
    }
    return { status: 200, json: async () => data };
  };

  it("lists upcoming shows of live events with sold from bookings and capacity from inventory", async () => {
    const rows = await collectSwiggy(f, "T", "acc", now);
    expect(rows.map((r) => [r.key, r.showDate, r.showTime, r.sold, r.capacity, r.remaining, r.venue])).toEqual([
      ["swiggy:1:11", "2026-11-08", "20:00", 2, 15, 13, "Big Pitcher, Indiranagar"],
      ["swiggy:1:12", "2026-11-15", "20:00", 0, 20, 20, "Big Pitcher, Indiranagar"],
    ]);
    expect(rows[0].bookings.map((b) => b.id)).toEqual(["B1", "B2"]);
  });
});
