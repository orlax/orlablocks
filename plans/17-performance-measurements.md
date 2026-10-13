# Editor performance measurements — 17.1

## Reproduction and scope

Use only a spare server with its own scratch `DATA_DIR`. No main scene files are read or edited. `scripts/performance-fixture.mjs <port> [small|mixed]` creates a fresh project through the existing WebSocket/MCP APIs. The mixed baseline is a **synthetic grid**, not the castle or the complete later batching acceptance fixture: 400 shapes, 58 rooms, 342 volumes, 80 sixteen-sided cylinders, no entities/holes/terrain. Small has eight shapes from the same recipe. Terrain fixtures remain in `scripts/check-16.mjs` and `scripts/terrain-fixture.ts`.

Temporary instrumentation is reproducible, but is **not installed in the shipped editor**:

1. `python3 scripts/install-performance-harness.py` adds marked temporary imports, a route adapter and an outer React Profiler.
2. Start development with `PORT=5171 DATA_DIR=/private/tmp/orlablocks-perf-dev/data npm run dev`; run `node scripts/performance-fixture.mjs 5171 mixed`.
3. Open `http://127.0.0.1:5171/?profile&quality=default`. Set stats as required and click **Run navigation baseline**. Keep the page foreground throughout. Results appear as JSON in `#performance-results`.
4. For production, run `npm run build:web && npm run build:server`, start `PORT=5172 DATA_DIR=/private/tmp/orlablocks-perf-prod/data npm start`, then create the equivalent fixture on 5172. Use `?profile` for default, shadows-off and DPR-2 comparisons; `?profile&quality=default` for the stats overhead comparison. Run these sequentially, not in background tabs.
5. Save the result JSON before reloading. Remove instrumentation with `python3 scripts/install-performance-harness.py remove`; rebuild afterwards. The installer preserves other edits and never accesses scene data; never commit the temporary imports/adapter.

Each route repeats three times. Reset editor camera: focus (0,0), yaw 45°, distance 150 m. Warm-up: 0.5 s settling plus 1 s moving, followed by about 2 s sampled. Rotation holds right yaw; pan and hover follow a ±120 CSS-pixel sine sweep at viewport center, period π seconds; zoom emits a cosine wheel delta of amplitude 3 per animation callback. Walk starts at (0,0,20), yaw 0°, first-person, moves forward and oscillates yaw ±15°. The adapter calls the real pan/hover handlers, wheel listener and Walk step/surface-ray path, but bypasses pointer acquisition/lock. This measures repeatable steady-state application work, **not native input latency or human feel**. First pick/loading/edit hitches are outside this warmed baseline.

The observer wraps the existing renderer without requesting frames, measures start-to-start editor intervals and synchronous CPU render duration, and times route input callbacks. Hover intervals are benchmark-only; hover does not become “navigation FPS” in the UI. Input cost includes fixture-driver DOM rectangle reads and excludes scheduled React work. Outer React Profiler `actualDuration` measures render work attached to commits, not commit-phase duration, and excludes the separate R3F React root. Development StrictMode/profiling results must not be treated as production timings. The idle check waits one second after settling, then counts renders for one second without a polling RAF.

## Environment (2026-10-09)

- Base commit: `65302a518ed9ec187a700b6e9f1cac06712c93d4`, plus the uncommitted 17.1 implementation and temporary harness. Pre-existing planning changes were present; no rendering optimization was applied.
- Apple M1 Max, 10 logical CPUs, 32 GiB RAM; macOS 15.7.9 (24G830); Node 22.23.3.
- Codex in-app Chromium 155.0.0.0 (UA reports Intel macOS for compatibility); canvas 1154 × 1245 CSS pixels, default renderer DPR 1. Shadow map default 2048², default quality/materials; editor overlays on. DPR sensitivity explicitly forces 2 rather than assuming a Retina default.
- The recurring ≈16.7 ms fast intervals are consistent with a 60 Hz presentation cadence. Hardware display refresh and GPU timer queries were not available through the browser tooling. The UI explicitly uses a **60 Hz reference budget**, not a claimed refresh-rate measurement. Unavailable GPU timing is not zero GPU cost.
- Castle reference is still the earlier screenshot/read-only audit: 450 expanded shapes, 767 draws, 196k triangles, 2.3 ms synchronous render CPU. It supplies **no FPS baseline** and was not mutated or copied here.

## Development baseline, stats off

Three trials per route. All times in milliseconds. Triples are trial 1 / 2 / 3. Counters include shadows.

| Route | Mean interval | Median interval | p95 interval | Mean render CPU | Mean input callback |
|---|---|---|---|---|---|
| Rotation | 24.32 / 21.55 / 25.38 | 14.0 / 13.8 / 15.6 | 60.5 / 59.7 / 98.1 | 2.39 / 2.38 / 2.49 | .08 / .09 / .10 |
| Pan | 42.13 / 42.47 / 46.10 | 39.3 / 53.8 / 39.6 | 96.6 / 97.2 / 105.4 | 2.35 / 2.40 / 2.36 | .39 / .22 / .22 |
| Zoom | 30.30 / 29.68 / 29.79 | 14.6 / 16.5 / 16.0 | 102.6 / 92.1 / 92.3 | 2.47 / 2.40 / 2.44 | .12 / .12 / .11 |
| Hover | 44.09 / 43.50 / 43.55 | 38.2 / 39.8 / 39.5 | 92.7 / 94.1 / 92.5 | 2.34 / 2.37 / 2.39 | .33 / .30 / .33 |
| Walk | 21.03 / 21.18 / 21.72 | 16.7 / 16.7 / 16.6 | 69.2 / 67.4 / 70.4 | 1.65 / 1.64 / 1.63 | .01 / .01 / .01 |

Mean draws: rotation 1065–1067, pan 1085–1086, zoom 1070–1073, hover 1088, Walk 613–615 (different camera/frustum). Final idle observation: **0 rendered frames in one second**.

## Development attribution, stats on, outer React Profiler enabled

This is an attribution run, **not a controlled stats-on/off comparison**: enabling the React Profiler adds instrumentation. The production comparison below keeps its harness constant.

- Rotation: mean interval 29.62–30.66 ms, render CPU 2.28–2.32 ms; outer React render work per commit 45.65–47.99 ms mean, 121.9–126.5 ms p95, 31–32 commits per route.
- Pan: mean interval 43.59–46.38 ms, render CPU 2.26–2.34 ms; outer React work 49.33–53.61 ms mean, 121.4–122.7 ms p95, 33–35 commits.
- Zoom: mean interval 27.29–27.68 ms; outer React work 38.49–47.34 ms mean, 96.8–121.3 ms p95.
- Hover: mean interval 42.10–43.54 ms; outer React work 47.00–50.10 ms mean, 95.0–98.9 ms p95.
- Walk: mean interval 20.55–20.76 ms, median 16.6–16.7 ms, p95 65.5–68.0 ms, CPU 1.54–1.56 ms; outer React work 25.46–28.47 ms mean, 69.2–74.3 ms p95. Final idle observation with stats on: **0 rendered frames in one second**.

These measurements establish substantial development React render work, while synchronous pointer callbacks and render submission are much smaller. They do not partition every millisecond: browser scheduling, separate R3F work, layout and GPU completion remain outside those attributed buckets.

## Production baseline, stats off

| Route | Mean interval, trials 1 / 2 / 3 | Median, trials 1 / 2 / 3 | p95, trials 1 / 2 / 3 | Mean CPU range |
|---|---|---|---|---|
| Rotation | 16.65 / 16.67 / 16.67 | 16.7 / 16.7 / 16.7 | 18.9 / 19.0 / 18.7 | 2.41–2.55 |
| Pan | 16.63 / 16.68 / 16.66 | 16.4 / 16.6 / 16.6 | 18.0 / 17.8 / 17.7 | 2.22–2.27 |
| Zoom | 16.67 / 16.67 / 16.67 | 16.7 / 16.7 / 16.6 | 18.7 / 17.8 / 18.7 | 2.41–2.53 |
| Hover | 16.65 / 16.70 / 16.63 | 16.5 / 16.5 / 16.4 | 18.4 / 18.2 / 18.0 | 2.27–2.29 |
| Walk | 16.67 / 16.67 / 16.67 | 16.7 / 16.7 / 16.7 | 17.7 / 17.7 / 17.6 | 1.65–1.83 |

Production input callback means were .08–.09 ms rotation, .17–.25 pan, .10–.11 zoom, .22 hover and .02 Walk. These routes meet the synthetic 60 Hz target. This does not assert castle performance or human acceptance.

### Temporary quality sensitivity (production, stats off)

Three repeats each. Disabling shadows retained ≈16.7 ms mean pacing: rotation p95 19.0–19.2, pan 16.9–17.5, zoom 18.2–18.5, hover 17.1–17.8 and Walk 17.6–18.6 ms. CPU fell to 1.97–2.01, 1.64–1.71, 1.82–1.94, 1.63–1.69 and 1.22–1.41 ms respectively. It reduces submission cost without improving the already refresh-limited average on this fixture.

Forced DPR 2 retained ≈16.7 ms pacing in the rotation, pan and zoom routes (p95 19.1, 18.0–18.5 and 17.7–18.5 ms respectively). This synthetic fixture does not justify a shipped lower-quality default. The harness restores original settings at completion; no quality controls were added to the product.

## Implementation priorities and limits

1. Continue with 17.2. Measured development outer React work is the strongest identified cost; contain cursor/stats updates and stabilize derivation inputs, then repeat the exact production routes to avoid trading development gains for production regressions. Pointer callbacks themselves were sub-millisecond here; a spatial index is not justified by these numbers.
2. Keep ordinary instancing and static batching as 17.3/17.4 experiments. The synthetic scene has >1,000 draws but still sustains ~60 FPS in production. Draw count alone does not prove a bottleneck, and castle/reference-browser measurements remain needed before prioritizing expensive changes.
3. Keep shadow caching/quality in 17.5. This run measured modest shadow submission savings, not a frame-rate improvement. GPU completion time remains unmeasured.
4. Still open: actual castle/native Chrome trace, detailed separate R3F derivation/commit and Walk-ray attribution, first-pick/edit-release/undo latency, the eight-shape control, full repetition/multipart/holes/terrain benchmark matrix and the full §8 regression checklist. Those results are not silently inferred from this grid. Orlando's reference-display smoothness and visual acceptance remain separate.

Forced DPR 2 hover: mean 16.69 / 16.65 / 16.66 ms, medians 16.7 / 16.6 / 16.6, p95 18.2 / 19.2 / 18.0; Walk: mean 16.67 / 16.67 / 16.66, medians 16.7, p95 17.0 / 17.5 / 17.2. Production stats-off matrix ended with **0 renders during the one-second idle check**.

## Controlled production stats-on comparison

Same production bundle/harness, default quality, three repeats. Mean intervals remained 16.60–16.73 ms. Per-route p95 triples: rotation 19.4 / 18.8 / 19.3 ms; pan 18.8 / 20.0 / 19.1; zoom 17.4 / 18.1 / 17.4; hover 19.1 / 18.7 / 18.6; Walk 17.2 / 18.9 / 17.3. Medians were 16.7 for rotation/zoom, 17.1 / 17.4 / 17.3 for pan, 17.3 / 16.9 / 17.0 for hover, and 16.7 / 16.6 / 16.7 for Walk. The stats overlay adds some pan/hover tail cost (~1–2 ms here), but no sustained FPS loss on this fixture. Final stats-on idle count: **0 frames in one second**.

The final source additionally resets on input-release epochs (including a short pause with no intervening rendered frame), excludes the entire capture preparation/queue/render span, and wraps the readout on narrow views. Those boundary changes have focused tests; the full browser matrix predates those final boundary refinements. Capture/background integration and native-input acceptance remain open. Work was wrapped at Orlando's explicit request to finish within the remaining usage budget.

## Castle baseline — live project (2026-10-09)

Orlando explicitly authorized starting his stopped server and checking the actual castle. These are read-only geometry measurements of **Adventure in Henders Castle ▸ castle v2**, not the synthetic fixture. No scene files were accessed directly and no fixture, geometry, library or shot edits were made on the main server. Navigation/view reports use the normal editor path. The original history remained `Rename group_28`, with no redo. No 17.2 optimization was implemented.

Same base commit/hardware/browser as above, plus the uncommitted 17.1 work. Canvas **1822 × 1561 CSS pixels**, renderer DPR **1**, default shadows/materials, overlays/cursor enabled, outliner and the 56-entity panel open. 450 expanded shapes; 13 rooms, 83 volumes, 13 holes, 13 ramps, 6 notes, 48 instances, 20 arrays (113 items), 34 groups. Starting editor camera: focus **(5.45, −61.7)**, yaw **135.46°**, distance **276.86 m**. This camera differs from the original screenshot; its draws must not be compared as the identical frame. Walk starts at the center-ray hit **(8.154625, 2.7, −64.448406)**, yaw 0°, first person; the relatively empty Walk frustum gives about 70 draws. It is a steady-state movement/look test, not a full castle traversal acceptance test.

Reproduce after explicit authorization for main-server read-only profiling: install the harness, open `http://127.0.0.1:5170/?profile&castle&quality=default`, and run the baseline. `castle` explicitly permits profiling on 5170, takes the current camera as the route reference and restores it after each trial. It does not enable the fixture script on 5170. Without `castle`, synthetic routes retain their existing fixed camera and main-port guard. Run the same source in development and production, loading the configured `.env` for both; stop one before starting the other to respect the data lock. Omit `quality` for default/shadows-off/DPR-2 trials, or specify `quality=no-shadows` / `quality=dpr2`. Remove the adapter and rebuild when finished. Future comparisons must restore the camera, viewport and panel conditions above.

All routes still use the documented warm-up, sample window and three trials. These are rendered-frame intervals; demand rendering can produce short bursts between longer stalls, so a low median does not establish smoothness. The outer React Profiler runs in development only; production's normal React build provides no commit-duration samples. The later attribution run adds lightweight timers around `cutters`, `expandNodes`, `expandShapes`, `splitInstanced` and the actual Walk `floorAt` path. Timed derivation calls are not all rendered frames, and their means must not be added to average render CPU time as if their sample populations matched. No browser trace or GPU completion timing is claimed.

### Development, outer React Profiler enabled

Triples are trial 1 / 2 / 3; milliseconds. Stats-on was measured first, stats-off second with the same harness.

| Route | Stats on mean interval | Stats on p95 | Stats off mean interval | Stats off p95 |
|---|---|---|---|---|
| Rotation | 85.38 / 87.53 / 87.04 | 215.6 / 212.7 / 214.3 | 82.30 / 83.67 / 79.90 | 200.6 / 201.8 / 199.3 |
| Pan | 83.75 / 83.81 / 84.06 | 214.1 / 214.0 / 214.6 | 79.96 / 77.99 / 84.38 | 200.9 / 198.2 / 200.1 |
| Zoom | 83.85 / 84.26 / 83.63 | 213.1 / 212.3 / 213.7 | 78.90 / 82.00 / 80.76 | 186.9 / 188.0 / 185.7 |
| Hover | 83.74 / 83.94 / 84.00 | 212.9 / 212.2 / 213.4 | 79.18 / 76.29 / 79.39 | 186.0 / 184.4 / 185.7 |
| Walk | 40.82 / 47.07 / 49.53 | 181.1 / 164.0 / 162.8 | 46.24 / 49.66 / 47.72 | 214.4 / 217.1 / 215.4 |

Stats-off median triples: rotation 34.4 / 34.7 / 37.5; pan 33.4 / 34.5 / 126.3; zoom 34.3 / 125.8 / 125.4; hover 29.0 / 28.6 / 30.7; Walk 16.7 / 16.7 / 16.7. Stats-on medians: rotation 36.6 / 127.8 / 127.1; pan 35.3 / 35.2 / 35.5; zoom 33.1 / 125.0 / 33.4; hover 35.8 / 36.1 / 33.5; Walk 16.7 / 16.7 / 17.7.

Stats-on synchronous render means were 1.80–2.00 ms for editor routes and .53–.55 ms for Walk. Outer React render work averaged 135–142 ms/commit for editor routes; stats-off averaged 128–135 ms. This profiled development run reproduces severe sluggishness, but is not an uninstrumented development benchmark. Both stats settings ended with **0 renders in the one-second idle observation**.

### Production, controlled stats comparison

| Route | Stats off mean interval | Stats off median | Stats off p95 | Stats on mean interval | Stats on p95 |
|---|---|---|---|---|---|
| Rotation | 24.79 / 23.99 / 24.49 | 14.1 / 12.8 / 14.4 | 74.7 / 75.1 / 74.7 | 30.13 / 30.20 / 29.55 | 74.8 / 74.4 / 74.5 |
| Pan | 39.79 / 39.37 / 39.71 | 7.2 / 10.4 / 6.9 | 73.6 / 73.8 / 73.5 | 39.98 / 39.87 / 39.74 | 73.7 / 73.8 / 73.6 |
| Zoom | 24.39 / 24.40 / 24.47 | 16.6 / 16.6 / 16.6 | 73.7 / 73.9 / 73.7 | 29.28 / 29.56 / 28.04 | 73.8 / 73.5 / 73.3 |
| Hover | 39.85 / 40.17 / 39.99 | 7.4 / 9.3 / 7.3 | 73.8 / 74.5 / 74.1 | 40.16 / 39.75 / 40.03 | 74.7 / 73.4 / 74.0 |
| Walk | 20.90 / 20.24 / 20.77 | 16.7 / 16.7 / 16.7 | 83.6 / 83.5 / 84.2 | 21.82 / 21.28 / 21.63 | 72.2 / 76.1 / 74.2 |

Stats-on median triples: rotation 8.6 / 11.6 / 8.0; pan 7.5 / 7.5 / 7.6; zoom 8.7 / 7.9 / 7.2; hover 9.9 / 7.3 / 7.6; Walk 16.6 / 16.6 / 16.7. Stats-off render CPU means: rotation 1.81–1.89, pan 1.88–1.90, zoom 1.93–1.98, hover 1.88–1.93, Walk .61–.62 ms. Mean input callbacks were .09–.10, .25–.28, .11, .33–.36 and .01 ms respectively. Mean draws were 675–676 / 729 / 728 / 734 / 70. Both stats settings ended with **0 idle renders**.

The castle fails the sustained 60 Hz/p95 target in production. Stats additionally worsen rotation and zoom means here, consistent with extra React updates triggering expensive derivation. This is materially different from the synthetic grid's refresh-limited results.

### Attribution and sensitivity

Collapsing only the Entities panel, with stats off, gave means of 24.30–24.49 ms rotation, 38.51–38.81 pan, 24.13–24.29 zoom, 38.77–38.90 hover and 19.44–19.67 Walk. Editor p95 remained 71.0–72.8 ms. This rejects the open panel as the dominant cause. It was restored after the control.

Direct production instrumentation, default quality/stats off, identified **`cutters()` at 54.40–55.20 ms per invocation on editor routes**, 19–25 measured invocations per trial. During Walk, it cost **62.01 / 62.05 / 62.44 ms**, eight measured calls per trial. Expansion means were around .01–.05 ms in the sampled Walk runs, `splitInstanced` .16–.21 ms, and actual Walk floor rays **.317 / .319 / .311 ms** (p95 .4 ms). Default editor pacing repeated the earlier baseline: rotation 24.49–24.61 ms mean, pan 39.48–39.98, zoom 24.10–24.90, hover 39.40–39.95; Walk 20.53–20.60. Thus the measurement wrappers did not remove the observed stalls.

Code explains the direct timing: `Viewport` recreates expanded cutter inputs and calls `cutters()` on React updates; `cutters()` repeatedly calculates target bounds for holes in scope. The castle's scoped holes/complex geometry exercise work the no-hole grid never covered. The dominant measured cost is repeated cutter derivation; the precise split within `cutters()` remains a follow-up measurement. Do not claim that every hole operation or all geometry creation is expensive from this alone.

Same instrumented production bundle, stats off, three trials each:

| Route | Shadows off mean | Shadows off p95 | DPR 2 mean | DPR 2 p95 |
|---|---|---|---|---|
| Rotation | 24.77 / 24.77 / 24.30 | 74.5 / 74.5 / 74.2 | 24.37 / 23.77 / 24.39 | 74.4 / 74.9 / 74.6 |
| Pan | 39.33 / 39.28 / 39.36 | 73.0 / 73.1 / 73.2 | 39.70 / 40.00 / 39.74 | 73.4 / 73.7 / 73.4 |
| Zoom | 24.38 / 24.30 / 24.30 | 73.6 / 73.4 / 73.9 | 23.70 / 24.48 / 25.29 | 74.0 / 73.6 / 73.6 |
| Hover | 39.39 / 39.35 / 39.32 | 73.2 / 73.0 / 72.9 | 39.67 / 39.86 / 39.75 | 73.3 / 73.5 / 73.3 |
| Walk | 20.96 / 21.02 / 20.96 | 83.7 / 83.9 / 84.0 | 19.80 / 21.04 / 20.81 | 79.8 / 83.0 / 83.0 |

Shadows-off render CPU means were 1.60–1.70 ms for editor routes and .48–.49 for Walk. DPR-2 means were 1.97–2.03 ms / .65–.67 respectively. Neither changes the main pacing bottleneck. Original quality was restored; final idle count was **0**. GPU completion remains unmeasured; these results justify no lower-quality default.

### Timing integration and remaining acceptance

- With stats enabled, real castle rotation displayed 32 FPS / 31.2 ms interval, cleared to `Navigation idle / warming up` after release, and resumed at 32 FPS / 31.0 ms without including the idle pause.
- An actual 800 × 600 offscreen castle capture took **332.3 ms**. The observer recorded capture epochs 0 → 1 → 2; the first sample in each epoch had `navigation: null`, epoch 1 was ineligible and epoch 2 eligible. Afterwards the readout resumed at 33 FPS / 30.0 ms over 18 new samples and returned to idle. A second check with a 345.2 ms capture repeated the resets. The capture span did not enter the navigation window. No saved shot was created.
- Background integration remains **unverified**: hiding the in-app browser pane and opening a second tab both left the castle document's `visibilityState` as `visible`, with no visibility-change events. This tooling does not simulate a real background tab in this session. Unit coverage is not browser acceptance.
- Native pointer acquisition/lock and human feel, first-pick/edit-release latency, small/richer fixture controls, full §8 editing/capture parity and Orlando's visual/smoothness acceptance remain open. The warmed adapter measurements do not close those checks.
- **17.2 priority:** stabilize cutter inputs and reuse cutter relationships across cursor/camera/stats updates, contain update propagation, then repeat these castle routes. Measure actual cutter-input changes during edits and undo so caching cannot leave stale cuts. Keep 17.3–17.5 in the existing order; current evidence favors no quality change.

## 17.2 — Reuse scene derivation and contain readouts (2026-10-09)

Source: base `65302a5` plus the existing 17.1 work and this uncommitted 17.2 increment. Same machine, OS, Node and in-app Chromium as 17.1. No quality/default shadow/DPR changes, renderer batching or MCP contract changes. The main castle geometry/library/history were not edited. Scratch editing uses `/private/tmp/orlablocks-17-2/data` on 5171; fixtures use MCP/editor operations exclusively.

Implementation: memoize the authored-shape/preview/follow/visibility/expansion/cutter/terrain-node pipeline by its real inputs, including the existing `definitionsVersion` signal. Preserve stable `Boxes`/array-instancing props across camera/hover updates; memoize `Boxes` and individual `ShapeMesh` components so highlights update their intended shapes. Local cursor/stats stores subscribe only their readouts; a resting cursor still reaches the normal view report. Pan bypasses all surface/hover picking and publishes its final cursor on release. Passive hover reuses its cursor ray hit when selectable, falling back behind locked geometry; note/line priority and fresh click/drawing queries remain intact. Stationary pointers re-pick after geometry/visibility/undo changes.

No spatial index, lazy hit-mesh rewrite or pointer-event queue was added: measured callbacks were already sub-millisecond, and queuing authoring events adds ordering/final-position risks without evidence of benefit. Camera reports still update App; development render work outside the contained scene remains a later profiling candidate.

### Production castle comparison

To avoid interrupting Orlando's existing server, `scripts/performance-live-preview.mjs` serves the production web bundle on 5173 and forwards only `tab`, `set_view` and `rendered` messages to the existing editor WebSocket on 5170. It rejects all edit/selection/library/shot messages. This measures a **production frontend with the existing development backend**, not a production server; backend performance is outside the navigation optimization. No main data files were accessed. Use the original direct-server procedure when server behavior is relevant.

Reproduce: install the harness, build the web bundle, run the preview script, open `http://127.0.0.1:5173/?profile&castle&reference=castle-17.1&quality=default`, and set the canvas to **1822 × 1561 CSS pixels**, DPR **1**. The new explicit reference option uses focus (5.45, −61.7), yaw 135.46°, distance 276.86 m, with the original center-ray Walk start (8.154625, 2.7, −64.448406). It restores the pre-profile camera after each trial. Original 56-entity/outliner panels remain open, 450 expanded shapes, default quality and overlays. Same route adapter, warm-up, sample windows and three trials per route as 17.1. The browser viewport includes a 28-pixel outer strip; verify the **canvas**, not only requested viewport dimensions.

With stats off, exact-viewport route means were 16.66–16.68 ms. Rotation p95: 18.0 / 18.1 / 17.9; pan: 17.3 / 17.4 / 17.6; zoom: 17.5 / 17.4 / 17.3; Walk: 21.4 / 18.3 / 22.8 ms. Retained hover p95 for trials 1–2: 16.8 / 17.1 ms (trial 3 ran but its value was overwritten when the next run began). All retained medians were 16.6–16.7 ms. Final idle observation: **0 frames in one second**. Draw means: rotation ~674, pan 729, zoom ~726, hover 734, Walk ~70; comparable to 17.1's 675–676 / 729 / 728 / 734 / 70, without claiming an exact draw improvement for routes whose motion is sampled at different frame cadences.

The direct derivation timers recorded **zero calls to `cutters`, `expandNodes`, `expandShapes` or `splitInstanced` during warmed route sampling**, including stats-enabled navigation. This replaces the previous castle's 54–62 ms repeated cutter invocations. Walk floor rays remain ~.36–.40 ms mean in stats-off trials, p95 .6–.7 ms; no surface-query optimization is claimed. Render CPU was ~2.0–2.5 ms for editor routes, .78–.86 ms Walk. Some submission measurements are higher than 17.1 despite much better frame pacing; these are separate populations/cadences and not evidence of a renderer speedup.

Stats enabled, same production bundle/route/canvas, three trials each (milliseconds):

| Route | Mean interval | Median | p95 interval |
|---|---|---|---|
| Rotation | 16.66 / 16.67 / 16.66 | 16.7 / 16.7 / 16.7 | 18.5 / 18.0 / 17.9 |
| Pan | 16.67 / 16.67 / 16.67 | 16.7 / 16.7 / 16.7 | 17.4 / 17.4 / 17.7 |
| Zoom | 16.67 / 16.66 / 16.67 | 16.7 / 16.7 / 16.7 | 18.6 / 17.6 / 17.3 |
| Hover | 16.67 / 16.67 / 16.67 | 16.7 / 16.7 / 16.7 | 16.8 / 16.8 / 16.8 |
| Walk | 16.66 / 16.67 / 16.67 | 16.7 / 16.7 / 16.7 | 20.2 / 21.8 / 18.9 |

The stats button title and rendered readout confirmed stats were enabled throughout this second run. Its metadata's `stats:false` was captured before the first post-toggle frame published the readout; do not infer disabled instrumentation from that initial empty DOM. Stats-on idle count: **0**. All warmed routes meet the existing 60 Hz reference/p95 target on this setup. This is adapter timing, not native input latency or Orlando's hands-on acceptance. Relative to the 17.1 stats-on castle baseline, pan/hover means fall from ~40 ms to ~16.7 ms, rotation/zoom from ~28–30 ms to ~16.7 ms, and the ~74 ms editor p95 stalls disappear. The existing visual quality and authored scene remain intact.

Production timing-boundary check: moving/resumed readouts both **60 FPS / 16.7 ms**, idle clears to `Navigation idle / warming up`. An actual 800 × 600 offscreen capture took **280.2 ms**; capture epochs 0/1/2 began with `navigation:null`, epoch 1 ineligible, and post-capture navigation resumed at 60 FPS / 16.6 ms using 31 new samples. No saved main-project shot was created. Real background-tab visibility remains the previously documented tooling limitation.

### Development attribution and remaining cost

Development outer-Profiler run of the 400-shape grid, stats on, canvas 1044 × 1256, DPR 1: three-trial hover means **16.67 / 16.72 / 16.72 ms**, p95 **22.5 / 22.7 / 22.8**, outer React render work only **.12–.14 ms/commit** versus ~47–50 ms in 17.1's attribution run. Pan input means **.08–.09 ms**, pan intervals **24.79 / 24.58 / 24.71**, p95 **59.0 / 59.7 / 60.4**. Rotation means 21.61 / 25.51 / 27.98, zoom 24.72 / 25.00 / 25.20 and Walk 21.40 / 21.13 / 20.92 ms. The canvas differs from 17.1's synthetic run, so these are supporting attribution results rather than a controlled frame-rate ratio. Cutter/expansion/instancing calls during sampling: zero. Idle renders: zero.

Exploratory development castle run at the user's current camera (17.72, −23.01), yaw 161.88°, distance 116.1 m, canvas 1280 × 692: hover means **16.95 / 16.81 / 16.95 ms**, p95 **17.0 / 17.3 / 16.8**, outer React **.09–.11 ms/commit**. Camera routes still show substantial development App render work (~36–51 ms/commit) at ~24–27 ms mean intervals, occasional >130 ms tails. This run intentionally is not used as the same-camera castle comparison. Production results above establish the controlled improvement. No browser trace, GPU completion timer or React commit-phase measurement is claimed.

### Small-scene control and editing regressions

Production eight-shape control on 5172 (`performance-fixture.mjs 5172 small`), stats on, canvas **1280 × 692**, DPR 1/default quality, fixed synthetic route: three-trial means 16.65–16.69 ms, all medians 16.7 ms. p95 triples: rotation **16.8 / 16.9 / 17.0**, pan **18.7 / 18.7 / 18.8**, zoom **18.7 / 18.7 / 18.8**, hover **18.7 / 18.7 / 18.7**, Walk **18.7 / 18.9 / 18.7**. Idle frames: **0**. This adds the previously missing small-scene control; it is not a retrospective before/after small-scene measurement.

Scratch fixture reproduction: `node scripts/check-17-interactions.mjs 5171 setup`; inspect with the temporary harness's **Inspect derived scene** button. Includes a room/floor hole, locked and hidden volumes, curved free-form/ramp, a scaled/tilted multipart ordinary instance and an array. The helper's subsequent `move-hole`, `undo`, `redo`, `definition`, `definition-undo`, `interaction-scene` and `capture <path>` actions use supported editor/MCP operations. `definition` is intended while the scratch human entity is open. The helper marks its scripted WebSocket invisible so it cannot steal render jobs from the real browser.

Verified on the final development source with native browser input unless otherwise stated:

- Select an ordinary volume, drag its body to a 0.5 m snapped position, undo; draw a volume on its y=3 m top. After drawing, the cursor reports the new top at 3.2 m; undo under the stationary pointer immediately reports the original 3 m surface. Native Hand pan updates its final cursor without editing history. A Space-modified empty-ground press preserves selection and returns to Select, exercising Space-hand dispatch; simultaneous native held-Space movement was not established by the serialized input tooling.
- Native marquee resolves group/ordinary-instance ownership and omits locked shapes; a native click on the locked volume cannot select it. Hidden volume is absent from drawn inputs. Isolation reduces the fixture to the room and hole and retains the cut relationship; leaving restores the scene.
- Native y-gizmo move snaps to y=.85 m; undo restores it. Native curved free-form point drag and curved-ramp station drag commit one reshape each; undo/redo update the editor. Subsequent undo restores the original canonical capture byte-for-byte.
- Via editor API, moving the hole out of range changes the cut map from `box_1 ← box_2` to empty. Its capture differs; undo restores both the cut map and the exact original PNG. Initial diagnostic center pick took **6.1 ms**, first pick after moving the hole **8.2 ms**, and after returning from definition editing **4.1 ms**; warmed checks were 0–.1 ms. These are individual scratch observations, not castle first-pick/p95 claims and not justification for a spatial index.
- Edit entity mode: changing the human torso from .6 to 1 m reaches all four array parts and the scaled/tilted ordinary instance (1.2 → 2 m), then entity undo restores the original geometry. Selection/isolation, surface drawing/body/gizmo edits and definition edit/undo together restore the same canonical plan PNG, SHA-1 `a012f2e3949f378933c4dcedda30367bbb2ae99f`. Captures use canonical geometry despite local camera/selection/edit overlays.
- Existing `node scripts/check-16.mjs 5171 render` passes terrain authoring/reorder/undo and canonical plan/sheet/node captures, plus its native-terrain/GLB export checks. Selecting a modifier and hiding Show modifiers leaves the canonical plan byte-identical (`check-16.mjs 5171 capture`). Native terrain-source y-gizmo drag commits at .95 m; undo again restores the byte-identical terrain capture. Terrain-aware walking remains deferred.

Curved-ramp point editing exposed a pre-existing `sampleEdge3` bug: flat `{x,z}` ramp handles were treated as `{x,y,z}`, producing NaN editing overlays. The sampler now accepts ramp handles with zero vertical offset; a focused regression test verifies finite samples and preserves explicit line-handle y offsets. Native station drag committed one reshape, undo restored it, and no new console errors appeared. A capture taken during the final development/HMR session briefly showed missing-definition placeholders; after a clean editor reload, the canonical PNG again matched SHA-1 `a012f2e3949f378933c4dcedda30367bbb2ae99f`. Hot-reload definition lifecycle is not claimed as covered by the production navigation runs.

Removed all temporary application imports, wrappers, adapter and outer Profiler before final checks. **577 tests / 47 files pass**, typecheck and production web build pass; only existing manifold externalization/chunk-size warnings remain. Application diff whitespace checks pass. Scratch servers/production-preview listener are stopped afterwards; the existing main development server remains available.

Remaining limitations: Orlando's own smoothness/visual acceptance, native pointer-lock/full castle traversal, real background-tab behavior, detailed browser/GPU traces, a full first-edit latency distribution and repeated resource-count audits are not claimed. The broader renderer batching/culling/material/resource matrix remains required for 17.3–17.5. The measured 17.2 exit—lower interaction overhead with tested edit/capture invalidation—is achieved without changing quality or authored data.
