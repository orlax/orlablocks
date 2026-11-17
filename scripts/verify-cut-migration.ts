/** Read-only post-migration comparison against a saved backup; no running-server access or mutations. */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { migrateProjectCuts } from "../src/shared/migrations/cutTags";
import { EntityFileSchema, SceneFileSchema } from "../src/shared/project.types";
const [original, current] = process.argv.slice(2);
if (!original || !current) throw new Error("Usage: node --import tsx scripts/verify-cut-migration.ts <backup> <converted-data>");
let count = 0;
for (const project of fs.readdirSync(path.join(original, "projects"))) {
  const read = (root: string, kind: "scenes" | "entities") => {
    const dir = path.join(root, "projects", project, kind);
    if (!fs.existsSync(dir)) return {};
    return Object.fromEntries(fs.readdirSync(dir).filter((id) => fs.statSync(path.join(dir, id)).isDirectory()).flatMap((id) => {
      const file = path.join(dir, id, kind === "scenes" ? "scene.json" : "entity.json");
      if (!fs.existsSync(file)) return [];
      return [[id, (kind === "scenes" ? SceneFileSchema : EntityFileSchema).parse(JSON.parse(fs.readFileSync(file, "utf8")))]];
    }));
  };
  const defs = read(original, "entities"), scenes = read(original, "scenes");
  const expected = migrateProjectCuts(Object.fromEntries(Object.entries(defs).map(([id, d]) => [id, d.nodes])), Object.fromEntries(Object.entries(scenes).map(([id, d]) => [id, d.nodes])), project);
  for (const kind of ["scenes", "entities"] as const) {
    const converted = read(current, kind);
    for (const [id, nodes] of Object.entries(kind === "scenes" ? expected.scenes : expected.definitions)) {
      assert.equal(converted[id]?.cutVersion, 1, `${project}/${kind}/${id} version`);
      assert.deepEqual(converted[id].nodes, nodes, `${project}/${kind}/${id} saved nodes`);
      count++;
    }
  }
}
console.log(`Verified ${count} saved documents against backup: exact cut-tag migration and unchanged authored geometry/IDs`);
