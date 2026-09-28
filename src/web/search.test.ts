import { describe, expect, it } from "vitest";
import type { Library } from "../shared/library";
import { entityTerms, fuzzyScore, searchEntities } from "./search";

const lib: Library = {
  tags: [{ name: "climbable", aliases: ["grabbable"] }, { name: "breakable" }],
  skills: [
    { name: "telekinesis", description: "moves #breakable things", tags: ["breakable"] },
    { name: "grapple", description: "pulls to a point" },
  ],
  entities: [
    { id: "barrel", name: "Barrel", tags: ["breakable"] },
    { id: "ladder", name: "Wooden ladder", tags: ["grabbable"] },
    { id: "crate", name: "Crate", description: "a hook point for @grapple" },
    { id: "human", name: "human" },
  ],
  guide: "",
};
const names = (q: string) => searchEntities(lib, q).map((e) => e.id);

describe("fuzzyScore", () => {
  it("matches letters in order, case-insensitively", () => {
    expect(fuzzyScore("brl", "Barrel")).not.toBeNull();
    expect(fuzzyScore("lrb", "Barrel")).toBeNull();
    expect(fuzzyScore("", "Barrel")).toBe(0);
  });
  it("ranks a prefix over a word start over a run inside over scattered letters", () => {
    const prefix = fuzzyScore("lad", "ladder")!;
    const word = fuzzyScore("lad", "wooden ladder")!;
    const inside = fuzzyScore("add", "ladder")!;
    const scattered = fuzzyScore("ldr", "ladder")!;
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(inside);
    expect(inside).toBeGreaterThan(scattered);
  });
  it("ranks consecutive letters and word starts over spread ones", () => {
    expect(fuzzyScore("wl", "wooden ladder")!).toBeGreaterThan(fuzzyScore("wl", "towel")!);
  });
});

describe("searchEntities", () => {
  it("lists everything for an empty query", () => {
    expect(names("  ")).toEqual(["barrel", "ladder", "crate", "human"]);
    expect(names("#")).toEqual(["barrel", "ladder", "crate", "human"]);
  });
  it("finds by name, fuzzily", () => {
    expect(names("wdldr")).toEqual(["ladder"]);
    expect(names("CRATE")).toEqual(["crate"]);
  });
  it("finds by tag, through aliases (by the current name)", () => {
    expect(names("#climb")).toEqual(["ladder"]);
    expect(names("#grabbable")).toEqual([]);
    expect(names("climbable")).toEqual(["ladder"]);
  });
  it("finds by skill: named in the description, or acting on a tag", () => {
    expect(names("@grapple")).toEqual(["crate"]);
    expect(names("@tele")).toEqual(["barrel"]);
    expect(entityTerms(lib, lib.entities[0]).map((t) => `${t.kind}:${t.text}`)).toEqual(["name:Barrel", "tag:breakable", "skill:telekinesis"]);
  });
  it("keeps # and @ to their kind", () => {
    expect(names("#barrel")).toEqual([]);
    expect(names("@crate")).toEqual([]);
  });
  it("needs every word to match", () => {
    expect(names("barrel #break")).toEqual(["barrel"]);
    expect(names("barrel #climb")).toEqual([]);
  });
});
