import type { Vec3 } from './types';
import type { WarpDetail } from './warp-handles';
import type { WarpModel } from './warp-model';
import { WarpRole } from './warp-region';
import {
  skinMapOf,
  writeRotation,
  writeSkinMaps,
  type WarpConstraint,
  type WarpState,
} from './warp-solve';

export interface WarpOutput {
  positions: Float32Array;
  normals: Float32Array | null;
  /** Mesh-local box around the vertices the last evaluation moved: min x, y, z, then max. */
  moved: Float64Array;
}

const none = 0xffffffff;

interface Scratch {
  rotation: Float64Array;
  skin: Float64Array;
  /** Per node, its position less its skin map applied to its half rest position. */
  shift: Float64Array;
  /** Deformed world position per welded vertex; rest for vertices that do not move. */
  world: Float64Array;
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
      skin: new Float64Array(model.grid.nodes.length * 9),
      shift: new Float64Array(model.grid.nodes.length * 3),
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

/** Each node's skin map for `state` into `skin`, by way of its rotation in `rotation`. */
function writeNodeMaps(
  model: WarpModel,
  state: WarpState,
  rotation: Float64Array,
  skin: Float64Array,
) {
  const { rotations } = state;
  const count = model.grid.nodes.length;
  for (let n = 0; n < count; n++)
    writeRotation(
      rotation,
      n * 9,
      rotations[n * 4],
      rotations[n * 4 + 1],
      rotations[n * 4 + 2],
      rotations[n * 4 + 3],
    );
  writeSkinMaps(model.grid, model.restNodes, state.positions, rotation, skin);
}

/** What skinning reads, gathered once per model. */
interface Skin {
  node: Uint32Array;
  weight: Float32Array;
  base: Float64Array;
  half: Float64Array;
  restWorld: Float64Array;
  K: number;
}
const skins = new WeakMap<WarpModel, Skin>();

function skinOf(model: WarpModel): Skin {
  let skin = skins.get(model);
  if (!skin) {
    const { node, weight, base, half } = model.binding;
    const K = node.length / model.region.weldedCount;
    skins.set(model, (skin = { node, weight, base, half, restWorld: model.restWorld, K }));
  }
  return skin;
}

/** Each node's position less its skin map applied to its half rest position, into `shift`. */
function writeShifts(skin: Skin, nodePos: Float64Array, map: Float64Array, shift: Float64Array) {
  const { half } = skin;
  for (let n = 0, h = 0, r = 0; h < shift.length; n++, h += 3, r += 9) {
    const hx = half[h],
      hy = half[h + 1],
      hz = half[h + 2];
    shift[h] = nodePos[h] - (map[r] * hx + map[r + 1] * hy + map[r + 2] * hz);
    shift[h + 1] = nodePos[h + 1] - (map[r + 3] * hx + map[r + 4] * hy + map[r + 5] * hz);
    shift[h + 2] = nodePos[h + 2] - (map[r + 6] * hx + map[r + 7] * hy + map[r + 8] * hz);
  }
}

/**
 * Skinned world position of interior welded vertex `v`, before any feather blend, into `world` at
 * `o`: Σ w (S (base − half) + p) over its nodes, gathered as (Σ w S) base + Σ w (p − S half). A
 * vertex on one node alone takes that node's map directly, so a node's own vertex lands exactly on
 * it. Returns false, writing rest, when the vertex has no usable binding.
 */
function skinVertex(
  skin: Skin,
  nodePos: Float64Array,
  map: Float64Array,
  shift: Float64Array,
  v: number,
  world: Float64Array,
  o: number,
) {
  const { node, weight, base, half, K } = skin;
  const px = base[v * 3],
    py = base[v * 3 + 1],
    pz = base[v * 3 + 2];
  const j0 = v * K;
  if (K > 1 && node[j0 + 1] === none && node[j0] !== none && weight[j0] > 0) {
    const n = node[j0],
      h = n * 3,
      r = n * 9;
    const dx = px - half[h],
      dy = py - half[h + 1],
      dz = pz - half[h + 2];
    world[o] = map[r] * dx + map[r + 1] * dy + map[r + 2] * dz + nodePos[h];
    world[o + 1] = map[r + 3] * dx + map[r + 4] * dy + map[r + 5] * dz + nodePos[h + 1];
    world[o + 2] = map[r + 6] * dx + map[r + 7] * dy + map[r + 8] * dz + nodePos[h + 2];
    return true;
  }
  let m0 = 0,
    m1 = 0,
    m2 = 0,
    m3 = 0,
    m4 = 0,
    m5 = 0,
    m6 = 0,
    m7 = 0,
    m8 = 0,
    tx = 0,
    ty = 0,
    tz = 0,
    sum = 0;
  for (let j = j0, end = j0 + K; j < end; j++) {
    const n = node[j];
    if (n === none) continue;
    const w = weight[j];
    const h = n * 3,
      r = n * 9;
    m0 += w * map[r];
    m1 += w * map[r + 1];
    m2 += w * map[r + 2];
    m3 += w * map[r + 3];
    m4 += w * map[r + 4];
    m5 += w * map[r + 5];
    m6 += w * map[r + 6];
    m7 += w * map[r + 7];
    m8 += w * map[r + 8];
    tx += w * shift[h];
    ty += w * shift[h + 1];
    tz += w * shift[h + 2];
    sum += w;
  }
  const x = m0 * px + m1 * py + m2 * pz + tx,
    y = m3 * px + m4 * py + m5 * pz + ty,
    z = m6 * px + m7 * py + m8 * pz + tz;
  if (!(sum > 0) || !Number.isFinite(x + y + z + sum)) {
    const { restWorld } = skin;
    world[o] = restWorld[v * 3];
    world[o + 1] = restWorld[v * 3 + 1];
    world[o + 2] = restWorld[v * 3 + 2];
    return false;
  }
  world[o] = x / sum;
  world[o + 1] = y / sum;
  world[o + 2] = z / sum;
  return true;
}

/**
 * World positions of the listed welded vertices as `evaluateWarp` skins them for `state`, before
 * any feather blend, three values each. A vertex the warp does not move gets NaN.
 */
export function skinnedWorldPositions(
  model: WarpModel,
  state: WarpState,
  vertices: ArrayLike<number>,
): Float64Array {
  const { region } = model;
  const rotation = new Float64Array(model.grid.nodes.length * 9),
    skin = new Float64Array(model.grid.nodes.length * 9),
    shift = new Float64Array(model.grid.nodes.length * 3);
  writeNodeMaps(model, state, rotation, skin);
  const skinned = skinOf(model);
  writeShifts(skinned, state.positions, skin, shift);
  const out = new Float64Array(vertices.length * 3).fill(NaN);
  for (let i = 0; i < vertices.length; i++) {
    const v = vertices[i];
    if (v >= region.weldedCount || region.role[v] !== WarpRole.Interior) continue;
    if (!skinVertex(skinned, state.positions, skin, shift, v, out, i * 3))
      out.fill(NaN, i * 3, i * 3 + 3);
  }
  return out;
}

const slotsByVertices = new WeakMap<Uint32Array, Map<number, number>>();

/** Offsets in a detail field, shared across frames with the same affected vertices. */
export function detailVertexSlots(vertices: Uint32Array) {
  let slots = slotsByVertices.get(vertices);
  if (!slots) {
    slots = new Map();
    for (let i = 0; i < vertices.length; i++) slots.set(vertices[i], i);
    slotsByVertices.set(vertices, slots);
  }
  return slots;
}

/**
 * Mesh-local positions of the listed welded vertices exactly as `evaluateWarp` writes them for
 * `state` and `detail`, without writing a whole mesh. A vertex the warp does not move keeps the
 * bits of `first[v]`, the geometry vertex given for it.
 */
export function writtenLocalPositions(
  model: WarpModel,
  state: WarpState,
  vertices: ArrayLike<number>,
  first: ArrayLike<number>,
  detail?: WarpDetail,
): Float32Array {
  const { region, restWorld, blend, inverse: inv } = model;
  const slots = detail && detailVertexSlots(detail.vertices);
  const rotation = new Float64Array(model.grid.nodes.length * 9),
    skin = new Float64Array(model.grid.nodes.length * 9),
    shift = new Float64Array(model.grid.nodes.length * 3);
  writeNodeMaps(model, state, rotation, skin);
  writeShifts(skinOf(model), state.positions, skin, shift);
  const world = new Float64Array(3);
  const out = new Float32Array(vertices.length * 3);
  for (let i = 0; i < vertices.length; i++) {
    const v = vertices[i];
    const moved =
      region.role[v] === WarpRole.Interior &&
      skinVertex(skinOf(model), state.positions, skin, shift, v, world, 0);
    if (!moved) {
      out.set(model.positions.subarray(first[v] * 3, first[v] * 3 + 3), i * 3);
      continue;
    }
    let x = world[0],
      y = world[1],
      z = world[2];
    const slot = slots?.get(v);
    if (slot !== undefined) {
      x += detail!.delta[slot * 3];
      y += detail!.delta[slot * 3 + 1];
      z += detail!.delta[slot * 3 + 2];
    }
    if (blend && blend[v] < 1) {
      const b = blend[v];
      x = restWorld[v * 3] + b * (x - restWorld[v * 3]);
      y = restWorld[v * 3 + 1] + b * (y - restWorld[v * 3 + 1]);
      z = restWorld[v * 3 + 2] + b * (z - restWorld[v * 3 + 2]);
    }
    out[i * 3] = Math.fround(inv[0] * x + inv[4] * y + inv[8] * z + inv[12]);
    out[i * 3 + 1] = Math.fround(inv[1] * x + inv[5] * y + inv[9] * z + inv[13]);
    out[i * 3 + 2] = Math.fround(inv[2] * x + inv[6] * y + inv[10] * z + inv[14]);
  }
  return out;
}

/**
 * Writes interior vertices and their normals, touching only the region. `detail`, from
 * `warpDetail`, adds the handles' bend between grid nodes to the skinned surface. A feathered
 * model blends once, in the welded world buffer, and everything else reads that. Returns the
 * region triangles whose world normal flipped, or null when `folds` is false, as for a drag frame.
 */
export function evaluateWarp(
  model: WarpModel,
  state: WarpState,
  out: WarpOutput,
  folds?: true,
  detail?: WarpDetail,
): Uint32Array;
export function evaluateWarp(
  model: WarpModel,
  state: WarpState,
  out: WarpOutput,
  folds: boolean,
  detail?: WarpDetail,
): Uint32Array | null;
export function evaluateWarp(
  model: WarpModel,
  state: WarpState,
  out: WarpOutput,
  folds = true,
  detail?: WarpDetail,
): Uint32Array | null {
  const { region } = model;
  const { weldOf, interior, interiorVertices } = region;
  const { rotation, skin: maps, shift, world, moved } = scratchFor(model);
  writeNodeMaps(model, state, rotation, maps);

  const { restWorld, blend } = model;
  const skin = skinOf(model),
    nodePos = state.positions;
  writeShifts(skin, nodePos, maps, shift);
  for (let i = 0; i < interior.length; i++) {
    const v = interior[i];
    moved[v] = skinVertex(skin, nodePos, maps, shift, v, world, v * 3) ? 1 : 0;
  }
  if (detail) {
    const { vertices, delta } = detail;
    for (let i = 0; i < vertices.length; i++) {
      const v = vertices[i];
      if (!moved[v]) continue;
      world[v * 3] += delta[i * 3];
      world[v * 3 + 1] += delta[i * 3 + 1];
      world[v * 3 + 2] += delta[i * 3 + 2];
    }
  }
  // The feather band writes part of the displacement: rest + b × (skinned − rest).
  if (blend) {
    const band = featherOf(model).band;
    for (let i = 0; i < band.length; i++) {
      const v = band[i],
        b = blend[v];
      for (let a = v * 3; a < v * 3 + 3; a++)
        world[a] = restWorld[a] + b * (world[a] - restWorld[a]);
    }
  }

  const inv = model.inverse;
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
function triangleNormals(triangles: Uint32Array, points: Float64Array) {
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

const feathers = new WeakMap<WarpModel, { band: Uint32Array; borderCorners: Uint32Array }>();

/** A feathered model's band vertices, and the normal offsets of region face corners on its border. */
function featherOf(model: WarpModel) {
  let feather = feathers.get(model);
  if (!feather) {
    const { faces, weldOf, role, interior } = model.region;
    const blend = model.blend!;
    const band = interior.filter((v) => blend[v] < 1);
    const corners: number[] = [];
    for (let t = 0; t < faces.length; t++)
      for (let k = 0; k < 3; k++) {
        const g = faces[t] * 3 + k;
        if (role[weldOf[g]] === WarpRole.Border) corners.push(g * 3);
      }
    feathers.set(model, (feather = { band, borderCorners: Uint32Array.from(corners) }));
  }
  return feather;
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
    // A feathered outer border keeps its corners' normal bits, as an indexed border vertex does.
    if (model.blend)
      for (const c of featherOf(model).borderCorners) {
        normals[c] = original[c];
        normals[c + 1] = original[c + 1];
        normals[c + 2] = original[c + 2];
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
  // Gap i lies after range i. Exactly enough of the narrowest join, the leftmost of equal ones.
  const joined = new Uint8Array(starts.length);
  if (starts.length > warpRangeCap) {
    const gaps = new Float64Array(starts.length - 1);
    for (let i = 0; i < gaps.length; i++) gaps[i] = starts[i + 1] - ends[i];
    const need = starts.length - warpRangeCap;
    const widest = gaps.slice().sort()[need - 1];
    let ties = need;
    for (let i = 0; i < gaps.length; i++) if (gaps[i] < widest) ties--;
    for (let i = 0; i < gaps.length; i++)
      if (gaps[i] < widest || (gaps[i] === widest && ties-- > 0)) joined[i] = 1;
  }
  const ranges: number[] = [];
  for (let i = 0; i < starts.length; i++) {
    const last = ranges.length - 2;
    if (i > 0 && joined[i - 1]) ranges[last + 1] = ends[i] - ranges[last];
    else ranges.push(starts[i], ends[i] - starts[i]);
  }
  return Uint32Array.from(ranges);
}

/**
 * World position of each grid node where the surface is written: its solved position plus the
 * local shoulder correction, blended toward rest across a feather band. Writes into `out` and returns it.
 */
export function writtenNodePositions(
  model: WarpModel,
  state: WarpState,
  out: Float32Array | Float64Array = new Float32Array(state.positions.length),
  detail?: WarpDetail,
) {
  const { blend, restNodes, grid } = model;
  const positions = state.positions;
  if (!blend && !detail) {
    out.set(positions);
    return out;
  }
  const slots = detail && detailVertexSlots(detail.vertices);
  for (let n = 0; n < grid.nodes.length; n++) {
    const v = grid.nodes[n];
    const b = blend?.[v] ?? 1;
    const slot = slots?.get(v);
    for (let k = 0; k < 3; k++) {
      const a = n * 3 + k;
      const value = positions[a] + (slot === undefined ? 0 : detail!.delta[slot * 3 + k]);
      out[a] = b === 1 ? value : restNodes[a] + b * (value - restNodes[a]);
    }
  }
  return out;
}

export function deformPoint(
  model: WarpModel,
  state: WarpState,
  binding: Pick<WarpConstraint, 'node' | 'weight' | 'restByNode' | 'fixed'>,
  restWorld: Vec3,
): Vec3 {
  const r = new Float64Array(9);
  const out: Vec3 = binding.fixed ? [...binding.fixed] : [0, 0, 0];
  for (let j = 0; j < binding.node.length; j++) {
    const n = binding.node[j],
      w = binding.weight[j];
    skinMapOf(model.grid, model.restNodes, state, n, r);
    const rest = binding.restByNode?.[j] ?? restWorld;
    const dx = rest[0] - model.restNodes[n * 3],
      dy = rest[1] - model.restNodes[n * 3 + 1],
      dz = rest[2] - model.restNodes[n * 3 + 2];
    out[0] += w * (r[0] * dx + r[1] * dy + r[2] * dz + state.positions[n * 3]);
    out[1] += w * (r[3] * dx + r[4] * dy + r[5] * dz + state.positions[n * 3 + 1]);
    out[2] += w * (r[6] * dx + r[7] * dy + r[8] * dz + state.positions[n * 3 + 2]);
  }
  return out;
}
