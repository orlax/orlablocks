# Terrain measurements — 16.3 (2026-10-06)

Reproduce with `node --expose-gc --import tsx scripts/benchmark-terrain.ts`. This script constructs in-memory fixtures; it never opens a data folder.

Machine: Apple M1 Max, macOS arm64, 10 logical CPUs, 32 GiB RAM, Node v22.23.3. Scene: 256 × 192 m; 20 or 100 mixed box, beveled cylinder, concave free-form and curved smooth-ramp inputs, 12–20 m footprints, 6 m fades. CPU timings from one run, not a universal speed guarantee. Rebuild includes mesh construction; drag is the mean of five source moves at canonical resolution. Preview evaluates the same inputs at 129 samples. Picking traverses canonical grid cells with an oblique ray. Export time includes canonical reevaluation after the preview displaced the full-resolution cache (except when the requested resolution already equals 129).

| Inputs | Samples | Initial rebuild ms | Mean full-resolution move ms | Preview ms | Pick ms | Export ms | Canonical geometry MiB |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 20 | 129 | 33.1 | 4 | 4 | 0.5 | 3.8 | 1.2 |
| 20 | 257 | 36.6 | 19 | 4.1 | 0.2 | 18 | 4.8 |
| 20 | 513 | 84.1 | 66 | 20.5 | 0.2 | 98.3 | 19 |
| 20 | 1025 | 285.6 | 225 | 4.4 | 0.4 | 238.1 | 76.1 |
| 100 | 129 | 33.7 | 20 | 20.6 | 0.1 | 1.4 | 1.2 |
| 100 | 257 | 101.4 | 71 | 20 | 0.1 | 74.7 | 4.8 |
| 100 | 513 | 296.3 | 282 | 20.4 | 0.2 | 289.7 | 19 |
| 100 | 1025 | 1117.8 | 1101 | 20.1 | 0.3 | 1115 | 76.1 |

Canonical geometry estimates number-array slots at 8 bytes plus the Float32 height buffer; actual JS allocation overhead varies. The script also reports heap/ArrayBuffer deltas and resident memory. Those include GC timing, imported modules, previous fixtures and cached grids, so they are diagnostics rather than per-terrain peak-memory claims. Observed whole-process resident memory was 153–495 MiB in this run. Grid indices are shared by resolution; at most eight content entries and 128 MiB of height/position estimates are retained, with four bounded resolution grids outside that budget.

## Baseline and chosen limits

Before these changes, a terrain color edit rebuilt the grid: roughly 23 ms for 100 inputs at 129, 79 ms at 257, 314 ms at 513, and 1,343 ms at 1025. Afterwards, color/cosmetic edits and unchanged reads take about 0.0–0.1 ms and reuse the same heightfield. Sparse per-input rectangles reduce allocation; shared regular-grid indices and preallocated positions avoid repeated index-list growth. These changes preserve the sequential algorithm; they do not silently smooth or approximate canonical output.

129 remains the default. With 100 inputs, canonical moves were about 20 ms at 129, 71 ms at 257, 282 ms at 513 and 1,101 ms at 1025. A temporary 129-sample drag mesh keeps CPU work near 20 ms for this fixture regardless of the saved resolution. Full-resolution regeneration happens on release: 1025 can still pause for about a second on a large input stack. Prefer 129/257 for active layout editing; 513/1025 are supported when finer cells justify their memory and settling cost. This does not assert a browser frame rate: GPU drawing, source overlays and the rest of the editor add time.

Preview evaluation is synchronous. There are no asynchronous jobs or stale-job races. Meshes, picking and influence outlines use the same preview rule while dragging; captures, shots, reads and export always use canonical resolution. Cached keys include the rectangle/base, resolution, eligible source geometry, operations, fades, hierarchy evaluation order and inherited hiding. Color/name/tag/lock changes do not affect heights. No worker or further optimization is justified as a prerequisite for this increment; the remaining full-resolution settling cost is recorded rather than hidden.

## Acceptance evidence

- 568 tests, typecheck and production web build passed, including exact grid-cell ray picking against brute-force triangle intersections and cache invalidation/preview separation.
- Scratch MCP check (`node scripts/check-16.mjs 5186 render`): batch refs, lean terrain read/edit fields, find_nodes, source ownership errors, failed/dry-run edits, outliner reordering, human undo and source edits, deferred-query warnings; real editor plan/sheet/node images and a saved shot.
- Repeated canonical plan PNG after selecting a source and toggling Show modifiers (`node scripts/check-16.mjs 5186 capture`): byte-identical. A source-handle drag at 513 samples followed by undo also restored a byte-identical canonical capture. Local authoring overlay state does not leak into captures.
- Unity height payload checked against every canonical grid sample, with z reversal/negative origin; browser terrain positions carry the same heights. The Unity importer is unchanged in 16.3; refresh/GLB acceptance remains 16.4.
