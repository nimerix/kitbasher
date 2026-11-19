import { Vector3 } from 'three';
import { detailVertexSlots, skinnedWorldPositions } from './warp-evaluate';
import {
  fadeWidth,
  handleOffset,
  snapshotDetail,
  untouchedAuto,
  type WarpDetail,
  type WarpHandle,
  type WarpSample,
  type WarpSnapshot,
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

const coherentReach = new WeakMap<
  WarpSample,
  { model: WarpModel; radius: number; coherent: boolean }
>();

/** Whether the connected footprint is smooth enough to use triangle marching and vertex detail. */
export function coherentPointPatch(model: WarpModel, sample: WarpSample, radius: number) {
  if (!(radius > 0)) return false;
  const cached = coherentReach.get(sample);
  if (cached?.model === model && cached.radius === radius) return cached.coherent;
  // Tight shoulders need a nearly flat patch. The generic profile also works on a curved cap
  // as long as it stays a single sheet without tight creases.
  const coherent =
    !!shoulderPatch(model, sample, radius) || !!findShoulderPatch(model, sample, radius, true);
  coherentReach.set(sample, { model, radius, coherent });
  return coherent;
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
  curved = false,
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
  const walk = (visit: (v: number) => boolean, done = () => false) => {
    const queue = Array.from(corners);
    const seen = new Set(queue);
    for (const v of queue) {
      if (done()) break;
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

  let clearance = curved ? radius : 2 * radius;
  let roughness = 0;
  let tilt = 0;
  const vertices: number[] = [],
    distances: number[] = [];
  walk(
    (v) => {
      arm.fromArray(restWorld, v * 3).sub(pin);
      const height = arm.dot(normal);
      const distance = curved ? arm.length() : arm.addScaledVector(normal, -height).length();
      if (distance >= clearance) return false;
      let alignment = 1;
      let fan = 1;
      let first: Vector3 | undefined;
      for (let i = start[v]; i < start[v + 1]; i++) {
        const n = faceNormal(faces[i]);
        const area = n.length();
        if (!area) continue;
        alignment = Math.min(alignment, n.dot(normal) / area);
        if (first) fan = Math.min(fan, n.dot(first) / (area * first.length()));
        else first = n;
      }
      const relief = Math.abs(height) / radius;
      // A crease vertex belongs to both sides. Stop there before the walk can reach its rear face.
      if (
        role[v] !== WarpRole.Interior ||
        (model.blend && model.blend[v] < 1) ||
        alignment < (curved ? 0.6 : 0.8) ||
        relief > (curved ? 0.4 : 0.12) ||
        fan < 0.82
      ) {
        clearance = Math.min(clearance, distance);
        return false;
      }
      if (curved) return true;
      if (distance <= radius) {
        roughness = Math.max(roughness, relief);
        tilt = Math.max(tilt, Math.sqrt(1 - alignment ** 2));
      }
      vertices.push(v);
      distances.push(distance);
      return true;
    },
    () => (curved ? clearance < radius : clearance <= radius),
  );
  if (curved ? clearance < radius : clearance <= radius) return null;
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

interface ShoulderBase {
  positions: Float64Array;
  distortion?: Float64Array;
}

const shoulderBases = new WeakMap<WarpSnapshot, WeakMap<ShoulderPatch, ShoulderBase>>();

function shoulderBase(
  model: WarpModel,
  baseline: WarpSnapshot,
  patch: ShoulderPatch,
  sample: WarpSample,
) {
  let bases = shoulderBases.get(baseline);
  if (!bases) shoulderBases.set(baseline, (bases = new WeakMap()));
  const cached = bases.get(patch);
  if (cached) return cached;
  const positions = skinnedWorldPositions(model, baseline, patch.vertices);
  const detail = snapshotDetail(baseline);
  const slots = detail && detailVertexSlots(detail.vertices);
  let distortion: Float64Array | undefined;
  if (detail || baseline.positions.some((x, i) => x !== model.restNodes[i])) {
    const shift = new Vector3()
      .fromArray(sample.pin)
      .sub(new Vector3().fromArray(sample.restWorld));
    const at = new Vector3();
    const rest = new Vector3();
    distortion = Float64Array.from(patch.vertices, (v, i) => {
      const slot = slots?.get(v);
      if (slot !== undefined)
        for (let a = 0; a < 3; a++) positions[i * 3 + a] += detail!.delta[slot * 3 + a];
      return at
        .fromArray(positions, i * 3)
        .sub(shift)
        .distanceTo(rest.fromArray(model.restWorld, v * 3));
    });
  }
  const base = { positions, distortion };
  bases.set(patch, base);
  return base;
}

interface PointShoulder extends WarpDetail {
  weights: Float64Array;
}

/**
 * Add the radial profiles of long pulls on coherent patches. Each yields to the grid near another
 * constraint. Away from those constraints, overlapping profiles share the surface by weight.
 */
export function planarPointDetail(
  model: WarpModel,
  state: WarpState,
  handles: readonly WarpHandle[],
  detail: WarpDetail | undefined,
): WarpDetail | undefined {
  const active = handles.filter((handle) => !untouchedAuto(handle));
  const shoulders: PointShoulder[] = [];
  for (const point of active) {
    const shoulder = pointShoulder(model, state, point, active);
    if (shoulder) shoulders.push(shoulder);
  }
  if (!shoulders.length) return undefined;

  const prior = detail?.vertices.length ?? 0;
  const capacity = shoulders.reduce((sum, s) => sum + s.vertices.length, prior);
  const vertices = new Uint32Array(capacity);
  const delta = new Float64Array(capacity * 3);
  const weights = new Float64Array(capacity);
  const priorSlots = detail && detailVertexSlots(detail.vertices);
  const shared = shoulders.length > 1 ? new Map<number, number>() : undefined;
  let count = prior;
  for (const shoulder of shoulders)
    for (let i = 0; i < shoulder.vertices.length; i++) {
      const weight = shoulder.weights[i];
      if (!weight) continue;
      const v = shoulder.vertices[i];
      let slot = priorSlots?.get(v) ?? shared?.get(v);
      if (slot === undefined) {
        slot = count++;
        vertices[slot] = v;
        shared?.set(v, slot);
      }
      weights[slot] += weight;
      for (let a = 0; a < 3; a++) delta[slot * 3 + a] += shoulder.delta[i * 3 + a];
    }
  if (detail) vertices.set(detail.vertices);
  for (let i = 0; i < count; i++) {
    const weight = weights[i];
    for (let a = i * 3; a < i * 3 + 3; a++) {
      delta[a] /= Math.max(1, weight);
      if (i < prior) delta[a] += (1 - Math.min(1, weight)) * detail!.delta[a];
    }
  }
  return { vertices: vertices.subarray(0, count), delta: delta.subarray(0, count * 3) };
}

function pointShoulder(
  model: WarpModel,
  state: WarpState,
  point: WarpHandle,
  handles: readonly WarpHandle[],
): PointShoulder | undefined {
  const { reach, radius, falloff, samples, baseline } = point;
  if (
    point.kind !== 'point' ||
    !point.target ||
    reach?.activation !== 1 ||
    baseline.grid !== model.grid
  )
    return;
  const offset = new Vector3().fromArray(handleOffset(point));
  if (offset.length() <= 1.5 * radius) return;
  const sample = samples[0];
  const patch = shoulderPatch(model, sample, radius);
  if (!patch) return;
  const { normal, corners, vertices, distances, clearance, roughness, tilt } = patch;
  const height = offset.dot(normal);
  const rise = smoothstep(Math.abs(height) / radius - 1.5);
  const tangent = offset.clone().addScaledVector(normal, -height).length();
  // The radial profile changes at most 1.5 / width. Leave room for oblique motion without
  // letting the taper reverse the surface in projection.
  const span = (1.5 / 0.85) * tangent;
  // Widen the shoulder as the pull tilts. The projection then stays monotone even when
  // the tangential travel exceeds what the original taper can carry.
  const extent = Math.max(radius, 2.25 * tangent);
  const shear = smoothstep((clearance - extent) / (0.5 * reach.spacing));
  const coherent =
    (1 - smoothstep((roughness - 0.025) / 0.055)) * (1 - smoothstep((tilt - 0.14) / 0.2));
  const room = smoothstep((clearance - radius) / reach.spacing);
  let blend = rise * shear * coherent * room;
  if (blend === 0) return;

  const { binding } = sample;
  if (binding.node.some((n, k) => model.grid.fixed[n] && binding.weight[k] > 0)) return;
  const width = Math.min(extent, Math.max(fadeWidth(point), span + 1.5 * Math.abs(height) * tilt));
  const weight = (distance: number) => {
    const t = Math.max(0, Math.min(1, (extent - distance) / width));
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
  if (support === 0) return;

  const { positions: base, distortion } = shoulderBase(model, baseline, patch, sample);
  // Use the written baseline for an earlier warp that left this footprint coherent. Let the
  // grid carry a point made on a steep bend or heavily distorted patch.
  if (distortion) {
    let strain = 0;
    for (let i = 0; i < vertices.length; i++) {
      const open = smoothstep((extent - distances[i]) / reach.spacing);
      if (open) strain = Math.max(strain, open * distortion[i]);
    }
    blend *= 1 - smoothstep((strain / radius - 0.025) / 0.035);
    if (!(blend > 0)) return;
  }

  const flat = Math.min(extent + 2 * reach.spacing, (clearance + extent) / 2);
  const followShoulder = smoothstep((blend * support - 0.9) / 0.1);
  const contests = handles.flatMap((other) => {
    if (other === point) return [];
    const travel = new Vector3().fromArray(handleOffset(other));
    const strength = smoothstep(travel.length() / reach.spacing);
    return other.samples.flatMap((sample) => {
      const triangle = regionTriangleOf(model.region, sample.face);
      if (triangle < 0) return [];
      const centre = new Vector3().fromArray(sample.restWorld);
      let inner = 0;
      let follows =
        other.kind === 'point' &&
        followShoulder > 0 &&
        strength < 1 &&
        sample.binding.node.every((n, k) => !model.grid.fixed[n] || !sample.binding.weight[k]);
      const written = new Vector3();
      for (let k = 0; k < 3; k++) {
        const v = model.region.triangles[triangle * 3 + k];
        arm.fromArray(model.restWorld, v * 3);
        inner = Math.max(inner, arm.distanceTo(centre));
        if (!follows) continue;
        const slot = detailVertexSlots(vertices).get(v);
        if (slot === undefined || distances[slot] >= flat) {
          follows = false;
          continue;
        }
        const amount = sample.barycentric[k];
        written.addScaledVector(arm.fromArray(base, slot * 3), amount);
        written.addScaledVector(offset, (amount * weight(distances[slot])) / centreWeight);
      }
      if (centre.distanceTo(pin) > clearance + inner + 2 * reach.spacing + other.radius) return [];
      // A new pin may already sit on this corrected bend. Carry a small change from that
      // baseline locally, then let the grid take over as the other point starts to drive it.
      const change = new Vector3().fromArray(sample.pin).sub(written);
      const retain = follows
        ? followShoulder * (1 - strength) * (1 - smoothstep(change.length() / (0.04 * radius)))
        : 0;
      change.add(travel);
      return [{ centre, inner, strength, radius: other.radius, retain, change }];
    });
  });
  const skin = skinnedWorldPositions(model, state, vertices);
  const changeAt = new Vector3();
  const weights = new Float64Array(vertices.length);
  const delta = new Float64Array(vertices.length * 3);
  for (let i = 0; i < vertices.length; i++) {
    const distance = distances[i];
    if (distance >= clearance || Number.isNaN(skin[i * 3])) continue;
    let mix = blend * support * (1 - smoothstep((distance - flat) / (clearance - flat)));
    const v = vertices[i];
    changeAt.set(0, 0, 0);
    if (contests.length) arm.fromArray(model.restWorld, v * 3);
    for (const { centre, inner, strength, radius, retain, change } of contests) {
      const d = arm.distanceTo(centre);
      const hold = 1 - smoothstep((d - inner) / (2 * reach.spacing));
      const drive = strength * (1 - smoothstep((d - inner) / Math.max(radius, reach.spacing)));
      mix *= 1 - Math.max((1 - retain) * hold, drive);
      // At the sample the analytic contribution aims for the full target. It fades away
      // towards the outside of the hold band as the grid takes over.
      if (retain > 0) changeAt.addScaledVector(change, (retain * hold) / (1 - strength * hold));
    }
    if (mix === 0) continue;
    weights[i] = mix;
    const lift = weight(distance) / centreWeight;
    for (let axis = 0; axis < 3; axis++) {
      const at = i * 3 + axis;
      const bend = base[at] + lift * offset.getComponent(axis) + changeAt.getComponent(axis);
      delta[at] = mix * (bend - skin[at]);
    }
  }
  return { vertices, delta, weights };
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
