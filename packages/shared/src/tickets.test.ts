import { describe, expect, it } from "vitest";
import { linkId, listingKey, maskLogin, newSealKeyPair, openSealed, sealTo, showTicketTotals, ticketMismatch, type TicketLink, type TicketListing } from "./tickets.ts";

const row = (o: Partial<TicketListing> & Pick<TicketListing, "accountId" | "listingId" | "sessionId" | "showDate">): TicketListing => ({
  key: listingKey("bms", o.listingId, o.sessionId),
  platform: "bms",
  eventName: "Unfiltered Comedy",
  showTime: "20:30",
  sold: 0,
  capacity: 20,
  state: "live",
  bookings: [],
  bookingsTruncated: false,
  syncedAt: 1000,
  ...o,
});
const link = (accountId: string, listingId: string, showId: string | string[] | null, sessionOverrides?: Record<string, string | null>): [string, TicketLink] => [
  linkId("bms", accountId, listingId),
  Array.isArray(showId) ? { platform: "bms", accountId, listingId, showId: showId[0] ?? null, showIds: showId, sessionOverrides, updatedAt: 0 } : { platform: "bms", accountId, listingId, showId, sessionOverrides, updatedAt: 0 },
];
const mon = { id: "mon", active: true, weekday: 1 as const };
const tue = { id: "tue", active: true, weekday: 2 as const };
const late = { id: "late", active: true, weekday: 1 as const };

describe("showTicketTotals", () => {
  it("adds every linked account's session on that date and keeps the oldest sync time", () => {
    const listings = [
      row({ accountId: "us", listingId: "ET1", sessionId: "1", showDate: "2026-11-09", sold: 4, syncedAt: 5000 }),
      row({ accountId: "producer", listingId: "ET9", sessionId: "7", showDate: "2026-11-09", sold: 3, capacity: 30, syncedAt: 2000 }),
      row({ accountId: "us", listingId: "ET1", sessionId: "2", showDate: "2026-11-16", sold: 9 }),
    ];
    const links = new Map([link("us", "ET1", "mon"), link("producer", "ET9", "mon")]);
    const t = showTicketTotals("mon", "2026-11-09", listings, links, [mon, late]);
    expect(t.totalSold).toBe(7);
    expect(t.totalCapacity).toBe(50);
    expect(t.lines).toHaveLength(2);
    expect(t.oldestSyncedAt).toBe(2000);
  });

  it("follows session overrides: moved to another show, or left out", () => {
    const listings = [
      row({ accountId: "us", listingId: "ET1", sessionId: "1", showDate: "2026-11-09", sold: 4 }),
      row({ accountId: "us", listingId: "ET1", sessionId: "2", showDate: "2026-11-09", sold: 5 }),
      row({ accountId: "us", listingId: "ET1", sessionId: "3", showDate: "2026-11-09", sold: 6 }),
    ];
    const links = new Map([link("us", "ET1", "mon", { "2": "late", "3": null })]);
    expect(showTicketTotals("mon", "2026-11-09", listings, links, [mon, late]).totalSold).toBe(4);
    expect(showTicketTotals("late", "2026-11-09", listings, links, [mon, late]).totalSold).toBe(5);
  });

  it("is empty with no links", () => {
    const t = showTicketTotals("mon", "2026-11-09", [row({ accountId: "us", listingId: "ET1", sessionId: "1", showDate: "2026-11-09", sold: 4 })], new Map(), [mon]);
    expect(t).toEqual({ date: "2026-11-09", lines: [], totalSold: 0, totalCapacity: 0, oldestSyncedAt: null });
  });
});

describe("one listing, several shows", () => {
  it("sends each date to the linked show that runs that night", () => {
    const listings = [
      row({ accountId: "us", listingId: "ET1", sessionId: "1", showDate: "2026-11-09", sold: 4 }), // Monday
      row({ accountId: "us", listingId: "ET1", sessionId: "2", showDate: "2026-11-10", sold: 6 }), // Tuesday
      row({ accountId: "us", listingId: "ET1", sessionId: "3", showDate: "2026-11-16", sold: 2 }), // next Monday, added later
    ];
    const links = new Map([link("us", "ET1", ["mon", "tue"])]);
    expect(showTicketTotals("mon", "2026-11-09", listings, links, [mon, tue]).totalSold).toBe(4);
    expect(showTicketTotals("tue", "2026-11-10", listings, links, [mon, tue]).totalSold).toBe(6);
    expect(showTicketTotals("mon", "2026-11-16", listings, links, [mon, tue]).totalSold).toBe(2);
    expect(listings.map((l) => ticketMismatch(l, links, [mon, tue]))).toEqual([null, null, null]);
  });
  it("flags a date no linked show runs on", () => {
    const fri = row({ accountId: "us", listingId: "ET1", sessionId: "4", showDate: "2026-11-13" });
    expect(ticketMismatch(fri, new Map([link("us", "ET1", ["mon", "tue"])]), [mon, tue])).toBe("not_show_day");
  });
});

describe("ticketMismatch", () => {
  const mon = { id: "mon", active: true, weekday: 1 as const, pausedDates: ["2026-11-16"] };
  const links = new Map([link("us", "ET1", "mon")]);
  it("flags a session that isn't on the show's night", () => {
    expect(ticketMismatch(row({ accountId: "us", listingId: "ET1", sessionId: "1", showDate: "2026-11-09" }), links, [mon])).toBeNull(); // Monday
    expect(ticketMismatch(row({ accountId: "us", listingId: "ET1", sessionId: "2", showDate: "2026-11-10" }), links, [mon])).toBe("not_show_day");
    expect(ticketMismatch(row({ accountId: "us", listingId: "ET1", sessionId: "3", showDate: "2026-11-16" }), links, [mon])).toBe("not_show_day"); // paused
    expect(ticketMismatch(row({ accountId: "us", listingId: "ET1", sessionId: "1", showDate: "2026-11-09" }), links, [])).toBe("no_show");
    expect(ticketMismatch(row({ accountId: "x", listingId: "ET5", sessionId: "1", showDate: "2026-11-10" }), links, [mon])).toBeNull(); // unlinked
  });
});

describe("maskLogin", () => {
  it("never shows the whole login", () => {
    expect(maskLogin("rahul@gmail.com")).toBe("ra•••@gm•••.com");
    expect(maskLogin("9876543210")).toBe("98•••••210");
  });
});

describe("sealTo / openSealed", () => {
  it("round-trips and rejects tampering or the wrong key", async () => {
    const kp = await newSealKeyPair();
    const box = await sealTo(kp.publicRawB64, JSON.stringify({ login: "a@b.co", password: "s3cret" }));
    expect(box.ct).not.toContain("s3cret");
    expect(JSON.parse(await openSealed(box, kp.privatePkcs8, kp.publicRawB64))).toEqual({ login: "a@b.co", password: "s3cret" });
    const other = await newSealKeyPair();
    await expect(openSealed(box, other.privatePkcs8, other.publicRawB64)).rejects.toThrow();
    const flipped = { ...box, ct: box.ct.slice(0, -4) + (box.ct.endsWith("AAAA") ? "BBBB" : "AAAA") };
    await expect(openSealed(flipped, kp.privatePkcs8, kp.publicRawB64)).rejects.toThrow();
  });
});
