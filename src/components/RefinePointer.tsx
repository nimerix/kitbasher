import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import type { ThreeEvent } from '@react-three/fiber';
import {
  Box3,
  Matrix3,
  Matrix4,
  Mesh,
  Ray,
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
  refineDrawingPlane,
  useEditor,
  type RefineMode,
  type RefineSession,
} from '../core/store';
import type { GuidePoint } from '../core/refine-band';
import { drawnCurve } from '../core/refine-curve';
import { lineNearRay, pointAt, rayOnPlane } from '../core/refine-sketch';
import type { RefineMesh } from '../core/refine-mesh';
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
/** A press that travels more than this many pixels is no click, as the part's own clicks count it. */
const clickSlop = 5;
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
  box = new Box3(),
  localRay = new Ray(),
  inverse = new Matrix4();
// Set when a move's ray passed close to a part that has no index, so its answer is not known.
let nearUnindexed = false;

const entry = new Vector3();

/**
 * Where a world ray enters a mesh's bounding box, as a distance along the ray (0 from inside it),
 * or null when it misses the box.
 */
export function boundsEntry(ray: Ray, mesh: Mesh) {
  const geometry = mesh.geometry;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  box.copy(geometry.boundingBox!);
  localRay.copy(ray).applyMatrix4(inverse.copy(mesh.matrixWorld).invert());
  if (box.containsPoint(localRay.origin)) return 0;
  if (!localRay.intersectBox(box, entry)) return null;
  return entry.applyMatrix4(mesh.matrixWorld).distanceTo(ray.origin);
}

/** Whether a world ray passes through a mesh's bounding box, in the mesh's own space. */
export const rayCrossesBounds = (ray: Ray, mesh: Mesh) => boundsEntry(ray, mesh) !== null;

/**
 * A gesture's samples in their order: one is handled at once while none waits before it and it
 * needs no exact answer from a part with no index; otherwise it waits, and those waiting are
 * handled in order, each with its own exact answer, as time allows.
 */
export class OrderedSamples<T> {
  private queue: T[] = [];
  get waiting() {
    return this.queue.length > 0;
  }
  /** Whether a sample must wait: one already does. */
  behind() {
    return this.waiting;
  }
  hold(sample: T) {
    this.queue.push(sample);
  }
  /** Handles waiting samples in order while `more()` allows; true when some still wait. */
  drain(handle: (sample: T) => void, more: () => boolean) {
    while (this.queue.length && more()) handle(this.queue.shift()!);
    return this.waiting;
  }
  clear() {
    this.queue.length = 0;
  }
}

/** Whether a press stays a click: no sample of it, coalesced ones included, left the slop. */
export class PressTrack {
  moved = false;
  constructor(
    readonly x: number,
    readonly y: number,
    private readonly slop: number,
  ) {}
  see(x: number, y: number) {
    if (Math.hypot(x - this.x, y - this.y) > this.slop) this.moved = true;
  }
}

/**
 * For a part's Mesh: while Refine asks what lies first under the pointer, a part with no index yet
 * is never seen through. Outside a pointer move its every triangle is tested. A move whose ray
 * passes through its bounds is not answered: it counts as blocked and is marked, so the caller
 * skips that sample and may ask again, exactly, once the frame's events are handled.
 */
export function occludingRaycast(pick: Mesh['raycast']): Mesh['raycast'] {
  return function (this: Mesh, raycaster, intersects) {
    if (!occlusionTest || !unindexed(this.geometry)) return pick.call(this, raycaster, intersects);
    // With the edited surface's own hit as the ray's far end, a part whose bounds begin beyond it
    // cannot cover it.
    if (raycaster.far < Infinity) {
      const enters = boundsEntry(raycaster.ray, this);
      if (enters === null || enters > raycaster.far) return;
    }
    if (!pointerMoving) return exactNearest(this, raycaster, intersects);
    if (!rayCrossesBounds(raycaster.ray, this)) return;
    nearUnindexed = true;
    intersects.push({ distance: 0, point: raycaster.ray.origin.clone(), object: this });
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
  const kept = shows ? hits.filter((hit) => shows(hit.point)) : hits;
  if (!raycaster.firstHitOnly) return void intersects.push(...kept);
  let nearest: Intersection | null = null;
  for (const hit of kept) if (!nearest || hit.distance < nearest.distance) nearest = hit;
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
  /** Set once released while samples still wait for exact answers. */
  waiting?: boolean;
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
/** A press the tool refused while the surface has no index: it owns the pointer and does nothing. */
interface Refused extends GestureBase {
  kind: 'refused';
  /** Every sample of the press, from down to release; once one leaves the slop it is no click. */
  track: PressTrack;
  /** For a press on a handle, the click that may still close its path. */
  click: HandleClick | null;
  region: { id: string; triangle: number; model: RefineSession['model'] } | null;
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
type Gesture = Stroke | Paint | HandleDrag | Refused;

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

/** The pending Detect region covering a picked triangle. */
export const refineRegionAt = (refine: RefineSession, triangle: number) =>
  refine.features.find(
    (f) =>
      f.state === 'pending' &&
      f.feature.type === 'region' &&
      f.feature.input.triangles.includes(triangle),
  );

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

/** Whether triangle `t` of the surface the session shows is the model's own triangle `t`, unmoved. */
export function sameAsModel(refine: Pick<RefineSession, 'draft' | 'model'>, t: number) {
  const draft = refine.draft,
    model = refine.model?.mesh;
  if (!model || !(t < model.triangleCount)) return false;
  if (!draft || draft === model) return true;
  if (!(t < draft.triangleCount)) return false;
  for (let k = 0; k < 3; k++) {
    const v = draft.weldOf[draft.corners[t * 3 + k]];
    if (v !== model.weldOf[model.corners[t * 3 + k]]) return false;
    for (let a = 0; a < 3; a++)
      if (draft.position[v * 3 + a] !== model.position[v * 3 + a]) return false;
  }
  return true;
}

const changedByDraft = new WeakMap<object, Uint32Array>();
/** The model's triangles that the draft does not show unchanged in their place, kept per draft. */
export function changedModelTriangles(refine: Pick<RefineSession, 'draft' | 'model'>) {
  const { draft, model } = refine;
  if (!draft || !model || draft === model.mesh) return new Uint32Array(0);
  let changed = changedByDraft.get(draft);
  if (!changed) {
    const list: number[] = [];
    for (let t = 0; t < model.mesh.triangleCount; t++) if (!sameAsModel(refine, t)) list.push(t);
    changed = Uint32Array.from(list);
    changedByDraft.set(draft, changed);
  }
  return changed;
}

/** A surface crossing in world space: distance along the ray, the point and the unit normal there. */
export interface SurfaceCrossing {
  distance: number;
  point: Vector3;
  normal: Vector3;
  /** The model triangle crossed, when the crossing is on the session's own model surface. */
  triangle?: number;
}

/** Where a world ray meets the plane of triangle `t` of a mesh, from its own positions. */
export function trianglePlaneHit(
  mesh: Pick<RefineMesh, 'position' | 'weldOf' | 'corners'>,
  t: number,
  ray: Ray,
): Vector3 | null {
  const { position, weldOf, corners } = mesh;
  const corner = (k: number) => {
    const o = weldOf[corners[t * 3 + k]] * 3;
    return new Vector3(position[o], position[o + 1], position[o + 2]);
  };
  const a = corner(0);
  const n = corner(1).sub(a).cross(corner(2).sub(a));
  const facing = n.dot(ray.direction);
  if (Math.abs(facing) < 1e-18) return null;
  return ray.at(a.sub(ray.origin).dot(n) / facing, new Vector3());
}

/** The nearest crossing beyond `near` of a world ray with the listed triangles of a mesh, either side. */
export function trianglesHit(
  mesh: Pick<RefineMesh, 'position' | 'weldOf' | 'corners'>,
  triangles: ArrayLike<number>,
  ray: Ray,
  near = 0,
): SurfaceCrossing | null {
  const { position, weldOf, corners } = mesh;
  const [ox, oy, oz] = [ray.origin.x, ray.origin.y, ray.origin.z];
  const [dx, dy, dz] = [ray.direction.x, ray.direction.y, ray.direction.z];
  let best = Infinity,
    bestT = -1;
  for (let i = 0; i < triangles.length; i++) {
    const t = triangles[i];
    const a = weldOf[corners[t * 3]] * 3,
      b = weldOf[corners[t * 3 + 1]] * 3,
      c = weldOf[corners[t * 3 + 2]] * 3;
    const e1x = position[b] - position[a],
      e1y = position[b + 1] - position[a + 1],
      e1z = position[b + 2] - position[a + 2];
    const e2x = position[c] - position[a],
      e2y = position[c + 1] - position[a + 1],
      e2z = position[c + 2] - position[a + 2];
    const px = dy * e2z - dz * e2y,
      py = dz * e2x - dx * e2z,
      pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-18) continue;
    const sx = ox - position[a],
      sy = oy - position[a + 1],
      sz = oz - position[a + 2];
    const u = (sx * px + sy * py + sz * pz) / det;
    if (u < 0 || u > 1) continue;
    const qx = sy * e1z - sz * e1y,
      qy = sz * e1x - sx * e1z,
      qz = sx * e1y - sy * e1x;
    const v = (dx * qx + dy * qy + dz * qz) / det;
    if (v < 0 || u + v > 1) continue;
    const distance = (e2x * qx + e2y * qy + e2z * qz) / det;
    if (distance >= near && distance < best) [best, bestT] = [distance, t];
  }
  if (bestT < 0) return null;
  const a = weldOf[corners[bestT * 3]] * 3,
    b = weldOf[corners[bestT * 3 + 1]] * 3,
    c = weldOf[corners[bestT * 3 + 2]] * 3;
  const corner = (o: number) => new Vector3(position[o], position[o + 1], position[o + 2]);
  const [pa, pb, pc] = [corner(a), corner(b), corner(c)];
  const normal = pb.sub(pa).cross(pc.sub(pa)).normalize();
  return { distance: best, point: ray.at(best, new Vector3()), normal, triangle: bestT };
}

/** Whether a press on a handle in the index gap may still close its path as a click. */
export interface HandleClick {
  session: string;
  mode: RefineMode;
  handle: RefineHandle;
  /** The guide as it was when pressed. */
  feature: unknown;
}

/** Whether a remembered handle click still holds: the same handle of the same selected guide. */
export function handleClickHolds(press: HandleClick, refine: RefineSession | null | undefined) {
  if (!refine || refine.id !== press.session || refine.mode !== press.mode) return false;
  const { handle } = press;
  if (!refine.selected.includes(handle.feature)) return false;
  const f = refine.features.find((f) => f.id === handle.feature);
  if (!f || f.state !== 'pending' || f.feature !== press.feature) return false;
  if (f.feature.type !== 'edge') return false;
  return f.feature.input.segments[handle.segment]?.points[handle.index] === handle.point;
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
    const firstHit = (skip?: Mesh) => {
      let nearest: Intersection | null = null;
      occlusionTest = true;
      try {
        for (const mesh of partMeshes.values()) {
          if (mesh === skip) continue;
          const hits = raycaster.intersectObject(mesh, false);
          if (hits.length && (!nearest || hits[0].distance < nearest.distance)) nearest = hits[0];
        }
      } finally {
        occlusionTest = false;
      }
      return nearest;
    };

    /** Points the raycaster through a client position. */
    const aimAt = (x: number, y: number) => {
      const rect = canvas().getBoundingClientRect();
      ndc.set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, get().camera);
    };

    /**
     * The first hit of the other parts along the ray, up to `far`: what lies beyond the part's own
     * hit cannot cover it, so a part with no index there is not tested at all.
     */
    const firstHitBefore = (own: Mesh, far: number) => {
      raycaster.far = far;
      try {
        return firstHit(own);
      } finally {
        raycaster.far = Infinity;
      }
    };

    /** The hit on the current ray, or null off the part or behind another part. */
    const intersectionOnRay = (partId: string) => {
      const own = partMeshes.get(partId);
      if (!own) return null;
      const hits = raycaster.intersectObject(own, false);
      const mine = hits[0]?.faceIndex != null ? hits[0] : null;
      if (!mine) return null;
      const other = firstHitBefore(own, mine.distance);
      return other && other.distance <= mine.distance ? null : mine;
    };
    const hitOnRay = (partId: string): GuidePoint | null => {
      const hit = intersectionOnRay(partId);
      return hit && { triangle: hit.faceIndex!, position: hit.point.toArray() };
    };
    surfaceHit = (partId, x, y) => {
      aimAt(x, y);
      return hitOnRay(partId);
    };

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
      const own = ownDraft && partMeshes.get(ownDraft.partId);
      const front = own && ownDraft ? modelFront(ownDraft, own) : crossing(firstHit());
      const offset = front ? along.set(x, y, z).sub(front.point).dot(front.normal) : null;
      return { item, depth, surface: front?.distance ?? null, offset, screen };
    };

    /** A hit as a world crossing; its normal follows the inverse transpose of the part's matrix. */
    const crossing = (hit: Intersection | null | undefined): SurfaceCrossing | null => {
      if (!hit?.face) return hit ? { distance: hit.distance, point: hit.point, normal } : null;
      normal
        .copy(hit.face.normal)
        .applyNormalMatrix(normalMatrix.getNormalMatrix(hit.object.matrixWorld));
      return { distance: hit.distance, point: hit.point, normal: normal.clone() };
    };

    /**
     * The first surface along the raycaster's ray with the session's part taken as its model, not
     * the draft it shows: other parts as they are; the part's triangles the draft left unchanged
     * from the preview's own picking; the triangles it changed from the model's positions.
     */
    const modelFront = (refine: RefineSession, own: Mesh, bounded = false) => {
      const model = refine.model?.mesh;
      if (!model) return crossing(firstHit(own));
      raycaster.firstHitOnly = false;
      const hits = raycaster.intersectObject(own, false);
      raycaster.firstHitOnly = true;
      const kept = hits.find((h) => h.faceIndex != null && sameAsModel(refine, h.faceIndex));
      let mine: SurfaceCrossing | null = kept
        ? { ...crossing(kept)!, triangle: kept.faceIndex! }
        : null;
      const changed = trianglesHit(model, changedModelTriangles(refine), raycaster.ray);
      if (changed && (!mine || changed.distance < mine.distance)) mine = changed;
      const other = crossing(
        bounded ? firstHitBefore(own, mine ? mine.distance : Infinity) : firstHit(own),
      );
      return other && (!mine || other.distance <= mine.distance) ? other : mine;
    };

    /**
     * The spot on the current ray on the session's model surface, the working surface without
     * the draft, or null off it or behind another part. Its position comes from the model triangle
     * alone, so a draft rebuilt sooner or later cannot move where a dragged point lands.
     */
    const modelHitOnRay = (partId: string): GuidePoint | null => {
      const refine = useEditor.getState().refine;
      const own = partMeshes.get(partId);
      const model = refine?.model?.mesh;
      if (!refine || !own || !model) return null;
      const front = modelFront(refine, own, true);
      if (front?.triangle === undefined) return null;
      const point = trianglePlaneHit(model, front.triangle, raycaster.ray);
      return point && { triangle: front.triangle, position: point.toArray() };
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

    /**
     * The segment of a guide drawn as handles whose drawn line passes within reach of a client
     * position on screen, nearest first; null when none does.
     */
    const segmentAt = (refine: RefineSession, x: number, y: number) => {
      const { camera } = get();
      const rect = canvas().getBoundingClientRect();
      const ids = new Set(refineHandles(refine).map((h) => h.feature));
      type Found = { feature: string; segment: number };
      let best = null as Found | null,
        nearest = proposalPick * proposalPick;
      for (const f of refine.features) {
        if (!ids.has(f.id) || f.feature.type !== 'edge') continue;
        f.feature.input.segments.forEach((segment, index) => {
          if (segment.points.length < 2) return;
          const curve = drawnCurve(
            segment.kind,
            segment.points.flatMap((p) => p.position),
            refine.model?.step ?? 0.05,
            64,
          );
          let previous: readonly [number, number] | null = null;
          for (let i = 0; i < curve.points.length; i += 3) {
            const spot = toScreen(
              camera,
              rect,
              ...(curve.points.subarray(i, i + 3) as unknown as [number, number, number]),
            );
            if (spot && previous) {
              const [d] = segmentDistance(x, y, previous[0], previous[1], spot[0], spot[1]);
              if (d <= nearest) [nearest, best] = [d, { feature: f.id, segment: index }];
            }
            previous = spot;
          }
        });
      }
      return best;
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

    /** A position of a gesture's path, or, last, its release. */
    type Sample = { gesture: Gesture } & ({ ray: Ray; erase: boolean } | { release: true });
    // Samples that need an exact answer from a part with no index wait here, in order, with every
    // later sample of their gesture behind them; each is answered exactly, never from another ray.
    const samples = new OrderedSamples<Sample>();
    let drainFrame = 0;
    /** Time a frame may spend answering waiting samples exactly, in ms. */
    const drainBudget = 8;
    const drainSamples = (more: () => boolean) => {
      const state = useEditor.getState();
      const repaint = gesture?.kind === 'paint' && !state.painting;
      if (repaint) useEditor.setState({ painting: true });
      try {
        return samples.drain(handleSample, more);
      } finally {
        if (repaint) useEditor.getState().endPaintStroke();
      }
    };
    const scheduleDrain = () => {
      if (drainFrame) return;
      drainFrame = requestAnimationFrame(() => {
        drainFrame = 0;
        const start = performance.now();
        let answered = 0;
        // At least one each frame, so a slow exact answer cannot stall the queue.
        if (drainSamples(() => !answered++ || performance.now() - start < drainBudget))
          scheduleDrain();
      });
    };
    // Time this frame has spent on exact answers inside pointer moves, in ms.
    let spent = 0,
      spentFrame = 0;
    const charge = (ms: number) => {
      spent += ms;
      if (!spentFrame)
        spentFrame = requestAnimationFrame(() => {
          spent = 0;
          spentFrame = 0;
        });
    };
    /**
     * Handles one sample now: at once when it needs no exact answer; with its own exact answer
     * while this frame's budget lasts; else it waits, as does every sample after one that waits.
     */
    const offer = (d: Gesture, x: number, y: number, erase = false) => {
      aimAt(x, y);
      if (!samples.behind()) {
        if (handlePath(d, erase, true)) return;
        if (spent < drainBudget) {
          const start = performance.now();
          const moving = pointerMoving;
          // Picks made outside a move test a part with no index exactly, for this ray alone.
          pointerMoving = false;
          try {
            handlePath(d, erase, false);
          } finally {
            pointerMoving = moving;
            charge(performance.now() - start);
          }
          return;
        }
      }
      samples.hold({ gesture: d, ray: raycaster.ray.clone(), erase });
      scheduleDrain();
    };
    const handleSample = (sample: Sample) => {
      const d = sample.gesture;
      if (gesture !== d) return;
      if ('release' in sample) return finish(d);
      raycaster.ray.copy(sample.ray);
      handlePath(d, sample.erase, false);
    };
    const handlePath = (d: Gesture, erase: boolean, live: boolean) => {
      if (d.kind === 'stroke') return strokeSample(d, live);
      if (d.kind === 'paint') return paintSample(d, erase, live);
      if (d.kind === 'handle') return dragSample(d, live);
      return true;
    };

    /** Runs one sample's pick, and whether it lay near an unindexed part, so it must wait. */
    const nearPick = <T,>(pick: () => T): [T, boolean] => {
      nearUnindexed = false;
      const value = pick();
      const near = nearUnindexed && pointerMoving;
      nearUnindexed = false;
      return [value, near];
    };

    /**
     * One stroke sample: a dab, or a point of the crease's current run. With `live`, false is
     * returned without acting when the sample needs an exact answer.
     */
    const strokeSample = (d: Stroke, live: boolean) => {
      const [point, near] = nearPick(() => hitOnRay(d.partId));
      if (near && live) return false;
      if (point && d.runs) {
        if (!d.onPart) d.runs.push([]);
        d.runs.at(-1)!.push(point);
      } else if (point) useEditor.getState().moveRefineStroke(point);
      d.onPart = !!point;
      return true;
    };
    const sampleAt = (d: Stroke, x: number, y: number) => {
      d.x = x;
      d.y = y;
      offer(d, x, y);
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

    /** Paints where the sample's ray first hits the part. */
    const paintSample = (d: Paint, erase: boolean, live: boolean) => {
      const [hit, near] = nearPick(() => intersectionOnRay(d.partId));
      if (near && live) return false;
      if (!hit) return true;
      const { object, point, face, faceIndex } = hit;
      useEditor.getState().paintRefineRegion(
        {
          partId: d.partId,
          point: object.worldToLocal(point.clone()).toArray(),
          normal: face?.normal.toArray() ?? [0, 1, 0],
        },
        faceIndex!,
        erase,
      );
      return true;
    };
    /** The press of a paint stroke: answered exactly, as every press is. */
    const paintPress = (d: Paint, x: number, y: number, erase: boolean) => {
      aimAt(x, y);
      const hit = intersectionOnRay(d.partId);
      if (!hit) return false;
      const { object, point, face, faceIndex } = hit;
      return useEditor.getState().paintRefineRegion(
        {
          partId: d.partId,
          point: object.worldToLocal(point.clone()).toArray(),
          normal: face?.normal.toArray() ?? [0, 1, 0],
        },
        faceIndex!,
        erase,
        true,
      );
    };

    /**
     * Where a point locked to a line, or of a guide on a plane, goes under the sample: the line's
     * point nearest the ray, or where the ray meets the plane. Undefined for a free point.
     */
    const heldOnRay = (d: HandleDrag): GuidePoint | null | undefined => {
      const refine = useEditor.getState().refine;
      const feature = refine?.features.find((f) => f.id === d.handle.feature)?.feature;
      if (!refine?.model || feature?.type !== 'edge') return undefined;
      const { lock } = d.current;
      const plane = feature.input.plane;
      if (lock?.kind !== 'line' && !plane) return undefined;
      const { origin, direction } = raycaster.ray;
      const o = origin.toArray(),
        dir = direction.toArray();
      const position =
        lock?.kind === 'line' ? lineNearRay(lock, o, dir) : rayOnPlane(plane!, o, dir);
      if (!position) return null;
      const point = pointAt(refine.model.mesh, position);
      return point && { ...point, ...(lock ? { lock } : {}) };
    };

    /** Moves the dragged point to the model surface under the sample, or along its lock. */
    const dragSample = (d: HandleDrag, live: boolean) => {
      if (d.current.lock?.kind === 'fixed') return true;
      const held = heldOnRay(d);
      if (held !== undefined) {
        if (!held) return true;
        const { handle } = d;
        useEditor
          .getState()
          .moveRefinePoint(handle.feature, handle.segment, handle.index, held, !d.began);
        d.began = true;
        d.current = held;
        return true;
      }
      const [point, near] = nearPick(() => modelHitOnRay(d.partId));
      if (near && live) return false;
      if (!point) return true;
      const { handle } = d;
      // The first move of a drag starts its own undo step.
      useEditor
        .getState()
        .moveRefinePoint(handle.feature, handle.segment, handle.index, point, !d.began);
      d.began = true;
      d.current = { ...point, ...(d.current.lock ? { lock: d.current.lock } : {}) };
      return true;
    };
    const dragHandle = (d: HandleDrag, x: number, y: number) => {
      if (!d.moved && Math.hypot(x - d.x, y - d.y) < dragStart) return;
      d.moved = true;
      offer(d, x, y);
    };

    /** Completes a released gesture once every sample of it is handled. */
    const finish = (d: Gesture) => {
      if (gesture !== d) return;
      end();
      const state = useEditor.getState();
      if (d.kind === 'paint' || d.kind === 'refused') return;
      if (d.kind === 'stroke' && d.runs) {
        // A crease is one line: of a stroke that left the part and came back, the longest run.
        const [first, ...rest] = longestRun(d.runs);
        if (first) state.beginRefineStroke(first);
        for (const point of rest) state.moveRefineStroke(point);
      }
      if (d.kind === 'stroke') return state.endRefineStroke();
      state.endRefineDrag();
      if (!d.moved) state.clickRefinePoint(d.handle.feature, d.handle.segment, d.handle.index);
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
      samples.clear();
      if (drainFrame) cancelAnimationFrame(drainFrame);
      drainFrame = 0;
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
      if (!d.waiting) cancelledPointer = d.pointer;
      const state = useEditor.getState();
      if (d.kind === 'handle') {
        state.cancelRefineDrag();
        return;
      }
      if (d.kind === 'stroke') state.cancelRefineStroke();
      if (d.kind === 'paint') state.endPaintStroke();
    };

    const move = (event: PointerEvent) => {
      const d = gesture;
      if (!d || d.waiting || event.pointerId !== d.pointer) return;
      if (pressed()) return discard();
      if (d.kind === 'refused') {
        // Every sample counts, coalesced ones included: once one leaves the slop it is no click.
        const events = event.getCoalescedEvents?.() ?? [];
        for (const e of [...events, event]) d.track.see(e.clientX, e.clientY);
        return;
      }
      if (d.kind === 'handle') return dragHandle(d, event.clientX, event.clientY);
      if (d.kind === 'paint') return void offer(d, event.clientX, event.clientY, event.altKey);
      const events = event.getCoalescedEvents?.() ?? [];
      for (const e of events.length ? events : [event]) sampleStroke(d, e.clientX, e.clientY);
    };
    const up = (event: PointerEvent) => {
      const d = gesture;
      if (!d || d.waiting || event.pointerId !== d.pointer) return;
      if (d.kind === 'refused') d.track.see(event.clientX, event.clientY);
      const detectClick =
        d.kind === 'paint' &&
        d.binding.mode === 'detect' &&
        Math.hypot(event.clientX - d.x, event.clientY - d.y) <= clickSlop;
      if (!detectClick) swallowRelease();
      if (pressed()) return discard();
      if (d.kind === 'refused') {
        end();
        if (d.track.moved) return;
        const state = useEditor.getState();
        const { refine } = state;
        if (d.click && handleClickHolds(d.click, refine)) {
          const { feature, segment, index } = d.click.handle;
          state.clickRefinePoint(feature, segment, index);
        }
        const region = d.region;
        if (
          region &&
          refine?.model === region.model &&
          refine.features.some(
            (f) =>
              f.id === region.id &&
              f.state === 'pending' &&
              f.feature.type === 'region' &&
              f.feature.input.triangles.includes(region.triangle),
          )
        )
          state.selectRefine([region.id]);
        return;
      }
      if (d.kind === 'handle') dragHandle(d, event.clientX, event.clientY);
      else if (d.kind === 'paint') offer(d, event.clientX, event.clientY, event.altKey);
      else sampleStroke(d, event.clientX, event.clientY, true);
      if (!samples.waiting) return finish(d);
      // Samples still wait for exact answers: the pointer is let go, and the gesture ends after them.
      samples.hold({ gesture: d, release: true });
      d.waiting = true;
      letGo(d);
    };
    const cancel = (event: PointerEvent) => {
      if (gesture && !gesture.waiting && event.pointerId === gesture.pointer) discard();
    };
    const lost = (event: PointerEvent) => {
      if (gesture && !gesture.waiting && event.pointerId === gesture.pointer) discard();
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
      unsubscribe = useEditor.subscribe((s, previous) => {
        if (gesture !== d) return;
        if (bindingBroken(d.binding, s) || (!d.waiting && blocked(s))) return discard();
        if (d.kind === 'paint' || d.kind === 'stroke') {
          const before = previous.refine!;
          const after = s.refine!;
          if (
            after.model !== before.model ||
            after.undo !== before.undo ||
            after.redo !== before.redo ||
            after.selected.length !== before.selected.length ||
            after.selected.some((id, i) => id !== before.selected[i]) ||
            (d.kind === 'paint' && after.detect.where !== before.detect.where)
          )
            return discard();
        }
        // A refused handle press is a click on that handle of that selected guide, or nothing.
        if (d.kind === 'refused' && d.click && !handleClickHolds(d.click, s.refine)) d.click = null;
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

    /**
     * What a press would start, or null while the session's surface has no index; every press
     * path asks here, and a refused one asks for the index again, in case its build was cancelled.
     */
    const gate = (state: ReturnType<typeof useEditor.getState>, stroke: boolean) => {
      const binding = pressGesture(state, stroke);
      const preview = state.refine?.preview;
      if (!binding && preview && !surfaceReady({ preview })) prepareEditedForPicking(preview);
      return binding;
    };

    /**
     * Takes a press the tool refuses while the surface has no index: it owns the pointer, so the
     * camera does not take the drag either, and does nothing else.
     */
    const refuse = (
      event: PointerEvent,
      partId: string,
      binding: GestureBinding,
      click: HandleClick | null = null,
      region: Refused['region'] = null,
    ) => {
      own(
        {
          ...base(event, partId, binding),
          kind: 'refused',
          // A handle's click ends where its drag would begin; a Detect click where the part's does.
          track: new PressTrack(event.clientX, event.clientY, click ? dragStart : clickSlop),
          click,
          region,
        },
        event.pointerId,
      );
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
      if (!gate(state, true)) return refuse(event.nativeEvent, partId, binding);
      const { clientX: x, clientY: y } = event.nativeEvent;
      // A press on another part in front reaches this one too; it starts nothing.
      aimAt(x, y);
      const first = hitOnRay(partId);
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
      const { clientX: x, clientY: y } = event.nativeEvent;
      if (!gate(state, false)) {
        const { refine } = state;
        if (refine?.mode !== 'detect') return refuse(event.nativeEvent, partId, binding);
        aimAt(x, y);
        const triangle = intersectionOnRay(partId)?.faceIndex;
        const region = triangle != null && refineRegionAt(refine, triangle);
        return refuse(
          event.nativeEvent,
          partId,
          binding,
          null,
          region && triangle != null ? { id: region.id, triangle, model: refine.model } : null,
        );
      }
      const d: Paint = { ...base(event.nativeEvent, partId, binding), kind: 'paint', x, y };
      // As a brush stroke, only where the part is the first thing under the pointer.
      if (!paintPress(d, x, y, event.altKey)) return false;
      own(d, event.pointerId);
      return true;
    };

    let pressX: [number, number] = [0, 0];
    /** Where the last primary press went down, for telling a click from a drag. */
    let pressAt: [number, number] = [0, 0];
    let unpress: (() => void) | null = null;
    const clearPress = () => {
      pressedProposal = null;
      unpress?.();
      unpress = null;
    };
    // A handle near the part's outline may lie off it, so handles are taken before the part sees
    // the press, and before the camera does.
    const down = (event: PointerEvent) => {
      clearPress();
      cancelledPointer = null;
      if (event.button === 0) pressAt = [event.clientX, event.clientY];
      if (gesture?.waiting && event.button === 0 && canvas().contains(event.target as Node))
        drainSamples(() => true);
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
        !canvas().contains(event.target as Node) ||
        // While the session waits for picks, a press on a handle picks it on its click.
        refine.picking
      )
        return;
      const handle = event.shiftKey ? null : handleAt(refine, event.clientX, event.clientY, true);
      if (handle) {
        event.stopImmediatePropagation();
        if (!gate(state, false)) {
          const feature = refine.features.find((f) => f.id === handle.feature)?.feature;
          const click = { session: refine.id, mode: refine.mode, handle, feature };
          refuse(event, refine.partId, binding, click);
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
        state.beginRefineDrag();
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
      if (sketchClick(event)) {
        event.stopImmediatePropagation();
        clearPress();
        return;
      }
      const id = pressedProposal;
      clearPress();
      const still = Math.hypot(event.clientX - pressX[0], event.clientY - pressX[1]) <= 5;
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

    /**
     * A click the session's sketching takes: a pick while it waits for picks, on a guide point or
     * the part; or, in Edge mode with a guide drawn on a plane, a point where the ray meets the
     * plane, also off the part. True when taken.
     */
    const sketchClick = (event: MouseEvent) => {
      const state = useEditor.getState(),
        refine = state.refine;
      if (
        event.button !== 0 ||
        state.tool !== 'refine' ||
        refine?.stage !== 'ready' ||
        !refine.model ||
        blocked(state) ||
        pressed() ||
        !canvas().contains(event.target as Node) ||
        Math.hypot(event.clientX - pressAt[0], event.clientY - pressAt[1]) > clickSlop
      )
        return false;
      const { clientX: x, clientY: y } = event;
      if (refine.picking) {
        const handle = handleAt(refine, x, y, false);
        const segment = handle ? null : segmentAt(refine, x, y);
        aimAt(x, y);
        const point = handle ? handle.point : modelHitOnRay(refine.partId);
        const on = handle
          ? { point: { feature: handle.feature, segment: handle.segment, index: handle.index } }
          : segment
            ? { segment }
            : {};
        if (point || segment) state.pickRefine(point ?? { triangle: 0, position: [0, 0, 0] }, on);
        return true;
      }
      const plane = refineDrawingPlane(refine);
      if (!plane || handleAt(refine, x, y, true)) return false;
      aimAt(x, y);
      const { origin, direction } = raycaster.ray;
      const at = rayOnPlane(plane, origin.toArray(), direction.toArray());
      const point = at && pointAt(refine.model.mesh, at);
      if (point) state.addRefinePoint(point);
      return true;
    };

    /** A right-click on a guide point opens its menu. */
    const menu = (event: MouseEvent) => {
      const state = useEditor.getState(),
        refine = state.refine;
      if (
        gesture ||
        state.tool !== 'refine' ||
        refine?.stage !== 'ready' ||
        refine.mode !== 'edge' ||
        blocked(state) ||
        !canvas().contains(event.target as Node) ||
        !ready()
      )
        return;
      const handle = handleAt(refine, event.clientX, event.clientY, false);
      const line = handle ? null : segmentAt(refine, event.clientX, event.clientY);
      if (!handle && !line) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const feature = handle?.feature ?? line!.feature;
      if (!refine.selected.includes(feature)) state.selectRefine([feature]);
      state.openContextMenu({
        x: event.clientX,
        y: event.clientY,
        ...(handle
          ? { refinePoint: { feature, segment: handle.segment, index: handle.index } }
          : { refineSegment: line! }),
      });
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
    window.addEventListener('contextmenu', menu, true);
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
      window.removeEventListener('contextmenu', menu, true);
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
