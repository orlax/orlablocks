import {
  applyLibraryOp,
  EMPTY_LIBRARY,
  invertLibraryOp,
  LibraryEditSchema,
  NAME_PATTERN,
  resolveRef,
  SIGIL,
  unknownRefs,
  type Library,
  type LibraryEdit,
  type LibraryKind,
  type LibraryOp,
  type EntityMeta,
  type Skill,
  type Tag,
} from "../shared/library";
import type { Actor, HistorySummary } from "../shared/scene.types";
import { createHistory, HISTORY_LIMIT, type History, type HistoryEntry } from "./commands";
import { SceneError } from "./scene";

/**
 * The project library's store (plan 08 §5): the tags, skills and design guide of the open scene's project, and their
 * own undo history, separate from every scene's. Every edit goes through `edit` as one step.
 */

export type LibraryHistory = History<Library, LibraryOp>;
export type LibraryEntry = HistoryEntry<LibraryOp>;
export type LibraryStep = { type: "commit" | "undo" | "redo"; entry: LibraryEntry };

export const newLibraryHistory = (): LibraryHistory => createHistory<Library, LibraryOp>(HISTORY_LIMIT, applyLibraryOp);

const ref = (kind: LibraryKind, name: string) => `${SIGIL[kind]}${name}`;

export function createLibraryStore() {
  let library: Library = EMPTY_LIBRARY;
  let history = newLibraryHistory();
  const listeners = new Set<(library: Library) => void>();
  const stepListeners = new Set<(step: LibraryStep) => void>();

  const emit = () => listeners.forEach((l) => l(library));

  const apply = (entry: LibraryEntry, type: LibraryStep["type"]) => {
    library = (type === "undo" ? entry.inverse : entry.ops).reduce(applyLibraryOp, library);
    stepListeners.forEach((l) => l({ type, entry }));
    emit();
  };

  return {
    get: (): Library => library,
    getHistory: (): HistorySummary => history.summary(),

    /** Replaces the library and its history (when a project's scene opens). Broadcasts; isn't a step. */
    load(next: { library: Library; history: LibraryHistory }): void {
      library = next.library;
      history = next.history;
      emit();
    },

    /**
     * Applies an edit as one step: renames, then upserts, then removals, then the guide, each seeing the ones before
     * it (so a batch can add a tag and a skill tagged with it). All-or-nothing. Returns what changed, as `#tag` and
     * `@skill`, and warnings for references to nothing in the descriptions it set.
     */
    edit(input: LibraryEdit, actor: Actor): { changed: string[]; warnings: string[] } {
      const parsed = LibraryEditSchema.safeParse(input);
      if (!parsed.success) {
        const lines = parsed.error.issues.map((i) => `${i.path.map(String).join(".") || "(edit)"}: ${i.message}`);
        throw new SceneError(`The library wasn't changed.\n${lines.join("\n")}`);
      }
      const { upsert = [], remove = [], rename = [], entities = [], guide } = parsed.data;
      const errors: string[] = [];
      const ops: LibraryOp[] = [];
      const labels: string[] = [];
      const changed: string[] = [];
      const described: string[] = [];
      let draft = library;
      const push = (op: LibraryOp) => {
        ops.push(op);
        draft = applyLibraryOp(draft, op);
      };
      const nameProblem = (name: string) => (NAME_PATTERN.test(name) && name.length <= 40 ? null : `"${name}" isn't a name: use lowercase letters, digits, _ and -, starting with a letter (no # or @)`);

      rename.forEach(({ kind, from, to }, i) => {
        const at = `rename[${i}]`;
        const record = resolveRef(draft, kind, from);
        if (!record) return void errors.push(`${at}.from: no ${kind} ${ref(kind, from)}`);
        const problem = nameProblem(to);
        if (problem) return void errors.push(`${at}.to: ${problem}`);
        if (to === record.name) return;
        const taken = resolveRef(draft, kind, to);
        if (taken && taken !== record) {
          return void errors.push(`${at}.to: ${ref(kind, to)} is taken${taken.name === to ? "" : ` (an alias of ${ref(kind, taken.name)})`}`);
        }
        const aliases = [...(record.aliases ?? []).filter((a) => a !== to), record.name];
        push({ op: kind, name: record.name, value: null } as LibraryOp);
        push({ op: kind, name: to, value: { ...record, name: to, aliases } } as LibraryOp);
        labels.push(`rename ${ref(kind, record.name)} to ${ref(kind, to)}`);
        changed.push(ref(kind, to));
      });

      upsert.forEach((u, i) => {
        const at = `upsert[${i}]`;
        const problem = nameProblem(u.name);
        if (problem) return void errors.push(`${at}.name: ${problem}`);
        const list: (Tag | Skill)[] = u.kind === "tag" ? draft.tags : draft.skills;
        const existing = list.find((r) => r.name === u.name);
        const aliasOf = !existing ? resolveRef(draft, u.kind, u.name) : undefined;
        if (aliasOf) return void errors.push(`${at}.name: ${ref(u.kind, u.name)} is an alias of ${ref(u.kind, aliasOf.name)}: use that name`);
        const description = u.description?.trim();
        if (u.kind === "tag") {
          if (u.tags !== undefined) return void errors.push(`${at}.tags: only a skill has tags`);
          const value: Tag = { ...(existing as Tag | undefined), name: u.name };
          if (u.description !== undefined) {
            if (description) value.description = description;
            else delete value.description;
          }
          push({ op: "tag", name: u.name, value });
        } else {
          const next: Partial<Skill> = { ...(existing as Skill | undefined), name: u.name };
          if (u.description !== undefined) next.description = description;
          if (!next.description) return void errors.push(`${at}.description: a skill needs a description (what the player can do with it)`);
          if (u.tags !== undefined) {
            const missing = u.tags.filter((t) => !resolveRef(draft, "tag", t));
            if (missing.length > 0) return void errors.push(`${at}.tags: no tag ${missing.map((t) => ref("tag", t)).join(", ")} (add it first)`);
            const tags = [...new Set(u.tags.map((t) => resolveRef(draft, "tag", t)!.name))];
            if (tags.length > 0) next.tags = tags;
            else delete next.tags;
          }
          push({ op: "skill", name: u.name, value: next as Skill });
        }
        if (description) described.push(description);
        labels.push(`${existing ? "edit" : "add"} ${ref(u.kind, u.name)}`);
        changed.push(ref(u.kind, u.name));
      });

      entities.forEach((e, i) => {
        const at = `entities[${i}]`;
        const meta = draft.entities.find((m) => m.id === e.id);
        if (!meta) return void errors.push(`${at}.id: no entity "${e.id}" (get_library lists them)`);
        const next: EntityMeta = { ...meta };
        if (e.name !== undefined) {
          if (!e.name.trim()) return void errors.push(`${at}.name: an entity needs a name`);
          next.name = e.name.trim();
        }
        if (e.description !== undefined) {
          const d = e.description.trim();
          if (d) next.description = d;
          else delete next.description;
          if (d) described.push(d);
        }
        if (e.tags !== undefined) {
          const missing = e.tags.filter((t) => !resolveRef(draft, "tag", t));
          if (missing.length > 0) return void errors.push(`${at}.tags: no tag ${missing.map((t) => ref("tag", t)).join(", ")} (add it first)`);
          const tags = [...new Set(e.tags.map((t) => resolveRef(draft, "tag", t)!.name))];
          if (tags.length > 0) next.tags = tags;
          else delete next.tags;
        }
        push({ op: "entity", name: meta.id, value: next });
        labels.push(`edit entity ${next.name}`);
        changed.push(`entity ${meta.id}`);
      });

      remove.forEach(({ kind, name }, i) => {
        if (kind === "entity") {
          const meta = draft.entities.find((m) => m.id === name);
          if (!meta) return void errors.push(`remove[${i}]: no entity "${name}"`);
          push({ op: "entity", name, value: null });
          labels.push(`delete entity ${meta.name}`);
          changed.push(`entity ${name}`);
          return;
        }
        const record = resolveRef(draft, kind, name);
        if (!record) return void errors.push(`remove[${i}]: no ${kind} ${ref(kind, name)}`);
        push({ op: kind, name: record.name, value: null } as LibraryOp);
        labels.push(`delete ${ref(kind, record.name)}`);
        changed.push(ref(kind, record.name));
      });

      if (guide !== undefined && guide !== draft.guide) {
        push({ op: "guide", text: guide });
        labels.push("edit design guide");
        changed.push("design guide");
      }

      if (errors.length > 0) throw new SceneError(`The library wasn't changed.\n${errors.join("\n")}`);
      // Keep only what changes something (an upsert with the same values records nothing).
      const effective = ops.filter((op, i) => JSON.stringify(invertLibraryOp(ops.slice(0, i).reduce(applyLibraryOp, library), op)) !== JSON.stringify(op));
      if (effective.length === 0) return { changed: [], warnings: [] };

      const text = labels.length === 1 ? labels[0] : "edit library";
      const label = actor === "agent" ? `Agent: ${text}` : text.charAt(0).toUpperCase() + text.slice(1);
      const inverse: LibraryOp[] = [];
      let state = library;
      for (const op of effective) {
        inverse.unshift(invertLibraryOp(state, op));
        state = applyLibraryOp(state, op);
      }
      const entry: LibraryEntry = { label, actor, at: Date.now(), ops: effective, inverse };
      history.push(entry);
      apply(entry, "commit");
      const warnings = [...new Set(described.flatMap((d) => unknownRefs(library, d)))].map((r) => `${r} names nothing in the library`);
      return { changed, warnings };
    },

    /**
     * Adds an entity's record without a history step (Make entity: the entity is created like a scene is, and only
     * deleting it is undoable). The workspace saves it.
     */
    addEntityQuietly(meta: EntityMeta): void {
      library = applyLibraryOp(library, { op: "entity", name: meta.id, value: meta });
      emit();
    },

    /** Reverts the library's latest step. Returns it, or null if there was nothing to undo. */
    undo(): LibraryEntry | null {
      const result = history.undo(library);
      if (!result) return null;
      apply(result.entry, "undo");
      return result.entry;
    },

    redo(): LibraryEntry | null {
      const result = history.redo(library);
      if (!result) return null;
      apply(result.entry, "redo");
      return result.entry;
    },

    /** After every commit, undo and redo, before the broadcast (to save it). */
    onStep(listener: (step: LibraryStep) => void): () => void {
      stepListeners.add(listener);
      return () => stepListeners.delete(listener);
    },

    onChange(listener: (library: Library) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type LibraryStore = ReturnType<typeof createLibraryStore>;
