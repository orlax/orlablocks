import type { EntityMeta } from "../shared/library";
import { MAX_MODEL_SHEET, MAX_RECHECKED_SHOTS, type RenderJob, type RenderRequest, type RenderResult, type SceneNode, type ShotRecord, type ShotView, type View } from "../shared/scene.types";
import { SceneError } from "./scene";

/**
 * `render_view`'s go-between (plan 09 §6): the renderer is the editor in a browser, so the server asks one of the
 * connected tabs to render and waits for its answer. It asks the tab that had focus last among the ones on screen
 * (a tab in the background may not draw), else the last one that had focus at all.
 */

/** How long a render may take before the agent is told it failed. */
export const RENDER_TIMEOUT_MS = 20_000;

export const NO_EDITOR =
  "render_view needs the editor open in a browser, and there's none connected: ask the human to open the editor (http://127.0.0.1:5170 by default).";

/** The views that have a single camera, so their image can be kept as a shot. */
const SAVABLE = new Set(["node", "eye", "shot"]);

/**
 * Checks a render request against the open document, and fills in what only the server knows: where the human is
 * walking (`from: "human"`) and a stored shot's camera. Throws a SceneError saying what's missing.
 */
export function prepareRender(
  request: RenderRequest,
  doc: {
    nodes: SceneNode[];
    view: View;
    shot: (id: string) => ShotRecord | undefined;
    /** The document's shots (with their URLs) and its history step now, for re-checking (09.4). */
    shots?: ShotView[];
    seq?: number;
    /** The project's entities, for model sheets (09.4). */
    entities?: EntityMeta[];
  },
): RenderJob {
  const failure = "Nothing was rendered.";
  const fail = (why: string): never => {
    throw new SceneError(`${failure}\n${why}`);
  };
  const ids = new Set(doc.nodes.map((n) => n.id));
  // A model sheet's ids are entities', checked below.
  const unknown = request.view === "entities" ? [] : (request.ids ?? []).filter((id) => !ids.has(id));
  if (unknown.length > 0) fail(`ids: no node ${unknown.join(", ")} in the open ${doc.nodes.length === 0 ? "document (it's empty)" : "document"}.`);
  const hidden = (request.hide ?? []).filter((id) => !ids.has(id));
  if (hidden.length > 0) fail(`hide: no node ${hidden.join(", ")} in the open document.`);
  if ((request.hide || request.clip !== undefined) && (request.view === "shots" || request.view === "entities")) {
    fail(`hide and clip apply to views of the document; a ${request.view} view shows ${request.view === "shots" ? "shots as taken and now" : "entities"}.`);
  }
  if (request.save && !SAVABLE.has(request.view)) fail(`save: only a node, eye or shot view can be kept as a shot (it has one camera); this is a ${request.view}.`);
  const job: RenderJob = { ...request };
  switch (request.view) {
    case "node":
      if (!request.ids) fail("A node view needs ids: what to frame.");
      break;
    case "eye":
      if (!request.from) fail('An eye view needs from: a point {x, y?, z} (the feet; y from the floor there when left out), or "human" for where the human is walking.');
      if (request.from === "human") {
        if (!doc.view.walking) fail('from: "human": the human isn\'t walking right now (view.walking is only there while they use the Walk tool).');
        job.human = doc.view.walking;
      }
      if (typeof request.at === "string" && !ids.has(request.at)) fail(`at: no node ${request.at}.`);
      break;
    case "walk":
      if (!request.path) fail("A walk view needs a path: a line or ramp ID, or at least 2 points.");
      if (typeof request.path === "string") {
        const node = doc.nodes.find((n) => n.id === request.path);
        if (!node) fail(`path: no node ${request.path}.`);
        if (node!.type !== "line" && node!.type !== "ramp") fail(`path: ${request.path} is a ${node!.type}; a walk follows a line or a ramp.`);
      }
      break;
    case "shot": {
      if (!request.shot) fail("A shot view needs shot: a shot ID (see get_shots).");
      const record = doc.shot(request.shot!);
      if (!record) fail(`shot: no shot ${request.shot} in the open document (see get_shots).`);
      job.shotCamera = { camera: record!.camera, width: record!.width, height: record!.height };
      break;
    }
    case "shots": {
      // The captioned shots taken before the last step (or the ones asked for), the most recent ones if there are more.
      const all = doc.shots ?? [];
      const seq = doc.seq ?? 0;
      let chosen: ShotView[];
      if (request.shots) {
        const missing = request.shots.filter((id) => !all.some((s) => s.id === id));
        if (missing.length > 0) fail(`shots: no shot ${missing.join(", ")} in the open document (see get_shots).`);
        chosen = all.filter((s) => request.shots!.includes(s.id));
      } else chosen = all.filter((s) => s.caption && s.seq < seq).slice(-MAX_RECHECKED_SHOTS);
      job.pairs = chosen.map((s) => ({
        id: s.id,
        ...(s.caption ? { caption: s.caption } : {}),
        url: s.url,
        camera: s.camera,
        width: s.width,
        height: s.height,
        since: seq - s.seq,
      }));
      break;
    }
    case "entities": {
      const all = doc.entities ?? [];
      const missing = (request.ids ?? []).filter((id) => !all.some((e) => e.id === id));
      if (missing.length > 0) fail(`ids: no entity ${missing.join(", ")} in the project library (get_library lists them).`);
      if ((request.ids?.length ?? 0) > MAX_MODEL_SHEET) fail(`ids: at most ${MAX_MODEL_SHEET} entities in one model sheet.`);
      const chosen = request.ids ? all.filter((e) => request.ids!.includes(e.id)) : all.slice(0, MAX_MODEL_SHEET);
      if (chosen.length === 0) fail("The project library has no entities yet.");
      job.entities = chosen.map((e) => ({ id: e.id, name: e.name, ...(e.tags ? { tags: e.tags } : {}) }));
      break;
    }
  }
  return job;
}

/** A connected tab, as the broker sees it: how to send it a job. */
export type RenderTab = { send: (requestId: number, job: RenderJob) => void };

export function createRenderBroker(timeoutMs = RENDER_TIMEOUT_MS) {
  // Each tab's state: whether it's on screen, and when it last had focus (or connected).
  const tabs = new Map<RenderTab, { visible: boolean; focusedAt: number }>();
  const pending = new Map<number, { tab: RenderTab; resolve: (r: RenderResult) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let nextId = 1;
  let clock = 0;
  // A counter, not the time: two events in the same millisecond still keep their order.
  const tick = () => ++clock;

  const settle = (requestId: number) => {
    const p = pending.get(requestId);
    if (!p) return null;
    clearTimeout(p.timer);
    pending.delete(requestId);
    return p;
  };

  return {
    /** A tab connected. It counts as the most recently focused until another is. */
    add(tab: RenderTab): void {
      tabs.set(tab, { visible: true, focusedAt: tick() });
    },

    /** A tab left: its unfinished renders fail. */
    remove(tab: RenderTab): void {
      tabs.delete(tab);
      for (const [id, p] of pending) {
        if (p.tab !== tab) continue;
        settle(id);
        p.reject(new SceneError("The editor tab closed before the render finished. Try again."));
      }
    },

    /** A tab says whether it's on screen, and whether it has focus now. */
    report(tab: RenderTab, state: { visible: boolean; focused: boolean }): void {
      const t = tabs.get(tab);
      if (!t) return;
      t.visible = state.visible;
      if (state.focused) t.focusedAt = tick();
    },

    /** The tab a render goes to, or null when none is connected. */
    pick(): RenderTab | null {
      const all = [...tabs.entries()];
      if (all.length === 0) return null;
      const shown = all.filter(([, t]) => t.visible);
      const from = shown.length > 0 ? shown : all;
      return from.sort((a, b) => b[1].focusedAt - a[1].focusedAt)[0][0];
    },

    /** Asks a tab to render `job`; resolves with its answer, or fails when none is connected, on its error, or on time. */
    request(job: RenderJob): Promise<RenderResult> {
      const tab = this.pick();
      if (!tab) return Promise.reject(new SceneError(NO_EDITOR));
      const requestId = nextId++;
      return new Promise<RenderResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          settle(requestId);
          reject(
            new SceneError(
              `The editor didn't answer in ${Math.round(timeoutMs / 1000)} s. It renders in the browser: ask the human to check the editor tab is open (and not frozen), then try again.`,
            ),
          );
        }, timeoutMs);
        timer.unref?.();
        pending.set(requestId, { tab, resolve, reject, timer });
        tab.send(requestId, job);
      });
    },

    /** A tab answered. An answer to a request that's gone (it timed out) is dropped. */
    answer(tab: RenderTab, requestId: number, answer: { result?: RenderResult; error?: string }): void {
      const p = pending.get(requestId);
      if (!p || p.tab !== tab) return;
      settle(requestId);
      if (answer.result) p.resolve(answer.result);
      else p.reject(new SceneError(`The render failed: ${answer.error ?? "the editor gave no reason"}`));
    },
  };
}

export type RenderBroker = ReturnType<typeof createRenderBroker>;
