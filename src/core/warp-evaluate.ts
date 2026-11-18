import type { Vec3 } from './types';
import type { WarpModel } from './warp-model';
import { WarpRole } from './warp-region';
import { writeRotation, type WarpState } from './warp-solve';

export interface WarpOutput {
  positions: Float32Array;
  normals: Float32Array | null;
  /** Mesh-local box around the vertices the last evaluation moved: min x, y, z, then max. */
  moved: Float64Array;
}

const none = 0xffffffff;

interface Scratch {
  rotation: Float64Array;
  /** Deformed world position per welded vertex; rest for vertices that do not move. */
  world: Float32Array;
  moved: Uint8Array;
  /** Unnormalized rest world normal per region triangle, made by the first fold check. */
  restNormals: Float32Array | null;
}
const scratches = new WeakMap<WarpModel, Scratch>();

function scratchFor(model: WarpModel): Scratch {
  let s = scratches.get(model);
  if (!s) {
    s = {
      rotation: new Float64Array(model.grid.nodes.length * 9),
      world: model.restWorld.slice(),
      moved: new Uint8Array(model.region.weldedCount),
      restNormals: null,
    };
    scratches.set(model, s);
  }
  return s;
}

export function createWarpOutput(model: WarpModel): WarpOutput {
  return {
    positions: model.positions.slice(),
    normals: model.normals?.slice() ?? null,
    moved: new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]),
  };
}

/**
 * Writes interior vertices and their normals, touching only the region. Returns the region
 * triangles whose world normal flipped, or null when `folds` is false, as for a drag frame.
 */
export function evaluateWarp(
  model: WarpModel,
  state: WarpState,
  out: WarpOutput,
  folds?: true,
): Uint32Array;
export function evaluateWarp(
  model: WarpModel,
  state: WarpState,
  out: WarpOutput,
  folds: boolean,
): Uint32Array | null;
export function evaluateWarp(
  model: WarpModel,
  state: WarpState,
  out: WarpOutput,
  folds = true,
): Uint32Array | null {
  const { region, grid, binding, restNodes, inverse: inv } = model;
  const { weldOf, weldedCount, interior, interiorVertices } = region;
  const { rotation, world, moved } = scratchFor(model);
  const { positions: nodePos, rotations } = state;
  const K = binding.node.length / weldedCount;

  for (let n = 0; n < grid.nodes.length; n++)
    writeRotation(
      rotation,
      n * 9,
      rotations[n * 4],
      rotations[n * 4 + 1],
      rotations[n * 4 + 2],
      rotations[n * 4 + 3],
    );

  const restWorld = model.restWorld;
  for (let i = 0; i < interior.length; i++) {
    const v = interior[i];
    moved[v] = 0;
    const px = restWorld[v * 3],
      py = restWorld[v * 3 + 1],
      pz = restWorld[v * 3 + 2];
    let x = 0,
      y = 0,
      z = 0,
      sum = 0;
    for (let j = 0; j < K; j++) {
      const n = binding.node[v * K + j];
      if (n === none) continue;
      const w = binding.weight[v * K + j];
      const dx = px - restNodes[n * 3],
        dy = py - restNodes[n * 3 + 1],
        dz = pz - restNodes[n * 3 + 2];
      const r = n * 9;
      x += w * (rotation[r] * dx + rotation[r + 1] * dy + rotation[r + 2] * dz + nodePos[n * 3]);
      y +=
        w *
        (rotation[r + 3] * dx + rotation[r + 4] * dy + rotation[r + 5] * dz + nodePos[n * 3 + 1]);
      z +=
        w *
        (rotation[r + 6] * dx + rotation[r + 7] * dy + rotation[r + 8] * dz + nodePos[n * 3 + 2]);
      sum += w;
    }
    if (!(sum > 0) || !Number.isFinite(x + y + z + sum)) {
      world[v * 3] = px;
      world[v * 3 + 1] = py;
      world[v * 3 + 2] = pz;
      continue;
    }
    moved[v] = 1;
    world[v * 3] = x;
    world[v * 3 + 1] = y;
    world[v * 3 + 2] = z;
  }

  const { positions, moved: box } = out;
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < interiorVertices.length; i++) {
    const g = interiorVertices[i],
      v = weldOf[g];
    if (!moved[v]) continue;
    const x = world[v * 3],
      y = world[v * 3 + 1],
      z = world[v * 3 + 2];
    const lx = Math.fround(inv[0] * x + inv[4] * y + inv[8] * z + inv[12]),
      ly = Math.fround(inv[1] * x + inv[5] * y + inv[9] * z + inv[13]),
      lz = Math.fround(inv[2] * x + inv[6] * y + inv[10] * z + inv[14]);
    positions[g * 3] = lx;
    positions[g * 3 + 1] = ly;
    positions[g * 3 + 2] = lz;
    if (lx < minX) minX = lx;
    if (lx > maxX) maxX = lx;
    if (ly < minY) minY = ly;
    if (ly > maxY) maxY = ly;
    if (lz < minZ) minZ = lz;
    if (lz > maxZ) maxZ = lz;
  }
  box[0] = minX;
  box[1] = minY;
  box[2] = minZ;
  box[3] = maxX;
  box[4] = maxY;
  box[5] = maxZ;

  if (out.normals && model.normals) writeNormals(model, positions, out.normals);
  return folds ? foldedTriangles(model) : null;
}

function foldedTriangles(model: WarpModel): Uint32Array {
  const scratch = scratchFor(model);
  const { world } = scratch;
  const { triangles } = model.region;
  const rest = (scratch.restNormals ??= triangleNormals(triangles, model.restWorld));
  const folds: number[] = [];
  for (let t = 0, o = 0; o < triangles.length; t++, o += 3) {
    const a = triangles[o] * 3,
      b = triangles[o + 1] * 3,
      c = triangles[o + 2] * 3;
    const ux = world[b] - world[a],
      uy = world[b + 1] - world[a + 1],
      uz = world[b + 2] - world[a + 2];
    const vx = world[c] - world[a],
      vy = world[c + 1] - world[a + 1],
      vz = world[c + 2] - world[a + 2];
    const dot =
      (uy * vz - uz * vy) * rest[o] +
      (uz * vx - ux * vz) * rest[o + 1] +
      (ux * vy - uy * vx) * rest[o + 2];
    if (dot < 0) folds.push(t);
  }
  return Uint32Array.from(folds);
}

/** Unnormalized normal of each welded triangle. */
function triangleNormals(triangles: Uint32Array, points: Float32Array) {
  const normals = new Float32Array(triangles.length);
  for (let o = 0; o < triangles.length; o += 3) {
    const a = triangles[o] * 3,
      b = triangles[o + 1] * 3,
      c = triangles[o + 2] * 3;
    const ux = points[b] - points[a],
      uy = points[b + 1] - points[a + 1],
      uz = points[b + 2] - points[a + 2];
    const vx = points[c] - points[a],
      vy = points[c + 1] - points[a + 1],
      vz = points[c + 2] - points[a + 2];
    normals[o] = uy * vz - uz * vy;
    normals[o + 1] = uz * vx - ux * vz;
    normals[o + 2] = ux * vy - uy * vx;
  }
  return normals;
}

function writeNormals(model: WarpModel, positions: Float32Array, normals: Float32Array) {
  const { region, index } = model;
  const { weldOf, role, faces, interiorVertices } = region;
  const original = model.normals!;

  if (!index) {
    for (let t = 0; t < faces.length; t++) {
      const o = faces[t] * 9;
      const ux = positions[o + 3] - positions[o],
        uy = positions[o + 4] - positions[o + 1],
        uz = positions[o + 5] - positions[o + 2];
      const vx = positions[o + 6] - positions[o],
        vy = positions[o + 7] - positions[o + 1],
        vz = positions[o + 8] - positions[o + 2];
      const nx = uy * vz - uz * vy,
        ny = uz * vx - ux * vz,
        nz = ux * vy - uy * vx;
      const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
      for (let c = o; c < o + 9; c += 3)
        if (length > 0) {
          normals[c] = nx / length;
          normals[c + 1] = ny / length;
          normals[c + 2] = nz / length;
        } else {
          normals[c] = original[c];
          normals[c + 1] = original[c + 1];
          normals[c + 2] = original[c + 2];
        }
    }
    return;
  }

  // Interior vertices take the area-weighted normal of their faces, which are all in the region.
  for (let i = 0; i < interiorVertices.length; i++) {
    const o = interiorVertices[i] * 3;
    normals[o] = normals[o + 1] = normals[o + 2] = 0;
  }
  for (let t = 0; t < faces.length; t++) {
    const f = faces[t] * 3;
    const a = index[f] * 3,
      b = index[f + 1] * 3,
      c = index[f + 2] * 3;
    const ux = positions[b] - positions[a],
      uy = positions[b + 1] - positions[a + 1],
      uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a],
      vy = positions[c + 1] - positions[a + 1],
      vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    for (let k = 0; k < 3; k++) {
      const g = index[f + k];
      if (role[weldOf[g]] !== WarpRole.Interior) continue;
      normals[g * 3] += nx;
      normals[g * 3 + 1] += ny;
      normals[g * 3 + 2] += nz;
    }
  }
  for (let i = 0; i < interiorVertices.length; i++) {
    const o = interiorVertices[i] * 3;
    const length = Math.sqrt(normals[o] ** 2 + normals[o + 1] ** 2 + normals[o + 2] ** 2);
    if (length > 0) {
      normals[o] /= length;
      normals[o + 1] /= length;
      normals[o + 2] /= length;
    } else {
      normals[o] = original[o];
      normals[o + 1] = original[o + 1];
      normals[o + 2] = original[o + 2];
    }
  }
}

// Each range is one GPU upload call. Ranges closer than this many values join, and then the
// narrowest gaps join until no more than the cap remain.
const joinGap = 1024;
export const warpRangeCap = 512;
const updateRanges = new WeakMap<WarpModel, { positions: Uint32Array; normals: Uint32Array }>();

/**
 * The parts of the position and normal arrays an evaluation can change, as start and count pairs
 * in array elements.
 */
export function warpUpdateRanges(model: WarpModel) {
  let ranges = updateRanges.get(model);
  if (!ranges) {
    const positions = joinedRanges(model.region.interiorVertices, 3);
    // Unindexed, every corner of a region face takes the face normal.
    const normals = model.index ? positions : joinedRanges(model.region.faces, 9);
    updateRanges.set(model, (ranges = { positions, normals }));
  }
  return ranges;
}

/** Start and count pairs covering ascending items of `size` values each. */
export function joinedRanges(items: ArrayLike<number>, size: number) {
  const starts: number[] = [],
    ends: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const start = items[i] * size;
    if (ends.length && start - ends[ends.length - 1] < joinGap)
      ends[ends.length - 1] = start + size;
    else {
      starts.push(start);
      ends.push(start + size);
    }
  }
  // Gap i lies after range i.
  const joined = new Uint8Array(starts.length);
  if (starts.length > warpRangeCap) {
    const order = Array.from({ length: starts.length - 1 }, (_, i) => i).sort(
      (a, b) => starts[a + 1] - ends[a] - (starts[b + 1] - ends[b]) || a - b,
    );
    for (let k = 0; k < starts.length - warpRangeCap; k++) joined[order[k]] = 1;
  }
  const ranges: number[] = [];
  for (let i = 0; i < starts.length; i++) {
    const last = ranges.length - 2;
    if (i > 0 && joined[i - 1]) ranges[last + 1] = ends[i] - ranges[last];
    else ranges.push(starts[i], ends[i] - starts[i]);
  }
  return Uint32Array.from(ranges);
}

export function deformPoint(
  model: WarpModel,
  state: WarpState,
  binding: { node: number[]; weight: number[] },
  restWorld: Vec3,
): Vec3 {
  const r = new Float64Array(9);
  const out: Vec3 = [0, 0, 0];
  for (let j = 0; j < binding.node.length; j++) {
    const n = binding.node[j],
      w = binding.weight[j];
    writeRotation(
      r,
      0,
      state.rotations[n * 4],
      state.rotations[n * 4 + 1],
      state.rotations[n * 4 + 2],
      state.rotations[n * 4 + 3],
    );
    const dx = restWorld[0] - model.restNodes[n * 3],
      dy = restWorld[1] - model.restNodes[n * 3 + 1],
      dz = restWorld[2] - model.restNodes[n * 3 + 2];
    out[0] += w * (r[0] * dx + r[1] * dy + r[2] * dz + state.positions[n * 3]);
    out[1] += w * (r[3] * dx + r[4] * dy + r[5] * dz + state.positions[n * 3 + 1]);
    out[2] += w * (r[6] * dx + r[7] * dy + r[8] * dz + state.positions[n * 3 + 2]);
  }
  return out;
}
