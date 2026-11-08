import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { collectDistrict, istParts, normalisePhone, signHeaders, type Fetch } from "./district.ts";

describe("signHeaders", () => {
  it("signs x-date with HMAC-SHA1 like the dashboard", () => {
    const at = new Date("2026-11-08T22:17:03Z");
    const h = signHeaders({ apiKey: "K", secret: "S" }, at);
    expect(h["x-date"]).toBe("Sun, 08 Nov 2026 22:17:03 GMT");
    const sig = createHmac("sha1", "S").update("x-date: Sun, 08 Nov 2026 22:17:03 GMT").digest("base64");
    expect(h.authorization).toBe(`Hmac username="K",algorithm="hmac-sha1",headers="x-date",signature="${sig}"`);
  });
});

describe("normalisePhone / istParts", () => {
  it("normalises Indian numbers", () => {
    expect(normalisePhone("98765 43210")).toBe("+919876543210");
    expect(normalisePhone("+91 98765-43210")).toBe("+919876543210");
    expect(() => normalisePhone("123")).toThrow();
  });
  it("turns UTC seconds into IST date and time", () => {
    expect(istParts(1786207500)).toEqual({ date: "2026-08-08", time: "22:15" }); // "August 8 | 10:15PM" in the capture
  });
});

describe("collectDistrict", () => {
  const now = () => 1786000000 * 1000;
  const fetchStub: Fetch = async (url) => {
    const path = new URL(url).pathname;
    const body =
      path.endsWith("/event-search/search")
        ? { data: { events: [{ _id: "E1", name: "Pitcher of Jokes", slug: "pitcher", max_show_end_utc_timestamp: 1790000000 }, { _id: "OLD", name: "Old", max_show_end_utc_timestamp: 1700000000 }], next_offset: null } }
        : {
            data: {
              venues: [{
                name: "Big Pitcher",
                shows: [
                  { _id: "S1", start_utc_timestamp: 1786207500, items_for_sale: [{ items: [{ finite_amount_sold: 3, finite_amount_available: 15 }, { finite_amount_sold: 1, finite_amount_available: 5 }] }] },
                  { _id: "PAST", start_utc_timestamp: 1700000000, items_for_sale: [] },
                  { _id: "HID", start_utc_timestamp: 1786207500, is_hidden: true, items_for_sale: [] },
                  { _id: "HIDSOLD", start_utc_timestamp: 1786207500, is_hidden: true, items_for_sale: [{ items: [{ finite_amount_sold: 1, finite_amount_available: 5 }] }] },
                ],
              }],
            },
          };
    return { status: 200, json: async () => body };
  };

  it("lists upcoming shows of current events with summed counts (hidden ones only with sales)", async () => {
    const rows = await collectDistrict(fetchStub, { apiKey: "K", secret: "S", deviceId: "d" }, "acc", now);
    expect(rows).toEqual([
      expect.objectContaining({ key: "district:E1:S1", platform: "district", listingId: "E1", sessionId: "S1", showDate: "2026-08-08", showTime: "22:15", sold: 4, capacity: 20, remaining: 16, venue: "Big Pitcher", publicUrl: "https://www.district.in/events/pitcher" }),
      expect.objectContaining({ key: "district:E1:HIDSOLD", sold: 1 }),
    ]);
  });

  it("turns 401 into needs_login", async () => {
    await expect(collectDistrict(async () => ({ status: 401, json: async () => ({}) }), { apiKey: "K", secret: "S", deviceId: "d" }, "acc", now)).rejects.toMatchObject({ kind: "needs_login" });
  });
});
