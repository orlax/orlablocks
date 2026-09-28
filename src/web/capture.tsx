import { useMemo, useRef, type ReactNode, type RefObject } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { cameraPosition, FOV_DEG, MAX_DISTANCE, type CameraState, type Vec3 } from "./camera";

/**
 * Captures (plan 09 §4): the scene rendered to an image, for shots and (09.3) the agent's renders. Each capture
 * mounts a hidden canvas of its own, at the image's size, with only the scene in it (no grid, gizmo, selection or
 * hover: the caller passes the clean content), renders one frame and reads it back as a PNG. The on-screen view is
 * never touched, so it doesn't flicker or move, and a capture can be any size.
 */

/**
 * The camera a capture is taken with: where it is, what it looks at, and its vertical field of view. `light` is an
 * editor camera the lighting follows (its sun and shadows cover the ground around the focus, as in the view).
 */
export type CaptureView = { position: Vec3; target: Vec3; vfov: number; light: CameraState };

/** The capture view of an editor camera (the view's own). */
export function editorView(cam: CameraState): CaptureView {
  return { position: cameraPosition(cam), target: { x: cam.focus.x, y: 0, z: cam.focus.z }, vfov: FOV_DEG, light: cam };
}

/**
 * A capture to take: the camera, the image's size in pixels, the pixel ratio it's drawn at (so lines, notes and
 * arrowheads, sized in screen pixels, look as they do on screen), and where the PNG goes.
 */
export type CaptureJob = {
  id: number;
  view: CaptureView;
  width: number;
  height: number;
  pixelRatio: number;
  resolve: (png: Blob) => void;
  reject: (err: Error) => void;
};

/** How long a capture may take before it's given up (a lost WebGL context, say). */
const CAPTURE_TIMEOUT_MS = 15_000;

/** A PNG blob as base64 (what `add_shot` sends). */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("The image couldn't be read"));
    reader.readAsDataURL(blob);
  });
}

/**
 * The hidden canvas for one capture. `children` is the clean scene (lighting and shapes), given the capture's camera
 * (the lighting follows its focus, as in the view). Unmounting it frees its WebGL context.
 */
export function CaptureStage({ job, background, children }: { job: CaptureJob; background: string; children: (cam: RefObject<CameraState>) => ReactNode }) {
  const cam = useRef<CameraState>(job.view.light);
  // The canvas's own camera, so what sizes itself from the camera (notes, arrowheads) does so for this picture.
  const camera = useMemo(() => {
    const { position: p, target: t, vfov } = job.view;
    const c = new THREE.PerspectiveCamera(vfov, job.width / job.height, 0.05, MAX_DISTANCE * 4);
    c.position.set(p.x, p.y, p.z);
    c.up.set(0, 1, 0);
    c.lookAt(t.x, t.y, t.z);
    c.updateMatrixWorld();
    return c;
  }, [job]);
  return (
    <div className="capture-stage" style={{ width: job.width / job.pixelRatio, height: job.height / job.pixelRatio }} aria-hidden>
      <Canvas
        shadows="percentage"
        dpr={job.pixelRatio}
        camera={camera}
        // The same look as the view (see the view's Canvas), and a buffer kept after drawing so it can be read.
        gl={{ preserveDrawingBuffer: true, antialias: true }}
        onCreated={({ gl }) => {
          gl.toneMapping = THREE.NeutralToneMapping;
        }}
        frameloop="always"
      >
        <color attach="background" args={[background]} />
        {children(cam)}
        <Snap job={job} />
      </Canvas>
    </div>
  );
}

/**
 * Takes the picture: on the first frame at the right size (the canvas is measured after it mounts; a pixel off from
 * rounding is fine), after the lighting has followed the camera (a later priority, which also stops r3f drawing on
 * its own).
 */
function Snap({ job }: { job: CaptureJob }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const state = useRef<"waiting" | "taken">("waiting");
  const started = useRef(performance.now());

  useFrame(() => {
    if (state.current === "taken") return;
    if (performance.now() - started.current > CAPTURE_TIMEOUT_MS) {
      state.current = "taken";
      return job.reject(new Error("The capture took too long"));
    }
    const canvas = gl.domElement;
    if (Math.abs(canvas.width - job.width) > 1 || Math.abs(canvas.height - job.height) > 1) return;
    state.current = "taken";
    gl.render(scene, camera);
    gl.domElement.toBlob((png) => (png ? job.resolve(png) : job.reject(new Error("The capture came back empty"))), "image/png");
  }, 1);

  return null;
}
