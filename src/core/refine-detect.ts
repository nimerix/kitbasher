import { EigenvalueDecomposition, Matrix } from 'ml-matrix';
import type { GuidePoint } from './refine-band';
import type { GuideKind } from './refine-curve';
import { VertexNormals, vertexCurvature } from './refine-curvature';
import type { EdgeInput } from './refine-edge';
import {
  type Shape,
  type ShapeFit,
  type ShapeKind,
  fitAuto,
  fitShape,
  shapeDistance,
} from './refine-fit';
import {
  type RefineMesh,
  type RefineTopology,
  medianEdgeLength,
  weldedCorner,
} from './refine-mesh';
import type { RegionInput } from './refine-region';
import type { Vec3 } from './types';

export type RefineProposal =
  { type: 'edge'; input: EdgeInput } | { type: 'region'; input: RegionInput };
export interface DetectOptions {
  /** Triangles to look in; null is the whole part. */
  triangles: Uint32Array | null;
  /** 0 to 1. Higher proposes softer edges. */
  sensitivity: number;
  /** mm. Shorter edges, and surfaces smaller than its square, are not proposed. */
  minLength: number;
}
export const detectDefaults = { sensitivity: 0.5, minLength: 1.5 };

/** Curvature is read over this many median edge lengths. */
const curvatureEdges = 4;
/** An edge vertex bends along the edge by at most this fraction of its bend across it. */
const edgeRatio = 0.4;
/**
 * The flanks of an edge are read from the band's half-width plus the curvature scale out, over this
 * many mm across and along, at stations this many mm apart; where both bend the crest's way by more
 * than `tubeRatio` of it, the piece follows a tube.
 */
const flankDepth = 0.15;
const flankSpacing = 0.5;
const tubeRatio = 0.5;
/** mm. A band's half-width is measured over the band within this of its spine. */
const tubeReach = 0.5;
/** Neighbouring edge vertices whose edge directions differ by more than this are not one band. */
const joinCosine = 0.8;
/** A band turning more than this many degrees within its turn window is split there. */
const splitTurn = 30;
/** The turn window is twice the band's half-width, but at least this many edge lengths. */
const turnEdges = 4;
/**
 * A ring shorter than this many `minLength`, or a piece bending round a circle that short, rings a
 * dome or a rivet rather than following an edge.
 */
const domeRing = 3;
/** Spline guide points are this many band half-widths apart. */
const splineSpacing = 8;
/** Region growth refits when the region has grown by this factor, on at most this many points. */
const refitGrowth = 1.5;
const fitSample = 512;
/** The first refits of a growing region choose the kind afresh; later ones keep it. */
const openRefits = 2;
/** Times growth may go on with a different kind of shape. */
const maxSwitches = 2;
/** Progress is reported at least this often, as a fraction of the run. */
const reportStep = 0.01;
const longestReport = 0.04;

class Progress {
  private last = -Infinity;
  private current = 0;

  constructor(
    private readonly report: ((fraction: number) => void) | undefined,
    private readonly signal: AbortSignal | undefined,
  ) {}

  /** Checks for cancellation and reports `fraction` when it has moved on far enough, or at the end. */
  at(fraction: number) {
    if (this.signal?.aborted) throw new DOMException('Detection cancelled', 'AbortError');
    this.current = Math.max(this.current, Math.min(1, fraction));
    if (!this.report || this.last >= this.current) return;
    if (this.current < 1 && this.current - this.last < reportStep) return;
    // A long stride is reported in steps, so no two reports are more than `longestReport` apart.
    let next = this.last < 0 ? this.current : Math.min(this.current, this.last + longestReport);
    for (;;) {
      this.report(next);
      this.last = next;
      if (this.signal?.aborted) throw new DOMException('Detection cancelled', 'AbortError');
      if (next >= this.current) return;
      next = Math.min(this.current, next + longestReport);
    }
  }
}

/** Binary min-heap of indices keyed by `key`. */
class Heap {
  private items = new Uint32Array(64);
  private size = 0;

  constructor(private readonly key: Float64Array) {}

  get empty() {
    return this.size === 0;
  }

  push(i: number) {
    if (this.size === this.items.length) {
      const grown = new Uint32Array(this.size * 2);
      grown.set(this.items);
      this.items = grown;
    }
    const { items, key } = this;
    let at = this.size++;
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (key[items[parent]] <= key[i]) break;
      items[at] = items[parent];
      at = parent;
    }
    items[at] = i;
  }

  pop() {
    const { items, key } = this;
    const top = items[0];
    const last = items[--this.size];
    let at = 0;
    for (;;) {
      let child = at * 2 + 1;
      if (child >= this.size) break;
      if (child + 1 < this.size && key[items[child + 1]] < key[items[child]]) child++;
      if (key[items[child]] >= key[last]) break;
      items[at] = items[child];
      at = child;
    }
    items[at] = last;
    return top;
  }
}

interface Context {
  mesh: RefineMesh;
  topology: RefineTopology;
  noise: number;
  options: DetectOptions;
  progress: Progress;
  step: number;
  /** Per welded vertex: 1 when it is in the triangles looked in. */
  inScope: Uint8Array;
  scope: Uint32Array;
  triangleInScope: Uint8Array | null;
  /** Per welded vertex, 0 outside the scope. */
  k1: Float32Array;
  k2: Float32Array;
  along: Float32Array;
  kMin: number;
  /** Mean surface area per vertex, mm^2. */
  vertexArea: number;
  normals: VertexNormals;
  /** Scratch per welded vertex for searches, each of which takes the next `mark`. */
  stamp: Int32Array;
  mark: number;
}

export function detectFeatures(
  mesh: RefineMesh,
  topology: RefineTopology,
  noise: number,
  options: DetectOptions,
  report?: (fraction: number) => void,
  signal?: AbortSignal,
): RefineProposal[] {
  const progress = new Progress(report, signal);
  progress.at(0);
  const step = medianEdgeLength(mesh);
  const { inScope, scope, triangleInScope } = scopeOf(mesh, options.triangles);
  const normals = new VertexNormals(mesh, topology);
  const local = vertexCurvature(mesh, topology, curvatureEdges * step, scope, normals, (done) =>
    progress.at((0.5 * done) / scope.length),
  );
  const n = mesh.weldedCount;
  const k1 = new Float32Array(n),
    k2 = new Float32Array(n),
    along = new Float32Array(n * 3);
  scope.forEach((v, i) => {
    k1[v] = local.k1[i];
    k2[v] = local.k2[i];
    along.set(local.along.subarray(i * 3, i * 3 + 3), v * 3);
  });
  const context: Context = {
    mesh,
    topology,
    noise,
    options,
    progress,
    step,
    inScope,
    scope,
    triangleInScope,
    k1,
    k2,
    along,
    kMin: 1 / (0.15 + 1.35 * options.sensitivity),
    vertexArea: areaOf(mesh, triangleInScope) / Math.max(1, scope.length),
    normals,
    stamp: new Int32Array(n),
    mark: 0,
  };
  const edges = proposeEdges(context, 0.5, 0.6);
  const regions = proposeRegions(context, 0.6, 1);
  progress.at(1);
  return [...edges, ...regions];
}

function scopeOf(mesh: RefineMesh, triangles: Uint32Array | null) {
  const inScope = new Uint8Array(mesh.weldedCount);
  if (!triangles) {
    inScope.fill(1);
    return {
      inScope,
      scope: Uint32Array.from({ length: mesh.weldedCount }, (_, v) => v),
      triangleInScope: null,
    };
  }
  const triangleInScope = new Uint8Array(mesh.triangleCount);
  for (const t of triangles) {
    triangleInScope[t] = 1;
    for (const k of [0, 1, 2] as const) inScope[weldedCorner(mesh, t, k)] = 1;
  }
  const scope: number[] = [];
  for (let v = 0; v < mesh.weldedCount; v++) if (inScope[v]) scope.push(v);
  return { inScope, scope: Uint32Array.from(scope), triangleInScope };
}

function triangleArea(mesh: RefineMesh, t: number) {
  const p = mesh.position;
  const a = weldedCorner(mesh, t, 0) * 3,
    b = weldedCorner(mesh, t, 1) * 3,
    c = weldedCorner(mesh, t, 2) * 3;
  const ux = p[b] - p[a],
    uy = p[b + 1] - p[a + 1],
    uz = p[b + 2] - p[a + 2];
  const vx = p[c] - p[a],
    vy = p[c + 1] - p[a + 1],
    vz = p[c + 2] - p[a + 2];
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
}

function areaOf(mesh: RefineMesh, triangleInScope: Uint8Array | null) {
  let area = 0;
  for (let t = 0; t < mesh.triangleCount; t++)
    if (!triangleInScope || triangleInScope[t]) area += triangleArea(mesh, t);
  return area;
}

const distanceBetween = (p: Float64Array, a: number, b: number) =>
  Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2]);

// ---------------------------------------------------------------------------------------------
// Edges

/** Bands of edge vertices: joined over mesh edges where they bend the same way along one direction. */
function edgeBands(context: Context) {
  const { mesh, topology, scope, k1, k2, along, kMin } = context;
  const n = mesh.weldedCount;
  const onEdge = new Uint8Array(n);
  for (const v of scope) {
    const k = Math.abs(k1[v]);
    if (k >= kMin && Math.abs(k2[v]) <= edgeRatio * k) onEdge[v] = 1;
  }
  const parent = new Int32Array(n).fill(-1);
  const root = (v: number) => {
    while (parent[v] !== v) v = parent[v] = parent[parent[v]];
    return v;
  };
  for (const v of scope) if (onEdge[v]) parent[v] = v;
  const { neighbourStart, neighbours } = topology;
  for (const v of scope) {
    if (!onEdge[v]) continue;
    for (let j = neighbourStart[v]; j < neighbourStart[v + 1]; j++) {
      const w = neighbours[j];
      if (w < v || !onEdge[w] || k1[v] * k1[w] <= 0) continue;
      const cos =
        along[v * 3] * along[w * 3] +
        along[v * 3 + 1] * along[w * 3 + 1] +
        along[v * 3 + 2] * along[w * 3 + 2];
      if (Math.abs(cos) < joinCosine) continue;
      const a = root(v),
        b = root(w);
      if (a !== b) parent[a] = b;
    }
  }
  const groups = new Map<number, number[]>();
  for (const v of scope) {
    if (!onEdge[v]) continue;
    const r = root(v);
    let group = groups.get(r);
    if (!group) groups.set(r, (group = []));
    group.push(v);
  }
  // Each band's vertices, and the band each welded vertex belongs to.
  const band = new Int32Array(n).fill(-1);
  const bands: Uint32Array[] = [];
  for (const members of groups.values()) {
    for (const v of members) band[v] = bands.length;
    bands.push(Uint32Array.from(members));
  }
  return { bands, band };
}

interface BandGraph {
  members: Uint32Array;
  /** Welded vertex -> index in `members`, valid where `band` names this band. */
  local: Int32Array;
  id: number;
  band: Int32Array;
}

/**
 * Shortest paths over a band from `source`, by length, or by length over the square of |k1|
 * relative to the band's peak when `curvature` is set. Vertices marked in `blocked` are skipped.
 */
function shortest(
  context: Context,
  graph: BandGraph,
  source: number,
  curvature: number,
  blocked?: Uint8Array,
) {
  const { mesh, topology, k1 } = context;
  const { members, local, id, band } = graph;
  const cost = new Float64Array(members.length).fill(Infinity);
  const previous = new Int32Array(members.length).fill(-1);
  const heap = new Heap(cost);
  cost[source] = 0;
  heap.push(source);
  const { neighbourStart, neighbours } = topology;
  while (!heap.empty) {
    const i = heap.pop();
    const v = members[i];
    for (let j = neighbourStart[v]; j < neighbourStart[v + 1]; j++) {
      const w = neighbours[j];
      if (band[w] !== id) continue;
      const k = local[w];
      if (blocked?.[k]) continue;
      let step = distanceBetween(mesh.position, v, w);
      if (curvature > 0) step *= (curvature / Math.max(Math.abs(k1[w]), 1e-9)) ** 2;
      const total = cost[i] + step;
      if (total < cost[k]) {
        cost[k] = total;
        heap.push(k);
        previous[k] = i;
      }
    }
  }
  return { cost, previous };
}

function farthest(cost: Float64Array) {
  let best = 0;
  for (let i = 0; i < cost.length; i++) if (cost[i] !== Infinity && cost[i] > cost[best]) best = i;
  return best;
}

function walkBack(previous: Int32Array, to: number) {
  const path = [to];
  while (previous[path[path.length - 1]] >= 0) path.push(previous[path[path.length - 1]]);
  return path.reverse();
}

function polylineLength(points: number[], closed: boolean) {
  let length = 0;
  const count = points.length / 3;
  for (let i = 1; i < count + (closed ? 1 : 0); i++) {
    const a = ((i - 1) % count) * 3,
      b = (i % count) * 3;
    length += Math.hypot(
      points[b] - points[a],
      points[b + 1] - points[a + 1],
      points[b + 2] - points[a + 2],
    );
  }
  return length;
}

/** The band's spine: its two farthest vertices joined by the path along high |k1|; a loop if it closes. */
function spineOf(context: Context, graph: BandGraph) {
  const { mesh, k1 } = context;
  const { members } = graph;
  let peak = 0;
  for (const v of members) peak = Math.max(peak, Math.abs(k1[v]));
  const a = farthest(shortest(context, graph, 0, 0).cost);
  const b = farthest(shortest(context, graph, a, 0).cost);
  const along = shortest(context, graph, a, peak);
  if (along.cost[b] === Infinity) return null;
  const path = walkBack(along.previous, b);
  const points = path.flatMap((i) => [
    ...mesh.position.subarray(members[i] * 3, members[i] * 3 + 3),
  ]);
  const length = polylineLength(points, false);
  const halfWidth = halfWidthOf(path, length);
  // A ring: the far ends still join, far from the first path, once its middle third is blocked.
  const reach = Math.min(2 * halfWidth + context.step, length / 8);
  const blocked = within(
    context,
    graph,
    path.slice(Math.floor(path.length / 3), Math.ceil((path.length * 2) / 3)),
    reach,
  );
  blocked[a] = blocked[b] = 0;
  const back = shortest(context, graph, b, peak, blocked);
  if (path.length >= 8 && back.cost[a] !== Infinity) {
    const other = walkBack(back.previous, a);
    const middle = members[other[other.length >> 1]];
    let apart = Infinity;
    for (const i of path)
      apart = Math.min(apart, distanceBetween(mesh.position, middle, members[i]));
    if (apart >= length / 4) {
      const loop = [...path, ...other.slice(1, -1)];
      const ring = polylineLength(
        loop.flatMap((i) => [...mesh.position.subarray(members[i] * 3, members[i] * 3 + 3)]),
        true,
      );
      return {
        path: loop.map((i) => members[i]),
        closed: true,
        halfWidth: halfWidthOf(loop, ring),
      };
    }
  }
  return { path: path.map((i) => members[i]), closed: false, halfWidth };

  /** Half the area of the band within `tubeReach` of a path, over the path's length. */
  function halfWidthOf(along: number[], length: number) {
    let count = 0;
    for (const inside of within(context, graph, along, tubeReach)) count += inside;
    return Math.max(context.step, (count * context.vertexArea) / Math.max(2 * length, 1e-9));
  }
}

/**
 * Band vertices within `reach` of any of `sources` (local indices), found over the band: each
 * vertex is reached from the source it was first found from.
 */
function within(context: Context, graph: BandGraph, sources: number[], reach: number) {
  const { mesh, topology } = context;
  const { members, local, id, band } = graph;
  const { neighbourStart, neighbours } = topology;
  const origin = new Int32Array(members.length).fill(-1);
  const queue: number[] = [];
  for (const i of sources) if (origin[i] < 0) ((origin[i] = members[i]), queue.push(i));
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    const v = members[i];
    for (let j = neighbourStart[v]; j < neighbourStart[v + 1]; j++) {
      const w = neighbours[j];
      if (band[w] !== id || origin[local[w]] >= 0) continue;
      if (distanceBetween(mesh.position, origin[i], w) > reach) continue;
      origin[local[w]] = origin[i];
      queue.push(local[w]);
    }
  }
  return Uint8Array.from(origin, (o) => (o >= 0 ? 1 : 0));
}

/**
 * The spine's vertices moved to the |k1|^2-weighted centre of the band vertices within `radius`, so
 * the guide follows the middle of a wide band rather than the path's zigzag. An open spine's ends
 * are then carried out along it as far as its end vertices reach.
 */
function centredSpine(
  context: Context,
  graph: BandGraph,
  path: number[],
  closed: boolean,
  radius: number,
) {
  const { mesh, topology, k1, kMin, inScope, stamp } = context;
  const { neighbourStart, neighbours } = topology;
  const p = mesh.position;
  const sign = Math.sign(k1[graph.members[0]]);
  const out: number[] = [];
  path.forEach((v) => {
    const queue = [v];
    const mark = ++context.mark;
    stamp[v] = mark;
    let x = 0,
      y = 0,
      z = 0,
      weight = 0;
    for (let q = 0; q < queue.length; q++) {
      const u = queue[q];
      // Weighted by how far the bend exceeds half of `kMin`, so the faces either side add nothing.
      const w2 = Math.max(0, sign * k1[u] - kMin / 2) ** 2;
      x += w2 * p[u * 3];
      y += w2 * p[u * 3 + 1];
      z += w2 * p[u * 3 + 2];
      weight += w2;
      for (let j = neighbourStart[u]; j < neighbourStart[u + 1]; j++) {
        const w = neighbours[j];
        if (!inScope[w] || stamp[w] === mark) continue;
        stamp[w] = mark;
        if (distanceBetween(p, v, w) <= radius) queue.push(w);
      }
    }
    out.push(x / weight, y / weight, z / weight);
  });
  const count = path.length;
  if (closed || count < 2) return out;
  const s = stations(out, false);
  for (const end of [0, count - 1]) {
    const here = out.slice(end * 3, end * 3 + 3);
    const back = pointAt(out, s, end === 0 ? radius : s[count - 1] - radius, false);
    const t = [0, 1, 2].map((k) => here[k] - back[k]);
    const length = Math.hypot(t[0], t[1], t[2]);
    if (!(length > 0)) continue;
    const v = path[end];
    const reach = [0, 1, 2].reduce((acc, k) => acc + (p[v * 3 + k] - here[k]) * t[k], 0) / length;
    if (reach > 0) for (let k = 0; k < 3; k++) out[end * 3 + k] += (reach * t[k]) / length;
  }
  return out;
}

/** Arc length at each point of a polyline. */
function stations(points: number[], closed: boolean) {
  const count = points.length / 3;
  const s = new Float64Array(count + (closed ? 1 : 0));
  for (let i = 1; i < s.length; i++) {
    const a = (i - 1) * 3,
      b = (i % count) * 3;
    s[i] =
      s[i - 1] +
      Math.hypot(
        points[b] - points[a],
        points[b + 1] - points[a + 1],
        points[b + 2] - points[a + 2],
      );
  }
  return s;
}

/** Point at arc length `at` along a polyline with `stations` `s`. */
function pointAt(points: number[], s: Float64Array, at: number, closed: boolean): Vec3 {
  const count = points.length / 3;
  const total = s[s.length - 1];
  if (closed) at = ((at % total) + total) % total;
  else at = Math.min(Math.max(at, 0), total);
  let lo = 0,
    hi = s.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid] <= at) lo = mid;
    else hi = mid;
  }
  const f = s[hi] > s[lo] ? (at - s[lo]) / (s[hi] - s[lo]) : 0;
  const a = lo * 3,
    b = (hi % count) * 3;
  return [0, 1, 2].map((k) => points[a + k] + f * (points[b + k] - points[a + k])) as Vec3;
}

/** Mean of a polyline's points between two arc lengths, sampled evenly. */
function meanBetween(points: number[], s: Float64Array, from: number, to: number, closed: boolean) {
  const mean: Vec3 = [0, 0, 0];
  const samples = 8;
  for (let j = 0; j < samples; j++) {
    const p = pointAt(points, s, from + ((to - from) * (j + 0.5)) / samples, closed);
    for (let k = 0; k < 3; k++) mean[k] += p[k] / samples;
  }
  return mean;
}

/** Indices where the polyline turns by more than `splitTurn` over `window` behind and ahead. */
function corners(points: number[], closed: boolean, window: number) {
  const count = points.length / 3;
  const s = stations(points, closed);
  const total = s[s.length - 1];
  const turn = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    if (!closed && (s[i] < window || s[i] > total - window)) continue;
    // Directions from the mean of the window behind to the middle, and on to the mean ahead.
    const before = meanBetween(points, s, s[i] - window, s[i], closed),
      here = meanBetween(points, s, s[i] - window / 4, s[i] + window / 4, closed),
      after = meanBetween(points, s, s[i], s[i] + window, closed);
    const u = [0, 1, 2].map((k) => here[k] - before[k]),
      w = [0, 1, 2].map((k) => after[k] - here[k]);
    const lu = Math.hypot(u[0], u[1], u[2]),
      lw = Math.hypot(w[0], w[1], w[2]);
    if (!(lu > 0 && lw > 0)) continue;
    const cos = (u[0] * w[0] + u[1] * w[1] + u[2] * w[2]) / (lu * lw);
    turn[i] = (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
  }
  // The sharpest point of each run of turning points.
  const cuts: number[] = [];
  for (let i = 0; i < count; i++) {
    if (turn[i] <= splitTurn) continue;
    let best = i;
    let j = i;
    while (j + 1 < count && turn[j + 1] > splitTurn) if (turn[++j] > turn[best]) best = j;
    cuts.push(best);
    i = j;
  }
  return cuts;
}

interface Circle {
  rms: number;
  centre: Vec3;
  radius: number;
  /** Unit axes of the circle's plane. */
  u: Vec3;
  v: Vec3;
}

function principalAxes(points: number[]) {
  const count = points.length / 3;
  const mean: Vec3 = [0, 0, 0];
  for (let i = 0; i < count; i++) for (let k = 0; k < 3; k++) mean[k] += points[i * 3 + k] / count;
  const c = new Matrix(3, 3);
  for (let i = 0; i < count; i++)
    for (let r = 0; r < 3; r++)
      for (let q = 0; q < 3; q++)
        c.set(r, q, c.get(r, q) + (points[i * 3 + r] - mean[r]) * (points[i * 3 + q] - mean[q]));
  const e = new EigenvalueDecomposition(c, { assumeSymmetric: true });
  const order = [0, 1, 2].sort((a, b) => e.realEigenvalues[b] - e.realEigenvalues[a]);
  const vectors = order.map((j) => [0, 1, 2].map((r) => e.eigenvectorMatrix.get(r, j)) as Vec3);
  return { mean, vectors };
}

/** RMS distance of the points from their best line. */
function lineRms(points: number[]) {
  const count = points.length / 3;
  const { mean, vectors } = principalAxes(points);
  const d = vectors[0];
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const w = [0, 1, 2].map((k) => points[i * 3 + k] - mean[k]);
    const t = w[0] * d[0] + w[1] * d[1] + w[2] * d[2];
    sum += w[0] ** 2 + w[1] ** 2 + w[2] ** 2 - t * t;
  }
  return Math.sqrt(Math.max(0, sum) / count);
}

/** Circle in the points' best plane, by least squares on x^2 + y^2 + D x + E y + F. */
function fitCircle(points: number[]): Circle | null {
  const count = points.length / 3;
  if (count < 3) return null;
  const { mean, vectors } = principalAxes(points);
  const [u, v, normal] = vectors;
  const a = new Matrix(3, 3),
    r = new Matrix(3, 1);
  const xy: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const w = [0, 1, 2].map((k) => points[i * 3 + k] - mean[k]);
    const x = w[0] * u[0] + w[1] * u[1] + w[2] * u[2],
      y = w[0] * v[0] + w[1] * v[1] + w[2] * v[2];
    xy.push([x, y]);
    const row = [x, y, 1];
    const rhs = -(x * x + y * y);
    for (let p = 0; p < 3; p++) {
      r.set(p, 0, r.get(p, 0) + row[p] * rhs);
      for (let q = 0; q < 3; q++) a.set(p, q, a.get(p, q) + row[p] * row[q]);
    }
  }
  let solution: Matrix;
  try {
    solution = solve3(a, r);
  } catch {
    return null;
  }
  const cx = -solution.get(0, 0) / 2,
    cy = -solution.get(1, 0) / 2;
  const radius = Math.sqrt(Math.max(0, cx * cx + cy * cy - solution.get(2, 0)));
  if (!Number.isFinite(radius) || radius <= 0) return null;
  let sum = 0;
  xy.forEach(([x, y], i) => {
    const h = [0, 1, 2].reduce((acc, k) => acc + (points[i * 3 + k] - mean[k]) * normal[k], 0);
    sum += h * h + (Math.hypot(x - cx, y - cy) - radius) ** 2;
  });
  const centre = [0, 1, 2].map((k) => mean[k] + cx * u[k] + cy * v[k]) as Vec3;
  return { rms: Math.sqrt(sum / count), centre, radius, u, v };
}

function solve3(a: Matrix, r: Matrix) {
  const m = a.to2DArray();
  const det = (q: number[][]) =>
    q[0][0] * (q[1][1] * q[2][2] - q[1][2] * q[2][1]) -
    q[0][1] * (q[1][0] * q[2][2] - q[1][2] * q[2][0]) +
    q[0][2] * (q[1][0] * q[2][1] - q[1][1] * q[2][0]);
  const d = det(m);
  if (!(Math.abs(d) > 1e-30)) throw new Error('singular');
  const out = new Matrix(3, 1);
  for (let k = 0; k < 3; k++)
    out.set(
      k,
      0,
      det(m.map((row, i) => row.map((value, j) => (j === k ? r.get(i, 0) : value)))) / d,
    );
  return out;
}

/** Point on a fitted circle at the angle of `p`. */
function onCircle(fit: Circle, p: Vec3): Vec3 {
  const { centre, radius, u, v } = fit;
  const w = [0, 1, 2].map((k) => p[k] - centre[k]);
  const angle = Math.atan2(
    w[0] * v[0] + w[1] * v[1] + w[2] * v[2],
    w[0] * u[0] + w[1] * u[1] + w[2] * u[2],
  );
  return [0, 1, 2].map(
    (k) => centre[k] + radius * (Math.cos(angle) * u[k] + Math.sin(angle) * v[k]),
  ) as Vec3;
}

function closestOnTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const sub = (x: Vec3, y: Vec3): Vec3 => [x[0] - y[0], x[1] - y[1], x[2] - y[2]];
  const dot = (x: Vec3, y: Vec3) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  const ab = sub(b, a),
    ac = sub(c, a),
    ap = sub(p, a);
  const d1 = dot(ab, ap),
    d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b);
  const d3 = dot(ab, bp),
    d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const t = d1 / (d1 - d3);
    return [a[0] + t * ab[0], a[1] + t * ab[1], a[2] + t * ab[2]];
  }
  const cp = sub(p, c);
  const d5 = dot(ab, cp),
    d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const t = d2 / (d2 - d6);
    return [a[0] + t * ac[0], a[1] + t * ac[1], a[2] + t * ac[2]];
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const t = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return [b[0] + t * (c[0] - b[0]), b[1] + t * (c[1] - b[1]), b[2] + t * (c[2] - b[2])];
  }
  const denominator = 1 / (va + vb + vc);
  const v = vb * denominator,
    w = vc * denominator;
  return [0, 1, 2].map((k) => a[k] + ab[k] * v + ac[k] * w) as Vec3;
}

/** The surface point nearest `p` among the triangles in scope within two rings of `vertex`. */
function snap(context: Context, vertex: number, p: Vec3): GuidePoint | null {
  const { mesh, topology, triangleInScope } = context;
  const { neighbourStart, neighbours, triangleStart, trianglesOf } = topology;
  const near = new Set([vertex]);
  for (let ring = 0; ring < 2; ring++)
    for (const v of [...near])
      for (let j = neighbourStart[v]; j < neighbourStart[v + 1]; j++) near.add(neighbours[j]);
  const corner = (t: number, k: 0 | 1 | 2): Vec3 => {
    const w = weldedCorner(mesh, t, k) * 3;
    return [mesh.position[w], mesh.position[w + 1], mesh.position[w + 2]];
  };
  let best: GuidePoint | null = null,
    nearest = Infinity;
  const seen = new Set<number>();
  for (const v of near)
    for (let i = triangleStart[v]; i < triangleStart[v + 1]; i++) {
      const t = trianglesOf[i];
      if (seen.has(t) || (triangleInScope && !triangleInScope[t])) continue;
      seen.add(t);
      const q = closestOnTriangle(p, corner(t, 0), corner(t, 1), corner(t, 2));
      const d = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
      if (d < nearest) [nearest, best] = [d, { triangle: t, position: q }];
    }
  return best;
}

/** The vertex of `path` whose centred point is nearest `p`. */
function nearestOnPath(path: number[], points: number[], p: Vec3) {
  let best = 0,
    nearest = Infinity;
  for (let i = 0; i < path.length; i++) {
    const d = Math.hypot(points[i * 3] - p[0], points[i * 3 + 1] - p[1], points[i * 3 + 2] - p[2]);
    if (d < nearest) [nearest, best] = [d, i];
  }
  return path[best];
}

/**
 * The points of an open piece more than `margin`, or a quarter of its length, from its ends: nearer
 * an end, the centring reaches past it into a corner or a fading edge.
 */
function core(points: number[], s: Float64Array, closed: boolean, margin: number) {
  const total = s[s.length - 1];
  if (closed) return points;
  margin = Math.min(margin, total / 4);
  return points.filter(
    (_, k) => s[Math.floor(k / 3)] >= margin && s[Math.floor(k / 3)] <= total - margin,
  );
}

/**
 * True when the surface bends nearly as much as the crest on both sides of a piece, past the band,
 * at most of the stations along it: a tube or a crown, not an edge between two faces.
 */
function tubeLike(
  context: Context,
  path: number[],
  points: number[],
  closed: boolean,
  halfWidth: number,
) {
  const { mesh, topology, k1, inScope, stamp, step } = context;
  const p = mesh.position;
  const { neighbourStart, neighbours } = topology;
  const near = halfWidth + curvatureEdges * step + step;
  const far = near + flankDepth;
  const s = stations(points, closed);
  const total = s[s.length - 1];
  const count = Math.max(3, Math.ceil(total / flankSpacing));
  const normal = context.normals;
  let tubes = 0;
  for (let k = 0; k < count; k++) {
    const station = closed ? (total * k) / count : (total * (k + 0.5)) / count;
    const centre = pointAt(points, s, station, closed);
    const ahead = pointAt(points, s, station + step, closed),
      behind = pointAt(points, s, station - step, closed);
    const t = [0, 1, 2].map((a) => ahead[a] - behind[a]);
    const tl = Math.hypot(t[0], t[1], t[2]);
    if (!(tl > 0)) continue;
    const v = nearestOnPath(path, points, centre);
    const n = normal.of(v).subarray(v * 3, v * 3 + 3);
    const b = [n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2], n[0] * t[1] - n[1] * t[0]];
    const crest = k1[v];
    const sums = [0, 0],
      counts = [0, 0];
    const mark = ++context.mark;
    stamp[v] = mark;
    const queue = [v];
    for (let q = 0; q < queue.length; q++) {
      const u = queue[q];
      for (let j = neighbourStart[u]; j < neighbourStart[u + 1]; j++) {
        const w = neighbours[j];
        if (!inScope[w] || stamp[w] === mark) continue;
        stamp[w] = mark;
        const e = [p[w * 3] - centre[0], p[w * 3 + 1] - centre[1], p[w * 3 + 2] - centre[2]];
        if (Math.hypot(e[0], e[1], e[2]) > far) continue;
        queue.push(w);
        const along = (e[0] * t[0] + e[1] * t[1] + e[2] * t[2]) / tl;
        if (Math.abs(along) > flankDepth) continue;
        const across = Math.hypot(e[0], e[1], e[2]) ** 2 - along * along;
        if (across < near * near) continue;
        const side = e[0] * b[0] + e[1] * b[1] + e[2] * b[2] > 0 ? 0 : 1;
        sums[side] += k1[w] / crest;
        counts[side]++;
      }
    }
    if (
      counts[0] &&
      counts[1] &&
      sums[0] / counts[0] > tubeRatio &&
      sums[1] / counts[1] > tubeRatio
    )
      tubes++;
  }
  return tubes > count / 2;
}

/** A proposal for one piece of a spine, or null when it is too short or rings a dome. */
function pieceProposal(
  context: Context,
  path: number[],
  points: number[],
  closed: boolean,
  halfWidth: number,
  hidden: number,
  margin: number,
): EdgeInput | null {
  const { minLength } = context.options;
  const length = polylineLength(points, closed);
  if (length + hidden < minLength) return null;
  const tolerance = 2 * context.noise;
  const s = stations(points, closed);
  const middle = core(points, s, closed, margin);
  const circle = fitCircle(middle);
  const domeRadius = (domeRing * minLength) / (2 * Math.PI);
  if (closed && length < domeRing * minLength) return null;
  if (circle && circle.rms <= tolerance && circle.radius < domeRadius) return null;
  if (tubeLike(context, path, points, closed, halfWidth)) return null;
  const guide = (p: Vec3) => snap(context, nearestOnPath(path, points, p), p);
  const at = (station: number) => pointAt(points, s, station, closed);
  let kind: GuideKind;
  let targets: Vec3[];
  if (!closed && lineRms(middle) <= tolerance) {
    kind = 'line';
    // The ends of the fitted line, level with the piece's own ends.
    const { mean, vectors } = principalAxes(middle);
    const d = vectors[0];
    targets = [at(0), at(length)].map((p) => {
      const t = [0, 1, 2].reduce((acc, k) => acc + (p[k] - mean[k]) * d[k], 0);
      return [0, 1, 2].map((k) => mean[k] + t * d[k]) as Vec3;
    });
  } else if (circle && circle.rms <= tolerance) {
    kind = 'arc';
    const thirds = closed ? [0, length / 3, (2 * length) / 3] : [0, length / 2, length];
    targets = thirds.map((station) => onCircle(circle, at(station)));
  } else if (!closed) {
    kind = 'spline';
    const count = Math.max(3, Math.round(length / (splineSpacing * halfWidth)) + 1);
    targets = Array.from({ length: count }, (_, i) => at((length * i) / (count - 1)));
  } else {
    // A closed path of one segment must be a circle; any other ring is offered open, as a spline.
    kind = 'spline';
    const open = length - 2 * halfWidth;
    const count = Math.max(3, Math.round(open / (splineSpacing * halfWidth)) + 1);
    targets = Array.from({ length: count }, (_, i) => at((open * i) / (count - 1)));
  }
  const guides = targets.map(guide);
  if (guides.some((g) => !g)) return null;
  const ring = closed && kind === 'arc';
  return {
    segments: [{ kind, points: guides as GuidePoint[] }],
    joints: ring ? ['smooth'] : [],
    closed: ring,
    width: null,
    strength: 1,
  };
}

/**
 * True when the surface past an open spine's end, within the curvature scale, still bends at least
 * `kMin` on average: the band stopped because another edge meets it there, and the curvature scale
 * hides that much of the edge from the edge test.
 */
function endsAtCorner(
  context: Context,
  graph: BandGraph,
  path: number[],
  points: number[],
  end: number,
  window: number,
) {
  const { mesh, topology, k1, inScope, step } = context;
  const p = mesh.position;
  const s = stations(points, false);
  const here = pointAt(points, s, s[end], false);
  const back = pointAt(points, s, end === 0 ? window : s[end] - window, false);
  const out = [0, 1, 2].map((k) => here[k] - back[k]);
  const length = Math.hypot(out[0], out[1], out[2]);
  if (!(length > 0)) return false;
  const reach = curvatureEdges * step;
  const start = path[end];
  const seen = new Set([start]);
  const queue = [start];
  let sum = 0,
    count = 0;
  for (let q = 0; q < queue.length; q++) {
    const v = queue[q];
    for (let j = topology.neighbourStart[v]; j < topology.neighbourStart[v + 1]; j++) {
      const w = topology.neighbours[j];
      if (seen.has(w) || !inScope[w]) continue;
      seen.add(w);
      if (distanceBetween(p, start, w) > reach) continue;
      queue.push(w);
      const ahead = [0, 1, 2].reduce((acc, k) => acc + (p[w * 3 + k] - here[k]) * out[k], 0);
      if (graph.band[w] === graph.id || ahead <= 0) continue;
      sum += Math.abs(k1[w]);
      count++;
    }
  }
  return count > 0 && sum / count >= context.kMin;
}

function proposeEdges(context: Context, from: number, to: number): RefineProposal[] {
  const { mesh, step, progress } = context;
  const { bands, band } = edgeBands(context);
  const local = new Int32Array(mesh.weldedCount).fill(-1);
  const proposals: RefineProposal[] = [];
  let done = 0;
  const total = bands.reduce((sum, members) => sum + members.length, 0);
  // Bands still to trace, with their ids in `band`. A band whose spine leaves branches is peeled:
  // what the spine covers is taken away and each branch left over is traced in turn.
  const work = bands.map((members, id) => ({ members, id }));
  let nextId = bands.length;
  while (work.length) {
    const { members, id } = work.pop()!;
    progress.at(from + ((to - from) * done) / Math.max(total, 1));
    // Too few vertices to span `minLength` even one triangle wide.
    if (members.length * step < context.options.minLength) {
      done += members.length;
      continue;
    }
    members.forEach((v, i) => (local[v] = i));
    const graph: BandGraph = { members, local, id, band };
    const spine = spineOf(context, graph);
    if (!spine) {
      done += members.length;
      continue;
    }
    proposals.push(...spineProposals(context, graph, spine));
    const covered = within(
      context,
      graph,
      spine.path.map((v) => local[v]),
      2 * spine.halfWidth + step,
    );
    for (const branch of branches(context, graph, covered)) {
      for (const v of branch) band[v] = nextId;
      work.push({ members: branch, id: nextId++ });
    }
    members.forEach((v, i) => {
      if (!covered[i]) return;
      band[v] = -1;
      done++;
    });
  }
  progress.at(to);
  return proposals;
}

/** Connected pieces of a band left once the vertices marked in `covered` are taken away. */
function branches(context: Context, graph: BandGraph, covered: Uint8Array) {
  const { neighbourStart, neighbours } = context.topology;
  const { members, local, id, band } = graph;
  const seen = covered.slice();
  const found: Uint32Array[] = [];
  for (let i = 0; i < members.length; i++) {
    if (seen[i]) continue;
    seen[i] = 1;
    const piece = [members[i]];
    for (let q = 0; q < piece.length; q++) {
      const v = piece[q];
      for (let j = neighbourStart[v]; j < neighbourStart[v + 1]; j++) {
        const w = neighbours[j];
        if (band[w] !== id || seen[local[w]]) continue;
        seen[local[w]] = 1;
        piece.push(w);
      }
    }
    found.push(Uint32Array.from(piece));
  }
  return found;
}

/** The proposals along one spine: its pieces between corners. */
function spineProposals(
  context: Context,
  graph: BandGraph,
  spine: NonNullable<ReturnType<typeof spineOf>>,
): RefineProposal[] {
  const { step } = context;
  const { path, closed, halfWidth } = spine;
  const radius = Math.max(1.5 * halfWidth, 2 * step);
  const points = centredSpine(context, graph, path, closed, radius);
  const window = Math.max(2 * halfWidth, turnEdges * step);
  const cuts = corners(points, closed, window);
  const pieces: number[][] = [];
  if (!cuts.length) pieces.push(path.map((_, i) => i));
  else if (closed) {
    for (let c = 0; c < cuts.length; c++) {
      const start = cuts[c],
        end = cuts[(c + 1) % cuts.length];
      const piece: number[] = [];
      for (let i = start; ; i = (i + 1) % path.length) {
        piece.push(i);
        if (i === end) break;
      }
      pieces.push(piece);
    }
  } else {
    let start = 0;
    for (const c of [...cuts, path.length - 1]) {
      pieces.push(Array.from({ length: c - start + 1 }, (_, k) => start + k));
      start = c;
    }
  }
  const whole = closed && !cuts.length;
  const scale = curvatureEdges * step;
  const hidden = closed
    ? [0, 0]
    : [0, path.length - 1].map((end) =>
        endsAtCorner(context, graph, path, points, end, window) ? scale : 0,
      );
  const proposals: RefineProposal[] = [];
  pieces.forEach((piece, k) => {
    const input = pieceProposal(
      context,
      piece.map((i) => path[i]),
      piece.flatMap((i) => points.slice(i * 3, i * 3 + 3)),
      whole,
      halfWidth,
      (k === 0 ? hidden[0] : 0) + (k === pieces.length - 1 ? hidden[1] : 0),
      radius,
    );
    if (input) proposals.push({ type: 'edge', input });
  });
  return proposals;
}

// ---------------------------------------------------------------------------------------------
// Surfaces

/** Positions and normals of `vertices`, at most `fitSample` of them evenly spread. */
function sampleOf(
  context: Context,
  normals: VertexNormals,
  vertices: ArrayLike<number>,
  count: number,
) {
  const take = Math.min(count, fitSample);
  const points = new Float32Array(take * 3),
    directions = new Float32Array(take * 3);
  for (let i = 0; i < take; i++) {
    const v = vertices[Math.floor((i * count) / take)];
    for (let k = 0; k < 3; k++) points[i * 3 + k] = context.mesh.position[v * 3 + k];
    directions.set(normals.of(v).subarray(v * 3, v * 3 + 3), i * 3);
  }
  return { points, directions };
}

/**
 * `fitAuto` without the cone, which costs as much as the other kinds together: a plane keeping
 * over 0.9 of the points, else the better within noise of a cylinder and a sphere. Cones are
 * chosen where a region stops growing.
 */
function openFit(points: Float32Array, normals: Float32Array, noise: number): ShapeFit | null {
  const plane = fitShape(points, normals, 'plane', noise);
  if (plane?.within && plane.support > 0.9) return plane;
  const fits = [
    plane,
    fitShape(points, normals, 'cylinder', noise),
    fitShape(points, normals, 'sphere', noise),
  ];
  const most = Math.max(0, ...fits.map((fit) => (fit?.within ? fit.support : 0)));
  const near = fits.filter((fit): fit is ShapeFit => !!fit?.within && fit.support >= 0.9 * most);
  if (near[0] === plane && plane) return plane;
  return near.reduce<ShapeFit | null>((a, b) => (!a || b.rms < a.rms ? b : a), null);
}

function tryFit(
  context: Context,
  normals: VertexNormals,
  vertices: ArrayLike<number>,
  count: number,
  kind?: ShapeKind | 'open',
) {
  const { points, directions } = sampleOf(context, normals, vertices, count);
  try {
    if (kind === 'open') return openFit(points, directions, context.noise);
    return kind
      ? fitShape(points, directions, kind, context.noise)
      : fitAuto(points, directions, context.noise);
  } catch {
    return null;
  }
}

/** Triangles in scope whose three corners are all in region `label`. */
function regionTriangles(
  mesh: RefineMesh,
  region: Int32Array,
  label: number,
  members: Uint32Array,
  count: number,
  topology: RefineTopology,
  triangleInScope: Uint8Array | null,
) {
  const triangles: number[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < count; i++) {
    const v = members[i];
    for (let j = topology.triangleStart[v]; j < topology.triangleStart[v + 1]; j++) {
      const t = topology.trianglesOf[j];
      if (seen.has(t)) continue;
      seen.add(t);
      if (triangleInScope && !triangleInScope[t]) continue;
      if (
        region[weldedCorner(mesh, t, 0)] === label &&
        region[weldedCorner(mesh, t, 1)] === label &&
        region[weldedCorner(mesh, t, 2)] === label
      )
        triangles.push(t);
    }
  }
  return triangles;
}

function regionArea(...args: Parameters<typeof regionTriangles>) {
  let area = 0;
  for (const t of regionTriangles(...args)) area += triangleArea(args[0], t);
  return area;
}

function proposeRegions(context: Context, from: number, to: number): RefineProposal[] {
  const { mesh, topology, scope, inScope, k1, kMin, noise, progress, triangleInScope } = context;
  const { minLength } = context.options;
  const { normals } = context;
  const order = Uint32Array.from(scope).sort((a, b) => Math.abs(k1[a]) - Math.abs(k1[b]));
  const region = new Int32Array(mesh.weldedCount).fill(-1);
  const tried = new Uint8Array(mesh.weldedCount);
  let consumed = 0;
  const consume = (v: number) => {
    if (!tried[v] && region[v] < 0) consumed++;
  };
  const report = () => progress.at(from + ((to - from) * consumed) / Math.max(scope.length, 1));
  const { neighbourStart, neighbours } = topology;
  const tolerance = 3 * noise;
  const seedRadius = Math.max(minLength / 2, 4 * context.step);
  let members = new Uint32Array(1024);
  const proposals: RefineProposal[] = [];
  let id = 0;
  for (const seed of order) {
    report();
    if (Math.abs(k1[seed]) >= kMin) break;
    if (tried[seed] || region[seed] >= 0) continue;
    // The seed patch: unclaimed vertices joined to the seed within `seedRadius`.
    let count = 0;
    const add = (v: number) => {
      if (count === members.length) {
        const grown = new Uint32Array(count * 2);
        grown.set(members);
        members = grown;
      }
      members[count++] = v;
    };
    const label = id++;
    consume(seed);
    region[seed] = label;
    add(seed);
    for (let head = 0; head < count; head++) {
      const v = members[head];
      for (let j = neighbourStart[v]; j < neighbourStart[v + 1]; j++) {
        const w = neighbours[j];
        if (!inScope[w] || region[w] >= 0) continue;
        if (distanceBetween(mesh.position, seed, w) > seedRadius) continue;
        consume(w);
        region[w] = label;
        add(w);
      }
    }
    let fit = count >= 12 ? tryFit(context, normals, members, count, 'open') : null;
    // A patch or region that is not kept is left to others to grow over, but seeds no region.
    const release = () => {
      for (let i = 0; i < count; i++) {
        region[members[i]] = -1;
        tried[members[i]] = 1;
      }
    };
    if (!fit?.within) {
      release();
      continue;
    }
    // Grow over neighbours within 3 * noise of the fitted shape, refitting as the region grows. While
    // growing only the kind already fitted is refitted; where growth stops, the region's own kind is
    // fitted, and growth goes on with it when that kind differs.
    let shape: Shape = fit.shape;
    let fitted = count;
    let final: ShapeFit | null = null;
    let refits = 0;
    for (let switches = 0; ; switches++) {
      let stopped = false;
      for (let head = 0; head < count; head++) {
        if ((head & 4095) === 0) report();
        const v = members[head];
        for (let j = neighbourStart[v]; j < neighbourStart[v + 1]; j++) {
          const w = neighbours[j];
          if (!inScope[w] || region[w] >= 0) continue;
          const d = shapeDistance(
            shape,
            mesh.position[w * 3],
            mesh.position[w * 3 + 1],
            mesh.position[w * 3 + 2],
          );
          if (Math.abs(d) > tolerance) continue;
          consume(w);
          region[w] = label;
          add(w);
        }
        if (count >= refitGrowth * fitted) {
          const next = tryFit(
            context,
            normals,
            members,
            count,
            ++refits > openRefits ? shape.kind : 'open',
          );
          fitted = count;
          if (!next?.within) {
            stopped = true;
            break;
          }
          shape = next.shape;
          // A changed shape may take in neighbours the old one refused.
          head = -1;
        }
      }
      final =
        regionArea(mesh, region, label, members, count, topology, triangleInScope) >
        minLength * minLength
          ? tryFit(context, normals, members, count)
          : null;
      if (stopped || !final?.within || final.shape.kind === shape.kind || switches === maxSwitches)
        break;
      shape = final.shape;
      fitted = count;
    }
    const triangles = regionTriangles(
      mesh,
      region,
      label,
      members,
      count,
      topology,
      triangleInScope,
    );
    if (!final?.within) {
      release();
      continue;
    }
    const kind = final.shape.kind;
    proposals.push({
      type: 'region',
      input: {
        triangles: Uint32Array.from(triangles.sort((a, b) => a - b)),
        treatment: kind === 'plane' ? 'flatten' : 'shape',
        shape: kind === 'plane' ? 'auto' : kind,
        strength: 1,
        keepDetail: true,
        detail: null,
        blend: null,
      },
    });
  }
  progress.at(to);
  return proposals;
}
