import { describe, expect, it } from "vitest";
import { mergeLogTail } from "./logTail.ts";

describe("mergeLogTail", () => {
  it("keeps old lines and adds only the new ones", () => {
    expect(mergeLogTail(["a", "b", "c"], ["b", "c", "d", "e"])).toEqual(["a", "b", "c", "d", "e"]);
  });
  it("returns the same array when nothing is new", () => {
    const prev = ["a", "b"];
    expect(mergeLogTail(prev, ["a", "b"])).toBe(prev);
  });
  it("handles repeated lines by the longest overlap", () => {
    expect(mergeLogTail(["x", "tick", "tick"], ["tick", "tick", "y"])).toEqual(["x", "tick", "tick", "y"]);
  });
  it("appends a window that doesn't overlap (server restarted)", () => {
    expect(mergeLogTail(["a", "b"], ["boot", "c"])).toEqual(["a", "b", "boot", "c"]);
  });
  it("caps the length", () => {
    expect(mergeLogTail(["a", "b", "c"], ["c", "d"], 3)).toEqual(["b", "c", "d"]);
  });
});
