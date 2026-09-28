import { describe, expect, it } from "vitest";
import { fitSize, shotFileName } from "./shots";

describe("shots in the editor", () => {
  it("caps a capture's long edge, keeping its shape, and never scales up", () => {
    expect(fitSize(1600, 900)).toEqual({ width: 1600, height: 900 });
    expect(fitSize(8192, 4608)).toEqual({ width: 4096, height: 2304 });
    expect(fitSize(1000, 3000, 1500)).toEqual({ width: 500, height: 1500 });
    expect(fitSize(0.2, 0.2)).toEqual({ width: 1, height: 1 });
  });
  it("names a shot's file by its ID and caption, safely", () => {
    expect(shotFileName({ id: "shot_3" })).toBe("shot_3.png");
    expect(shotFileName({ id: "shot_3", caption: "can we see the window?" })).toBe("shot_3 can we see the window.png");
    expect(shotFileName({ id: "shot_4", caption: "a/b\\c:d  e" })).toBe("shot_4 a b c d e.png");
    expect(shotFileName({ id: "shot_5", caption: "x".repeat(200) })).toBe(`shot_5 ${"x".repeat(60)}.png`);
  });
});
