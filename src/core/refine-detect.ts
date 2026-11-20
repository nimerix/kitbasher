import { EigenvalueDecomposition, Matrix } from 'ml-matrix';
import type { GuidePoint } from './refine-band';
import { type GuideKind, drawnCurve } from './refine-curve';
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

/** Curvature is read over this many median edge lengths: the curvature scale. */
const curvatureEdges = 4;
/** An edge vertex bends along the edge by at most this fraction of its bend across it. */
const edgeRatio = 0.4;
/**
 * Across an edge the bend falls below `fallRatio` of its peak (the most within one curvature scale)
 * on both sides within `fallReach` curvature scales, and the surface turns by at most `maxTurn`
 * degrees between those two places: a narrow band between two flatter flanks. A tube bends on all
 * the way round. Where the bend dips below `valleyRatio` of the peak and rises again to another
 * ridge, the band ends at the dip, provided the bend falls within reach of it.
 */
const fallRatio = 0.5;
const fallReach = 3;
const maxTurn = 150;
const valleyRatio = 0.8;
/** The ridge of a band: its vertices bending at least this fraction of the peak across them. */
const ridgeRatio = 0.85;
/** A path along a band costs this many times more where it leaves the ridge. */
const offRidge = 25;
/** mm. A band's half-width is measured over the band within this of its spine. */
const widthReach = 0.5;
/** Neighbouring edge vertices whose edge directions differ by more than this are not one band. */
const joinCosine = 0.8;
/** A band turning more than this many degrees within its turn window is split there. */
const splitTurn = 30;
/** The turn window is twice the band's half-width, but at least this many edge lengths. */
const turnEdges = 4;
/**
 * An open end is carried on, up to this many curvature scales, to where it passes within half a
 * curvature scale of another edge: the curvature scale hides that much of an edge at a corner.
 */
const meetReach = 1;
/** A piece is proposed when it is drawn at least `minLength` long and spans this many `minLength`. */
const spanRatio = 1;
/** Spline guide points are this many band half-widths apart. */
const splineSpacing = 8;
/** Region growth refits when the region has grown by this factor, on at most this many points. */
const refitGrowth = 1.5;
const fitSample = 512;
/** The first refits of a growing region choose the kind afresh; later ones keep it. */
const openRefits = 2;
/**
 * Two neighbouring regions are one surface only when each, on its own, is held by the fit to both:
 * of each region's samples, the fraction within the growth tolerance of the joint surface is at
 * least `joinSupport` of the fraction its own fit holds and never below `acceptedSupport` (what a
 * fit needs to be accepted at all), the rms of those is no more than `joinRms` times its own, and
 * its mean signed distance is within the noise. Then their own shapes must agree: axes or normals
 * within `joinAngle` degrees, and offsets between planes, axes, centres or apexes and differences
 * of radius within the growth tolerance or `parameterSpread` times the two regions' own scatter
 * (the difference between fits to the even and the odd half of each sample), whichever is larger.
 */
const joinRms = 1.2;
const joinAngle = 0.5;
const joinSupport = 0.9;
const acceptedSupport = 0.5;
const parameterSpread = 2;
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
  /** Per welded vertex: 1 on an edge band, and 1 on a band's ridge. */
  onEdge: Uint8Array;
  ridge: Uint8Array;
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
  // With paint, everything reads only the painted triangles: a gap in the paint is a gap in the mesh.
  const looked = triangleInScope ? paintedTopology(mesh, topology, triangleInScope) : topology;
  const normals = new VertexNormals(mesh, looked);
  const local = vertexCurvature(mesh, looked, curvatureEdges * step, scope, normals, (done) =>
    progress.at((0.45 * done) / scope.length),
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
    topology: looked,
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
    onEdge: new Uint8Array(n),
    ridge: new Uint8Array(n),
    vertexArea: areaOf(mesh, triangleInScope) / Math.max(1, scope.length),
    normals,
    stamp: new Int32Array(n),
    mark: 0,
  };
  markEdgeVertices(context, 0.45, 0.5);
  const { proposals: edges, proposed } = proposeEdges(context, 0.5, 0.6);
  const regions = proposeRegions(context, proposed, 0.6, 1);
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

/** The topology of the painted triangles alone: the painted triangles and edges around each vertex. */
function paintedTopology(
  mesh: RefineMesh,
  topology: RefineTopology,
  painted: Uint8Array,
): RefineTopology {
  const n = mesh.weldedCount;
  const triangleStart = new Uint32Array(n + 1);
  const triangles: number[] = [];
  const neighbourStart = new Uint32Array(n + 1);
  const neighbours: number[] = [];
  const near: number[] = [];
  for (let v = 0; v < n; v++) {
    near.length = 0;
    for (let i = topology.triangleStart[v]; i < topology.triangleStart[v + 1]; i++) {
      const t = topology.trianglesOf[i];
      if (!painted[t]) continue;
      triangles.push(t);
      for (const k of [0, 1, 2] as const) {
        const w = weldedCorner(mesh, t, k);
        if (w !== v) near.push(w);
      }
    }
    near.sort((a, b) => a - b);
    near.forEach((w, i) => {
      if (i === 0 || w !== near[i - 1]) neighbours.push(w);
    });
    triangleStart[v + 1] = triangles.length;
    neighbourStart[v + 1] = neighbours.length;
  }
  return {
    triangleStart,
    trianglesOf: Uint32Array.from(triangles),
    neighbourStart,
    neighbours: Uint32Array.from(neighbours),
  };
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

/**
 * Marks the edge vertices: bent at least `kMin` across and little along, where the bend across
 * falls away on both sides and the surface between turns as two faces meeting do, not round a tube.
 * Also marks the ridge of each band: its vertices bending nearly as much as the peak across them.
 */
function markEdgeVertices(context: Context, from: number, to: number) {
  const { mesh, topology, scope, k1, k2, along, kMin, normals, onEdge, ridge, step, progress } =
    context;
  const p = mesh.position;
  const { neighbourStart, neighbours } = topology;
  const scale = curvatureEdges * step;
  const reach = fallReach * scale;
  // A walk goes on past valleys to at most three reaches, and advances at least half an edge a step.
  const most = Math.ceil((6 * reach) / step) + 4;
  const visited = [new Int32Array(most), new Int32Array(most)];
  const distance = [new Float64Array(most), new Float64Array(most)];
  const count = [0, 0];
  const cut = [false, false];
  /** Walks from `v` straight on over the surface along (hx, hy, hz), for up to `reach` mm. */
  const walk = (v: number, side: number, hx: number, hy: number, hz: number) => {
    let u = v,
      travelled = 0;
    count[side] = 0;
    cut[side] = false;
    while (travelled < 3 * reach && count[side] < most) {
      let best = -1,
        bestCos = 0.5,
        bestLength = 0;
      for (let j = neighbourStart[u]; j < neighbourStart[u + 1]; j++) {
        const w = neighbours[j];
        const ex = p[w * 3] - p[u * 3],
          ey = p[w * 3 + 1] - p[u * 3 + 1],
          ez = p[w * 3 + 2] - p[u * 3 + 2];
        const length = Math.hypot(ex, ey, ez);
        const cos = (ex * hx + ey * hy + ez * hz) / length;
        if (cos > bestCos) [best, bestCos, bestLength] = [w, cos, length];
      }
      if (best < 0) {
        cut[side] = true;
        return;
      }
      travelled += bestLength * bestCos;
      u = best;
      visited[side][count[side]] = u;
      distance[side][count[side]++] = travelled;
      // Keep the heading in the tangent plane as the surface turns.
      const n = normals.of(u);
      const d = hx * n[u * 3] + hy * n[u * 3 + 1] + hz * n[u * 3 + 2];
      hx -= d * n[u * 3];
      hy -= d * n[u * 3 + 1];
      hz -= d * n[u * 3 + 2];
      const length = Math.hypot(hx, hy, hz);
      if (!(length > 0)) {
        cut[side] = true;
        return;
      }
      hx /= length;
      hy /= length;
      hz /= length;
    }
  };
  const fall = [0, 0];
  for (let i = 0; i < scope.length; i++) {
    if ((i & 1023) === 0) progress.at(from + ((to - from) * i) / scope.length);
    const v = scope[i];
    const k = Math.abs(k1[v]);
    if (k < kMin || Math.abs(k2[v]) > edgeRatio * k) continue;
    const sign = Math.sign(k1[v]);
    const n = normals.of(v);
    const nx = n[v * 3],
      ny = n[v * 3 + 1],
      nz = n[v * 3 + 2];
    const ax = along[v * 3],
      ay = along[v * 3 + 1],
      az = along[v * 3 + 2];
    let cx = ny * az - nz * ay,
      cy = nz * ax - nx * az,
      cz = nx * ay - ny * ax;
    const length = Math.hypot(cx, cy, cz);
    if (!(length > 0)) continue;
    cx /= length;
    cy /= length;
    cz /= length;
    walk(v, 0, cx, cy, cz);
    walk(v, 1, -cx, -cy, -cz);
    let peak = k;
    for (let side = 0; side < 2; side++)
      for (let j = 0; j < count[side] && distance[side][j] <= scale; j++)
        peak = Math.max(peak, sign * k1[visited[side][j]]);
    let flanked = true;
    for (let side = 0; side < 2 && flanked; side++) {
      fall[side] = -1;
      let fell = false,
        since = 0,
        low = Infinity,
        lowAt = -1,
        lowDistance = 0;
      for (let j = 0; j < count[side]; j++) {
        const u = visited[side][j],
          bend = sign * k1[u],
          d = distance[side][j];
        if (bend < fallRatio * peak) {
          fell = true;
          if (fall[side] < 0) fall[side] = u;
          break;
        }
        if (d - since > reach) break;
        if (bend >= ridgeRatio * peak) {
          if (low < valleyRatio * peak) {
            if (fall[side] < 0) fall[side] = lowAt;
            since = lowDistance;
          }
          low = Infinity;
        } else if (bend < low) [low, lowAt, lowDistance] = [bend, u, d];
      }
      // Where the surface or the paint ends, the band ends with it.
      const last = count[side] ? distance[side][count[side] - 1] : 0;
      if (!fell && cut[side] && last - since <= reach) {
        fell = true;
        if (fall[side] < 0) fall[side] = count[side] ? visited[side][count[side] - 1] : v;
      }
      flanked = fell;
    }
    if (!flanked) continue;
    const a = normals.of(fall[0]).subarray(fall[0] * 3, fall[0] * 3 + 3);
    const b = normals.of(fall[1]).subarray(fall[1] * 3, fall[1] * 3 + 3);
    const cos = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    if ((Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI > maxTurn) continue;
    onEdge[v] = 1;
    if (k >= ridgeRatio * peak) ridge[v] = 1;
  }
  progress.at(to);
}

/**
 * Bands of edge vertices, one per ridge: ridge vertices joined over mesh edges where they bend the
 * same way along one direction, and every other edge vertex given to the ridge nearest it over the
 * band. Two crests side by side are two bands, however close.
 */
function edgeBands(context: Context) {
  const { mesh, topology, scope, k1, along, onEdge, ridge } = context;
  const n = mesh.weldedCount;
  const { neighbourStart, neighbours } = topology;
  const joined = (v: number, w: number) =>
    onEdge[w] === 1 &&
    k1[v] * k1[w] > 0 &&
    Math.abs(
      along[v * 3] * along[w * 3] +
        along[v * 3 + 1] * along[w * 3 + 1] +
        along[v * 3 + 2] * along[w * 3 + 2],
    ) >= joinCosine;
  const parent = new Int32Array(n).fill(-1);
  const root = (v: number) => {
    while (parent[v] !== v) v = parent[v] = parent[parent[v]];
    return v;
  };
  for (const v of scope) if (ridge[v]) parent[v] = v;
  for (const v of scope) {
    if (!ridge[v]) continue;
    for (let j = neighbourStart[v]; j < neighbourStart[v + 1]; j++) {
      const w = neighbours[j];
      if (w < v || !ridge[w] || !joined(v, w)) continue;
      const a = root(v),
        b = root(w);
      if (a !== b) parent[a] = b;
    }
  }
  const band = new Int32Array(n).fill(-1);
  const ids = new Map<number, number>();
  const queue: number[] = [];
  for (const v of scope) {
    if (!ridge[v]) continue;
    const r = root(v);
    let id = ids.get(r);
    if (id === undefined) ids.set(r, (id = ids.size));
    band[v] = id;
    queue.push(v);
  }
  for (let q = 0; q < queue.length; q++) {
    const u = queue[q];
    for (let j = neighbourStart[u]; j < neighbourStart[u + 1]; j++) {
      const w = neighbours[j];
      if (band[w] >= 0 || !joined(u, w)) continue;
      band[w] = band[u];
      queue.push(w);
    }
  }
  const groups: number[][] = Array.from({ length: ids.size }, () => []);
  for (const v of scope) if (band[v] >= 0) groups[band[v]].push(v);
  return { bands: groups.map((g) => Uint32Array.from(g)), band };
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
  const { mesh, topology, k1, ridge } = context;
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
      if (!ridge[w]) step *= offRidge;
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

/** The ridge vertex of a band farthest by `cost`. */
function farthest(context: Context, graph: BandGraph, cost: Float64Array) {
  let best = -1;
  for (let i = 0; i < cost.length; i++)
    if (
      context.ridge[graph.members[i]] &&
      cost[i] !== Infinity &&
      (best < 0 || cost[i] > cost[best])
    )
      best = i;
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
  const start = members.findIndex((v) => context.ridge[v] === 1);
  if (start < 0) return null;
  const a = farthest(context, graph, shortest(context, graph, start, 0).cost);
  const b = farthest(context, graph, shortest(context, graph, a, 0).cost);
  const along = shortest(context, graph, a, peak);
  if (a === b || along.cost[b] === Infinity) return null;
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

  /** Half the area of the band within `widthReach` of a path, over the path's length. */
  function halfWidthOf(along: number[], length: number) {
    let count = 0;
    for (const inside of within(context, graph, along, widthReach)) count += inside;
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
 * The spine's vertices moved to the weighted centre of the band's vertices within `radius`, so the
 * guide follows the middle of a wide band rather than the path's zigzag, and never another band's. An open spine's ends
 * are then carried out along it as far as its end vertices reach.
 */
function centredSpine(
  context: Context,
  graph: BandGraph,
  path: number[],
  closed: boolean,
  radius: number,
) {
  const { mesh, topology, k1, kMin, stamp } = context;
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
        if (graph.band[w] !== graph.id || stamp[w] === mark) continue;
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

/** One piece of a spine between corners, fitted, before it is snapped and measured. */
interface Piece {
  path: number[];
  /** Centred points along `path`, flat. */
  points: number[];
  closed: boolean;
  halfWidth: number;
  kind: GuideKind;
  targets: Vec3[];
  /** The triangle under each target once snapped to the surface, -1 before. */
  triangles: number[];
  circle: Circle | null;
  /** Per end, how far along the piece's own curve it is to be carried to meet another edge. */
  carried: [number, number];
  /** The band the piece follows. */
  members: Uint32Array;
}

/** RMS within which a fit is accepted. */
function fitTolerance(context: Context) {
  // Centring on a mesh leaves an error of a fraction of an edge even where the scan has no noise.
  return Math.max(2 * context.noise, context.step / 8);
}

/** A piece of a spine, fitted as a line, then an arc, then a spline. */
function fitPiece(
  context: Context,
  path: number[],
  points: number[],
  closed: boolean,
  halfWidth: number,
  margin: number,
  members: Uint32Array,
): Piece | null {
  const length = polylineLength(points, closed);
  if (!(length > 0)) return null;
  const tolerance = fitTolerance(context);
  const s = stations(points, closed);
  const middle = core(points, s, closed, margin);
  const circle = fitCircle(middle);
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
    closed = false;
    // The open piece keeps the ring's own points and vertices up to where it stops, in step.
    const kept = Array.from(s.subarray(0, path.length)).filter((station) => station <= open).length;
    path = path.slice(0, kept);
    points = points.slice(0, kept * 3);
  }
  return {
    path,
    points,
    closed: closed && kind === 'arc',
    halfWidth,
    kind,
    targets,
    triangles: targets.map(() => -1),
    circle: kind === 'arc' ? circle : null,
    carried: [0, 0],
    members,
  };
}

/** The pieces along one spine, between its corners. */
function spinePieces(
  context: Context,
  graph: BandGraph,
  spine: NonNullable<ReturnType<typeof spineOf>>,
  members: Uint32Array,
): Piece[] {
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
  return pieces.flatMap((piece) => {
    const fitted = fitPiece(
      context,
      piece.map((i) => path[i]),
      piece.flatMap((i) => points.slice(i * 3, i * 3 + 3)),
      whole,
      halfWidth,
      radius,
      members,
    );
    return fitted ? [fitted] : [];
  });
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const along = (a: Vec3, d: Vec3, t: number): Vec3 => [
  a[0] + t * d[0],
  a[1] + t * d[1],
  a[2] + t * d[2],
];

/** Closest points of segments a0-a1 and b0-b1, as parameters 0..1 along each. */
function closestOfSegments(a0: Vec3, a1: Vec3, b0: Vec3, b1: Vec3) {
  const d1 = sub(a1, a0),
    d2 = sub(b1, b0),
    r = sub(a0, b0);
  const a = dot(d1, d1),
    e = dot(d2, d2),
    f = dot(d2, r);
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  let s = 0,
    t = 0;
  if (a <= 1e-18 && e <= 1e-18) return { s, t };
  if (a <= 1e-18) t = clamp(f / e);
  else {
    const c = dot(d1, r);
    if (e <= 1e-18) s = clamp(-c / a);
    else {
      const b = dot(d1, d2);
      const denominator = a * e - b * b;
      s = denominator > 1e-18 ? clamp((b * f - c * e) / denominator) : 0;
      t = (b * s + f) / e;
      if (t < 0) [t, s] = [0, clamp(-c / a)];
      else if (t > 1) [t, s] = [1, clamp((b - c) / a)];
    }
  }
  return { s, t };
}

/** The open end `end` of a piece: its point and the unit direction leading out of it. */
function endOf(piece: Piece, end: 0 | 1, window: number) {
  const { targets, points } = piece;
  const point = end === 0 ? targets[0] : targets[targets.length - 1];
  let back: Vec3;
  if (piece.kind === 'line') back = end === 0 ? targets[1] : targets[0];
  else {
    const s = stations(points, false);
    const total = s[s.length - 1];
    const w = Math.min(window, total / 3);
    back = pointAt(points, s, end === 0 ? w : total - w, false);
    const tip = pointAt(points, s, end === 0 ? 0 : total, false);
    const out = sub(tip, back);
    const length = Math.hypot(...out);
    return { point, out: out.map((x) => x / length) as Vec3 };
  }
  const out = sub(point, back);
  const length = Math.hypot(...out);
  return { point, out: out.map((x) => x / length) as Vec3 };
}

/**
 * Carries each open end that meets another edge on to the meeting point: where its line out, up
 * to `meetReach` curvature scales long, comes closest to another piece or to another end's line
 * out, when they pass within half a curvature scale.
 */
function meetEnds(context: Context, pieces: Piece[]) {
  const scale = curvatureEdges * context.step;
  const reach = meetReach * scale;
  const gap = scale / 2;
  const window = turnEdges * context.step;
  interface End {
    piece: number;
    end: 0 | 1;
    point: Vec3;
    out: Vec3;
  }
  const ends: End[] = [];
  pieces.forEach((piece, i) => {
    if (piece.closed) return;
    for (const end of [0, 1] as const) {
      const at = endOf(piece, end, window);
      // A piece too short to have a direction meets nothing.
      if (at.out.every(Number.isFinite)) ends.push({ piece: i, end, ...at });
    }
  });
  // Each piece as fitted: its drawn curve, or its centred points for a ring.
  const curves = pieces.map((piece) =>
    piece.closed
      ? [...piece.points, ...piece.points.slice(0, 3)]
      : Array.from(drawnCurve(piece.kind, piece.targets.flat(), context.step).points),
  );
  const boxes = curves.map((curve) => {
    const lo: Vec3 = [Infinity, Infinity, Infinity],
      hi: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < curve.length; i++) {
      lo[i % 3] = Math.min(lo[i % 3], curve[i]);
      hi[i % 3] = Math.max(hi[i % 3], curve[i]);
    }
    return { lo, hi };
  });
  const outward = (e: End): [Vec3, Vec3] => [
    along(e.point, e.out, -gap),
    along(e.point, e.out, reach),
  ];
  const crossing = Math.cos((splitTurn * Math.PI) / 180);
  const meetings = ends.map((e) => {
    const [a0, a1] = outward(e);
    let best: { apart: number; at: number; meet: Vec3 } | null = null;
    const consider = (b0: Vec3, b1: Vec3) => {
      const d = sub(b1, b0);
      // Edges meet at an angle: an edge carried on in line with another is one edge, not a corner.
      if (Math.abs(dot(d, e.out)) > crossing * Math.hypot(...d)) return;
      const { s, t } = closestOfSegments(a0, a1, b0, b1);
      const p = along(a0, sub(a1, a0), s),
        q = along(b0, d, t);
      const apart = Math.hypot(...sub(p, q));
      if (!(apart <= gap) || (best && apart >= best.apart)) return;
      best = {
        apart,
        at: -gap + s * (reach + gap),
        meet: [0, 1, 2].map((k) => (p[k] + q[k]) / 2) as Vec3,
      };
    };
    curves.forEach((curve, j) => {
      if (j === e.piece) return;
      const { lo, hi } = boxes[j];
      for (let k = 0; k < 3; k++)
        if (e.point[k] < lo[k] - reach - gap || e.point[k] > hi[k] + reach + gap) return;
      for (let i = 3; i < curve.length; i += 3)
        consider(curve.slice(i - 3, i) as Vec3, curve.slice(i, i + 3) as Vec3);
    });
    for (const f of ends) if (f.piece !== e.piece) consider(...outward(f));
    return best as { apart: number; at: number; meet: Vec3 } | null;
  });
  // Ends meeting at one corner meet at one point: the mean of their meeting points.
  const corner = meetings.map((_, i) => i);
  const find = (i: number): number => (corner[i] === i ? i : (corner[i] = find(corner[i])));
  meetings.forEach((a, i) =>
    meetings.forEach((b, j) => {
      if (a && b && j > i && Math.hypot(...sub(a.meet, b.meet)) <= gap) corner[find(i)] = find(j);
    }),
  );
  const sums = new Map<number, number[]>();
  meetings.forEach((m, i) => {
    if (!m) return;
    const sum = sums.get(find(i)) ?? [0, 0, 0, 0];
    for (let k = 0; k < 3; k++) sum[k] += m.meet[k];
    sum[3]++;
    sums.set(find(i), sum);
  });
  meetings.forEach((m, i) => {
    if (!m) return;
    const sum = sums.get(find(i))!;
    const mean = [sum[0] / sum[3], sum[1] / sum[3], sum[2] / sum[3]] as Vec3;
    // Each end stays on its own line out, at the point of it nearest the corner.
    m.at = dot(sub(mean, ends[i].point), ends[i].out);
    m.meet = along(ends[i].point, ends[i].out, m.at);
  });
  ends.forEach((e, i) => {
    const meeting = meetings[i];
    if (meeting && meeting.at > 0) pieces[e.piece].carried[e.end] = Math.min(meeting.at, reach);
  });
}

/**
 * Joins pieces of one circle: two pieces whose ends lie within a curvature scale of each other and
 * whose points together fit one circle (and not one line) become one arc, which `carryEnds` closes
 * into a ring when its own ends then nearly meet.
 */
function joinArcs(context: Context, pieces: Piece[]) {
  const scale = curvatureEdges * context.step;
  const tip = (piece: Piece, end: 0 | 1): Vec3 => {
    const k = end === 0 ? 0 : piece.points.length - 3;
    return piece.points.slice(k, k + 3) as Vec3;
  };
  // Pairs already tried and refused, so a piece is fitted against each neighbour only once.
  const refused = new Set<string>();
  const ids = new Map<Piece, number>();
  const id = (piece: Piece) => {
    if (!ids.has(piece)) ids.set(piece, ids.size);
    return ids.get(piece)!;
  };
  for (let i = 0; i < pieces.length; i++) {
    if (pieces[i].closed) continue;
    for (let j = i + 1; j < pieces.length; j++) {
      const a = pieces[i],
        b = pieces[j];
      if (b.closed) continue;
      let merged: Piece | null = null;
      for (const ea of [0, 1] as const)
        for (const eb of [0, 1] as const) {
          if (merged || Math.hypot(...sub(tip(a, ea), tip(b, eb))) > scale) continue;
          const key = id(a) + ' ' + id(b) + ' ' + ea + eb;
          if (refused.has(key)) continue;
          merged = joined(a, ea, b, eb);
          if (!merged) refused.add(key);
        }
      if (!merged) continue;
      pieces[i] = merged;
      pieces.splice(j, 1);
      // The joined piece may join more: look again from the start.
      j = i;
    }
  }

  /** a and b as one arc, a's end `ea` running into b's end `eb`, or null when they fit no arc. */
  function joined(a: Piece, ea: 0 | 1, b: Piece, eb: 0 | 1) {
    const flip = (piece: Piece, reverse: boolean) => {
      const count = piece.path.length;
      const order = Array.from({ length: count }, (_, k) => (reverse ? count - 1 - k : k));
      return {
        path: order.map((k) => piece.path[k]),
        points: order.flatMap((k) => piece.points.slice(k * 3, k * 3 + 3)),
      };
    };
    const first = flip(a, ea === 0),
      second = flip(b, eb === 1);
    const halfWidth = Math.max(a.halfWidth, b.halfWidth);
    const members = new Uint32Array(a.members.length + b.members.length);
    members.set(a.members);
    members.set(b.members, a.members.length);
    const merged = fitPiece(
      context,
      [...first.path, ...second.path],
      [...first.points, ...second.points],
      false,
      halfWidth,
      Math.max(1.5 * halfWidth, 2 * context.step),
      members,
    );
    if (merged?.kind !== 'arc' || !snapPiece(context, merged)) return null;
    // The joined arc must be edge all along, the stretch between the two pieces included, on the
    // surface in scope.
    const circle = fitCircle(merged.targets.flat());
    if (!circle) return null;
    const [head, middle, tail] = merged.targets;
    const start = angleOn(circle, head);
    const wrap = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const toMiddle = wrap(angleOn(circle, middle) - start),
      toEnd = wrap(angleOn(circle, tail) - start);
    const sweep = toMiddle < toEnd ? toEnd : toEnd - 2 * Math.PI;
    return edgeOnArc(context, circle, start, sweep, merged.path[0]) ? merged : null;
  }
}

/**
 * True when the shorter stretch of `circle` between the angles of `p` and `q` is edge all along:
 * at every sample the surface in scope lies under the circle (within three fit tolerances along
 * its normal, not off to its side past the paint) and an edge vertex is at or next to the
 * nearest vertex. A strap, a slot or a gap in the paint across the stretch fails it.
 */
function edgeBetween(context: Context, circle: Circle, p: Vec3, q: Vec3, from: number) {
  const a = angleOn(circle, p);
  const sweep = angleOn(circle, q) - a;
  return edgeOnArc(context, circle, a, Math.atan2(Math.sin(sweep), Math.cos(sweep)), from);
}

/** True when the arc of `circle` from angle `a` round by `sweep` is edge all along: see `edgeBetween`. */
function edgeOnArc(context: Context, circle: Circle, a: number, sweep: number, from: number) {
  const { topology, onEdge } = context;
  const count = Math.max(1, Math.ceil(Math.abs(sweep * circle.radius) / (context.step / 2)));
  for (let k = 0; k <= count; k++) {
    const at = onCircle(circle, along(circle.centre, rotated(circle, a + (sweep * k) / count), 1));
    from = nearestVertex(context, from, at);
    if (!onSurface(context, at, from)) return false;
    let edge = onEdge[from] === 1;
    for (let j = topology.neighbourStart[from]; j < topology.neighbourStart[from + 1] && !edge; j++)
      edge = onEdge[topology.neighbours[j]] === 1;
    if (!edge) return false;
  }
  return true;
}

/**
 * The surface point in scope under `q`, found from vertex `from`, or null when the surface there is
 * more than three fit tolerances from `q` along its normal or off to its side (past the paint).
 */
function onSurface(context: Context, q: Vec3, from: number) {
  const guide = snap(context, nearestVertex(context, from, q), q);
  if (!guide) return null;
  const off = sub(q, guide.position);
  const n = faceNormal(context.mesh, guide.triangle);
  const normal = dot(off, n);
  const side = Math.hypot(...off.map((x, k) => x - normal * n[k]));
  return Math.abs(normal) <= 3 * fitTolerance(context) && side <= context.step / 8 ? guide : null;
}

/** Angles about a circle's centre in its plane. */
function angleOn(circle: Circle, p: Vec3) {
  const w = sub(p, circle.centre);
  return Math.atan2(dot(w, circle.v), dot(w, circle.u));
}

/**
 * Carries a piece's ends on along its own curve by the distances `meetEnds` found, in short steps,
 * for as long as the surface in scope stays under the curve: an arc keeps its circle and grows only
 * at its ends, a line keeps its line, and a spline gains one point past its end. A piece whose ends
 * nearly meet is a ring and is not carried; an arc that nearly closes is closed instead. False when
 * a closed ring cannot be snapped.
 */
function carryEnds(context: Context, piece: Piece) {
  const { targets, triangles } = piece;
  const scale = curvatureEdges * context.step;
  const first = targets[0],
    last = targets[targets.length - 1];
  const ring = !piece.closed && Math.hypot(...sub(first, last)) <= scale;
  const circle = piece.kind === 'arc' ? fitCircle(targets.flat()) : null;
  const end = piece.path[piece.path.length - 1];
  if (ring && circle && edgeBetween(context, circle, last, first, end)) {
    // An arc whose ends almost touch is the whole ring, drawn through three points at thirds.
    const a = angleOn(circle, first);
    piece.closed = true;
    piece.targets = [0, 1, 2].map((k) =>
      onCircle(circle, along(circle.centre, rotated(circle, a + (2 * Math.PI * k) / 3), 1)),
    );
    piece.triangles = [-1, -1, -1];
    return snapPiece(context, piece);
  }
  if (piece.closed || ring) return true;
  // An arc's direction of travel round its circle: the way that passes its middle point.
  let sweep = 0,
    start = 0;
  if (circle) {
    start = angleOn(circle, first);
    const wrap = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const toMiddle = wrap(angleOn(circle, targets[1]) - start),
      toEnd = wrap(angleOn(circle, last) - start);
    sweep = toMiddle < toEnd ? toEnd : toEnd - 2 * Math.PI;
  }
  const ends: (Vec3 | null)[] = [null, null];
  for (const end of [0, 1] as const) {
    const carry = piece.carried[end];
    if (!(carry > 0)) continue;
    const tip = end === 0 ? first : last;
    const out = endOf(piece, end, turnEdges * context.step).out;
    let from = nearestOnPath(piece.path, piece.points, tip);
    for (let t = context.step / 4; t <= carry + 1e-9; t += context.step / 4) {
      let q: Vec3;
      if (circle) {
        const turn = (Math.sign(sweep) * t) / circle.radius;
        const angle = end === 0 ? start - turn : start + sweep + turn;
        q = onCircle(circle, along(circle.centre, rotated(circle, angle), 1));
      } else q = along(tip, out, t);
      const guide = onSurface(context, q, from);
      if (!guide) break;
      from = weldedCorner(context.mesh, guide.triangle, 0);
      ends[end] = q;
      if (piece.kind === 'spline') continue;
      targets[end === 0 ? 0 : targets.length - 1] = q;
      triangles[end === 0 ? 0 : targets.length - 1] = guide.triangle;
    }
  }
  if (piece.kind === 'spline')
    for (const end of [0, 1] as const) {
      const q = ends[end];
      // A point closer to the end than half the spline's spacing would crowd it: not added.
      const tip = end === 0 ? targets[0] : targets[targets.length - 1];
      if (!q || Math.hypot(...sub(q, tip)) < (splineSpacing * piece.halfWidth) / 2) continue;
      const guide = snap(context, nearestOnPath(piece.path, piece.points, q), q);
      if (!guide) continue;
      if (end === 0) (targets.unshift(q), triangles.unshift(guide.triangle));
      else (targets.push(q), triangles.push(guide.triangle));
    }
  return true;
}

/** Unit direction at `angle` in a circle's plane. */
function rotated(circle: Circle, angle: number): Vec3 {
  return [0, 1, 2].map(
    (k) => Math.cos(angle) * circle.u[k] + Math.sin(angle) * circle.v[k],
  ) as Vec3;
}

/** Unit normal of a triangle. */
function faceNormal(mesh: RefineMesh, t: number): Vec3 {
  const corner = (k: 0 | 1 | 2): Vec3 => {
    const w = weldedCorner(mesh, t, k) * 3;
    return [mesh.position[w], mesh.position[w + 1], mesh.position[w + 2]];
  };
  const [a, b, c] = [corner(0), corner(1), corner(2)];
  const u = sub(b, a),
    v = sub(c, a);
  const n: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const length = Math.hypot(...n) || 1;
  return n.map((x) => x / length) as Vec3;
}

/** The proposal for a piece, or null when it is drawn shorter than `minLength` or spans too little. */
function pieceInput(context: Context, piece: Piece): EdgeInput | null {
  const { minLength } = context.options;
  const { path, points, targets, triangles, kind, closed } = piece;
  const guides: GuidePoint[] = [];
  // With paint, every point goes to the nearest point of the painted surface.
  for (let i = 0; i < targets.length; i++) {
    const from =
      triangles[i] >= 0
        ? weldedCorner(context.mesh, triangles[i], 0)
        : nearestOnPath(path, points, targets[i]);
    const guide = snap(context, nearestVertex(context, from, targets[i]), targets[i]);
    if (!guide) return null;
    // Without paint a point already placed (a line's end, a carried end) keeps its place on its
    // curve, within the fit tolerance of the surface: off a rounded corner, toward the true edge.
    const placed = triangles[i] >= 0 && !context.triangleInScope;
    guides.push(placed ? { triangle: guide.triangle, position: targets[i] } : guide);
  }
  const flat = guides.flatMap((g) => g.position);
  let length: number, span: number;
  if (closed) {
    const circle = fitCircle(flat);
    if (!circle) return null;
    length = 2 * Math.PI * circle.radius;
    span = 2 * circle.radius;
  } else {
    const drawn = drawnCurve(kind, flat, context.step).points;
    length = polylineLength(Array.from(drawn), false);
    span = 0;
    for (let i = 0; i < drawn.length; i += 3)
      for (let j = i + 3; j < drawn.length; j += 3)
        span = Math.max(
          span,
          Math.hypot(drawn[i] - drawn[j], drawn[i + 1] - drawn[j + 1], drawn[i + 2] - drawn[j + 2]),
        );
  }
  if (length < minLength || span < spanRatio * minLength) return null;
  return {
    segments: [{ kind, points: guides }],
    joints: closed ? ['smooth'] : [],
    closed,
    width: null,
    strength: 1,
  };
}

/**
 * Moves a piece's points onto the surface; false when one has no surface in scope near it. A line
 * is refitted to the surface under its middle, away from any rounded corner at its ends, and keeps
 * its ends on it.
 */
function snapPiece(context: Context, piece: Piece) {
  const { path, points, targets, triangles } = piece;
  const onSurface = (p: Vec3) => snap(context, nearestOnPath(path, points, p), p);
  if (piece.kind === 'line') {
    const [a, b] = targets;
    const on: number[] = [];
    for (let k = 0; k <= 16; k++) {
      const guide = onSurface(along(a, sub(b, a), 0.1 + (0.8 * k) / 16));
      if (!guide) return false;
      on.push(...guide.position);
    }
    const { mean, vectors } = principalAxes(on);
    const d = vectors[0];
    for (let i = 0; i < 2; i++) {
      targets[i] = along(mean, d, dot(sub(targets[i], mean), d));
      const guide = onSurface(targets[i]);
      if (!guide) return false;
      triangles[i] = guide.triangle;
    }
    return true;
  }
  for (let i = 0; i < targets.length; i++) {
    const guide = onSurface(targets[i]);
    if (!guide) return false;
    targets[i] = guide.position;
    triangles[i] = guide.triangle;
  }
  return true;
}

/** The vertex nearest `p`, found downhill over the surface from `from`. */
function nearestVertex(context: Context, from: number, p: Vec3) {
  const { mesh, topology } = context;
  const q = mesh.position;
  const d = (v: number) => Math.hypot(q[v * 3] - p[0], q[v * 3 + 1] - p[1], q[v * 3 + 2] - p[2]);
  let v = from,
    best = d(v);
  for (;;) {
    let next = -1;
    for (let j = topology.neighbourStart[v]; j < topology.neighbourStart[v + 1]; j++) {
      const w = topology.neighbours[j];
      const e = d(w);
      if (e < best) [best, next] = [e, w];
    }
    if (next < 0) return v;
    v = next;
  }
}

function proposeEdges(context: Context, from: number, to: number) {
  const { mesh, step, progress } = context;
  const { bands, band } = edgeBands(context);
  const local = new Int32Array(mesh.weldedCount).fill(-1);
  const pieces: Piece[] = [];
  let done = 0;
  const total = bands.reduce((sum, members) => sum + members.length, 0);
  // Bands still to trace, with their ids in `band`. A band whose spine leaves branches is peeled:
  // what the spine covers is taken away and each branch left over is traced in turn.
  const work: { members: Uint32Array; id: number }[] = bands.map((members, id) => ({
    members,
    id,
  }));
  let nextId = bands.length;
  while (work.length) {
    const { members, id } = work.pop()!;
    progress.at(from + ((to - from) * done) / Math.max(total, 1));
    members.forEach((v, i) => (local[v] = i));
    const graph: BandGraph = { members, local, id, band };
    const spine = spineOf(context, graph);
    if (!spine) {
      done += members.length;
      continue;
    }
    const covered = within(
      context,
      graph,
      spine.path.map((v) => local[v]),
      2 * spine.halfWidth + step,
    );
    // A piece stands for the band it covers, not the branches peeled off to be traced apart.
    const own = members.filter((_, i) => covered[i] === 1);
    for (const piece of spinePieces(context, graph, spine, own))
      if (snapPiece(context, piece)) pieces.push(piece);
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
  joinArcs(context, pieces);
  meetEnds(context, pieces);
  const proposals: RefineProposal[] = [];
  const proposed = new Uint8Array(mesh.weldedCount);
  for (const piece of pieces) {
    if (!carryEnds(context, piece)) continue;
    const input = pieceInput(context, piece);
    if (!input) continue;
    proposals.push({ type: 'edge', input });
    for (const v of piece.members) proposed[v] = 1;
  }
  progress.at(to);
  return { proposals, proposed };
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

function proposeRegions(
  context: Context,
  proposed: Uint8Array,
  from: number,
  to: number,
): RefineProposal[] {
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
  const found: { kind: ShapeKind; triangles: number[] }[] = [];
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
        if (!inScope[w] || region[w] >= 0 || proposed[w]) continue;
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
          // A region never grows across the band of a proposed edge.
          if (!inScope[w] || region[w] >= 0 || proposed[w]) continue;
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
    if (final?.within) {
      // Membership is checked again against the shape the region was finished with.
      const shape = final.shape;
      let kept = 0;
      for (let i = 0; i < count; i++) {
        const v = members[i];
        const p = mesh.position;
        if (Math.abs(shapeDistance(shape, p[v * 3], p[v * 3 + 1], p[v * 3 + 2])) <= tolerance)
          members[kept++] = v;
        else region[v] = -1;
      }
      count = kept;
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
    let area = 0;
    for (const t of triangles) area += triangleArea(mesh, t);
    if (!final?.within || area <= minLength * minLength) {
      release();
      continue;
    }
    found.push({ kind: final.shape.kind, triangles });
  }
  joinRegions(context, found);
  const kept = fillHoles(context, found, proposed);
  for (const { kind, triangles } of kept)
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
  progress.at(to);
  return proposals;
}

/** The triangle across each edge of `t`, or -1 where the mesh, or the paint, ends there. */
function acrossEdges(context: Context, t: number, out: Int32Array) {
  const { mesh, topology } = context;
  const { triangleStart, trianglesOf } = topology;
  for (let k = 0; k < 3; k++) {
    const a = weldedCorner(mesh, t, k as 0 | 1 | 2),
      b = weldedCorner(mesh, t, ((k + 1) % 3) as 0 | 1 | 2);
    out[k] = -1;
    for (let i = triangleStart[a]; i < triangleStart[a + 1] && out[k] < 0; i++) {
      const u = trianglesOf[i];
      if (u === t) continue;
      for (const j of [0, 1, 2] as const) if (weldedCorner(mesh, u, j) === b) out[k] = u;
    }
  }
}

/**
 * Gives each region the holes in it: pieces of surface enclosed by the region and smaller than it,
 * such as rivets standing on a plate, so that keeping detail carries them. A hole whose rim is
 * mostly a proposed edge (a pocket or a through hole) is left out. A region whose triangles go to
 * a larger one's hole is taken into it; what is left of it is dropped when below the minimum area.
 */
function fillHoles(
  context: Context,
  regions: { kind: ShapeKind; triangles: number[] }[],
  proposed: Uint8Array,
) {
  const { mesh, options } = context;
  const { neighbourStart, neighbours } = context.topology;
  const owner = new Int32Array(mesh.triangleCount).fill(-1);
  regions.forEach((r, i) => r.triangles.forEach((t) => (owner[t] = i)));
  const order = regions
    .map((_, i) => i)
    .sort((a, b) => regions[b].triangles.length - regions[a].triangles.length);
  // Per triangle: 2 * pass while being flooded, 2 * pass + 1 once known to reach outside.
  const seen = new Int32Array(mesh.triangleCount).fill(-1);
  const across = new Int32Array(3);
  const inScope = (t: number) => !context.triangleInScope || context.triangleInScope[t] === 1;
  order.forEach((r, pass) => {
    const region = regions[r];
    const size = region.triangles.length;
    const flooding = 2 * pass,
      outside = 2 * pass + 1;
    const holes: number[][] = [];
    for (const t of region.triangles) {
      acrossEdges(context, t, across);
      for (const start of across) {
        if (start < 0 || owner[start] === r || seen[start] === flooding || seen[start] === outside)
          continue;
        const hole = [start];
        seen[start] = flooding;
        let open = false;
        for (let q = 0; q < hole.length && !open; q++) {
          acrossEdges(context, hole[q], across);
          for (const u of across) {
            if (u < 0 || !inScope(u) || seen[u] === outside) open = true;
            else if (owner[u] !== r && seen[u] !== flooding) {
              seen[u] = flooding;
              hole.push(u);
            }
          }
          if (hole.length >= size) open = true;
        }
        if (open) for (const u of hole) seen[u] = outside;
        else holes.push(hole);
        acrossEdges(context, t, across);
      }
    }
    if (!holes.length) return;
    const onRegion = new Uint8Array(mesh.weldedCount);
    for (const t of region.triangles)
      for (const k of [0, 1, 2] as const) onRegion[weldedCorner(mesh, t, k)] = 1;
    const taken = new Set<number>();
    for (const hole of holes) {
      // The rim: the hole's corners on the region. A rim corner is on an edge when it or a
      // neighbour belongs to a band that was proposed.
      const rim = new Set<number>();
      for (const t of hole)
        for (const k of [0, 1, 2] as const) {
          const v = weldedCorner(mesh, t, k);
          if (onRegion[v]) rim.add(v);
        }
      let edge = 0;
      for (const v of rim) {
        let near = proposed[v] === 1;
        for (let j = neighbourStart[v]; j < neighbourStart[v + 1] && !near; j++)
          near = proposed[neighbours[j]] === 1;
        if (near) edge++;
      }
      if (2 * edge >= rim.size) continue;
      for (const t of hole) {
        if (owner[t] >= 0) taken.add(t);
        owner[t] = r;
        region.triangles.push(t);
      }
    }
    if (taken.size)
      for (const other of regions)
        if (other !== region) other.triangles = other.triangles.filter((t) => !taken.has(t));
  });
  const least = options.minLength * options.minLength;
  return regions.filter((r) => {
    let area = 0;
    for (const t of r.triangles) area += triangleArea(mesh, t);
    return r.triangles.length > 0 && area > least;
  });
}

/**
 * Joins neighbouring regions of one kind that are one surface (`sameSurface`): growth from two seeds
 * can stop short of each other on one surface.
 */
function joinRegions(context: Context, regions: { kind: ShapeKind; triangles: number[] }[]) {
  const { mesh, topology, normals } = context;
  const owner = new Int32Array(mesh.weldedCount).fill(-1);
  const cornersOf = (r: { triangles: number[] }) => {
    const set = new Set<number>();
    for (const t of r.triangles)
      for (const k of [0, 1, 2] as const) set.add(weldedCorner(mesh, t, k));
    return set;
  };
  const corners = regions.map(cornersOf);
  corners.forEach((set, i) => set.forEach((v) => (owner[v] = i)));
  const pairs = new Set<string>();
  corners.forEach((set, i) => {
    for (const v of set)
      for (let j = topology.neighbourStart[v]; j < topology.neighbourStart[v + 1]; j++) {
        const o = owner[topology.neighbours[j]];
        if (o >= 0 && o !== i && regions[o].kind === regions[i].kind)
          pairs.add(Math.min(i, o) + ' ' + Math.max(i, o));
      }
  });
  const into = regions.map((_, i) => i);
  const find = (i: number): number => (into[i] === i ? i : (into[i] = find(into[i])));
  const order = [...pairs]
    .map((key) => key.split(' ').map(Number))
    .sort(
      (a, b) =>
        regions[b[0]].triangles.length +
        regions[b[1]].triangles.length -
        regions[a[0]].triangles.length -
        regions[a[1]].triangles.length,
    );
  for (const [x, y] of order) {
    const a = find(x),
      b = find(y);
    if (a === b) continue;
    const sample = (set: Set<number>) => {
      const list = [...set];
      return sampleOf(context, normals, list, list.length);
    };
    if (!sameSurface(regions[a].kind, sample(corners[a]), sample(corners[b]), context.noise))
      continue;
    into[b] = a;
    // Appended one by one: a spread of a large region would overflow the call stack.
    for (const t of regions[b].triangles) regions[a].triangles.push(t);
    regions[b].triangles = [];
    for (const v of corners[b]) corners[a].add(v);
  }
  for (let i = regions.length - 1; i >= 0; i--)
    if (!regions[i].triangles.length) regions.splice(i, 1);
}

interface Sample {
  points: Float32Array;
  directions: Float32Array;
}

/**
 * True when samples of two neighbouring regions are one surface of `kind`: see `joinRms`. A step, a
 * fold or a taper leaves each side consistently to one side of the joint fit, or the joint fit
 * worse than either alone.
 */
export function sameSurface(kind: ShapeKind, a: Sample, b: Sample, noise: number) {
  const fit = (s: Sample) => {
    try {
      return fitShape(s.points, s.directions, kind, noise);
    } catch {
      return null;
    }
  };
  const both: Sample = {
    points: new Float32Array(a.points.length + b.points.length),
    directions: new Float32Array(a.directions.length + b.directions.length),
  };
  both.points.set(a.points);
  both.points.set(b.points, a.points.length);
  both.directions.set(a.directions);
  both.directions.set(b.directions, a.directions.length);
  const own = [fit(a), fit(b)],
    joint = fit(both);
  if (!own[0]?.within || !own[1]?.within || !joint?.within) return false;
  // Each side on its own terms: the shared surface must hold it nearly as well as its own fit.
  const tolerance = 3 * noise;
  for (const [k, side] of [a, b].entries()) {
    const mine = scored(own[k]!.shape, side, tolerance),
      shared = scored(joint.shape, side, tolerance);
    if (shared.support < Math.max(joinSupport * mine.support, acceptedSupport)) return false;
    if (shared.rms > joinRms * Math.max(mine.rms, 1e-9)) return false;
    if (Math.abs(shared.mean) > noise) return false;
  }
  // And the two shapes themselves agree, within what each region's own fit can tell.
  const spread = [a, b].map((side) => {
    const halves = [0, 1].map((h) => {
      const count = side.points.length / 3;
      const take = Math.floor((count - h + 1) / 2);
      const half: Sample = {
        points: new Float32Array(take * 3),
        directions: new Float32Array(take * 3),
      };
      for (let i = 0; i < take; i++) {
        half.points.set(side.points.subarray((2 * i + h) * 3, (2 * i + h) * 3 + 3), i * 3);
        half.directions.set(side.directions.subarray((2 * i + h) * 3, (2 * i + h) * 3 + 3), i * 3);
      }
      return fit(half);
    });
    return halves[0] && halves[1] ? apart(halves[0].shape, halves[1].shape, side) : null;
  });
  const between = apart(own[0]!.shape, own[1]!.shape, both);
  if (!spread[0] || !spread[1]) return false;
  const allowed = (key: keyof Apart, floor: number) =>
    Math.max(floor, parameterSpread * (spread[0]![key] + spread[1]![key]));
  return (
    between.angle <= allowed('angle', joinAngle) &&
    between.offset <= allowed('offset', tolerance) &&
    between.size <= allowed('size', tolerance)
  );
}

/**
 * Of a sample against `shape`: the fraction within `tolerance`, the rms of those (as a fit's rms is
 * of its inliers), and the mean signed distance of all.
 */
function scored(shape: Shape, { points }: Sample, tolerance: number) {
  let sum = 0,
    squares = 0,
    near = 0;
  const count = points.length / 3;
  for (let i = 0; i < count; i++) {
    const d = shapeDistance(shape, points[i * 3], points[i * 3 + 1], points[i * 3 + 2]);
    sum += d;
    if (Math.abs(d) > tolerance) continue;
    squares += d * d;
    near++;
  }
  return { support: near / count, rms: Math.sqrt(squares / Math.max(near, 1)), mean: sum / count };
}

/**
 * How far apart two shapes of one kind are, near a sample: `angle` between normals or axes in
 * degrees (a cone's half-angle difference counts too), `offset` between planes, axes, centres or
 * apexes in mm (between axes, at the sample's centroid), `size` between radii in mm.
 */
interface Apart {
  angle: number;
  offset: number;
  size: number;
}
function apart(p: Shape, q: Shape, near: Sample): Apart {
  const count = near.points.length / 3;
  const centroid: Vec3 = [0, 0, 0];
  for (let i = 0; i < count; i++)
    for (let k = 0; k < 3; k++) centroid[k] += near.points[i * 3 + k] / count;
  const degrees = (u: Vec3, v: Vec3) =>
    (Math.acos(Math.min(1, Math.abs(dot(u, v)))) * 180) / Math.PI;
  /** Distance from `x` to the line through `o` along unit `d`. */
  const fromLine = (x: Vec3, o: Vec3, d: Vec3) => {
    const w = sub(x, o);
    const t = dot(w, d);
    return Math.hypot(w[0] - t * d[0], w[1] - t * d[1], w[2] - t * d[2]);
  };
  if (p.kind === 'plane' && q.kind === 'plane')
    return {
      angle: degrees(p.normal, q.normal),
      offset: Math.abs(
        dot(sub(centroid, p.point), p.normal) - dot(sub(centroid, q.point), q.normal),
      ),
      size: 0,
    };
  if (p.kind === 'sphere' && q.kind === 'sphere')
    return {
      angle: 0,
      offset: Math.hypot(...sub(p.center, q.center)),
      size: Math.abs(Math.abs(p.radius) - Math.abs(q.radius)),
    };
  if (p.kind === 'cylinder' && q.kind === 'cylinder') {
    // The axis of q at the centroid's level on p's axis, measured from p's axis.
    const t = dot(sub(centroid, q.point), q.axis);
    const onQ = along(q.point, q.axis, t);
    return {
      angle: degrees(p.axis, q.axis),
      offset: fromLine(onQ, p.point, p.axis),
      size: Math.abs(Math.abs(p.radius) - Math.abs(q.radius)),
    };
  }
  if (p.kind === 'cone' && q.kind === 'cone')
    return {
      angle: degrees(p.axis, q.axis) + (Math.abs(p.angle - q.angle) * 180) / Math.PI,
      offset: Math.hypot(...sub(p.apex, q.apex)),
      size: 0,
    };
  return { angle: Infinity, offset: Infinity, size: Infinity };
}
