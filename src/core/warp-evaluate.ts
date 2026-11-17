import type { Vec3 } from './types';
import type { WarpModel } from './warp-model';
import { WarpRole } from './warp-region';
import { writeRotation, type WarpState } from './warp-solve';

export interface WarpOutput {
  positions: Float32Array;
  normals: Float32Array | null;
}

const none = 0xffffffff;

interface Scratch {
  rotation: Float64Array;
  /** Deformed world position per welded vertex; valid for interior welds. */
  world: Float32Array;
  moved: Uint8Array;
  pending: Uint8Array | null;
}
const scratches = new WeakMap<WarpModel, Scratch>();

function scratchFor(model: WarpModel): Scratch {
  let s = scratches.get(model);
  if (!s) {
    s = {
      rotation: new Float64Array(model.grid.nodes.length * 9),
      world: new Float32Array(model.region.weldedCount * 3),
      moved: new Uint8Array(model.region.weldedCount),
      pending: model.normals ? new Uint8Array(model.positions.length / 3) : null,
    };
    scratches.set(model, s);
  }
  return s;
}

export function createWarpOutput(model: WarpModel): WarpOutput {
  return { positions: model.positions.slice(), normals: model.normals?.slice() ?? null };
}

/** Writes interior vertices (and their normals); returns region triangle ids whose world normal flipped. */
export function evaluateWarp(model: WarpModel, state: WarpState, out: WarpOutput): Uint32Array {
  const { region, grid, binding, restWorld, restNodes, inverse: inv } = model;
  const { weldOf, weldedCount, role, triangles, faces } = region;
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

  for (let v = 0; v < weldedCount; v++) {
    moved[v] = 0;
    if (role[v] !== WarpRole.Interior) continue;
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

  const { positions } = out;
  for (let g = 0; g < weldOf.length; g++) {
    const v = weldOf[g];
    if (v === none || !moved[v]) continue;
    const x = world[v * 3],
      y = world[v * 3 + 1],
      z = world[v * 3 + 2];
    positions[g * 3] = inv[0] * x + inv[4] * y + inv[8] * z + inv[12];
    positions[g * 3 + 1] = inv[1] * x + inv[5] * y + inv[9] * z + inv[13];
    positions[g * 3 + 2] = inv[2] * x + inv[6] * y + inv[10] * z + inv[14];
  }

  if (out.normals && model.normals) writeNormals(model, out, out.normals);

  const folds: number[] = [];
  const at = (v: number, c: number) =>
    role[v] === WarpRole.Interior ? world[v * 3 + c] : restWorld[v * 3 + c];
  for (let t = 0; t < faces.length; t++) {
    const a = triangles[t * 3],
      b = triangles[t * 3 + 1],
      c = triangles[t * 3 + 2];
    let dot = 0;
    const deformed = faceNormal(
      at(a, 0),
      at(a, 1),
      at(a, 2),
      at(b, 0),
      at(b, 1),
      at(b, 2),
      at(c, 0),
      at(c, 1),
      at(c, 2),
    );
    const rest = faceNormal(
      restWorld[a * 3],
      restWorld[a * 3 + 1],
      restWorld[a * 3 + 2],
      restWorld[b * 3],
      restWorld[b * 3 + 1],
      restWorld[b * 3 + 2],
      restWorld[c * 3],
      restWorld[c * 3 + 1],
      restWorld[c * 3 + 2],
    );
    dot = deformed[0] * rest[0] + deformed[1] * rest[1] + deformed[2] * rest[2];
    if (dot < 0) folds.push(t);
  }
  return Uint32Array.from(folds);
}

function faceNormal(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
): Vec3 {
  const ux = bx - ax,
    uy = by - ay,
    uz = bz - az;
  const vx = cx - ax,
    vy = cy - ay,
    vz = cz - az;
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

function writeNormals(model: WarpModel, out: WarpOutput, normals: Float32Array) {
  const { region, index, indexed } = model;
  const { weldOf, role, faces } = region;
  const original = model.normals!;
  const { positions } = out;
  const vertexOf = (f: number, c: number) => (index ? index[f * 3 + c] : f * 3 + c);

  if (!indexed) {
    for (let t = 0; t < faces.length; t++) {
      const f = faces[t];
      const a = f * 3 * 3;
      const [nx, ny, nz] = faceNormal(
        positions[a],
        positions[a + 1],
        positions[a + 2],
        positions[a + 3],
        positions[a + 4],
        positions[a + 5],
        positions[a + 6],
        positions[a + 7],
        positions[a + 8],
      );
      const length = Math.hypot(nx, ny, nz);
      for (let c = 0; c < 3; c++) {
        const o = (f * 3 + c) * 3;
        if (length > 0) {
          normals[o] = nx / length;
          normals[o + 1] = ny / length;
          normals[o + 2] = nz / length;
        } else {
          normals[o] = original[o];
          normals[o + 1] = original[o + 1];
          normals[o + 2] = original[o + 2];
        }
      }
    }
    return;
  }

  const pending = scratchFor(model).pending!;
  const interior = (g: number) => role[weldOf[g]] === WarpRole.Interior;
  for (let t = 0; t < faces.length; t++)
    for (let c = 0; c < 3; c++) {
      const g = vertexOf(faces[t], c);
      if (!interior(g) || pending[g]) continue;
      pending[g] = 1;
      normals[g * 3] = normals[g * 3 + 1] = normals[g * 3 + 2] = 0;
    }
  for (let t = 0; t < faces.length; t++) {
    const a = vertexOf(faces[t], 0) * 3,
      b = vertexOf(faces[t], 1) * 3,
      c = vertexOf(faces[t], 2) * 3;
    const n = faceNormal(
      positions[a],
      positions[a + 1],
      positions[a + 2],
      positions[b],
      positions[b + 1],
      positions[b + 2],
      positions[c],
      positions[c + 1],
      positions[c + 2],
    );
    for (const o of [a, b, c]) {
      if (!pending[o / 3]) continue;
      normals[o] += n[0];
      normals[o + 1] += n[1];
      normals[o + 2] += n[2];
    }
  }
  for (let t = 0; t < faces.length; t++)
    for (let c = 0; c < 3; c++) {
      const g = vertexOf(faces[t], c);
      if (!pending[g]) continue;
      pending[g] = 0;
      const o = g * 3;
      const length = Math.hypot(normals[o], normals[o + 1], normals[o + 2]);
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
