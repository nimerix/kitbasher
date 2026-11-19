import { Vector3 } from 'three';
import { skinnedWorldPositions } from './warp-evaluate';
import {
  handleOffset,
  fadeWidth,
  untouchedAuto,
  type WarpDetail,
  type WarpHandle,
  type WarpSample,
} from './warp-handles';
import type { WarpModel } from './warp-model';
import { WarpRole, regionTriangleOf } from './warp-region';
import type { WarpState } from './warp-solve';

interface ShoulderPatch {
  normal: Vector3;
  corners: Uint32Array;
  vertices: Uint32Array;
  distances: Float64Array;
  clearance: number;
  roughness: number;
  tilt: number;
}

const planarReach = new WeakMap<WarpSample, { model: WarpModel; radius: number; flat: boolean }>();

/** Exact coplanarity for choosing the grid's planar reach metric. */
export function flatPointPatch(model: WarpModel, sample: WarpSample, radius: number): boolean {
  const cached = planarReach.get(sample);
  if (cached?.model === model && cached.radius === radius) return cached.flat;
  const flat = hasPlanarReach(model, sample, radius);
  planarReach.set(sample, { model, radius, flat });
  return flat;
}

function hasPlanarReach(model: WarpModel, sample: WarpSample, radius: number): boolean {
  if (!(radius > 0)) return false;
  const { region, restWorld } = model;
  const t = regionTriangleOf(region, sample.face);
  if (t < 0) return false;
  const corners = region.triangles.subarray(t * 3, t * 3 + 3);
  const a = new Vector3().fromArray(restWorld, corners[0] * 3);
  const b = new Vector3().fromArray(restWorld, corners[1] * 3);
  const c = new Vector3().fromArray(restWorld, corners[2] * 3);
  const normal = b.sub(a).cross(c.sub(a)).normalize();
  if (normal.lengthSq() === 0) return false;

  const tolerance = Math.max(1e-6, radius * 1e-6);
  const [x, y, z] = sample.restWorld;
  const { adjacency, adjacencyStart, role } = region;
  // Walk the actual welded mesh so a parallel or disconnected surface cannot inherit the bend.
  // Stop at the first crease or hold.
  let clearance = 2 * radius;
  const stack = Array.from(corners);
  const seen = new Set(stack);
  for (let i = 0; i < stack.length; i++) {
    const v = stack[i];
    const vx = restWorld[v * 3] - x;
    const vy = restWorld[v * 3 + 1] - y;
    const vz = restWorld[v * 3 + 2] - z;
    const distance = Math.hypot(vx, vy, vz);
    if (distance >= clearance) continue;
    if (role[v] !== WarpRole.Interior || (model.blend && model.blend[v] < 1)) {
      clearance = distance;
      if (clearance <= radius) return false;
      continue;
    }
    for (let e = adjacencyStart[v]; e < adjacencyStart[v + 1]; e++) {
      const w = adjacency[e];
      if (seen.has(w)) continue;
      const h =
        normal.x * (restWorld[w * 3] - x) +
        normal.y * (restWorld[w * 3 + 1] - y) +
        normal.z * (restWorld[w * 3 + 2] - z);
      if (Math.abs(h) > tolerance) {
        clearance = Math.min(clearance, distance);
        if (clearance <= radius) return false;
        continue;
      }
      seen.add(w);
      stack.push(w);
    }
  }
  return true;
}

const shoulderPatches = new WeakMap<
  WarpSample,
  { model: WarpModel; radius: number; patch: ShoulderPatch | null }
>();

const incidentFaces = new WeakMap<WarpModel, { start: Uint32Array; faces: Uint32Array }>();

function facesAtVertices(model: WarpModel) {
  const cached = incidentFaces.get(model);
  if (cached) return cached;
  const { triangles, weldedCount } = model.region;
  const start = new Uint32Array(weldedCount + 1);
  for (const v of triangles) start[v + 1]++;
  for (let v = 0; v < weldedCount; v++) start[v + 1] += start[v];
  const fill = start.slice(0, weldedCount);
  const faces = new Uint32Array(triangles.length);
  for (let i = 0; i < triangles.length; i += 3)
    for (let k = i; k < i + 3; k++) faces[fill[triangles[k]]++] = i;
  const entry = { start, faces };
  incidentFaces.set(model, entry);
  return entry;
}

function shoulderPatch(model: WarpModel, sample: WarpSample, radius: number) {
  const cached = shoulderPatches.get(sample);
  if (cached?.model === model && cached.radius === radius) return cached.patch;
  const patch = findShoulderPatch(model, sample, radius);
  shoulderPatches.set(sample, { model, radius, patch });
  return patch;
}

function findShoulderPatch(
  model: WarpModel,
  sample: WarpSample,
  radius: number,
): ShoulderPatch | null {
  const { region, restWorld } = model;
  const t = regionTriangleOf(region, sample.face);
  if (t < 0) return null;
  const { triangles, adjacency, adjacencyStart, role } = region;
  const corners = triangles.subarray(t * 3, t * 3 + 3);
  const { start, faces } = facesAtVertices(model);
  const pin = new Vector3().fromArray(sample.restWorld);
  const a = new Vector3(),
    b = new Vector3(),
    c = new Vector3();
  const faceNormals = new Map<number, Vector3>();
  const faceNormal = (i: number) => {
    let n = faceNormals.get(i);
    if (!n) {
      a.fromArray(restWorld, triangles[i] * 3);
      b.fromArray(restWorld, triangles[i + 1] * 3).sub(a);
      c.fromArray(restWorld, triangles[i + 2] * 3).sub(a);
      n = new Vector3().crossVectors(b, c);
      faceNormals.set(i, n);
    }
    return n;
  };
  const seed = faceNormal(t * 3)
    .clone()
    .normalize();
  if (seed.lengthSq() === 0) return null;
  const arm = new Vector3();
  const walk = (visit: (v: number) => boolean) => {
    const queue = Array.from(corners);
    const seen = new Set(queue);
    for (const v of queue) {
      if (!visit(v)) continue;
      for (let i = adjacencyStart[v]; i < adjacencyStart[v + 1]; i++) {
        const next = adjacency[i];
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
  };

  // Average an inner neighbourhood so one small or rough hit triangle cannot tilt the profile.
  const normal = new Vector3();
  const counted = new Set<number>();
  walk((v) => {
    if (arm.fromArray(restWorld, v * 3).distanceToSquared(pin) > (radius / 3) ** 2) return false;
    for (let i = start[v]; i < start[v + 1]; i++) {
      const f = faces[i];
      if (counted.has(f)) continue;
      counted.add(f);
      const n = faceNormal(f);
      if (n.dot(seed) > 0.5 * n.length()) normal.add(n);
    }
    return true;
  });
  if (normal.lengthSq() === 0) normal.copy(seed);
  normal.normalize();

  let clearance = 2 * radius;
  let roughness = 0;
  let tilt = 0;
  const vertices: number[] = [],
    distances: number[] = [];
  walk((v) => {
    arm.fromArray(restWorld, v * 3).sub(pin);
    const height = arm.dot(normal);
    const distance = arm.addScaledVector(normal, -height).length();
    if (distance >= clearance) return false;
    let alignment = 1;
    for (let i = start[v]; i < start[v + 1]; i++) {
      const n = faceNormal(faces[i]);
      const area = n.length();
      if (area) alignment = Math.min(alignment, n.dot(normal) / area);
    }
    const relief = Math.abs(height) / radius;
    // A crease vertex belongs to both sides. Stop there before the walk can reach its rear face.
    if (
      role[v] !== WarpRole.Interior ||
      (model.blend && model.blend[v] < 1) ||
      alignment < 0.8 ||
      relief > 0.12
    ) {
      clearance = Math.min(clearance, distance);
      return false;
    }
    if (distance <= radius) {
      roughness = Math.max(roughness, relief);
      tilt = Math.max(tilt, Math.sqrt(1 - alignment ** 2));
    }
    vertices.push(v);
    distances.push(distance);
    return true;
  });
  if (clearance <= radius) return null;
  return {
    normal,
    corners,
    vertices: Uint32Array.from(vertices),
    distances: Float64Array.from(distances),
    clearance,
    roughness,
    tilt,
  };
}

/**
 * For an isolated long pull on a coherent patch, add a radial displacement to the original
 * vertices. Blend back into skinning beyond the raised shoulder.
 */
export function planarPointDetail(
  model: WarpModel,
  state: WarpState,
  handles: readonly WarpHandle[],
  detail: WarpDetail | undefined,
): WarpDetail | undefined {
  const active = handles.filter((handle) => !untouchedAuto(handle));
  if (active.length !== 1) return undefined;
  const [point] = active;
  const { reach, radius, falloff, samples, baseline } = point;
  if (
    point.kind !== 'point' ||
    !point.target ||
    reach?.activation !== 1 ||
    baseline.grid !== model.grid
  )
    return undefined;
  const offset = new Vector3().fromArray(handleOffset(point));
  if (offset.length() <= 1.5 * radius) return undefined;
  if (baseline.positions.some((x, i) => x !== model.restNodes[i])) return undefined;
  const sample = samples[0];
  const patch = shoulderPatch(model, sample, radius);
  if (!patch) return undefined;
  const { normal, corners, vertices, distances, clearance, roughness, tilt } = patch;
  const height = offset.dot(normal);
  const rise = smoothstep(Math.abs(height) / radius - 1.5);
  const tangent = offset.clone().addScaledVector(normal, -height).length();
  // The radial profile changes at most 1.5 / width. Leave room for oblique motion without
  // letting the taper reverse the surface in projection.
  const span = (1.5 / 0.85) * tangent;
  const shear = 1 - smoothstep((span / radius - 0.9) / 0.1);
  const coherent =
    (1 - smoothstep((roughness - 0.025) / 0.055)) * (1 - smoothstep((tilt - 0.14) / 0.2));
  const room = smoothstep((clearance - radius) / reach.spacing);
  const blend = rise * shear * coherent * room;
  if (blend === 0) return undefined;

  const { binding } = sample;
  if (binding.node.some((n, k) => model.grid.fixed[n] && binding.weight[k] > 0)) return undefined;
  const width = Math.min(radius, Math.max(fadeWidth(point), span + 1.5 * Math.abs(height) * tilt));
  const weight = (distance: number) => {
    const t = Math.max(0, Math.min(1, (radius - distance) / width));
    // At 0% the shoulder is steep. Zero curvature at its base keeps the first row of
    // triangles from forming a bright, uneven rim around the spike.
    const rounded = roundedShoulder(t);
    return (1 - falloff) * rounded + falloff * smoothstep(t);
  };
  const arm = new Vector3();
  const pin = new Vector3().fromArray(sample.restWorld);
  let centreWeight = 0;
  for (let k = 0; k < 3; k++) {
    arm.fromArray(model.restWorld, corners[k] * 3).sub(pin);
    arm.addScaledVector(normal, -arm.dot(normal));
    centreWeight += sample.barycentric[k] * weight(arm.length());
  }
  // Coarse triangles may miss the top of a narrow profile. Fade out before renormalising
  // would lift their vertices much farther than the handle moved.
  const support = smoothstep((centreWeight - 0.9) / 0.08);
  if (support === 0) return undefined;

  const flat = Math.min(radius + 2 * reach.spacing, (clearance + radius) / 2);
  const skin = skinnedWorldPositions(model, state, vertices);
  const prior = detail?.vertices.length ?? 0;
  const merged = new Uint32Array(prior + vertices.length);
  const delta = new Float64Array(merged.length * 3);
  const slots = new Map<number, number>();
  if (detail) {
    merged.set(detail.vertices);
    delta.set(detail.delta);
    detail.vertices.forEach((v, i) => slots.set(v, i));
  }
  let count = prior;
  for (let i = 0; i < vertices.length; i++) {
    const distance = distances[i];
    if (distance >= clearance || Number.isNaN(skin[i * 3])) continue;
    const mix = blend * support * (1 - smoothstep((distance - flat) / (clearance - flat)));
    const v = vertices[i];
    const slot = slots.get(v) ?? count++;
    merged[slot] = v;
    const lift = weight(distance) / centreWeight;
    for (let axis = 0; axis < 3; axis++) {
      const at = slot * 3 + axis;
      const bend = model.restWorld[v * 3 + axis] + lift * offset.getComponent(axis);
      delta[at] += mix * (bend - skin[i * 3 + axis] - delta[at]);
    }
  }
  return { vertices: merged.subarray(0, count), delta: delta.subarray(0, count * 3) };
}

function smoothstep(value: number) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

/** Integrate a smooth rise, a constant slope, and a smooth fall. Both ends have zero curvature. */
function roundedShoulder(t: number) {
  const edge = 0.3;
  const near = Math.min(t, 1 - t);
  const u = near / edge;
  const integral = near < edge ? edge * u ** 3 * (1 - u / 2) : near - edge / 2;
  const weight = integral / (1 - edge);
  return t <= 0.5 ? weight : 1 - weight;
}
