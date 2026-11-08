import { describe, expect, it } from "vitest";
import { TicketAuthError, collectBms, readAuthResponse, splitLocal, tokenSecondsLeft, type ApiCall } from "./bms.ts";

const jwt = (exp: number) => `x.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.y`;

describe("tokenSecondsLeft", () => {
  it("reads the JWT expiry, with or without Bearer", () => {
    expect(tokenSecondsLeft(jwt(1000), 400_000)).toBe(600);
    expect(tokenSecondsLeft(`Bearer ${jwt(1000)}`, 400_000)).toBe(600);
    expect(tokenSecondsLeft("garbage")).toBe(0);
  });
});

describe("readAuthResponse", () => {
  it("returns the token on success", () => {
    expect(readAuthResponse(200, { data: { accessToken: "tok", refreshToken: "r" }, status: 200 })).toBe("tok");
  });
  it("asks for an OTP when BMS returns an mfaToken", () => {
    try {
      readAuthResponse(200, { data: { mfaToken: "m1" } });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TicketAuthError);
      expect((e as TicketAuthError).kind).toBe("needs_otp");
      expect((e as TicketAuthError).mfaToken).toBe("m1");
    }
  });
  it("calls a refusal needs_login and keeps secrets out of the message", () => {
    try {
      readAuthResponse(400, { errors: { code: "ERR.AUTH.INVALID", message: "invalid credentials" } });
      expect.unreachable();
    } catch (e) {
      expect((e as TicketAuthError).kind).toBe("needs_login");
      expect((e as Error).message).toContain("ERR.AUTH.INVALID");
    }
  });
});

describe("splitLocal", () => {
  it("keeps the venue's local date and time", () => {
    expect(splitLocal("2026-11-09 20:30:00")).toEqual({ date: "2026-11-09", time: "20:30", iso: "2026-11-09T20:30:00+05:30" });
  });
});

describe("collectBms", () => {
  // Shapes from the HostMyShow capture (values made up).
  const responses: Record<string, unknown> = {
    "/diy-event-creation/event-list?listType=live&start=0&limit=100&searchKey=": { data: { list: [{ eventCode: "ET1", eventName: "Unfiltered", eventUrl: "https://in.bookmyshow.com/events/x/ET1", venueName: "Bloom", status: "active" }], total: 1 } },
    "/v1/reports/event-wise/event/ET1/live": { data: { sessionWiseSummary: { sessions: [{ sessionId: 11362, vnuCode: "IOYD", vnuName: "Bloom", sessionTime: "2026-11-09 20:30:00", ticketsSold: 3, totalInventory: 20, percentSold: 15 }] } } },
    "/v1/reports/session-wise/event/ET1/session/11362?vnuCode=IOYD": {
      data: {
        sessionWiseSummary: { remainingTickets: 17 },
        bookingSummary: { bookings: [{ bookingId: "B1", bookingTimeStamp: "2026-11-01 10:00:00", ticketQuantity: 2, ticketCatName: "GA", ticketAmount: 398, bookingStatus: "Booked" }] },
        totalRowsCount: 2,
      },
    },
  };
  const call: ApiCall = async (_m, path, token) => ({ status: token ? 200 : 401, data: responses[path] ?? null });

  it("returns one normalized row per session, with bookings and the truncation flag", async () => {
    const rows = await collectBms(call, "tok", "acc1", () => 42);
    expect(rows).toEqual([
      expect.objectContaining({
        key: "bms:ET1:11362", accountId: "acc1", listingId: "ET1", sessionId: "11362", showDate: "2026-11-09", showTime: "20:30",
        sold: 3, capacity: 20, remaining: 17, bookingsTruncated: true, syncedAt: 42, publicUrl: "https://in.bookmyshow.com/events/x/ET1",
        bookings: [{ id: "B1", bookedAt: "2026-11-01T10:00:00+05:30", qty: 2, category: "GA", amount: 398, status: "Booked" }],
      }),
    ]);
  });

  it("turns a 401 into needs_login", async () => {
    const r = collectBms(async () => ({ status: 401, data: null }), "tok", "acc1");
    await expect(r).rejects.toMatchObject({ kind: "needs_login" });
  });
});
