# Cut-tag migration (19.6)

Ordinary holes now cut overlapping solids with matching `cutTags`, independently of groups. Cut tags are separate from library/gameplay tags and require no registration. Empty/omitted tags cut nothing. Entity-definition tags are local to each placement; instance/array tags govern external cuts. Terrain-source holes keep their terrain-only behavior.

The server refuses unconverted saved documents. Stop every server using the folder before migrating:

```sh
node --import tsx scripts/migrate-cut-tags.ts --data /absolute/path/to/data
node --import tsx scripts/migrate-cut-tags.ts --data /absolute/path/to/data --write --reset-history
```

The first command audits without changing documents. The second validates all projects, creates a complete sibling backup, writes converted documents, and starts fresh undo histories. The backup retains the original scenes, entity definitions and histories. Saved sequence numbers remain for shot provenance. A repeated run skips documents marked `cutVersion: 1`; a partially converted project stops with instructions to restore its backup.

The migration walks every project's definitions and scenes together. It uses the frozen legacy rule to preserve exact eligible targets, including non-overlapping ones, and verifies the new resolver before writing. Generated names include project and document identity, so unrelated sets do not collide when pasted across scenes. `cutTagParts` preserves differences among placement parts. Array part bindings follow layout indices; changed layouts/entities or additional items may need retagging. Copies retain external tags and join their matching sets.

After conversion, with no subsequent edits, independently compare saved output to the original backup:

```sh
node --import tsx scripts/verify-cut-migration.ts /absolute/path/to/backup /absolute/path/to/data
```

The backup contains legacy cutting data and must be used with compatible old code or migrated again before opening in the tag-only server. Restore while servers are stopped. Do not merge its old history logs into the converted documents: historical undo entries have not been migrated.
