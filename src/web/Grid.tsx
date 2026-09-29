import { useMemo, useRef, type RefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { pxPerMeterAtFocus, visibleGround, type CameraState } from "./camera";

const SIZE = 4000; // the plane follows the focus point, so it only has to be larger than any visible area

const vertexShader = /* glsl */ `
  varying vec2 vPos;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vPos = world.xz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uMinorColor;
  uniform vec3 uMajorColor;
  uniform vec2 uFocus;
  uniform float uFadeRadius;
  uniform float uMinorAlpha;
  uniform float uStep;
  varying vec2 vPos;

  // Antialiased grid lines, about widthPx wide on screen.
  float grid(float spacing, float widthPx) {
    vec2 c = vPos / spacing;
    vec2 d = abs(fract(c - 0.5) - 0.5) / fwidth(c);
    return 1.0 - clamp(min(d.x, d.y) - (widthPx - 1.0) * 0.5, 0.0, 1.0);
  }

  void main() {
    float minor = grid(uStep, 1.0) * uMinorAlpha;
    float major = grid(uStep * 5.0, 1.5);
    float alpha = max(minor, major);
    if (alpha < 0.01) discard;
    float fade = 1.0 - smoothstep(uFadeRadius * 0.55, uFadeRadius, distance(vPos, uFocus));
    gl_FragColor = vec4(mix(uMinorColor, uMajorColor, major), alpha * fade);
    #include <colorspace_fragment>
  }
`;

/**
 * Reference grid on the ground plane: a line every 1 m, stronger every 5 m, fading out away from the focus point.
 * Zoomed far out (14.1) the lines step up by tens (10 m and 50 m, 100 m and 500 m, ...) so they never turn into
 * noise, and the plane grows to cover the view. A visual aid only, never part of the scene data.
 */
export function Grid({ cam }: { cam: RefObject<CameraState> }) {
  const mesh = useRef<THREE.Mesh>(null);
  const size = useThree((s) => s.size);
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        transparent: true,
        depthWrite: false,
        uniforms: {
          uMinorColor: { value: new THREE.Color("#e2ded4") },
          uMajorColor: { value: new THREE.Color("#c9c3b5") },
          uFocus: { value: new THREE.Vector2() },
          uFadeRadius: { value: 1 },
          uMinorAlpha: { value: 1 },
          uStep: { value: 1 },
        },
      }),
    [],
  );

  // The camera lives in a ref and changes every frame while panning or rotating, so update without re-rendering.
  useFrame(() => {
    const { focus } = cam.current;
    mesh.current?.position.set(focus.x, 0, focus.z);
    material.uniforms.uFocus.value.set(focus.x, focus.z);
    // Fade out toward the farthest visible corner, so the grid softly reaches the window edges.
    const farthest = Math.max(...visibleGround(cam.current, size).map((g) => Math.hypot(g.x - focus.x, g.z - focus.z)));
    material.uniforms.uFadeRadius.value = farthest;
    mesh.current?.scale.setScalar(Math.max(1, (farthest * 2.2) / SIZE));
    // Minor lines turn into noise when zoomed far out, so fade them before they get denser than ~5 px apart, and
    // step up by tens once even the major lines would be closer than ~8 px.
    const ppm = pxPerMeterAtFocus(cam.current, size);
    const step = Math.max(1, 10 ** Math.ceil(Math.log10(8 / (5 * ppm))));
    material.uniforms.uStep.value = step;
    material.uniforms.uMinorAlpha.value = THREE.MathUtils.smoothstep(ppm * step, 5, 10);
  });

  return (
    <mesh ref={mesh} rotation-x={-Math.PI / 2} material={material} renderOrder={-1}>
      <planeGeometry args={[SIZE, SIZE]} />
    </mesh>
  );
}
