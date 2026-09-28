import { currentTags, findRefs, resolveRef, type EntityMeta, type Library } from "../shared/library";

/**
 * Fuzzy search (the Entities panel's search bar). A query matches a text when its letters appear in the text in
 * order (`brl` finds `barrel`), case-insensitively. Letters that follow each other, and ones at the start of a word,
 * score higher, so the closest matches come first.
 */

/** How well `query` matches `text`: null for no match, otherwise higher is better. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q === "") return 0;
  const at = t.indexOf(q);
  // A whole run of the query beats any scattered match, a prefix most of all, then one at a word's start.
  if (at >= 0) return 1000 + (at === 0 ? 200 : wordStart(t, at) ? 100 : 0) - t.length;
  let score = 0;
  let last = -2;
  let i = 0;
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (t[j] !== q[i]) continue;
    score += 1 + (j === last + 1 ? 5 : 0) + (wordStart(t, j) ? 8 : 0) - Math.min(j - last - 1, 5) * (last < 0 ? 0 : 1);
    last = j;
    i++;
  }
  return i === q.length ? score : null;
}

const wordStart = (t: string, i: number) => i === 0 || !/[\p{L}\p{N}]/u.test(t[i - 1]);

type Term = { text: string; kind: "name" | "tag" | "skill" };

/**
 * What an entity is found by: its name, its tags, and its skills (the ones its description names, and the ones
 * that act on its tags). Tags and skills by their current names.
 */
export function entityTerms(lib: Library, e: EntityMeta): Term[] {
  const tags = currentTags(lib, e.tags);
  const skills = new Set<string>();
  for (const r of findRefs(e.description ?? "")) {
    if (r.kind === "skill") {
      const s = resolveRef(lib, "skill", r.name);
      if (s) skills.add(s.name);
    } else {
      const t = resolveRef(lib, "tag", r.name);
      if (t && !tags.includes(t.name)) tags.push(t.name);
    }
  }
  for (const s of lib.skills) if (currentTags(lib, s.tags).some((t) => tags.includes(t))) skills.add(s.name);
  return [{ text: e.name, kind: "name" }, ...tags.map((text) => ({ text, kind: "tag" as const })), ...[...skills].map((text) => ({ text, kind: "skill" as const }))];
}

/**
 * The entities that match `query`, best first (ties keep the library's order). Each word of the query must match
 * one of an entity's terms: `#word` only its tags, `@word` only its skills, a plain word any of them.
 */
export function searchEntities(lib: Library, query: string): EntityMeta[] {
  const words = query.trim().split(/\s+/).filter((w) => w !== "" && w !== "#" && w !== "@");
  if (words.length === 0) return lib.entities;
  const scored: { e: EntityMeta; score: number; order: number }[] = [];
  lib.entities.forEach((e, order) => {
    const terms = entityTerms(lib, e);
    let score = 0;
    for (const w of words) {
      const kind = w[0] === "#" ? "tag" : w[0] === "@" ? "skill" : null;
      const q = kind ? w.slice(1) : w;
      let best: number | null = null;
      for (const t of terms) {
        if (kind && t.kind !== kind) continue;
        const s = fuzzyScore(q, t.text);
        // A name match counts a little more than a tag or skill one.
        if (s !== null && (best === null || s + (t.kind === "name" ? 1 : 0) > best)) best = s + (t.kind === "name" ? 1 : 0);
      }
      if (best === null) return;
      score += best;
    }
    scored.push({ e, score, order });
  });
  return scored.sort((a, b) => b.score - a.score || a.order - b.order).map((s) => s.e);
}
