import { describe, expect, it } from "vitest";
import { nextTheme, parseTheme } from "./theme";

describe("theme choice", () => {
  it("cycles System → Light → Dark → System", () => {
    expect(nextTheme("system")).toBe("light");
    expect(nextTheme("light")).toBe("dark");
    expect(nextTheme("dark")).toBe("system");
  });

  it("reads anything but light or dark as System", () => {
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("dark")).toBe("dark");
    expect(parseTheme(null)).toBe("system");
    expect(parseTheme("sepia")).toBe("system");
  });
});
