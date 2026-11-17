# Thinking 13 — A fast editor as scenes grow

Written 2026-11-17 following Orlando's report that complex scenes still feel slow. This is a source audit and architecture proposal, not an implementation phase or a new benchmark. Reviewed the current working tree, including ongoing cut-tag/UX changes; those changes are not assumed to be committed or accepted.

## Direction

The editor should stay responsive while geometry catches up, and a small edit should cost approximately the size of its affected neighborhood, not the whole scene. Keep the server-owned scene and undo history. Separate authored data, derived geometry, and GPU representation so each can update independently.

Recommended order: measure current edit latency; preserve unchanged identities and incrementally maintain dependencies; finish ordinary instancing and bounded static batching; move expensive geometry into a browser worker; consider Rust only for demonstrated remaining kernels. These address different costs and need separate measurements. Do not promise that one migration solves all of them.

Phase 17 still owns its implementation status and acceptance. Its last implemented increment is 17.2; ordinary instancing (17.3), static batching (17.4), and shadows/quality (17.5) remain subsequent work. Workers and server/protocol work exceed its current scope and need an explicit follow-up plan. This discussion does not silently expand that phase.

## What the current implementation actually does

| Area | Evidence in current source | Implication |
|---|---|---|
| Navigation containment | `src/web/Viewport.tsx:1059–1112` memoizes expansion, preview inputs and cutter relationships; `ShapeMesh` and `Boxes` are memoized | Already avoids much repeated work during unchanged navigation. It is not yet an incremental dependency system for edits. |
| Cut eligibility | `src/shared/holes.ts`, `holeScope` | Current working tree matches `cutTags`, independent of hierarchy, with entity-internal namespace rules and separate terrain-source holes. The earlier “own group” model is no longer the full rule. |
| Cut broad phase | `holes.ts`, `cutters` | Already tests world-axis X/Y/Z bounds before assigning a cutter. However, each hole scans scope candidates and recomputes target bounds inside that loop. |
| Boolean engine | `src/shared/csg.ts`, `src/web/csg.ts`, `src/server/manifold.ts` | CSG already uses Manifold WASM on browser and server. Loading asynchronously does not make subsequent synchronous subtraction a background job. |
| Render geometry | `src/web/ShapeMesh.tsx`, `useShapeGeometry` | Content keys protect mesh creation across new objects. Cut keys serialize whole cutter records; geometry, draw buffers and edges are built synchronously in React memo calculations. Not every React render rebuilds every mesh. |
| Shared caches | `src/shared/mesh.ts`, `src/shared/bake.ts` | Several caches use object identity (`WeakMap`). Fresh decoded snapshots and expanded shapes can lose reuse even when authored geometry is unchanged. This differs from the viewer's content-key memoization. |
| Repeated geometry | `src/web/instancing.ts`, `src/web/InstancedArrays.tsx` | Compatible array items are instanced, grouped per array/entity. Ordinary instances remain separate rendered shapes. External cuts cause item fallback. |
| Server delivery | `src/server/ws.ts`, `sceneMessage`/`broadcast`; `src/web/useScene.ts` | Every scene-change broadcast sends a full scene; the client parses it and replaces scene state. Serialization happens inside per-client `send`. Returning a managed list alone would not reduce React components. |
| Commit durability | `src/server/workspace.ts`, `onStep`/`writeScene`; `src/server/persist.ts` | Scene snapshots and history use synchronous persistence. This is a candidate for release/remote-edit latency, not proof of a navigation bottleneck. |
| Terrain | `src/shared/terrain.ts` | Already has a content cache (8 entries / 128 MiB), per-input raster rectangles, and reduced drag resolution where holes permit. A changed input still causes a new heightfield evaluation; this is not persistent dirty-tile updating. |

The older claim in `thinking-05-performance` that geometry calculations are insignificant was based on a synthetic fixture, not all real scenes. The later actual-castle investigation found repeated cutter derivation taking 54–62 ms. Phase 17.2 removed that work from warmed navigation: production route means improved from roughly 24–40 ms to 16.7 ms, with editor p95 16.8–18.6 ms. Those are **October measurements**, not today's scene or edit-latency results. See `17-performance-measurements.md` and phase 17 Progress. Current perceived slowdown needs fresh attribution, especially cold picks, drag previews, release and larger scenes.

## 1. Make edits incremental before changing languages

Maintain stable records keyed by document and node ID. Separate revisions for topology/dimensions, world transform, cut eligibility, appearance and metadata. Keep entity-definition revisions per definition rather than invalidating every placement whenever any definition changes. Track dependencies for expanded placements, followed arrays, wall attachments and terrain sources.

A name edit should not trigger CSG. A color edit should update material membership, not topology. An uncut rigid move should usually update a matrix; check current world-aligned UV behavior before removing UV rebuilds. Moving relative to a cutter does require new cut geometry. A transform applied to both target and cutter may preserve their relative geometry, but only reuse it after verifying floor-cut rules, UVs and coordinate conventions.

Start with snapshot reconciliation: compare incoming records and reuse unchanged client objects. This retains the existing protocol while exposing how much identity churn costs. It still incurs full parsing/comparison, so it is an intermediate step, not the final scaling solution.

If that cost matters, send document-scoped patches with base revision, next revision, changed/added/deleted nodes and ordering changes. Preserve stable references for unchanged records. Include dependent changes resolved by the server, not just the user's original command. Initial connection, document switches and revision gaps get a full snapshot. Undo/redo remains normal server authority; client application must be atomic. Definition and scene updates need coherent revision handling.

Use explicit geometry signatures rather than serializing complete records in hot paths. Include all actual geometric dependencies and engine version; exclude names/selection and other irrelevant metadata. Cache by those signatures with byte limits and disposal. Do not introduce a cache whose correctness depends on remembering to clear it in dozens of UI handlers.

## 2. Incremental cuts: improve the existing AABB test

Orlando's idea is the right direction; the missing step is reuse and neighborhood queries, not the existence of box rejection.

1. Cache conservative world-space bounds once per geometry/transform revision. Verify tilted, curved, ramp, scaled entity and array bounds never exclude real intersections. Preserve boundary tolerances and the room-floor rule.
2. Maintain tag-to-target and tag-to-hole indexes, plus terrain-source ownership. Avoid scanning all nodes and rebuilding subtree membership for every hole. Deduplicate candidates with multiple matching tags and retain deterministic cutter order.
3. Keep target→cutters and cutter→targets relationships. For a moving cutter, invalidate the union of its previous targets and candidates overlapping its new bounds. Otherwise a hole that moves away leaves an obsolete cut behind.
4. For a moving/resized target, query compatible cutters at its new bounds and update its old relationships. Handle deletion, tag changes, hide/show, definition changes, copy, undo, redo, and document replacement with the same dependency rules. Isolation must retain current external-cutter behavior.
5. Add a spatial grid or bounds tree only when cached-bounds/tag filtering is still costly. Query by tags and bounds; choose the index against actual density and update rate. Large spanning shapes and dense all-overlapping cutters remain expensive worst cases.
6. Rebuild only targets whose own geometry or effective cutter geometry changed. Reuse unaffected target meshes, cut lists, render buffers and batches.

Expected improvement is proportional to the affected neighborhood for sparse scenes, not a guaranteed constant cost. Initially validate every incremental result against a full `cutters` recomputation in focused tests/debug runs. Include a cutter moving between distant targets, tag changes without motion, internal/external entity holes, hidden cutters, and terrain-source exclusions.

## 3. Keep React for the interface; manage rendering separately

A server-supplied object list does not itself change reconciliation or draw-call count. We already receive a list. The useful change is a client render registry mapping stable authored/expanded IDs to geometry handles, batch slots, transforms, bounds and picking ownership.

React can own panels, tools, scene lifecycle and a few renderer roots; a renderer adapter applies dirty records to Three.js objects. This can be introduced within R3F without rewriting the whole editor. One component per object is not automatically the bottleneck: benchmark React work separately from geometry builds and GPU submission.

Prioritize existing 17.3/17.4 work:

- Instance compatible ordinary entity placements, sharing part geometry and materials. Preserve selected/hovered ownership and cut variants. Later consider compatible repetition across separate arrays as well.
- Compare spatially chunked merged geometry with Three.js batching for ordinary static shapes. Keep bodies, floors, edges, transparency and shadows compatible. Avoid one enormous batch that defeats culling and makes a tiny edit rebuild the world.
- Put transient selection/hover feedback in small overlays or per-instance attributes. Current array hover overlays provide a starting point. Do not rebuild static buffers on every hover.
- Maintain instance/batch bounds after transforms. Picking IDs, Walk surface queries, captures and disposal must survive the representation change.
- Budget buffer uploads as well as CPU mesh construction. A worker can prepare a huge mesh while its final upload still freezes the main thread. Partition updates and reuse capacity where measured useful.

Three.js documents [InstancedMesh](https://threejs.org/docs/pages/InstancedMesh.html) and [BatchedMesh](https://threejs.org/docs/pages/BatchedMesh); test the installed version and actual browser path rather than assuming a particular batching API guarantees a draw-count or frame-time result.

## 4. Geometry execution: worker first, Rust as an experiment

| Option | What it could solve | Costs and limits | Position |
|---|---|---|---|
| Existing TypeScript + Manifold in browser worker | Main-thread blocking during mesh/CSG/terrain/edge preparation | Messaging, buffer ownership, stale jobs and duplicate memory; does not inherently reduce total computation | First isolation prototype |
| Rust compiled to WASM in a browser worker | Measured expensive remaining kernels, with reusable native implementation if useful | Porting/testing, JS/WASM data conversion, packaging; existing booleans already WASM | Benchmark one kernel after profiling |
| Server geometry service, Node worker or Rust process | Shared canonical results across viewers/export; potentially stronger CPU resources | Request/queue/transfer latency, large meshes over WS, preview divergence, process lifecycle | Consider for canonical jobs or demonstrable multi-client reuse |
| All geometry on server, thin viewer | Centralized derivation and caching | Every uncached preview depends on round trips; browser still owns rendering, picking integration and GPU uploads | Do not make the default architecture yet |

WASM on the UI thread still blocks it. Rust does not remove full-scene scans, excessive invalidation, draw calls or fragment cost. Also distinguish synchronous native work in the Node event loop from a real worker/process: centralizing geometry must not block MCP, edits or persistence.

Prototype a worker using the existing shared mesh/CSG code and Manifold. [Web Workers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers) run outside the main execution thread. Send compact inputs and transferable typed-array buffers; [transferring an ArrayBuffer](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects) moves ownership and detaches the sender's buffer. Design cache ownership explicitly instead of transferring live renderer buffers accidentally.

Jobs need document generation, target identity, input signature and preview generation. Accept a result only when all still match. Keep at most bounded pending work; replace obsolete pending previews with the latest, and discard stale running results. A synchronous WASM call may not be interruptible mid-call, so cancellation must not depend on it. Start with one worker; add concurrency only if latency/memory measurements justify it.

Keep direct manipulation immediate with a transform/outline proxy and last valid mesh while affected exact cuts compute. Make any approximate preview explicit; release schedules the exact final state. Captures/export must wait for the requested canonical revision (or report failure), never silently use a stale preview. Picking/Walk need a documented policy while geometry is pending; do not mix new visual geometry with old authoritative surfaces unnoticed. Worker failure must surface an error and permit recovery; retain exact synchronous fallback for correctness where appropriate, not as a claimed responsiveness guarantee.

A Rust spike should compare end-to-end p95 input→visible result, including serialization, conversion, queueing and upload, against the worker baseline. Retain it only for a material reproducible improvement. Use existing geometry tests and fixed-scene output comparisons to protect normals, UVs, holes, floor rules and export parity.

## 5. Other opportunities worth measuring

- **Terrain dirty tiles:** recompute affected tiles from their base through all relevant ordered modifiers, not just the changed modifier. Include old/new influence extents, fade, holes and neighboring samples needed for normals. A removal or reordered set/raise/lower modifier must restore the right result. Preserve canonical resolution and current hole-preview safeguards.
- **Lazy expansion and picking:** cache definition-local parts; derive only changed placements. Use bounds to narrow candidates before exact hit meshes. Current picking already has mesh bounds/cache support; add an index only if traces show a problem. Keep small scenes cheap.
- **UI scale:** profile Outliner rows, inspector derivation, entity previews and hierarchy traversal; virtualize long visible lists if DOM/React work dominates. Subscriptions should follow the fields each panel displays.
- **Allocation pressure:** inspect GC, repeated arrays/JSON keys and mesh conversions (`number[]` ↔ typed arrays). Pool or retain buffers where ownership is clear; measure retained memory as well as allocation rate.
- **Shadows and pixels:** retain 17.5's invalidation and quality investigation. Rust cannot fix GPU fill cost. Previous castle quality probes did not justify reducing default quality; remeasure larger scenes before choosing DPR/shadow/edge tradeoffs.
- **Server release latency:** measure command resolution, synchronous journal/snapshot writing, serialization and client receipt separately. Serialize a broadcast once if worthwhile. Any deferred snapshot design must preserve write ordering, recovery and durability; do not casually debounce history to improve a chart.
- **Resource lifetime:** repeated scene switches, edits and canceled jobs must reach a memory plateau. Track geometry/material/texture counts plus worker/WASM buffers; bounded caches are part of performance.

## Experiments and decision gates

Record commit plus dirty-tree context, production/development build, browser/hardware, canvas/DPR, quality, scene composition and exact actions. Reuse phase 17's harness where compatible with the current tree; its warmed routes alone are insufficient. Use a scratch server/data folder and MCP/editor-created fixtures only. Do not inspect scene files directly.

Fixtures: small control; current real scene read-only or a supported copy; 400 ordinary instances versus equivalent arrays; sparse and dense cut-tag targets; complex curved/tilted geometry; terrain with modifiers and holes. Scale counts until the first budget failure and record that capacity rather than selecting only an easy demo.

Measure cold load/first pick, navigation, hover, repeated one-shape drag, cutter crossing old/new targets, release, undo, definition edits, remote edits and canonical capture. At least three warmed trials plus separate cold trials. Record p50/p95/p99 and worst hitches, input→preview and input→exact-result, main-thread long tasks, React/R3F work, cutter candidates/bounds/CSG counts, cache reuse, server/WS latency, buffer upload, draw calls and memory. GPU timing unavailable means unknown, not zero.

Proposed follow-up budgets, to ratify on Orlando's reference hardware:

- Retain phase 17's sustained 60 Hz target and p95 active interval ≤1.5 refresh intervals.
- Aim for visible drag feedback within 33 ms p95 and no main-thread tasks over 50 ms in warmed interactions. Measure exact-result delay separately; provisional common-edit target ≤100 ms p95, with expensive cases explicitly recorded.
- Zero geometry jobs during unchanged navigation/hover; zero CSG for metadata-only edits; unrelated targets do not rebuild during a local cutter edit.
- No worse small-scene latency, unbounded queue, resource growth, silent approximate captures or geometry parity regressions.

Suggested increments: **A** current latency/counter baseline; **B** stable identities, bounds/tag caches and incremental cut graph; **C** existing ordinary instancing/static batching; **D** worker prototype and safe job lifecycle; **E** only measured follow-ups (Rust kernel, protocol deltas, terrain tiles, persistence or GPU quality). B and C can change order based on attribution. Each increment needs an independently measurable result before proceeding.

## Progress — 2026-11-17

- Read phase 17, its thinking document and measurement history, relevant terrain checkpoint, glossary, and the source paths cited above. Recorded differences between current code, existing optimizations and proposed work.
- Created this discussion at Orlando's request. No application/scene changes, new performance measurements or claimed acceptance. Existing unrelated working-tree edits were left intact.
- Documentation-only verification: reviewed referenced source paths and checked whitespace. No test/build/browser run was needed for this proposal. New architecture terms here are proposals; add implemented terminology to the glossary when adopted.
- Next: agree a bounded follow-up implementation plan using a fresh production edit-latency baseline. Preserve phase 17's remaining acceptance and terrain-aware Walk deferral; neither is closed by this document.

### Bounded implementation — 2026-11-17

Selected three edit-path changes from §1–2. The baseline was the existing dirty working tree at `d385d71`, including ongoing cut-tag and UX work.

1. `src/web/reconcileScene.ts` and `useScene.ts` reconcile full WebSocket snapshots by node ID and JSON content. Equal records retain their identities so expansion and picking caches can reuse them. Incoming order, deletions, view and selection remain server-owned.
2. `src/shared/holes.ts` indexes eligible targets by tag for each cutter pass and caches world bounds by shape identity. Terrain-source exclusions are derived once per pass. Overlap rules, placement namespaces, deduplication and scene order are checked against the full scan.
3. `src/shared/csg.ts`, `bake.ts` and `src/web/ShapeMesh.tsx` use an ordered geometry signature for effective cutters. Metadata changes can reuse geometry, while move, shape and floor-cut inputs still invalidate it.

Synthetic CPU timings on arm64 macOS with Node 22.23.3 and Manifold WASM loaded. Values are the median of five warmed trial means after one discarded warmup. The same fixture and operation counts were used before and after.

| Operation | Before (ms) | After (ms) |
| --- | ---: | ---: |
| One cutter moves each pass, 800 targets and 200 tilted cutters, one shared tag, 32 passes per trial | 13.842 | 1.223 |
| Same workload, 40 tag groups | 4.089 | 0.182 |
| Decode alternating one-placement edits, expand and request all hit meshes, 8 two-part placements, 55 snapshots per trial | 0.367 | 0.097 |
| Same workload, 400 placements | 12.406 | 0.674 |
| Bake a cut room after renaming its cutter, 150 edits per trial | 0.376 | 0.008 |
| Bake the same room while moving its cutter, 150 edits per trial | 0.347 | 0.376 |

Baseline test suite had 631 passing tests. Afterward, all 634 passed, including tests for snapshot edits and undo, cutter scan parity and bake invalidation. Typecheck, production web build and whitespace checks passed. The production build emitted a bundle-size warning. Measurements cover isolated CPU work. Browser input-to-frame latency, real-scene performance and Orlando's visual acceptance remain open. Phase 17.3–17.5, terrain-aware Walk, and full incremental cut relationships remain separate.

### Follow-up implementation — 2026-11-17

Implemented ordinary entity instancing and the incremental cut graph. Phase 17 Progress records the browser draw-call comparison, moving-cutter CPU benchmarks, compatibility rules, checks and remaining visual acceptance. The 400-placement fixture dropped from 1,205 to 8 draw calls. Updating cut relationships for a moving cutter among 3,000 targets and 750 cutters dropped from 13.488 to 0.465 ms per update.

### Static batch and geometry worker follow-up — 2026-11-17

Implemented spatial merging and a browser worker for costly shape geometry and batch preparation. On the isolated `castle v2` copy, the fixed view dropped from 1,131 to 865 draws, and an 11-cutter edit dropped from 37.5 to 1.6 ms of main-thread geometry preparation with the worker enabled. Phase 17 Progress and the measurement file contain the conditions and remaining acceptance.

### Large-edit follow-up — 2026-11-17

Measured the first exact draw through the next paint opportunity on the scratch castle. A second worker for shape bursts and reuse of exact synchronous geometry reduced the warmed 11-cutter move from 101.2 to 71.6 ms and returning from Edit entity after a planter change from 93.8 to 72.2 ms in the final comparison. See Phase 17 Progress and the measurement file for the cache and scheduling decisions.
