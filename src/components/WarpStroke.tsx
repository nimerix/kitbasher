import { useEffect, useLayoutEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import type { ThreeEvent } from '@react-three/fiber';
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  Raycaster,
  Vector2,
  Vector3,
  type InstancedInterleavedBuffer,
  type Intersection,
} from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import {
  strokingWarp,
  useEditor,
  warpBrushRadius,
  type WarpPoint,
  type WarpSession,
} from '../core/store';
import type { Part, Vec3 } from '../core/types';
import type { WarpSample } from '../core/warp-handles';
import { isPaintedFace, type WarpModel } from '../core/warp-model';
import {
  areaBrushFaces,
  faceBarycentric,
  facePoint,
  strokeConnected,
  strokeSample,
  type WarpStrokePoint,
} from '../core/warp-strokes';
import { partMeshes } from '../xr/part-meshes';

/** Handle colours, shared with the point markers. */
export const pointAccent = '#ed9b54',
  pointIdle = '#e9eaec';
const casingColor = '#15181b';

/** Screen pixels between the spots a stroke is sampled at, whatever the pointer's speed. */
const strokeStep = 2;
/** A line drawn shorter than this many pixels makes nothing. */
const shortStroke = 4;
/** Area dabs are this share of the brush radius apart along the stroke. */
const dabSpacing = 0.25;
/**
 * How far a line is drawn toward the eye, in pixels. Its width is screen-aligned at one depth, so
 * without this half of it would sink into a surface sloping across it.
 */
const lineLift = 4;

/** A line material whose segments sit `lineLift` pixels nearer the eye than their points. */
function liftedLine(color: string, width: number) {
  const material = new LineMaterial({ color, linewidth: width });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      'vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );',
      `vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );
      {
        bool eye = projectionMatrix[ 2 ][ 3 ] == - 1.0;
        float pixel = 2.0 / ( projectionMatrix[ 1 ][ 1 ] * resolution.y );
        if ( eye ) {
          start.xyz -= normalize( start.xyz ) * ${lineLift.toFixed(1)} * pixel * - start.z;
          end.xyz -= normalize( end.xyz ) * ${lineLift.toFixed(1)} * pixel * - end.z;
        } else {
          start.z += ${lineLift.toFixed(1)} * pixel;
          end.z += ${lineLift.toFixed(1)} * pixel;
        }
      }`,
    );
  };
  return material;
}

/**
 * Line segments on a surface, as a dark casing under a coloured core so they read on any part
 * colour. Positions are written in place; the buffer grows only when it must.
 */
class SurfaceSegments {
  readonly geometry = new LineSegmentsGeometry();
  readonly core: LineSegments2;
  readonly casing: LineSegments2;
  private array = new Float32Array(0);
  count = 0;
  constructor(color: string) {
    this.casing = new LineSegments2(this.geometry, liftedLine(casingColor, 5));
    // The core of every segment draws over the casing of its neighbours.
    this.casing.material.depthWrite = false;
    this.core = new LineSegments2(this.geometry, liftedLine(color, 2.5));
    for (const [line, order] of [
      [this.casing, 6],
      [this.core, 7],
    ] as const) {
      line.renderOrder = order;
      line.frustumCulled = false;
      line.raycast = () => {};
    }
  }
  setColor(color: string) {
    (this.core.material as LineMaterial).color.set(color);
  }
  /** Room for `segments`, keeping those written. */
  reserve(segments: number) {
    if (segments * 6 <= this.array.length) return this.array;
    const array = new Float32Array(Math.max(segments, 2 * (this.array.length / 6), 16) * 6);
    array.set(this.array);
    this.array = array;
    this.geometry.setPositions(array);
    return array;
  }
  /** Shows the first `count` segments written. */
  show(count: number) {
    this.count = count;
    this.geometry.instanceCount = count;
    const start = this.geometry.getAttribute('instanceStart') as unknown as
      { data: InstancedInterleavedBuffer } | undefined;
    if (start) start.data.needsUpdate = true;
    this.casing.visible = this.core.visible = count > 0;
  }
  dispose() {
    this.geometry.dispose();
    (this.core.material as LineMaterial).dispose();
    (this.casing.material as LineMaterial).dispose();
  }
}

/** Faces drawn with diagonal stripes of a colour and a dark tone, so the surface shows between. */
class StripedFaces {
  readonly geometry = new BufferGeometry();
  readonly mesh: Mesh;
  private array = new Float32Array(0);
  private attribute = new BufferAttribute(this.array, 3);
  constructor(color: string) {
    const material = new MeshBasicMaterial({
      color,
      side: DoubleSide,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    const dark = new Color(casingColor);
    material.onBeforeCompile = (shader) => {
      shader.uniforms.stripeDark = { value: dark };
      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', 'uniform vec3 stripeDark;\nvoid main() {')
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          diffuseColor.rgb = mod( gl_FragCoord.x + gl_FragCoord.y, 10.0 ) < 4.0 ? stripeDark : diffuseColor.rgb;`,
        );
    };
    this.mesh = new Mesh(this.geometry, material);
    this.mesh.renderOrder = 5;
    this.mesh.frustumCulled = false;
    this.mesh.raycast = () => {};
    this.geometry.setAttribute('position', this.attribute);
  }
  setColor(color: string) {
    (this.mesh.material as MeshBasicMaterial).color.set(color);
  }
  reserve(faces: number) {
    if (faces * 9 <= this.array.length) return this.array;
    const array = new Float32Array(Math.max(faces, 2 * (this.array.length / 9), 64) * 9);
    array.set(this.array);
    this.array = array;
    this.attribute = new BufferAttribute(array, 3);
    this.geometry.setAttribute('position', this.attribute);
    return array;
  }
  show(faces: number) {
    this.attribute.needsUpdate = true;
    this.geometry.setDrawRange(0, faces * 3);
    this.mesh.visible = faces > 0;
  }
  dispose() {
    this.geometry.dispose();
    (this.mesh.material as MeshBasicMaterial).dispose();
  }
}

/** Writes a face's three warped corners, mesh-local, at `offset`. */
function writeFace(
  model: WarpModel,
  positions: ArrayLike<number>,
  face: number,
  out: Float32Array,
  offset: number,
) {
  for (let c = 0; c < 3; c++) {
    const v = model.index?.[face * 3 + c] ?? face * 3 + c;
    out[offset + c * 3] = positions[v * 3];
    out[offset + c * 3 + 1] = positions[v * 3 + 1];
    out[offset + c * 3 + 2] = positions[v * 3 + 2];
  }
}

interface Draft {
  kind: 'line' | 'area';
  pointer: number;
  partId: string;
  model: WarpModel;
  /** Where the stroke was last sampled, client pixels. */
  x: number;
  y: number;
  travelled: number;
  /** Unbroken stretches of a line, each with its length at rest. */
  runs: { points: WarpStrokePoint[]; length: number }[];
  previous: WarpSample | null;
  broken: boolean;
  /** Line segments drawn so far. */
  drawn: number;
  faces: Set<number>;
  first: WarpStrokePoint | null;
  dab: Vector3 | null;
  radius: number;
  controls: { enabled: boolean } | null;
}

let draft: Draft | null = null;
let starter: ((event: ThreeEvent<PointerEvent>, partId: string) => boolean) | null = null;
// The click that ends a stroke follows its pointer up; it must not add or select anything.
let swallowing = false;

/**
 * Starts a line or area stroke from a press on the warped surface, when the Add mode draws and
 * nothing else owns the press. Returns whether it started.
 */
export const beginWarpStroke = (event: ThreeEvent<PointerEvent>, partId: string) =>
  starter?.(event, partId) ?? false;

/** Whether the click under way ends a stroke rather than picks. */
export const endingWarpStroke = () => swallowing;

/**
 * Owns a stroke from press to release: samples the pointer's path every few pixels on the warped
 * surface, draws the line or the faces painted so far, and makes one handle on release. Escape,
 * pointer cancel, lost capture, window blur, camera navigation and a gizmo press discard it.
 */
export function WarpStrokeController({ pressed }: { pressed: () => boolean }) {
  const get = useThree((s) => s.get),
    invalidate = useThree((s) => s.invalidate);
  const view = useMemo(() => {
    const group = new Group();
    group.matrixAutoUpdate = false;
    const line = new SurfaceSegments(pointAccent);
    const fill = new StripedFaces(pointAccent);
    group.add(line.casing, line.core, fill.mesh);
    line.show(0);
    fill.show(0);
    return { group, line, fill };
  }, []);
  useEffect(() => () => (view.line.dispose(), view.fill.dispose()), [view]);

  useEffect(() => {
    const raycaster = new Raycaster();
    raycaster.firstHitOnly = true;
    const ndc = new Vector2();
    const canvas = () => {
      const { events, gl } = get();
      return events.connected instanceof HTMLElement ? events.connected : gl.domElement;
    };
    const output = () => useEditor.getState().warp?.output?.positions;

    /** The spot under a client position on the warped part, or null off it or behind another. */
    const hitAt = (d: Draft, x: number, y: number): WarpStrokePoint | null => {
      const own = partMeshes.get(d.partId);
      const positions = output();
      if (!own || !positions) return null;
      const rect = canvas().getBoundingClientRect();
      ndc.set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, get().camera);
      let nearest: Intersection | null = null;
      for (const mesh of partMeshes.values()) {
        const hits = raycaster.intersectObject(mesh, false);
        if (hits.length && (!nearest || hits[0].distance < nearest.distance)) nearest = hits[0];
      }
      if (!nearest || nearest.object !== own || nearest.faceIndex == null) return null;
      const local = own.worldToLocal(nearest.point.clone()).toArray() as Vec3;
      return {
        face: nearest.faceIndex,
        barycentric: faceBarycentric(d.model, positions, nearest.faceIndex, local),
      };
    };

    const drawLine = (d: Draft, positions: ArrayLike<number>) => {
      let segments = 0;
      for (const run of d.runs) segments += Math.max(0, run.points.length - 1);
      if (segments === d.drawn) return;
      const array = view.line.reserve(segments);
      let s = 0;
      const a: Vec3 = [0, 0, 0],
        b: Vec3 = [0, 0, 0];
      for (const run of d.runs)
        for (let i = 1; i < run.points.length; i++, s++) {
          // Only segments added since the last draw are written.
          if (s < d.drawn) continue;
          facePoint(d.model, positions, run.points[i - 1], a);
          facePoint(d.model, positions, run.points[i], b);
          array.set(a, s * 6);
          array.set(b, s * 6 + 3);
        }
      d.drawn = segments;
      view.line.show(segments);
    };

    const addLine = (d: Draft, point: WarpStrokePoint | null) => {
      const state = useEditor.getState().warp?.state;
      const sample = point && state ? strokeSample(d.model, state, point) : null;
      if (!sample) {
        d.broken = true;
        d.previous = null;
        return;
      }
      if (d.previous && !strokeConnected(d.model, d.previous, sample)) d.broken = true;
      if (d.broken || !d.runs.length) d.runs.push({ points: [], length: 0 });
      const run = d.runs[d.runs.length - 1];
      if (d.previous && !d.broken)
        run.length += Math.hypot(
          ...sample.restWorld.map((value, a) => value - d.previous!.restWorld[a]),
        );
      run.points.push(point!);
      d.previous = sample;
      d.broken = false;
    };

    const dab = (d: Draft, point: WarpStrokePoint | null, positions: ArrayLike<number>) => {
      if (!point || !isPaintedFace(d.model, point.face)) return;
      const local = facePoint(d.model, positions, point);
      const at = new Vector3(...local).applyMatrix4(view.group.matrix);
      if (d.dab && d.dab.distanceTo(at) < dabSpacing * d.radius) return;
      d.dab = at;
      d.first ??= point;
      const added = areaBrushFaces(d.model, positions, point, d.radius).filter(
        (face) => !d.faces.has(face),
      );
      if (!added.length) return;
      const start = d.faces.size;
      const array = view.fill.reserve(start + added.length);
      added.forEach((face, i) => {
        d.faces.add(face);
        writeFace(d.model, positions, face, array, (start + i) * 9);
      });
      view.fill.show(d.faces.size);
    };

    const sample = (d: Draft, point: WarpStrokePoint | null) => {
      const positions = output();
      if (!positions) return;
      if (d.kind === 'line') addLine(d, point);
      else dab(d, point, positions);
    };

    /** Samples the path from the last sampled spot toward a client position, every few pixels. */
    const follow = (d: Draft, x: number, y: number) => {
      const dx = x - d.x,
        dy = y - d.y;
      const length = Math.hypot(dx, dy);
      const steps = Math.floor(length / strokeStep);
      for (let i = 1; i <= steps; i++) {
        const t = (i * strokeStep) / length;
        sample(d, hitAt(d, d.x + dx * t, d.y + dy * t));
      }
      if (steps) {
        d.travelled += steps * strokeStep;
        d.x += (dx * steps * strokeStep) / length;
        d.y += (dy * steps * strokeStep) / length;
      }
    };

    const redraw = (d: Draft) => {
      const positions = output();
      if (positions && d.kind === 'line') drawLine(d, positions);
      invalidate();
    };

    const end = () => {
      const d = draft;
      if (!d) return null;
      draft = null;
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('blur', discard);
      window.removeEventListener('keydown', key, true);
      canvas().removeEventListener('lostpointercapture', lost);
      try {
        canvas().releasePointerCapture(d.pointer);
      } catch {
        // Already released.
      }
      if (d.controls) d.controls.enabled = true;
      view.line.show(0);
      view.fill.show(0);
      unsubscribe?.();
      unsubscribe = null;
      invalidate();
      return d;
    };
    const discard = () => void end();

    const move = (event: PointerEvent) => {
      const d = draft;
      if (!d || event.pointerId !== d.pointer) return;
      if (pressed()) return discard();
      const events = event.getCoalescedEvents?.() ?? [];
      for (const e of events.length ? events : [event]) follow(d, e.clientX, e.clientY);
      redraw(d);
    };
    const up = (event: PointerEvent) => {
      const d = draft;
      if (!d || event.pointerId !== d.pointer) return;
      swallowing = true;
      setTimeout(() => (swallowing = false));
      if (pressed()) return discard();
      // The spot let go over closes the stroke.
      follow(d, event.clientX, event.clientY);
      if (Math.hypot(event.clientX - d.x, event.clientY - d.y) > 0.5) {
        d.travelled += Math.hypot(event.clientX - d.x, event.clientY - d.y);
        sample(d, hitAt(d, event.clientX, event.clientY));
      }
      end();
      const state = useEditor.getState();
      if (d.kind === 'line') {
        if (d.travelled < shortStroke) return;
        const longest = d.runs.reduce<Draft['runs'][number] | null>(
          (best, run) => (!best || run.length > best.length ? run : best),
          null,
        );
        if (longest && longest.points.length > 1)
          state.addWarpStroke({ kind: 'line', points: longest.points });
      } else if (d.first && d.faces.size)
        state.addWarpStroke({ kind: 'area', faces: [...d.faces], first: d.first });
    };
    const cancel = (event: PointerEvent) => {
      if (draft && event.pointerId === draft.pointer) discard();
    };
    const lost = (event: PointerEvent) => {
      if (draft && event.pointerId === draft.pointer) discard();
    };
    const key = (event: KeyboardEvent) => {
      if (!draft || event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      discard();
    };
    let unsubscribe: (() => void) | null = null;

    starter = (event, partId) => {
      const state = useEditor.getState(),
        warp = state.warp;
      const model = warp?.model;
      const face = event.faceIndex;
      if (
        draft ||
        !strokingWarp(state) ||
        !model ||
        !warp?.output ||
        warp.partId !== partId ||
        face == null ||
        !isPaintedFace(model, face) ||
        event.button !== 0 ||
        event.shiftKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        state.navigationMode ||
        state.temporaryOrbit ||
        state.pivotPicking ||
        state.freeTransform ||
        state.view.explode ||
        pressed()
      )
        return false;
      const mesh = event.object as Mesh;
      const local = mesh.worldToLocal(event.point.clone()).toArray() as Vec3;
      const first = {
        face,
        barycentric: faceBarycentric(model, warp.output.positions, face, local),
      };
      // The camera's controls see this press after it; a stroke owns it instead.
      const controls = get().controls as { enabled: boolean } | null;
      const owned = controls?.enabled ? controls : null;
      if (owned) owned.enabled = false;
      const d: Draft = {
        kind: state.warpAdd === 'area' ? 'area' : 'line',
        pointer: event.pointerId,
        partId,
        model,
        x: event.nativeEvent.clientX,
        y: event.nativeEvent.clientY,
        travelled: 0,
        runs: [],
        previous: null,
        broken: false,
        drawn: 0,
        faces: new Set(),
        first: null,
        dab: null,
        radius: warpBrushRadius(state),
        controls: owned,
      };
      draft = d;
      mesh.updateWorldMatrix(true, false);
      view.group.matrix.copy(mesh.matrixWorld);
      view.group.matrixWorldNeedsUpdate = true;
      view.line.show(0);
      view.fill.show(0);
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerup', up, true);
      window.addEventListener('pointercancel', cancel, true);
      window.addEventListener('blur', discard);
      window.addEventListener('keydown', key, true);
      const element = canvas();
      element.addEventListener('lostpointercapture', lost);
      try {
        element.setPointerCapture(event.pointerId);
      } catch {
        // A pointer that is not active cannot be captured; window listeners still follow it.
      }
      // Anything that takes the pointer or the session away ends the stroke.
      unsubscribe = useEditor.subscribe((s) => {
        if (
          draft === d &&
          (!strokingWarp(s) ||
            s.warp?.model !== d.model ||
            s.temporaryOrbit ||
            !!s.navigationMode ||
            s.pivotPicking ||
            !!s.freeTransform ||
            s.view.explode > 0)
        )
          discard();
      });
      sample(d, first);
      redraw(d);
      return true;
    };
    return () => {
      discard();
      starter = null;
    };
  }, [get, invalidate, pressed, view]);

  return <primitive object={view.group} />;
}

/** Boundary edges of a set of faces, as pairs of face corners: face × 3 + corner. */
function boundaryCorners(model: WarpModel, faces: readonly number[]) {
  const { weldOf, weldedCount } = model.region;
  const welded = (face: number, c: number) => weldOf[model.index?.[face * 3 + c] ?? face * 3 + c];
  const count = new Map<number, number>();
  const key = (a: number, b: number) => (a < b ? a * weldedCount + b : b * weldedCount + a);
  for (const face of faces)
    for (let c = 0; c < 3; c++) {
      const k = key(welded(face, c), welded(face, (c + 1) % 3));
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  const corners: number[] = [];
  for (const face of faces)
    for (let c = 0; c < 3; c++)
      if (count.get(key(welded(face, c), welded(face, (c + 1) % 3))) === 1)
        corners.push(face * 3 + c, face * 3 + ((c + 1) % 3));
  return corners;
}

/**
 * A line handle as its line on the written surface, and an area handle as its faces tinted with
 * its outline, in the colours of the point markers. Shapes are built when a handle's path or
 * faces change; each solve only rewrites their positions.
 */
export function WarpHandleShapes({ warp, part }: { warp: WarpSession; part: Part }) {
  const handles = warp.points.filter((point) => point.kind !== 'point');
  if (!handles.length) return null;
  return (
    <group position={part.position} quaternion={part.quaternion} scale={part.scale}>
      {handles.map((handle) => (
        <HandleShape
          key={handle.id}
          handle={handle}
          warp={warp}
          selected={warp.selectedPoints.includes(handle.id)}
        />
      ))}
    </group>
  );
}

function HandleShape({
  handle,
  warp,
  selected,
}: {
  handle: WarpPoint;
  warp: WarpSession;
  selected: boolean;
}) {
  const invalidate = useThree((s) => s.invalidate);
  const model = warp.model!;
  const { path, faces } = handle;
  const shape = useMemo(() => {
    const group = new Group();
    const line = new SurfaceSegments(pointIdle);
    group.add(line.casing, line.core);
    if (faces) {
      const fill = new StripedFaces(pointIdle);
      group.add(fill.mesh);
      fill.reserve(faces.length);
      return { group, line, fill, corners: boundaryCorners(model, faces) };
    }
    return { group, line, fill: null, corners: null };
  }, [model, faces]);
  useEffect(() => () => (shape.line.dispose(), shape.fill?.dispose()), [shape]);
  useLayoutEffect(() => {
    shape.line.setColor(selected ? pointAccent : pointIdle);
    shape.fill?.setColor(selected ? pointAccent : pointIdle);
    invalidate();
  }, [shape, selected, invalidate]);
  const positions = warp.output?.positions;
  // Each solve writes the preview in place and makes a new session object.
  useLayoutEffect(() => {
    if (!positions) return;
    const { line, fill, corners } = shape;
    const a: Vec3 = [0, 0, 0];
    if (fill && faces && corners) {
      const array = fill.reserve(faces.length);
      faces.forEach((face, i) => writeFace(model, positions, face, array, i * 9));
      fill.show(faces.length);
      const segments = corners.length / 2;
      const ends = line.reserve(segments);
      for (let i = 0; i < corners.length; i++) {
        const corner = corners[i];
        const v = model.index?.[corner] ?? corner;
        ends[i * 3] = positions[v * 3];
        ends[i * 3 + 1] = positions[v * 3 + 1];
        ends[i * 3 + 2] = positions[v * 3 + 2];
      }
      line.show(segments);
    } else if (path && path.length > 1) {
      const ends = line.reserve(path.length - 1);
      const b: Vec3 = [0, 0, 0];
      facePoint(model, positions, path[0], a);
      for (let i = 1; i < path.length; i++) {
        facePoint(model, positions, path[i], b);
        ends.set(a, (i - 1) * 6);
        ends.set(b, (i - 1) * 6 + 3);
        a[0] = b[0];
        a[1] = b[1];
        a[2] = b[2];
      }
      line.show(path.length - 1);
    }
    invalidate();
  }, [shape, warp, positions, model, path, faces, invalidate]);
  return <primitive object={shape.group} />;
}
