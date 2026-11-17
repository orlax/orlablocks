/** Offline migration: dry-run by default. --write requires --reset-history and makes a complete sibling backup. */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { openDataDir } from "../src/server/persist";
import { restoreScene } from "../src/server/workspace";
import { NodeSchema } from "../src/shared/scene.types";
import { migrateProjectCuts } from "../src/shared/migrations/cutTags";

const { values } = parseArgs({ options: { data: { type: "string" }, write: { type: "boolean" }, "reset-history": { type: "boolean" } } });
if (!values.data) throw new Error("Usage: node --import tsx scripts/migrate-cut-tags.ts --data <folder> [--write --reset-history]");
if (values.write && !values["reset-history"]) throw new Error("Writing requires --reset-history: original histories are preserved in the backup, converted documents start a fresh undo baseline");
const root = path.resolve(values.data);
if (!fs.existsSync(path.join(root, "projects"))) throw new Error("Data folder has no projects directory");
const data = openDataDir(root);
const pending: { file: string; value: unknown; history: string }[] = [];
let backup: string | undefined;
try {
  for (const project of data.listProjects()) {
    if (project.error) throw new Error(project.error);
    const loaded = data.readEntities(project.id);
    if (loaded.errors.length) throw new Error(loaded.errors.join("\n"));
    const docs = [
      ...Object.entries(loaded.entities).map(([id, file]) => ({ id, kind: "entities", file, history: data.readEntityHistory(project.id, id) })),
      ...project.scenes.map((sc) => {
        if (sc.error) throw new Error(sc.error);
        return { id: sc.id, kind: "scenes", file: data.readScene(project.id, sc.id), history: data.readHistory(project.id, sc.id) };
      }),
    ];
    const marked = docs.filter((d) => (d.file as { cutVersion?: number }).cutVersion === 1);
    if (marked.length === docs.length) { console.log(`${project.id}: already migrated`); continue; }
    if (marked.length) throw new Error(`${project.id}: partially migrated project; restore its backup before retrying`);
    const restored = docs.map((d) => ({ ...d, state: restoreScene(d.file as Parameters<typeof restoreScene>[0], d.history) }));
    const result = migrateProjectCuts(
      Object.fromEntries(restored.filter((d) => d.kind === "entities").map((d) => [d.id, d.state.nodes])),
      Object.fromEntries(restored.filter((d) => d.kind === "scenes").map((d) => [d.id, d.state.nodes])),
      project.id,
    );
    let tagged = 0;
    for (const doc of restored) {
      const nodes = (doc.kind === "entities" ? result.definitions : result.scenes)[doc.id];
      nodes.forEach((n) => NodeSchema.parse(n));
      tagged += nodes.filter((n) => "cutTags" in n || "cutTagParts" in n).length;
      const dir = path.join(root, "projects", project.id, doc.kind, doc.id);
      // Keep seq for saved-shot provenance; a missing log is a supported new history baseline.
      pending.push({ file: path.join(dir, doc.kind === "entities" ? "entity.json" : "scene.json"), value: { ...doc.file, nodes, nextId: doc.state.nextId, seq: doc.state.seq, cutVersion: 1 }, history: path.join(dir, "history.jsonl") });
    }
    console.log(`${project.id}: ${project.scenes.length} scenes, ${Object.keys(loaded.entities).length} definitions, ${tagged} annotated nodes; exact eligible-target parity passed`);
  }
  if (values.write && pending.length) {
    backup = `${root}.before-cut-tags-${Date.now()}`;
    fs.cpSync(root, backup, { recursive: true, errorOnExist: true, force: false, filter: (src) => src !== path.join(root, ".lock") });
    console.log(`Originals and undo history backed up to ${backup}`);
    // All projects were validated before the first mutation. Restore full backup on any write failure.
    try {
      for (const doc of pending) {
        fs.writeFileSync(`${doc.file}.cut-tags-tmp`, JSON.stringify(doc.value, null, 2) + "\n");
        fs.renameSync(`${doc.file}.cut-tags-tmp`, doc.file);
        if (fs.existsSync(doc.history)) fs.unlinkSync(doc.history);
      }
    } catch (error) {
      fs.cpSync(backup, root, { recursive: true, force: true });
      throw error;
    }
  }
  console.log(JSON.stringify({ mode: values.write ? "write" : "dry-run", documents: pending.length, backup }));
} finally { data.release(); }
