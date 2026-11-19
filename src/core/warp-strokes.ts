import { Triangle, Vector3 } from 'three';
import type { Vec3 } from './types';
import { bindTrianglePoint } from './warp-bind';
import { deformPoint } from './warp-evaluate';
import { spacingAt, warpEligibleNodes, type WarpSample } from './warp-handles';
import { isPaintedFace, type WarpModel } from './warp-model';
import { regionTriangleOf } from './warp-region';
import type { WarpState } from './warp-solve';

/** A spot on a geometry face, as a stroke hit it on the warped surface. */
export interface WarpStrokePoint {
  face: number;
  barycentric: Vec3;
}

/** A line handle's drawn path keeps at most this many points. */
export const warpPathLimit = 512;
/** A line takes a sample about every this many node spacings along it. */
export const warpLineStep = 0.5;
/** An area takes at most this many samples, and at least this many where its faces allow. */
export const warpAreaSamples = { max: 32, min: 4 };

/** The barycentric coordinates of a mesh-local point on a face of `positions`, clamped onto it. */
export function faceBarycentric(
  model: WarpModel,
  positions: ArrayLike<number>,
  face: number,
  point: Vec3,
) {
  const corner = (c: number) => {
    const v = model.index?.[face * 3 + c] ?? face * 3 + c;
    return new Vector3(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
  };
  const weights = new Triangle(corner(0), corner(1), corner(2))
    .getBarycoord(new Vector3(...point), new Vector3())
    ?.toArray()
    .map((w) => Math.max(0, w)) ?? [1, 1, 1];
  const sum = weights[0] + weights[1] + weights[2];
  return weights.map((w) => w / sum) as Vec3;
}

/** A mesh-local point on a face of `positions`. */
export function facePoint(
  model: WarpModel,
  positions: ArrayLike<number>,
  { face, barycentric }: WarpStrokePoint,
  out: Vec3 = [0, 0, 0],
): Vec3 {
  out[0] = out[1] = out[2] = 0;
  for (let c = 0; c < 3; c++) {
    const v = model.index?.[face * 3 + c] ?? face * 3 + c;
    for (let a = 0; a < 3; a++) out[a] += barycentric[c] * positions[v * 3 + a];
  }
  return out;
}

/**
 * A sample on a painted face, pinned where `state` writes it, as a clicked point is. Null off the
 * paint, or where only fixed nodes hold the spot.
 */
export function strokeSample(
  model: WarpModel,
  state: Pick<WarpState, 'positions' | 'rotations'>,
  { face, barycentric }: WarpStrokePoint,
): WarpSample | null {
  if (!isPaintedFace(model, face)) return null;
  const triangle = regionTriangleOf(model.region, face);
  const restWorld: Vec3 = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const v = model.region.triangles[triangle * 3 + c];
    for (let a = 0; a < 3; a++) restWorld[a] += barycentric[c] * model.restWorld[v * 3 + a];
  }
  const binding = bindTrianglePoint(
    model.region,
    model.binding,
    model.restWorld,
    triangle,
    barycentric,
  );
  const { fixed } = model.grid;
  if (binding.node.every((node) => fixed[node])) return null;
  return {
    face,
    barycentric,
    binding,
    restWorld,
    pin: deformPoint(model, state as WarpState, binding, restWorld),
  };
}

const distance = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Mean grid spacing at the free nodes a sample is bound to. */
export function sampleSpacing(model: WarpModel, sample: Pick<WarpSample, 'binding'>) {
  const eligible = warpEligibleNodes(model);
  const free = sample.binding.node.filter((n) => eligible[n]);
  return spacingAt(model, free.length ? free : sample.binding.node);
}

const nodeKey = (sample: WarpSample) =>
  [...new Set(sample.binding.node)].sort((a, b) => a - b).join(',');

/**
 * Whether two stroke samples lie on one stretch of surface: the grid joins their nodes by a path
 * not much longer than the straight line between them. A pointer that crosses a silhouette onto
 * a surface behind it jumps far along the grid for a short way on screen.
 */
export function strokeConnected(model: WarpModel, a: WarpSample, b: WarpSample) {
  const shared = new Set(a.binding.node);
  if (b.binding.node.some((n) => shared.has(n))) return true;
  const jump = distance(a.restWorld, b.restWorld);
  const spacing = Math.max(sampleSpacing(model, a), sampleSpacing(model, b));
  const limit = 1.5 * jump + 2.5 * spacing;
  const { edgeStart, edges } = model.grid;
  const rest = model.restNodes;
  const at = (n: number) => [rest[n * 3], rest[n * 3 + 1], rest[n * 3 + 2]];
  const goal = new Map(b.binding.node.map((n) => [n, distance(at(n), b.restWorld)]));
  const best = new Map<number, number>();
  const open: [number, number][] = [];
  for (const n of a.binding.node) {
    const d = distance(at(n), a.restWorld);
    if (d < (best.get(n) ?? Infinity)) {
      best.set(n, d);
      open.push([d, n]);
    }
  }
  while (open.length) {
    let low = 0;
    for (let i = 1; i < open.length; i++) if (open[i][0] < open[low][0]) low = i;
    const [d, i] = open[low];
    open[low] = open[open.length - 1];
    open.pop();
    if (d > (best.get(i) ?? Infinity) || d > limit) continue;
    const end = goal.get(i);
    if (end !== undefined && d + end <= limit) return true;
    for (let e = edgeStart[i]; e < edgeStart[i + 1]; e++) {
      const j = edges[e];
      const next = d + distance(at(i), at(j));
      if (next <= limit && next < (best.get(j) ?? Infinity)) {
        best.set(j, next);
        open.push([next, j]);
      }
    }
  }
  return false;
}

/**
 * A drawn line's samples: its hits taken about every half node spacing along the surface at rest,
 * keeping the first and the last, then one sample for each set of grid nodes they are bound to, so
 * pointer speed does not change how firmly the line holds. `pin` is where the surface is halfway
 * along it.
 */
export function lineSamples(
  model: WarpModel,
  state: Pick<WarpState, 'positions' | 'rotations'>,
  points: readonly WarpStrokePoint[],
): { samples: WarpSample[]; pin: Vec3; length: number } | null {
  const hits = points.flatMap((point) => strokeSample(model, state, point) ?? []);
  if (!hits.length) return null;
  const along = [0];
  for (let i = 1; i < hits.length; i++)
    along.push(along[i - 1] + distance(hits[i - 1].restWorld, hits[i].restWorld));
  const length = along[along.length - 1];
  const step = (i: number) => warpLineStep * sampleSpacing(model, hits[i]);
  const chosen = [0];
  let next = step(0);
  for (let i = 1; i < hits.length - 1; i++) {
    const last = chosen[chosen.length - 1];
    const target = along[last] + next;
    if (along[i] < target) continue;
    // The hit nearest the target, which may be the one before.
    const pick = i - 1 > last && target - along[i - 1] < along[i] - target ? i - 1 : i;
    chosen.push(pick);
    next = step(pick);
    if (pick < i) i--;
  }
  const end = hits.length - 1;
  if (end > 0) {
    if (chosen.length > 1 && along[end] - along[chosen[chosen.length - 1]] < 0.5 * next)
      chosen.pop();
    chosen.push(end);
  }
  // One sample per set of bound nodes, and both ends.
  const kept = new Map<string, number>();
  for (const i of chosen) {
    const key = i === 0 || i === end ? `end ${i}` : nodeKey(hits[i]);
    if (!kept.has(key)) kept.set(key, i);
  }
  const order = [...kept.values()].sort((a, b) => a - b);
  let middle = 0;
  for (let i = 1; i < hits.length; i++)
    if (Math.abs(along[i] - length / 2) < Math.abs(along[middle] - length / 2)) middle = i;
  return { samples: order.map((i) => hits[i]), pin: hits[middle].pin, length };
}

/** At most `limit` points spread evenly along a path, keeping its ends. */
export function thinPath<T>(points: readonly T[], limit = warpPathLimit): T[] {
  if (points.length <= limit) return points.slice();
  return Array.from(
    { length: limit },
    (_, i) => points[Math.round((i * (points.length - 1)) / (limit - 1))],
  );
}

const vertexTriangles = new WeakMap<WarpModel, { start: Uint32Array; triangles: Uint32Array }>();

/** The region triangles around each welded vertex, built once per model. */
function trianglesAround(model: WarpModel) {
  let around = vertexTriangles.get(model);
  if (!around) {
    const { triangles, weldedCount } = model.region;
    const start = new Uint32Array(weldedCount + 1);
    for (let i = 0; i < triangles.length; i++) start[triangles[i] + 1]++;
    for (let v = 0; v < weldedCount; v++) start[v + 1] += start[v];
    const fill = start.slice(0, weldedCount);
    const list = new Uint32Array(triangles.length);
    for (let i = 0; i < triangles.length; i++) list[fill[triangles[i]]++] = Math.floor(i / 3);
    around = { start, triangles: list };
    vertexTriangles.set(model, around);
  }
  return around;
}

const visits = new WeakMap<WarpModel, { mark: Uint32Array; stamp: number }>();

/**
 * The painted faces Warp's brush covers around a hit on the warped surface: those connected to the
 * hit face through the source mesh whose warped triangle comes within `radius` of the hit and
 * faces the same way, as region painting picks them. `positions` are the warped mesh-local
 * positions; distance is measured in world space.
 */
export function areaBrushFaces(
  model: WarpModel,
  positions: ArrayLike<number>,
  hit: WarpStrokePoint,
  radius: number,
): number[] {
  const seed = regionTriangleOf(model.region, hit.face);
  if (seed < 0 || !isPaintedFace(model, hit.face) || !(radius > 0)) return [];
  const { region, painted } = model;
  const around = trianglesAround(model);
  let visit = visits.get(model);
  if (!visit) visits.set(model, (visit = { mark: new Uint32Array(region.faces.length), stamp: 0 }));
  if (++visit.stamp === 0xffffffff) {
    visit.mark.fill(0);
    visit.stamp = 1;
  }
  const { mark, stamp } = visit;
  const m = model.matrix;
  const world = (face: number, c: number, out: Vector3) => {
    const v = model.index?.[face * 3 + c] ?? face * 3 + c;
    const x = positions[v * 3],
      y = positions[v * 3 + 1],
      z = positions[v * 3 + 2];
    return out.set(
      m[0] * x + m[4] * y + m[8] * z + m[12],
      m[1] * x + m[5] * y + m[9] * z + m[13],
      m[2] * x + m[6] * y + m[10] * z + m[14],
    );
  };
  const triangle = new Triangle(),
    closest = new Vector3(),
    normal = new Vector3();
  const load = (t: number) => {
    const face = region.faces[t];
    world(face, 0, triangle.a);
    world(face, 1, triangle.b);
    world(face, 2, triangle.c);
    return triangle;
  };
  const centre = new Vector3();
  facePoint(model, positions, hit, [0, 0, 0]).forEach((value, a) => centre.setComponent(a, value));
  centre.set(
    m[0] * centre.x + m[4] * centre.y + m[8] * centre.z + m[12],
    m[1] * centre.x + m[5] * centre.y + m[9] * centre.z + m[13],
    m[2] * centre.x + m[6] * centre.y + m[10] * centre.z + m[14],
  );
  const facing = load(seed).getNormal(new Vector3());
  const queue = [seed];
  mark[seed] = stamp;
  for (let q = 0; q < queue.length; q++) {
    const t = queue[q];
    for (let c = 0; c < 3; c++) {
      const v = region.triangles[t * 3 + c];
      for (let k = around.start[v]; k < around.start[v + 1]; k++) {
        const u = around.triangles[k];
        if (mark[u] === stamp) continue;
        mark[u] = stamp;
        if (painted && painted[u] !== 1) continue;
        load(u);
        if (triangle.getArea() < 1e-14) continue;
        if (triangle.getNormal(normal).dot(facing) < 0.2) continue;
        if (
          triangle.closestPointToPoint(centre, closest).distanceToSquared(centre) >
          radius * radius
        )
          continue;
        queue.push(u);
      }
    }
  }
  return queue.map((t) => region.faces[t]).sort((a, b) => a - b);
}

const cornerWeights: Vec3[] = [
  [0.6, 0.2, 0.2],
  [0.2, 0.6, 0.2],
  [0.2, 0.2, 0.6],
];
const third: Vec3 = [1 / 3, 1 / 3, 1 / 3];

/**
 * An area's samples: face centres spread by farthest-point sampling at rest from the first hit, up
 * to a few dozen, about half a node spacing apart. An area of fewer faces than that also takes
 * spots toward each face's corners, so even one face holds several samples and lifts as a small
 * plateau. `pin` is where the surface is at the face centre nearest the area's centroid. Null when
 * no spot on the faces is painted and free.
 */
export function areaSamples(
  model: WarpModel,
  state: Pick<WarpState, 'positions' | 'rotations'>,
  faces: readonly number[],
  first: WarpStrokePoint,
): { samples: WarpSample[]; pin: Vec3 } | null {
  const start = strokeSample(model, state, first);
  const painted = faces.filter((face) => isPaintedFace(model, face));
  if (!painted.length) return null;
  const rest = (point: WarpStrokePoint) => {
    const triangle = regionTriangleOf(model.region, point.face);
    const out: Vec3 = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const v = model.region.triangles[triangle * 3 + c];
      for (let a = 0; a < 3; a++) out[a] += point.barycentric[c] * model.restWorld[v * 3 + a];
    }
    return out;
  };
  const candidates: WarpStrokePoint[] = painted.map((face) => ({ face, barycentric: third }));
  if (painted.length < warpAreaSamples.min)
    for (const face of painted)
      for (const barycentric of cornerWeights) candidates.push({ face, barycentric });
  const at = candidates.map(rest);
  // The area-weighted centroid, for the centre.
  const centroid: Vec3 = [0, 0, 0];
  let area = 0;
  const triangle = new Triangle();
  for (const face of painted) {
    const t = regionTriangleOf(model.region, face);
    const corner = (c: number, out: Vector3) => {
      const v = model.region.triangles[t * 3 + c];
      return out.set(
        model.restWorld[v * 3],
        model.restWorld[v * 3 + 1],
        model.restWorld[v * 3 + 2],
      );
    };
    corner(0, triangle.a);
    corner(1, triangle.b);
    corner(2, triangle.c);
    const weight = triangle.getArea();
    const mid = rest({ face, barycentric: third });
    for (let a = 0; a < 3; a++) centroid[a] += weight * mid[a];
    area += weight;
  }
  if (area > 0) for (let a = 0; a < 3; a++) centroid[a] /= area;
  // Spaced by the grid at the first spot that can hold; none can where fixed nodes alone bind it.
  let spaced = start;
  for (let i = 0; !spaced && i < candidates.length; i++)
    spaced = strokeSample(model, state, candidates[i]);
  if (!spaced) return null;
  const apart = warpLineStep * sampleSpacing(model, spaced);
  const near = new Float64Array(candidates.length).fill(Infinity);
  const chosen: WarpSample[] = [];
  const take = (sample: WarpSample) => {
    chosen.push(sample);
    for (let i = 0; i < at.length; i++)
      near[i] = Math.min(near[i], distance(at[i], sample.restWorld));
  };
  if (start) take(start);
  while (chosen.length < warpAreaSamples.max) {
    let best = -1;
    for (let i = 0; i < near.length; i++)
      if (near[i] > 0 && (best < 0 || near[i] > near[best])) best = i;
    if (best < 0 || (chosen.length >= warpAreaSamples.min && near[best] < apart)) break;
    const sample = strokeSample(model, state, candidates[best]);
    if (sample) take(sample);
    else near[best] = 0;
  }
  if (!chosen.length) return null;
  let middle = -1;
  for (let i = 0; i < candidates.length; i++)
    if (middle < 0 || distance(at[i], centroid) < distance(at[middle], centroid)) middle = i;
  const pin = strokeSample(model, state, candidates[middle])?.pin ?? chosen[0].pin;
  return { samples: chosen, pin };
}
