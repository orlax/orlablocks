import { useEffect, useMemo } from "react";
import { useThree } from "@react-three/fiber";
import { CanvasTexture, LinearFilter, PerspectiveCamera, SRGBColorSpace, Sprite, SpriteMaterial } from "three";
import { PALETTE, type Note } from "../shared/scene.types";
import { NOTE_PX } from "./pick";
import { VIEW_ACCENT } from "../ui/viewColors";

/**
 * A note in the view (from 08): a pin standing on its point, painted into a canvas and shown as a sprite, so it
 * faces the camera and keeps its size in pixels at any zoom. With a label it's a flag with the letters on it;
 * without, a round head. It's drawn over everything (a work item shouldn't hide behind a wall). A done note is gray
 * and faint. Selected, it's outlined blue; hovered, yellow. `pick.ts`'s `noteRect` is where clicks land.
 */

const SELECT_STROKE = VIEW_ACCENT;
const HOVER_STROKE = "#e0a800";
const INK = "#34332f";
const DONE_FILL = "#c9c8c4";
/** Room around the pin in the canvas, for the outline. */
const PAD = 4;
const DPR = 2;

/** The canvas's size in CSS pixels, and where the pole's foot is in it. */
const layout = (labeled: boolean) => {
  const width = PAD * 2 + (labeled ? NOTE_PX.head / 2 + NOTE_PX.flagW : NOTE_PX.head);
  const height = PAD + NOTE_PX.pole + (labeled ? NOTE_PX.flagH / 2 : NOTE_PX.head / 2);
  return { width, height, footX: PAD + NOTE_PX.head / 2 };
};

function paintPin(note: Note, highlight: "hover" | "selected" | undefined): { texture: CanvasTexture; width: number; height: number; footX: number } {
  const labeled = !!note.label;
  const { width, height, footX } = layout(labeled);
  const canvas = document.createElement("canvas");
  canvas.width = width * DPR;
  canvas.height = height * DPR;
  const g = canvas.getContext("2d")!;
  g.scale(DPR, DPR);
  const done = note.status === "done";
  const fill = done ? DONE_FILL : PALETTE[note.color];
  const stroke = highlight === "selected" ? SELECT_STROKE : highlight === "hover" ? HOVER_STROKE : INK;
  const strokeWidth = highlight ? 2.5 : 1.25;
  const top = height - NOTE_PX.pole;

  // The pole.
  g.strokeStyle = highlight ? stroke : INK;
  g.lineWidth = highlight ? 2.5 : 1.5;
  g.beginPath();
  g.moveTo(footX, height);
  g.lineTo(footX, top);
  g.stroke();
  // Its foot: a small dot where it's pinned.
  g.fillStyle = INK;
  g.beginPath();
  g.arc(footX, height - 1.5, 1.5, 0, Math.PI * 2);
  g.fill();

  g.fillStyle = fill;
  g.strokeStyle = stroke;
  g.lineWidth = strokeWidth;
  if (labeled) {
    const x = footX;
    const y = top - NOTE_PX.flagH / 2;
    const w = NOTE_PX.flagW;
    const h = NOTE_PX.flagH;
    g.beginPath();
    g.roundRect(x, y, w, h, [0, 5, 5, 0]);
    g.fill();
    g.stroke();
    g.fillStyle = INK;
    g.font = `700 ${note.label!.length > 2 ? 10 : 11}px system-ui, sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(note.label!, x + w / 2, y + h / 2 + 0.5);
  } else {
    g.beginPath();
    g.arc(footX, top, NOTE_PX.head / 2, 0, Math.PI * 2);
    g.fill();
    g.stroke();
  }

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.generateMipmaps = false;
  return { texture, width, height, footX };
}

export function NoteMesh({ note, highlight }: { note: Note; highlight?: "hover" | "selected" }) {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const pin = useMemo(() => paintPin(note, highlight), [note.label, note.color, note.status, highlight]); // eslint-disable-line react-hooks/exhaustive-deps
  const sprite = useMemo(() => {
    const material = new SpriteMaterial({ map: pin.texture, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true });
    const s = new Sprite(material);
    s.renderOrder = 20;
    return s;
  }, [pin]);
  useEffect(
    () => () => {
      pin.texture.dispose();
      sprite.material.dispose();
    },
    [pin, sprite],
  );

  // Without size attenuation, a sprite's scale is its size at 1 m from a perspective camera: pixels over the view's
  // height times the height the view spans there.
  const fov = camera instanceof PerspectiveCamera ? camera.fov : 50;
  const perPx = (2 * Math.tan((fov * Math.PI) / 360)) / Math.max(1, size.height);
  sprite.scale.set(pin.width * perPx, pin.height * perPx, 1);
  // The pole's foot on the note's point.
  sprite.center.set(pin.footX / pin.width, 0);
  sprite.material.opacity = note.status === "done" && !highlight ? 0.55 : 1;
  return <primitive object={sprite} position={[note.x, note.y, note.z]} />;
}
