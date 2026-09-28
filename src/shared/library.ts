import { z } from "zod";

/**
 * The project library (plan 08 §5): project-wide tags (`#climbable`) and skills (`@telekinesis`), both with
 * descriptions, and the project's design guide. Descriptions and notes refer to them as `#name` and `@name`. A
 * renamed tag or skill keeps its old names as aliases, so nothing that refers to it is ever rewritten. Pure, shared
 * by the server and the editor.
 */

export type LibraryKind = "tag" | "skill";
export type Tag = { name: string; description?: string; aliases?: string[] };
export type Skill = { name: string; description: string; tags?: string[]; aliases?: string[] };
export type Library = { tags: Tag[]; skills: Skill[]; guide: string };

export const EMPTY_LIBRARY: Library = { tags: [], skills: [], guide: "" };
export const SIGIL: Record<LibraryKind, "#" | "@"> = { tag: "#", skill: "@" };
export const MAX_NAME = 40;
export const MAX_LIBRARY_DESCRIPTION = 2000;
/** The design guide's longest text, in characters. */
export const MAX_GUIDE = 100_000;

/** A tag's or skill's name: lowercase, starting with a letter, then letters, digits, `_` and `-`. */
export const NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;
export const NameSchema = z
  .string()
  .max(MAX_NAME)
  .regex(NAME_PATTERN, "lowercase letters, digits, _ and -, starting with a letter (no # or @)");

export const TagSchema = z.object({
  name: NameSchema,
  description: z.string().max(MAX_LIBRARY_DESCRIPTION).optional(),
  aliases: z.array(z.string()).optional(),
});
export const SkillSchema = z.object({
  name: NameSchema,
  description: z.string().max(MAX_LIBRARY_DESCRIPTION),
  tags: z.array(z.string()).optional(),
  aliases: z.array(z.string()).optional(),
});

/**
 * One change to the library: a tag or a skill set (`value`) or removed (null) by name, or the design guide's whole
 * text. Every op is absolute, so applying one twice gives the same library.
 */
export type LibraryOp =
  | { op: "tag"; name: string; value: Tag | null }
  | { op: "skill"; name: string; value: Skill | null }
  | { op: "guide"; text: string };

export const LibraryOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("tag"), name: z.string(), value: TagSchema.nullable() }),
  z.object({ op: z.literal("skill"), name: z.string(), value: SkillSchema.nullable() }),
  z.object({ op: z.literal("guide"), text: z.string() }),
]);

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);

/** The library with `op` applied (tags and skills stay sorted by name). Never mutates `lib`. */
export function applyLibraryOp(lib: Library, op: LibraryOp): Library {
  if (op.op === "guide") return { ...lib, guide: op.text };
  const list = op.op === "tag" ? lib.tags : lib.skills;
  const next = list.filter((r) => r.name !== op.name);
  if (op.value) next.push(op.value as Tag & Skill);
  next.sort(byName);
  return op.op === "tag" ? { ...lib, tags: next as Tag[] } : { ...lib, skills: next as Skill[] };
}

/** The op that undoes `op`, computed against the library before `op` is applied. */
export function invertLibraryOp(lib: Library, op: LibraryOp): LibraryOp {
  if (op.op === "guide") return { op: "guide", text: lib.guide };
  if (op.op === "tag") return { op: "tag", name: op.name, value: lib.tags.find((t) => t.name === op.name) ?? null };
  return { op: "skill", name: op.name, value: lib.skills.find((s) => s.name === op.name) ?? null };
}

/** The tag or skill called `name`, by its name or one of its aliases (any case), or undefined. */
export function resolveRef(lib: Library, kind: "tag", name: string): Tag | undefined;
export function resolveRef(lib: Library, kind: "skill", name: string): Skill | undefined;
export function resolveRef(lib: Library, kind: LibraryKind, name: string): Tag | Skill | undefined;
export function resolveRef(lib: Library, kind: LibraryKind, name: string): Tag | Skill | undefined {
  const key = name.replace(/^[#@]/, "").toLowerCase();
  const list: (Tag | Skill)[] = kind === "tag" ? lib.tags : lib.skills;
  return list.find((r) => r.name === key) ?? list.find((r) => r.aliases?.includes(key));
}

export type TextRef = { kind: LibraryKind; name: string; start: number; end: number };

/**
 * The `@skill` and `#tag` references in a text, in order: a sigil at the start or after a character that can't be
 * part of a word (so an email or `a#b` isn't one), then a name that starts with a letter (so `room #2` isn't one).
 * A trailing `-` or `_` isn't part of the name.
 */
export function findRefs(text: string): TextRef[] {
  const refs: TextRef[] = [];
  const pattern = /(^|[^\p{L}\p{N}_@#-])([@#])([a-zA-Z][a-zA-Z0-9_-]*)/gu;
  for (const m of text.matchAll(pattern)) {
    const name = m[3].replace(/[-_]+$/, "");
    const start = m.index! + m[1].length;
    refs.push({ kind: m[2] === "@" ? "skill" : "tag", name: name.toLowerCase(), start, end: start + 1 + name.length });
  }
  return refs;
}

/** The references in `text` that name nothing in the library, as written (`@fsh`, `#clmb`), each once. */
export function unknownRefs(lib: Library, text: string): string[] {
  const unknown = findRefs(text)
    .filter((r) => !resolveRef(lib, r.kind, r.name))
    .map((r) => `${SIGIL[r.kind]}${r.name}`);
  return [...new Set(unknown)];
}

/** Tags as stored on a node or a skill, by their current names: aliases resolved, unknown ones left out. */
export function currentTags(lib: Library, tags: string[] | undefined): string[] {
  if (!tags) return [];
  return [...new Set(tags.flatMap((t) => resolveRef(lib, "tag", t)?.name ?? []))];
}

/** How many nodes use a tag or skill, and in how many scenes: carrying the tag, or naming it in a description. */
export type Uses = { tags: Record<string, { nodes: number; scenes: number }>; skills: Record<string, { nodes: number; scenes: number }> };

/** The library's edits, as `update_library` and the editor send them: applied together, as one step. */
export const LibraryEditSchema = z.strictObject({
  upsert: z
    .array(
      z.strictObject({
        kind: z.enum(["tag", "skill"]),
        name: z.string().describe("The name, without # or @: lowercase letters, digits, _ and -, starting with a letter"),
        description: z
          .string()
          .max(MAX_LIBRARY_DESCRIPTION)
          .optional()
          .describe("What it is or does. Required for a new skill. It can refer to other skills (@name) and tags (#name)"),
        tags: z.array(z.string()).optional().describe("Skills only: the tags it acts on, e.g. [\"light\"] for telekinesis (the whole list)"),
      }),
    )
    .optional()
    .describe("Tags and skills to add, or to change (only the fields given change)"),
  remove: z
    .array(z.strictObject({ kind: z.enum(["tag", "skill"]), name: z.string() }))
    .optional()
    .describe("Tags and skills to delete. What refers to them stays, unresolved"),
  rename: z
    .array(z.strictObject({ kind: z.enum(["tag", "skill"]), from: z.string(), to: z.string() }))
    .optional()
    .describe("Renames; the old name stays as an alias, so references to it still resolve"),
  guide: z.string().max(MAX_GUIDE).optional().describe("The design guide's whole new text (markdown). Only when the human asks"),
});
export type LibraryEdit = z.input<typeof LibraryEditSchema>;
