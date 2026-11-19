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

interface FlatPatch {
  normal: Vector3;
  corners: Uint32Array;
  vertices: Uint32Array;
  distances: Float64Array;
  clearance: number;
}

const patches = new WeakMap<
  WarpSample,
  { model: WarpModel; radius: number; patch: FlatPatch | null }
>();

/** A point can use the radial profile if its connected footprint lies on the sample's plane. */
export function flatPointPatch(
  model: WarpModel,
  sample: WarpSample,
  radius: number,
): FlatPatch | null {
  const cached = patches.get(sample);
  if (cached?.model === model && cached.radius === radius) return cached.patch;
  const patch = findFlatPatch(model, sample, radius);
  patches.set(sample, { model, radius, patch });
  return patch;
}

function findFlatPatch(model: WarpModel, sample: WarpSample, radius: number): FlatPatch | null {
  if (!(radius > 0)) return null;
  const { region, restWorld } = model;
  const t = regionTriangleOf(region, sample.face);
  if (t < 0) return null;
  const corners = region.triangles.subarray(t * 3, t * 3 + 3);
  const a = new Vector3().fromArray(restWorld, corners[0] * 3);
  const b = new Vector3().fromArray(restWorld, corners[1] * 3);
  const c = new Vector3().fromArray(restWorld, corners[2] * 3);
  const normal = b.sub(a).cross(c.sub(a)).normalize();
  if (normal.lengthSq() === 0) return null;

  const tolerance = Math.max(1e-6, radius * 1e-6);
  const [x, y, z] = sample.restWorld;
  const { adjacency, adjacencyStart, role } = region;
  // Walk the actual welded mesh so a parallel or disconnected surface cannot inherit the bend.
  // Stop at the first crease or hold. The spare room outside the radius is for blending to skinning.
  let clearance = 2 * radius;
  const stack = Array.from(corners);
  const seen = new Set(stack);
  const vertices: number[] = [];
  const distances: number[] = [];
  for (let i = 0; i < stack.length; i++) {
    const v = stack[i];
    const vx = restWorld[v * 3] - x;
    const vy = restWorld[v * 3 + 1] - y;
    const vz = restWorld[v * 3 + 2] - z;
    const distance = Math.hypot(vx, vy, vz);
    if (distance >= clearance) continue;
    if (role[v] !== WarpRole.Interior || (model.blend && model.blend[v] < 1)) {
      clearance = distance;
      if (clearance <= radius) return null;
      continue;
    }
    vertices.push(v);
    distances.push(distance);
    for (let e = adjacencyStart[v]; e < adjacencyStart[v + 1]; e++) {
      const w = adjacency[e];
      if (seen.has(w)) continue;
      const h =
        normal.x * (restWorld[w * 3] - x) +
        normal.y * (restWorld[w * 3 + 1] - y) +
        normal.z * (restWorld[w * 3 + 2] - z);
      if (Math.abs(h) > tolerance) {
        clearance = Math.min(clearance, distance);
        if (clearance <= radius) return null;
        continue;
      }
      seen.add(w);
      stack.push(w);
    }
  }
  return {
    normal,
    corners,
    vertices: Uint32Array.from(vertices),
    distances: Float64Array.from(distances),
    clearance,
  };
}

/**
 * For an isolated normal pull with room on the plane, write the profile from the rest surface.
 * This removes the grid's tangential drift and residual shoulder ripples. General pulls keep
 * their skinned solution, and the transition to that solution lies outside the raised shoulder.
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
  if (baseline.positions.some((x, i) => x !== model.restNodes[i])) return undefined;
  const sample = samples[0];
  const patch = flatPointPatch(model, sample, radius);
  if (!patch || patch.clearance < radius + reach.spacing) return undefined;
  const { normal, corners, vertices, distances, clearance } = patch;
  const offset = new Vector3().fromArray(handleOffset(point));
  const height = offset.dot(normal);
  // Blend into the radial surface when the pull gets steep enough for rotation to pull the
  // shoulder sideways. Across the plane, let the grid keep its usual elastic response.
  const rise = smoothstep(Math.abs(height) / radius - 1.5);
  const tangent = offset.clone().addScaledVector(normal, -height).length();
  const blend = rise * (1 - smoothstep(tangent / (radius * 0.01)));
  if (blend === 0) return undefined;

  const { binding } = sample;
  if (binding.node.some((n, k) => model.grid.fixed[n] && binding.weight[k] > 0)) return undefined;
  const width = fadeWidth(point);
  const weight = (distance: number) => {
    const t = Math.max(0, Math.min(1, (radius - distance) / width));
    // At 0% the shoulder is steep. Zero curvature at its base keeps the first row of
    // triangles from forming a bright, uneven rim around the spike.
    const rounded = t * t * t * (10 + t * (6 * t - 15));
    return (1 - falloff) * rounded + falloff * smoothstep(t);
  };
  const v = new Vector3();
  const pin = new Vector3().fromArray(sample.restWorld);
  let centreWeight = 0;
  for (let k = 0; k < 3; k++)
    centreWeight +=
      sample.barycentric[k] * weight(v.fromArray(model.restWorld, corners[k] * 3).distanceTo(pin));
  if (centreWeight < 0.9) return undefined;

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
    const mix = blend * (1 - smoothstep((distance - flat) / (clearance - flat)));
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
