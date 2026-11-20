import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import type { ThreeEvent } from '@react-three/fiber';
import {
  Matrix3,
  Mesh,
  Raycaster,
  Sphere,
  Vector2,
  Vector3,
  type BufferGeometry,
  type Camera,
  type Intersection,
} from 'three';
import {
  brushingRefine,
  paintingRefine,
  useEditor,
  type RefineMode,
  type RefineSession,
} from '../core/store';
import type { GuidePoint } from '../core/refine-band';
import type { RefineBrush } from '../core/refine-brush';
import { prepareEditedForPicking } from '../core/bvh';
import { triangleCount } from '../core/geometry';
import { workerIndexTriangles } from '../core/spatial-index';
import { partMeshes } from '../xr/part-meshes';

/** Screen pixels between the spots a brush stroke is sampled at, whatever the pointer's speed. */
const strokeStep = 2;
/** A press within this many pixels of a guide handle takes the handle. */
export const handlePick = 8;
/** A click within this many pixels of a proposal's drawn curve selects it in Detect mode. */
export const proposalPick = 6;
/** A handle press that travels this many pixels is a drag. */
const dragStart = 3;
/** The most a handle or curve on the surface may lie off the surface in front of it and be seen, mm. */
const maxAllowance = 0.15;

/**
 * How far off the first surface along its view ray a handle or curve point may lie and still count
 * as on it: one and a half of the mesh's median edge length, at most 0.15 mm, at every zoom.
 */
export const surfaceAllowance = (step: number) => Math.min(1.5 * step, maxAllowance);

/** A handle or proposal within the pick radius: its distance along the view ray and on screen. */
export interface PickCandidate<T> {
  item: T;
  /** Distance from the eye along the view ray through it. */
  depth: number;
  /** Distance along the same ray to the first surface, or null when nothing is in front. */
  surface: number | null;
  /** Its distance from that surface along the surface's normal there; null with no surface. */
  offset: number | null;
  /** Squared screen distance to the pointer. */
  screen: number;
}

/**
 * The candidate to pick: only one seen, with no surface in front of it or lying within `allowance`
 * of the first surface along that surface's normal (so a grazing view still sees a point on it);
 * among those the nearest in depth, then, at a level depth, the nearest on screen.
 */
export function chooseCandidate<T>(candidates: PickCandidate<T>[], allowance: number): T | null {
  const seen = candidates.filter(
    (c) =>
      c.surface === null ||
      c.depth <= c.surface ||
      (c.offset !== null && Math.abs(c.offset) <= allowance),
  );
  if (!seen.length) return null;
  const front = seen.reduce((a, b) => (b.depth < a.depth ? b : a));
  let best = front;
  for (const c of seen) if (c.depth <= front.depth + allowance && c.screen < best.screen) best = c;
  return best.item;
}

/** What a gesture belongs to; a change to any of it before release cancels the gesture. */
export interface GestureBinding {
  session: string;
  partId: string;
  mode: RefineMode;
  /** The brush a stroke started with; null for a handle drag or a proposal press. */
  kind: RefineBrush | null;
}

/** The binding of a gesture starting now, or null without a ready session. */
export function gestureBinding(
  state: Pick<ReturnType<typeof useEditor.getState>, 'refine'>,
  stroke: boolean,
): GestureBinding | null {
  const { refine } = state;
  if (!refine || refine.stage !== 'ready') return null;
  return {
    session: refine.id,
    partId: refine.partId,
    mode: refine.mode,
    kind: stroke ? refine.brush.kind : null,
  };
}

/** Whether the session, part, mode or brush a gesture started with has changed. */
export function bindingBroken(
  binding: GestureBinding,
  state: Pick<ReturnType<typeof useEditor.getState>, 'refine' | 'tool'>,
) {
  const { refine } = state;
  return (
    state.tool !== 'refine' ||
    refine?.stage !== 'ready' ||
    refine.id !== binding.session ||
    refine.partId !== binding.partId ||
    refine.mode !== binding.mode ||
    (binding.kind !== null && refine.brush.kind !== binding.kind)
  );
}

/** Length of a run of stroke samples along the surface. */
const runLength = (run: GuidePoint[]) => {
  let length = 0;
  for (let i = 1; i < run.length; i++) {
    const [a, b] = [run[i - 1].position, run[i].position];
    length += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  }
  return length;
};

/** The longest of a stroke's runs of consecutive hits on the part; the first of equals. */
export function longestRun(runs: GuidePoint[][]) {
  let best: GuidePoint[] = [],
    length = -1;
  for (const run of runs) {
    const l = runLength(run);
    if (run.length && l > length) [best, length] = [run, l];
  }
  return best;
}

// Set while a pointer move is being handled, so the pick it makes may be skipped; see previewRaycast.
let pointerMoving = false;

/** Runs `pick` as a pointer move would, for tests of what a move finds. */
export function asPointerMove<T>(pick: () => T): T {
  const before = pointerMoving;
  pointerMoving = true;
  try {
    return pick();
  } finally {
    pointerMoving = before;
  }
}

// Set while the controller asks what lies first under the pointer.
let occlusionTest = false;

/** Whether a geometry is too dense to pick without the index it does not have, read from it now. */
const unindexed = (geometry: BufferGeometry) =>
  !geometry.boundsTree && triangleCount(geometry) > workerIndexTriangles;

/** Whether the session's surface can be picked at pointer moves: its preview has its index. */
export const surfaceReady = (refine: Pick<RefineSession, 'preview'> | null | undefined) =>
  !refine?.preview || !unindexed(refine.preview);

/**
 * What a press would start a brush stroke, Region paint or handle drag as, or null: no continuous
 * gesture starts without a ready session, or while the session's preview has no picking index.
 */
export function pressGesture(
  state: Pick<ReturnType<typeof useEditor.getState>, 'refine'>,
  stroke: boolean,
): GestureBinding | null {
  const binding = gestureBinding(state, stroke);
  return binding && surfaceReady(state.refine) ? binding : null;
}

const bounds = new Sphere(),
  toCentre = new Vector3();
// Each unindexed part's exact answer for a move, kept until the next animation frame.
const frameAnswers = new Map<Mesh, Intersection | null>();

/**
 * For a part's Mesh: while Refine asks what lies first under the pointer, a part with no index yet
 * is never seen through. A press tests every triangle of it. A move whose ray passes its bounding
 * sphere tests it so at most once an animation frame, and that frame's other moves take the answer.
 */
export function occludingRaycast(pick: Mesh['raycast']): Mesh['raycast'] {
  return function (this: Mesh, raycaster, intersects) {
    if (!occlusionTest || !unindexed(this.geometry)) return pick.call(this, raycaster, intersects);
    if (!pointerMoving) return exactNearest(this, raycaster, intersects);
    if (!this.geometry.boundingSphere) this.geometry.computeBoundingSphere();
    bounds.copy(this.geometry.boundingSphere!).applyMatrix4(this.matrixWorld);
    const { ray } = raycaster;
    const along = toCentre.copy(bounds.center).sub(ray.origin).dot(ray.direction);
    const apart = toCentre.lengthSq() - along * along;
    const reach = bounds.radius * bounds.radius - apart;
    if (reach < 0 || along + Math.sqrt(reach) < 0) return;
    if (!frameAnswers.has(this)) {
      const answer: Intersection[] = [];
      exactNearest(this, raycaster, answer);
      frameAnswers.set(this, answer[0] ?? null);
      requestAnimationFrame(() => frameAnswers.delete(this));
    }
    const answer = frameAnswers.get(this);
    if (answer) intersects.push(answer);
  };
}

/** The nearest hit of a ray on a mesh by testing every triangle, kept only where `shows` holds. */
function exactNearest(
  mesh: Mesh,
  raycaster: Raycaster,
  intersects: Intersection[],
  shows?: (point: Vector3) => boolean,
) {
  const hits: Intersection[] = [];
  Mesh.prototype.raycast.call(mesh, raycaster, hits);
  let nearest: Intersection | null = null;
  for (const hit of hits)
    if ((!nearest || hit.distance < nearest.distance) && (!shows || shows(hit.point)))
      nearest = hit;
  if (nearest) intersects.push(nearest);
}

/** A drawn proposal curve, world space, written by the overlay that draws it. */
export interface DrawnCurve {
  points: Float32Array;
  centre: Vector3;
  radius: number;
}
/** The curve each pending edge is drawn with, by feature id, for picking proposals on screen. */
export const refineCurves = new Map<string, DrawnCurve>();

/** A guide point shown as a handle: where it is in its feature's segments. */
export interface RefineHandle {
  feature: string;
  segment: number;
  index: number;
  point: GuidePoint;
  /** The first point of its path. */
  first: boolean;
}

/** Pending edges whose points the overlay draws as handles: hand guides and every selected edge. */
export function refineHandles(refine: Pick<RefineSession, 'features' | 'selected'>) {
  const handles: RefineHandle[] = [];
  for (const f of refine.features) {
    if (f.state !== 'pending' || f.feature.type !== 'edge') continue;
    if (f.origin !== 'hand' && !refine.selected.includes(f.id)) continue;
    const seen = new Set<GuidePoint>();
    f.feature.input.segments.forEach((segment, s) =>
      segment.points.forEach((point, index) => {
        // A point two segments share is one handle.
        if (seen.has(point)) return;
        seen.add(point);
        handles.push({ feature: f.id, segment: s, index, point, first: s === 0 && index === 0 });
      }),
    );
  }
  return handles;
}

interface GestureBase {
  pointer: number;
  partId: string;
  binding: GestureBinding;
  controls: { enabled: boolean } | null;
}
interface Stroke extends GestureBase {
  kind: 'stroke';
  /** Where the stroke was last sampled. */
  x: number;
  y: number;
  /** Whether the last sample hit the part. */
  onPart: boolean;
  /** A crease stroke's runs of consecutive hits on the part, the current one last. */
  runs: GuidePoint[][] | null;
}
interface Paint extends GestureBase {
  kind: 'paint';
  /** Where it was pressed. */
  x: number;
  y: number;
}
interface HandleDrag extends GestureBase {
  kind: 'handle';
  handle: RefineHandle;
  /** The point it now stands at, as last given to the store. */
  current: GuidePoint;
  x: number;
  y: number;
  moved: boolean;
  /** Set once the store has been given this drag's first move. */
  began?: boolean;
}
type Gesture = Stroke | Paint | HandleDrag;

let gesture: Gesture | null = null;
let starter: ((event: ThreeEvent<PointerEvent>, partId: string) => boolean) | null = null;
let painter: ((event: ThreeEvent<PointerEvent>, partId: string) => boolean) | null = null;
// The click that ends a gesture follows its pointer up; it must not add or select anything.
let swallowing = false;
// A press in Detect mode near a proposal: the click that follows selects it instead of painting.
let pressedProposal: string | null = null;
let surfaceHit: ((partId: string, x: number, y: number) => GuidePoint | null) | null = null;

/** Starts a brush stroke or a guide-point drag from a pointer-down on the part. True when it took the event. */
export const beginRefinePointer = (event: ThreeEvent<PointerEvent>, partId: string) =>
  starter?.(event, partId) ?? false;

/** Starts Region paint from a pointer-down on the part. True when it took the event. */
export const beginRefinePaint = (event: ThreeEvent<PointerEvent>, partId: string) =>
  painter?.(event, partId) ?? false;

/** Whether the click under way ends a Refine gesture rather than picks. */
export const endingRefinePointer = () => swallowing;

/** Whether the press under way lies on a proposal, which the click that follows will select. */
export const pressingRefineProposal = () => pressedProposal !== null;

/**
 * The spot under a client position on the session's part, or null when off it or when another
 * part is the first thing under the pointer.
 */
export const refineSurfaceAt = (partId: string, x: number, y: number) =>
  surfaceHit?.(partId, x, y) ?? null;

const blocked = (state: ReturnType<typeof useEditor.getState>) =>
  !!state.navigationMode ||
  state.temporaryOrbit ||
  state.pivotPicking ||
  !!state.freeTransform ||
  state.view.explode > 0;

/** Squared pixel distance from (x, y) to the segment between two screen points, and where along it. */
function segmentDistance(x: number, y: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax,
    dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / length)) : 0;
  const ex = ax + t * dx - x,
    ey = ay + t * dy - y;
  return [ex * ex + ey * ey, t] as const;
}

/**
 * Whether the session's draft moved or made triangle `t` of the surface it shows: one of its
 * corners is new or stands off its place on the model.
 */
export function draftMoved(refine: Pick<RefineSession, 'draft' | 'model'>, t: number) {
  const draft = refine.draft,
    model = refine.model?.mesh;
  if (!draft || !model || draft === model || !(t < draft.triangleCount)) return false;
  for (let k = 0; k < 3; k++) {
    const v = draft.weldOf[draft.corners[t * 3 + k]];
    if (v >= model.weldedCount) return true;
    for (let a = 0; a < 3; a++)
      if (draft.position[v * 3 + a] !== model.position[v * 3 + a]) return true;
  }
  return false;
}

/**
 * Owns a Refine gesture from press to release: a brush stroke sampled every few pixels along the
 * pointer's path, Region paint, or a guide handle dragged over the surface. Escape, pointer cancel,
 * lost capture, window blur, camera navigation and a change of session, part, mode or brush discard
 * it. None starts while the session's preview has no picking index; a busy cursor over the part
 * says so. Also selects proposals clicked in Detect mode and sets the cursor over a handle or a
 * proposal.
 */
export function RefinePointerController({ pressed }: { pressed: () => boolean }) {
  const get = useThree((s) => s.get);
  useEffect(() => {
    const raycaster = new Raycaster();
    raycaster.firstHitOnly = true;
    const ndc = new Vector2(),
      projected = new Vector3(),
      along = new Vector3(),
      normal = new Vector3(),
      normalMatrix = new Matrix3();
    const canvas = () => {
      const { events, gl } = get();
      return events.connected instanceof HTMLElement ? events.connected : gl.domElement;
    };

    // Registered first, so every pick made while a move is handled, here or by the canvas, sees it.
    const moveStarts = (event: PointerEvent) => (pointerMoving = event.type === 'pointermove');
    const moveEnds = () => (pointerMoving = false);
    window.addEventListener('pointermove', moveStarts, true);
    window.addEventListener('pointermove', moveEnds);

    /** The first surface of any part along the raycaster's ray, parts still indexing included. */
    const firstHit = () => {
      let nearest: Intersection | null = null;
      occlusionTest = true;
      try {
        for (const mesh of partMeshes.values()) {
          const hits = raycaster.intersectObject(mesh, false);
          if (hits.length && (!nearest || hits[0].distance < nearest.distance)) nearest = hits[0];
        }
      } finally {
        occlusionTest = false;
      }
      return nearest;
    };

    /** The hit under a client position on the part, or null off it or behind another part. */
    const intersectionAt = (partId: string, x: number, y: number) => {
      const own = partMeshes.get(partId);
      if (!own) return null;
      const rect = canvas().getBoundingClientRect();
      ndc.set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, get().camera);
      const nearest = firstHit();
      if (!nearest || nearest.object !== own || nearest.faceIndex == null) return null;
      return nearest;
    };
    const hitAt = (partId: string, x: number, y: number): GuidePoint | null => {
      const hit = intersectionAt(partId, x, y);
      return hit && { triangle: hit.faceIndex!, position: hit.point.toArray() };
    };
    surfaceHit = hitAt;

    /** Whether the session's part can be picked at pointer moves, read from its preview now. */
    const ready = () => surfaceReady(useEditor.getState().refine);

    /** Client position of a world point, or null behind the camera. */
    const toScreen = (camera: Camera, rect: DOMRect, x: number, y: number, z: number) => {
      projected.set(x, y, z).project(camera);
      if (projected.z > 1) return null;
      return [
        rect.left + ((projected.x + 1) / 2) * rect.width,
        rect.top + ((1 - projected.y) / 2) * rect.height,
      ] as const;
    };

    /**
     * A world point near the pointer as a pick candidate: its depth along the view ray through it,
     * the first surface along that ray, and its distance from that surface along the surface normal.
     */
    const candidate = <T,>(
      item: T,
      screen: number,
      x: number,
      y: number,
      z: number,
      ownDraft: RefineSession | null = null,
    ) => {
      const { camera } = get();
      projected.set(x, y, z).project(camera);
      ndc.set(projected.x, projected.y);
      raycaster.setFromCamera(ndc, camera);
      const depth = along.set(x, y, z).sub(raycaster.ray.origin).dot(raycaster.ray.direction);
      let hit = firstHit();
      // A selected guide's handle is seen through the draft its own session shows: the surface the
      // draft moved counts as it was, and the ray goes on to what lies behind it.
      const own = ownDraft && partMeshes.get(ownDraft.partId);
      for (let i = 0; own && hit?.object === own && i < 16; i++) {
        if (hit.faceIndex == null || !draftMoved(ownDraft, hit.faceIndex)) break;
        raycaster.near = hit.distance + 1e-6;
        hit = firstHit();
      }
      raycaster.near = 0;
      let offset: number | null = null;
      if (hit?.face) {
        // Normals follow the inverse transpose, so a scaled or mirrored part keeps true distances.
        normal
          .copy(hit.face.normal)
          .applyNormalMatrix(normalMatrix.getNormalMatrix(hit.object.matrixWorld));
        offset = along.set(x, y, z).sub(hit.point).dot(normal);
      }
      return { item, depth, surface: hit?.distance ?? null, offset, screen };
    };
    const allowance = (refine: RefineSession) => surfaceAllowance(refine.model?.step ?? Infinity);

    /** The visible handle within reach of a client position, among the selected guides'. */
    const handleAt = (refine: RefineSession, x: number, y: number, selectedOnly: boolean) => {
      const { camera } = get();
      const rect = canvas().getBoundingClientRect();
      const near: { handle: RefineHandle; d: number }[] = [];
      for (const handle of refineHandles(refine)) {
        if (selectedOnly && !refine.selected.includes(handle.feature)) continue;
        const spot = toScreen(camera, rect, ...handle.point.position);
        if (!spot) continue;
        const d = (spot[0] - x) ** 2 + (spot[1] - y) ** 2;
        if (d <= handlePick * handlePick) near.push({ handle, d });
      }
      return chooseCandidate(
        near.map(({ handle, d }) =>
          candidate(handle, d, ...handle.point.position, selectedOnly ? refine : null),
        ),
        allowance(refine),
      );
    };

    /** The pending edge whose visible drawn curve passes within reach of a client position. */
    const proposalAt = (refine: RefineSession, x: number, y: number) => {
      const { camera } = get();
      const rect = canvas().getBoundingClientRect();
      const pending = new Set(
        refine.features.filter((f) => f.state === 'pending').map((f) => f.id),
      );
      const reachable = proposalPick * proposalPick;
      const right = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion),
        rimPoint = new Vector3();
      const near: PickCandidate<string>[] = [];
      for (const [id, curve] of refineCurves) {
        if (!pending.has(id)) continue;
        // Curves whose bounding sphere lies well away on screen are skipped unprojected.
        const middle = toScreen(camera, rect, curve.centre.x, curve.centre.y, curve.centre.z);
        if (middle) {
          rimPoint.copy(curve.centre).addScaledVector(right, curve.radius);
          const rim = toScreen(camera, rect, rimPoint.x, rimPoint.y, rimPoint.z);
          const reach = rim
            ? Math.hypot(rim[0] - middle[0], rim[1] - middle[1]) * 2 + proposalPick
            : Infinity;
          if (Math.hypot(middle[0] - x, middle[1] - y) > reach) continue;
        }
        // The curve's point nearest the pointer on screen: segment start index and parameter.
        const { points } = curve;
        let nearest = reachable,
          at = -1,
          t = 0;
        let previous: readonly [number, number] | null = null;
        for (let i = 0; i < points.length; i += 3) {
          const spot = toScreen(camera, rect, points[i], points[i + 1], points[i + 2]);
          if (spot && previous) {
            const [d, u] = segmentDistance(x, y, previous[0], previous[1], spot[0], spot[1]);
            if (d <= nearest) [nearest, at, t] = [d, i - 3, u];
          } else if (spot && points.length === 3) {
            const d = (spot[0] - x) ** 2 + (spot[1] - y) ** 2;
            if (d <= nearest) [nearest, at, t] = [d, 0, 0];
          }
          previous = spot;
        }
        if (at < 0) continue;
        const b = points.length === 3 ? at : at + 3;
        const lerp = (k: number) => points[at + k] + (points[b + k] - points[at + k]) * t;
        near.push(candidate(id, nearest, lerp(0), lerp(1), lerp(2)));
      }
      return chooseCandidate(near, allowance(refine));
    };

    /** One stroke sample at a client position: a dab, or a point of the crease's current run. */
    const sampleAt = (d: Stroke, x: number, y: number) => {
      const point = hitAt(d.partId, x, y);
      if (point && d.runs) {
        if (!d.onPart) d.runs.push([]);
        d.runs.at(-1)!.push(point);
      } else if (point) useEditor.getState().moveRefineStroke(point);
      d.onPart = !!point;
      d.x = x;
      d.y = y;
    };
    /** Samples the path to (x, y) every few pixels; on release, at (x, y) itself too. */
    const sampleStroke = (d: Stroke, x: number, y: number, release = false) => {
      const [x0, y0] = [d.x, d.y];
      const dx = x - x0,
        dy = y - y0;
      const length = Math.hypot(dx, dy);
      const steps = Math.floor(length / strokeStep);
      for (let i = 1; i <= steps; i++) {
        const t = (i * strokeStep) / length;
        sampleAt(d, x0 + dx * t, y0 + dy * t);
      }
      if (release && (d.x !== x || d.y !== y)) sampleAt(d, x, y);
    };

    /** Paints where (x, y) falls on the part, when the part is the first thing there. */
    const paintAt = (d: Paint, x: number, y: number, erase: boolean, begin = false) => {
      const hit = intersectionAt(d.partId, x, y);
      if (!hit) return false;
      return useEditor.getState().paintRefineRegion(
        {
          partId: d.partId,
          point: hit.object.worldToLocal(hit.point.clone()).toArray(),
          normal: hit.face?.normal.toArray() ?? [0, 1, 0],
        },
        hit.faceIndex!,
        erase,
        begin,
      );
    };

    const dragHandle = (d: HandleDrag, x: number, y: number) => {
      if (!d.moved && Math.hypot(x - d.x, y - d.y) < dragStart) return;
      d.moved = true;
      const point = hitAt(d.partId, x, y);
      if (!point) return;
      const { handle } = d;
      // The first move of a drag starts its own undo step.
      useEditor
        .getState()
        .moveRefinePoint(handle.feature, handle.segment, handle.index, point, !d.began);
      d.began = true;
      d.current = point;
    };

    // The release of a press whose gesture was cancelled does nothing.
    let cancelledPointer: number | null = null;
    const swallowRelease = () => {
      swallowing = true;
      setTimeout(() => (swallowing = false));
    };
    const released = (event: PointerEvent) => {
      if (event.pointerId !== cancelledPointer) return;
      cancelledPointer = null;
      swallowRelease();
    };

    let unsubscribe: (() => void) | null = null;
    /** Lets go of the pointer: its listeners, its capture and the camera's controls. */
    const letGo = (d: Gesture) => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('blur', discard);
      canvas().removeEventListener('lostpointercapture', lost);
      try {
        canvas().releasePointerCapture(d.pointer);
      } catch {
        // Already released.
      }
      if (d.controls) d.controls.enabled = true;
      d.controls = null;
    };
    const end = () => {
      const d = gesture;
      if (!d) return null;
      gesture = null;
      letGo(d);
      window.removeEventListener('keydown', key, true);
      unsubscribe?.();
      unsubscribe = null;
      updateCursor();
      return d;
    };
    /** Ends the gesture leaving the session as it was before it. */
    const discard = () => {
      const d = end();
      if (!d) return;
      cancelledPointer = d.pointer;
      const state = useEditor.getState();
      if (d.kind === 'handle') {
        // A drag that moved the point puts the session back as it found it, history included.
        if (d.began) state.cancelRefineDrag();
        return;
      }
      if (d.kind === 'stroke') state.cancelRefineStroke();
    };

    const move = (event: PointerEvent) => {
      const d = gesture;
      if (!d || event.pointerId !== d.pointer) return;
      if (pressed()) return discard();
      if (d.kind === 'handle') return dragHandle(d, event.clientX, event.clientY);
      if (d.kind === 'paint') return void paintAt(d, event.clientX, event.clientY, event.altKey);
      const events = event.getCoalescedEvents?.() ?? [];
      for (const e of events.length ? events : [event]) sampleStroke(d, e.clientX, e.clientY);
    };
    const up = (event: PointerEvent) => {
      const d = gesture;
      if (!d || event.pointerId !== d.pointer) return;
      // In Detect, a paint click still reaches the part, to select a pending region under it.
      const click = Math.hypot(event.clientX - d.x, event.clientY - d.y) <= 5;
      if (!(d.kind === 'paint' && d.binding.mode === 'detect' && click)) swallowRelease();
      if (pressed()) return discard();
      if (d.kind === 'handle') dragHandle(d, event.clientX, event.clientY);
      else if (d.kind === 'paint') paintAt(d, event.clientX, event.clientY, event.altKey);
      else sampleStroke(d, event.clientX, event.clientY, true);
      end();
      const state = useEditor.getState();
      if (d.kind === 'paint') return;
      if (d.kind === 'stroke' && d.runs) {
        // A crease is one line: of a stroke that left the part and came back, the longest run.
        const [first, ...rest] = longestRun(d.runs);
        if (first) state.beginRefineStroke(first);
        for (const point of rest) state.moveRefineStroke(point);
      }
      if (d.kind === 'stroke') return state.endRefineStroke();
      // A click on the open path's first handle closes it.
      if (!d.moved && d.handle.first) state.addRefinePoint(d.handle.point, true);
    };
    const cancel = (event: PointerEvent) => {
      if (gesture && event.pointerId === gesture.pointer) discard();
    };
    const lost = (event: PointerEvent) => {
      if (gesture && event.pointerId === gesture.pointer) discard();
    };
    const key = (event: KeyboardEvent) => {
      if (!gesture || event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      discard();
    };

    const own = (d: Gesture, pointer: number) => {
      // The camera's controls see a press on the part after it; the gesture owns it instead.
      const controls = get().controls as { enabled: boolean } | null;
      d.controls = controls?.enabled ? controls : null;
      if (d.controls) d.controls.enabled = false;
      gesture = d;
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerup', up, true);
      window.addEventListener('pointercancel', cancel, true);
      window.addEventListener('blur', discard);
      window.addEventListener('keydown', key, true);
      const element = canvas();
      element.addEventListener('lostpointercapture', lost);
      try {
        element.setPointerCapture(pointer);
      } catch {
        // A pointer that is not active cannot be captured; window listeners still follow it.
      }
      // Anything that takes the pointer, the session, its part, mode or brush away ends it at once.
      unsubscribe = useEditor.subscribe((s) => {
        if (gesture === d && (bindingBroken(d.binding, s) || blocked(s))) discard();
      });
    };
    const base = (event: PointerEvent, partId: string, binding: GestureBinding) => ({
      pointer: event.pointerId,
      partId,
      binding,
      controls: null,
    });

    const pressable = (event: ThreeEvent<PointerEvent>) =>
      !gesture &&
      event.faceIndex != null &&
      event.button === 0 &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !blocked(useEditor.getState()) &&
      !pressed();

    /** Takes a press that would start a gesture while the surface has no index: nothing happens. */
    const refuse = (pointer: number) => {
      cancelledPointer = pointer;
      // A build someone cancelled is asked for again, so the surface does not stay unpickable.
      const { preview } = useEditor.getState().refine ?? {};
      if (preview && !surfaceReady({ preview })) prepareEditedForPicking(preview);
      updateCursor();
      return true;
    };

    starter = (event, partId) => {
      const state = useEditor.getState();
      const binding = gestureBinding(state, true);
      if (
        !binding ||
        !brushingRefine(state) ||
        binding.partId !== partId ||
        event.altKey ||
        !pressable(event)
      )
        return false;
      if (!pressGesture(state, true)) return refuse(event.pointerId);
      const { clientX: x, clientY: y } = event.nativeEvent;
      // A press on another part in front reaches this one too; it starts nothing.
      const first = hitAt(partId, x, y);
      if (!first) return false;
      const crease = binding.kind === 'crease';
      own(
        {
          ...base(event.nativeEvent, partId, binding),
          kind: 'stroke',
          x,
          y,
          onPart: true,
          runs: crease ? [[first]] : null,
        },
        event.pointerId,
      );
      // A crease is given to the store on release, as its longest run on the part.
      if (!crease) state.beginRefineStroke(first);
      return true;
    };

    painter = (event, partId) => {
      const state = useEditor.getState();
      const binding = gestureBinding(state, false);
      if (!binding || !paintingRefine(state) || binding.partId !== partId || !pressable(event))
        return false;
      if (!pressGesture(state, false)) return refuse(event.pointerId);
      const { clientX: x, clientY: y } = event.nativeEvent;
      const d: Paint = { ...base(event.nativeEvent, partId, binding), kind: 'paint', x, y };
      // As a brush stroke, only where the part is the first thing under the pointer.
      if (!paintAt(d, x, y, event.altKey, true)) return false;
      own(d, event.pointerId);
      return true;
    };

    let pressX: [number, number] = [0, 0];
    let unpress: (() => void) | null = null;
    // A press on a handle while the surface has no index: its click may still close the path.
    let pressedHandle: RefineHandle | null = null;
    const clearPress = () => {
      pressedProposal = null;
      pressedHandle = null;
      unpress?.();
      unpress = null;
    };
    // A handle near the part's outline may lie off it, so handles are taken before the part sees
    // the press, and before the camera does.
    const down = (event: PointerEvent) => {
      clearPress();
      cancelledPointer = null;
      const state = useEditor.getState(),
        refine = state.refine;
      const binding = gestureBinding(state, false);
      if (
        gesture ||
        !binding ||
        state.tool !== 'refine' ||
        refine?.stage !== 'ready' ||
        (refine.mode !== 'edge' && refine.mode !== 'detect') ||
        event.button !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        blocked(state) ||
        !canvas().contains(event.target as Node)
      )
        return;
      const handle = event.shiftKey ? null : handleAt(refine, event.clientX, event.clientY, true);
      if (handle) {
        event.stopImmediatePropagation();
        if (!pressGesture(state, false)) {
          pressedHandle = handle;
          pressX = [event.clientX, event.clientY];
          return;
        }
        own(
          {
            ...base(event, refine.partId, binding),
            kind: 'handle',
            handle,
            current: handle.point,
            x: event.clientX,
            y: event.clientY,
            moved: false,
          },
          event.pointerId,
        );
        return;
      }
      if (refine.mode !== 'detect') return;
      pressedProposal = proposalAt(refine, event.clientX, event.clientY);
      if (!pressedProposal) return;
      pressX = [event.clientX, event.clientY];
      const pointer = event.pointerId;
      // A pick belongs to the mode it was pressed in: leaving it forgets the pick, and its release.
      unpress = useEditor.subscribe((s) => {
        if (!bindingBroken(binding, s)) return;
        clearPress();
        cancelledPointer = pointer;
      });
    };
    const click = (event: MouseEvent) => {
      if (swallowing && canvas().contains(event.target as Node)) {
        event.stopImmediatePropagation();
        return;
      }
      const id = pressedProposal,
        handle = pressedHandle;
      clearPress();
      const still = Math.hypot(event.clientX - pressX[0], event.clientY - pressX[1]) <= 5;
      if (handle && canvas().contains(event.target as Node)) {
        // Its press was the handle's alone; a click on the open path's first handle closes it.
        event.stopImmediatePropagation();
        if (still && handle.first) useEditor.getState().addRefinePoint(handle.point, true);
        return;
      }
      if (!id || !still) return;
      const state = useEditor.getState(),
        refine = state.refine;
      if (!refine || state.tool !== 'refine') return;
      event.stopImmediatePropagation();
      const selected = refine.selected;
      state.selectRefine(
        event.shiftKey
          ? selected.includes(id)
            ? selected.filter((s) => s !== id)
            : [...selected, id]
          : [id],
      );
    };

    // The cursor: busy over the part while it has no index and one is being built, a pointer over a
    // handle or proposal.
    let shown: string | null = null,
      before = '',
      last: [number, number] | null = null,
      overHandle = false;
    /** Whether a client position falls in the screen bounds of the session's part. */
    const overPart = (x: number, y: number) => {
      const refine = useEditor.getState().refine;
      const mesh = refine && partMeshes.get(refine.partId);
      const geometry = refine?.preview;
      if (!mesh || !geometry) return false;
      if (!geometry.boundingSphere) geometry.computeBoundingSphere();
      bounds.copy(geometry.boundingSphere!).applyMatrix4(mesh.matrixWorld);
      const { camera } = get();
      const rect = canvas().getBoundingClientRect();
      const centre = toScreen(camera, rect, bounds.center.x, bounds.center.y, bounds.center.z);
      if (!centre) return true;
      // The sphere's screen radius, from a point on it square to the view.
      along.set(1, 0, 0).applyQuaternion(camera.quaternion).multiplyScalar(bounds.radius);
      along.add(bounds.center);
      const rim = toScreen(camera, rect, along.x, along.y, along.z);
      const radius = rim ? Math.hypot(rim[0] - centre[0], rim[1] - centre[1]) : Infinity;
      return Math.hypot(x - centre[0], y - centre[1]) <= radius;
    };
    function updateCursor() {
      const state = useEditor.getState();
      const busy =
        state.tool === 'refine' &&
        state.refine?.stage === 'ready' &&
        state.indexingMeshes > 0 &&
        !ready() &&
        !!last &&
        overPart(...last);
      const want = busy ? 'progress' : overHandle ? 'pointer' : null;
      if (want === shown) return;
      if (want && shown === null) before = document.body.style.cursor;
      if (want) document.body.style.cursor = want;
      else if (document.body.style.cursor === shown) document.body.style.cursor = before;
      shown = want;
    }
    const hover = (event: PointerEvent) => {
      const state = useEditor.getState(),
        refine = state.refine;
      last = canvas().contains(event.target as Node) ? [event.clientX, event.clientY] : null;
      let over = false;
      // Nothing is highlighted until the surface can be picked as the pointer moves.
      if (
        !gesture &&
        last &&
        ready() &&
        state.tool === 'refine' &&
        refine?.stage === 'ready' &&
        !blocked(state)
      ) {
        if (refine.mode === 'edge' || refine.mode === 'detect')
          over = !!handleAt(refine, event.clientX, event.clientY, true);
        if (!over && refine.mode === 'detect')
          over = !!proposalAt(refine, event.clientX, event.clientY);
      }
      overHandle = over;
      updateCursor();
    };
    // The index arriving, or its build ending, updates the cursor without waiting for a move.
    const unready = useEditor.subscribe((s, previous) => {
      if (s.indexingMeshes !== previous.indexingMeshes || s.refine !== previous.refine)
        updateCursor();
    });

    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', released, true);
    window.addEventListener('click', click, true);
    window.addEventListener('pointermove', hover);
    return () => {
      discard();
      starter = null;
      painter = null;
      surfaceHit = null;
      clearPress();
      unready();
      pointerMoving = false;
      window.removeEventListener('pointermove', moveStarts, true);
      window.removeEventListener('pointermove', moveEnds);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', released, true);
      window.removeEventListener('click', click, true);
      window.removeEventListener('pointermove', hover);
      if (shown && document.body.style.cursor === shown) document.body.style.cursor = before;
    };
  }, [get, pressed]);
  return null;
}

/**
 * For a Mesh drawing a Refine preview: picks the preview itself, with the tree the store keeps on
 * it. A preview a cut has just rewritten has no tree until its index is built: until then a press
 * or a click tests every triangle (with `shows`, only hits it shows), and a pointer move finds
 * nothing, so the frame stays responsive; no gesture starts meanwhile.
 */
export function previewRaycast(
  pick: Mesh['raycast'],
  shows?: (point: Vector3) => boolean,
): Mesh['raycast'] {
  return function (this: Mesh, raycaster, intersects) {
    if (useEditor.getState().freeTransform) return;
    if (!unindexed(this.geometry)) return pick.call(this, raycaster, intersects);
    if (pointerMoving) return;
    exactNearest(this, raycaster, intersects, shows);
  };
}
