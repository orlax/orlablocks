import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { advance, createRoot } from "@react-three/fiber";
import * as THREE from "three";
import { cameraPosition, clipPlanes, FOV_DEG, MAX_DISTANCE, type CameraState, type Vec3 } from "./camera";

/**
 * Captures (plan 09 §4): the scene rendered to an image, for shots and the agent's renders (09.3). Each capture
 * renders into a canvas of its own that's never in the page: a react-three-fiber root of its own, holding only the
 * clean scene (the caller passes it: no grid, gizmo, selection or hover), sized by hand, drawn once on request and
 * read back as a PNG. So the view is never touched, a capture can be any size, and nothing waits for the page's
 * animation frames or layout, which a browser stops in a tab that's in the background (the agent renders while the
 * human is elsewhere).
 */

/**
 * The camera a capture is taken with: where it is, what it looks at, and its vertical field of view; or, with
 * `ortho`, straight down with that many meters across and down the image (a plan: north up). `light` is an editor
 * camera the lighting follows (its sun and shadows cover the ground around the focus, as in the view).
 */
export type CaptureView = { position: Vec3; target: Vec3; vfov: number; light: CameraState; ortho?: { width: number; height: number } };

/** The capture view of an editor camera (the view's own). */
export function editorView(cam: CameraState): CaptureView {
  return { position: cameraPosition(cam), target: { x: cam.focus.x, y: 0, z: cam.focus.z }, vfov: FOV_DEG, light: cam };
}

/** The three.js camera for a capture view at an image size (also for projecting labels onto the image). */
export function makeCamera(view: CaptureView, width: number, height: number): THREE.PerspectiveCamera | THREE.OrthographicCamera {
  const { position: p, target: t } = view;
  let c: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  if (view.ortho) {
    const hw = view.ortho.width / 2;
    const hh = view.ortho.height / 2;
    c = new THREE.OrthographicCamera(-hw, hw, hh, -hh, 0.1, MAX_DISTANCE * 8);
    // Looking straight down, north (-z) up the image.
    c.up.set(0, 0, -1);
  } else {
    // Far enough for the farthest editor view (its planes follow the distance, 14.1), near enough for a walk's eye.
    const d = Math.hypot(p.x - t.x, p.y - t.y, p.z - t.z);
    const { far } = clipPlanes(d);
    c = new THREE.PerspectiveCamera(view.vfov, width / height, d > 200 ? clipPlanes(d).near : 0.05, far);
    c.up.set(0, 1, 0);
  }
  c.position.set(p.x, p.y, p.z);
  c.lookAt(t.x, t.y, t.z);
  c.updateProjectionMatrix();
  c.updateMatrixWorld();
  return c;
}

/** A capture: its camera, size in pixels, the pixel ratio lines and notes are sized at, and what to draw. */
export type CaptureRequest = {
  view: CaptureView;
  width: number;
  height: number;
  /** Lines, notes and arrowheads are sized in screen pixels: the ratio makes them look as on a screen of that density. */
  pixelRatio: number;
  background: string;
  /** A height everything above is cut away at (13.6: a section), or none. */
  clip?: number;
  /** The clean scene (lighting and shapes), given the camera the lighting follows. */
  content: (light: RefObject<CameraState>) => ReactNode;
};

/** How long a capture may take before it's given up (a lost WebGL context, say). */
const CAPTURE_TIMEOUT_MS = 20_000;

/** A blob as base64 (what `add_shot` and `rendered` send). */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("The image couldn't be read"));
    reader.readAsDataURL(blob);
  });
}

/** Resolves once everything rendered before it has been committed (its layout effect runs after its siblings'). */
function Ready({ onReady }: { onReady: () => void }) {
  useLayoutEffect(() => onReady(), []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

/** The content, with the camera the lighting follows. */
function Content({ light, content }: { light: CameraState; content: CaptureRequest["content"] }) {
  const cam = useRef<CameraState>(light);
  return <>{content(cam)}</>;
}

// One capture at a time: each has a WebGL context of its own until it's done.
let queue: Promise<unknown> = Promise.resolve();

/** Renders a capture and resolves with its PNG. Captures run one after another. */
export function captureScene(request: CaptureRequest): Promise<Blob> {
  const run = queue.then(() => withTimeout(capture(request), CAPTURE_TIMEOUT_MS, "The capture took too long"));
  queue = run.catch(() => {});
  return run;
}

async function capture({ view, width, height, pixelRatio, background, clip, content }: CaptureRequest): Promise<Blob> {
  const canvas = document.createElement("canvas");
  const root = createRoot(canvas);
  try {
    await root.configure({
      // The same look as the view (see the view's Canvas), and a buffer kept after drawing so it can be read.
      gl: { preserveDrawingBuffer: true, antialias: true },
      shadows: "percentage",
      dpr: pixelRatio,
      size: { width: width / pixelRatio, height: height / pixelRatio, top: 0, left: 0 },
      // `manual`: r3f keeps the camera as made (it would size an orthographic one to the canvas's pixels).
      camera: Object.assign(makeCamera(view, width, height), { manual: true }),
      frameloop: "never",
      onCreated: ({ gl }) => {
        gl.toneMapping = THREE.NeutralToneMapping;
        // Keeps what's below the height: the plane's normal points down.
        if (clip !== undefined) gl.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, -1, 0), clip)];
      },
    });
    let ready!: () => void;
    const committed = new Promise<void>((resolve) => (ready = resolve));
    const store = root.render(
      <>
        <color attach="background" args={[background]} />
        <Content light={view.light} content={content} />
        <Ready onReady={ready} />
      </>,
    );
    await committed;
    // One frame by hand: the lighting follows its camera (useFrame), then it's drawn with the capture's camera.
    advance(performance.now(), true, store.getState());
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((png) => (png ? resolve(png) : reject(new Error("The capture came back empty"))), "image/png"),
    );
  } finally {
    root.unmount();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}
