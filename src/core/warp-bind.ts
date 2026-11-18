import type { Vec3 } from './types';
import type { WarpGrid } from './warp-grid';
import { WarpRole, regionTriangleOf, type WarpRegion } from './warp-region';

export const warpBindingNodes = 4;

export interface WarpBinding {
  /** warpBindingNodes node ids per welded vertex, padded with 0xffffffff. */
  node: Uint32Array;
  weight: Float32Array;
  /**
   * Per welded vertex: its rest position less half the weighted rest centre of its nodes. Node n
   * carries the vertex by its rigid transform applied to `base − half(n)`, which integrates the
   * rotation along the way from the node by the trapezoid rule instead of holding the node's own
   * rotation all the way. A grid node's own vertex has offset 0.
   */
  base: Float64Array;
  /** Half of each node's rest position. */
  half: Float64Array;
}

const K = warpBindingNodes;
const none = 0xffffffff;

class MinHeap {
  private dist: number[] = [];
  private vertex: number[] = [];
  private node: number[] = [];
  size = 0;

  push(d: number, v: number, n: number) {
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.dist[p] <= d) break;
      this.dist[i] = this.dist[p];
      this.vertex[i] = this.vertex[p];
      this.node[i] = this.node[p];
      i = p;
    }
    this.dist[i] = d;
    this.vertex[i] = v;
    this.node[i] = n;
  }

  pop(out: { d: number; v: number; n: number }) {
    out.d = this.dist[0];
    out.v = this.vertex[0];
    out.n = this.node[0];
    const last = --this.size;
    const d = this.dist[last],
      v = this.vertex[last],
      n = this.node[last];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= last) break;
      if (c + 1 < last && this.dist[c + 1] < this.dist[c]) c++;
      if (this.dist[c] >= d) break;
      this.dist[i] = this.dist[c];
      this.vertex[i] = this.vertex[c];
      this.node[i] = this.node[c];
      i = c;
    }
    this.dist[i] = d;
    this.vertex[i] = v;
    this.node[i] = n;
  }
}

export function bindRegion(
  region: WarpRegion,
  grid: WarpGrid,
  restWorld: Float32Array | Float64Array,
): WarpBinding {
  const { weldedCount, role, adjacencyStart, adjacency } = region;
  const slots = K + 1;
  const foundNode = new Uint32Array(weldedCount * slots).fill(none);
  const foundDist = new Float32Array(weldedCount * slots);
  const count = new Uint8Array(weldedCount);

  const heap = new MinHeap();
  for (let n = 0; n < grid.nodes.length; n++) heap.push(0, grid.nodes[n], n);

  const top = { d: 0, v: 0, n: 0 };
  while (heap.size) {
    heap.pop(top);
    const { d, v, n } = top;
    const base = v * slots;
    if (count[v] >= slots) continue;
    let dup = false;
    for (let i = 0; i < count[v]; i++) if (foundNode[base + i] === n) dup = true;
    if (dup) continue;
    foundNode[base + count[v]] = n;
    foundDist[base + count[v]++] = d;
    for (let e = adjacencyStart[v]; e < adjacencyStart[v + 1]; e++) {
      const u = adjacency[e];
      if (count[u] >= slots) continue;
      const dx = restWorld[u * 3] - restWorld[v * 3];
      const dy = restWorld[u * 3 + 1] - restWorld[v * 3 + 1];
      const dz = restWorld[u * 3 + 2] - restWorld[v * 3 + 2];
      heap.push(d + Math.hypot(dx, dy, dz), u, n);
    }
  }

  const node = new Uint32Array(weldedCount * K).fill(none);
  const weight = new Float32Array(weldedCount * K);
  const normals = restNormals(region, restWorld);
  const u = new Float64Array(K),
    t = new Float64Array(K);
  for (let v = 0; v < weldedCount; v++) {
    if (role[v] === WarpRole.Outside || count[v] === 0) continue;
    const base = v * slots;
    const reached = count[v];
    const used = Math.min(reached, K);
    if (foundDist[base] === 0) {
      node[v * K] = foundNode[base];
      weight[v * K] = 1;
      continue;
    }
    const radius = reached > K ? foundDist[base + K] : 1.5 * foundDist[base + reached - 1];
    let sum = 0;
    for (let j = 0; j < used; j++) {
      const d = foundDist[base + j];
      const w = ((radius - d) / (radius * d)) ** 2;
      node[v * K + j] = foundNode[base + j];
      weight[v * K + j] = w;
      sum += w;
    }
    // Nodes all as far as the radius weigh nothing, so they share the vertex equally.
    if (!(sum > 0) || !Number.isFinite(sum)) {
      for (let j = 0; j < used; j++) weight[v * K + j] = 1 / used;
      continue;
    }
    for (let j = 0; j < used; j++) weight[v * K + j] /= sum;
    if (used > 1) linearPrecision(v, used, grid, restWorld, normals, node, weight, u, t);
  }

  // The trapezoid offsets use the stored weights, so a rigid motion of every node stays rigid.
  const baseOf = new Float64Array(weldedCount * 3);
  const half = new Float64Array(grid.nodes.length * 3);
  for (let n = 0; n < grid.nodes.length; n++)
    for (let a = 0; a < 3; a++) half[n * 3 + a] = 0.5 * restWorld[grid.nodes[n] * 3 + a];
  for (let v = 0; v < weldedCount; v++) {
    let x = 0,
      y = 0,
      z = 0,
      sum = 0;
    for (let j = 0; j < K; j++) {
      const n = node[v * K + j];
      if (n === none) continue;
      const w = weight[v * K + j];
      x += w * half[n * 3];
      y += w * half[n * 3 + 1];
      z += w * half[n * 3 + 2];
      sum += w;
    }
    const o = v * 3;
    if (sum > 0 && node[v * K + 1] === none) {
      // Bound to one node alone: offset from it exactly as a rigid transform would.
      const n = node[v * K];
      baseOf[o] = restWorld[o] - half[n * 3];
      baseOf[o + 1] = restWorld[o + 1] - half[n * 3 + 1];
      baseOf[o + 2] = restWorld[o + 2] - half[n * 3 + 2];
    } else if (sum > 0) {
      baseOf[o] = restWorld[o] - x / sum;
      baseOf[o + 1] = restWorld[o + 1] - y / sum;
      baseOf[o + 2] = restWorld[o + 2] - z / sum;
    } else {
      baseOf[o] = restWorld[o];
      baseOf[o + 1] = restWorld[o + 1];
      baseOf[o + 2] = restWorld[o + 2];
    }
  }
  return { node, weight, base: baseOf, half };
}

/** Area-weighted rest normal of each welded vertex over the region's triangles, unnormalized. */
function restNormals(region: WarpRegion, restWorld: Float32Array | Float64Array) {
  const { triangles } = region;
  const normals = new Float64Array(region.weldedCount * 3);
  for (let i = 0; i < triangles.length; i += 3) {
    const a = triangles[i] * 3,
      b = triangles[i + 1] * 3,
      c = triangles[i + 2] * 3;
    const ux = restWorld[b] - restWorld[a],
      uy = restWorld[b + 1] - restWorld[a + 1],
      uz = restWorld[b + 2] - restWorld[a + 2];
    const vx = restWorld[c] - restWorld[a],
      vy = restWorld[c + 1] - restWorld[a + 1],
      vz = restWorld[c + 2] - restWorld[a + 2];
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    for (const o of [a, b, c]) {
      normals[o] += nx;
      normals[o + 1] += ny;
      normals[o + 2] += nz;
    }
  }
  return normals;
}

/**
 * Reweights vertex v's nodes so their weighted centre lies on the vertex in its tangent plane, as
 * a moving least squares fit with a linear basis does: w'ᵢ = wᵢ (a + b uᵢ + c tᵢ). Without this the
 * weights pull the vertex toward its nearest node, and the surface between nodes kinks. Weights
 * stay continuous and are clipped at zero where the nodes do not surround the vertex.
 */
function linearPrecision(
  v: number,
  used: number,
  grid: WarpGrid,
  restWorld: Float32Array | Float64Array,
  normals: Float64Array,
  node: Uint32Array,
  weight: Float32Array,
  u: Float64Array,
  t: Float64Array,
) {
  let nx = normals[v * 3],
    ny = normals[v * 3 + 1],
    nz = normals[v * 3 + 2];
  const length = Math.hypot(nx, ny, nz);
  if (!(length > 0)) return;
  nx /= length;
  ny /= length;
  nz /= length;
  // A tangent basis: the axis least along the normal, made perpendicular, and the normal across it.
  let ax = 0,
    ay = 0,
    az = 0;
  if (Math.abs(nx) <= Math.abs(ny) && Math.abs(nx) <= Math.abs(nz)) ax = 1;
  else if (Math.abs(ny) <= Math.abs(nz)) ay = 1;
  else az = 1;
  const along = ax * nx + ay * ny + az * nz;
  ax -= along * nx;
  ay -= along * ny;
  az -= along * nz;
  const size = Math.hypot(ax, ay, az);
  ax /= size;
  ay /= size;
  az /= size;
  const bx = ny * az - nz * ay,
    by = nz * ax - nx * az,
    bz = nx * ay - ny * ax;

  const K = warpBindingNodes;
  let s = 0,
    su = 0,
    st = 0,
    suu = 0,
    sut = 0,
    stt = 0;
  for (let j = 0; j < used; j++) {
    const o = grid.nodes[node[v * K + j]] * 3;
    const dx = restWorld[o] - restWorld[v * 3],
      dy = restWorld[o + 1] - restWorld[v * 3 + 1],
      dz = restWorld[o + 2] - restWorld[v * 3 + 2];
    const w = weight[v * K + j];
    u[j] = dx * ax + dy * ay + dz * az;
    t[j] = dx * bx + dy * by + dz * bz;
    s += w;
    su += w * u[j];
    st += w * t[j];
    suu += w * u[j] * u[j];
    sut += w * u[j] * t[j];
    stt += w * t[j] * t[j];
  }
  // A ridge as large as the spread keeps the correction gentle. Full linear precision moves the
  // weights between nodes within a few fine triangles, which folds them where neighbouring nodes'
  // rigid transforms disagree, as near a sharp pull on a dense scan.
  const ridge = suu + stt;
  suu += ridge;
  stt += ridge;
  // Solve [s su st; su suu sut; st sut stt] (a b c) = (1 0 0) by its first column of cofactors.
  const c00 = suu * stt - sut * sut,
    c01 = st * sut - su * stt,
    c02 = su * sut - st * suu;
  const det = s * c00 + su * c01 + st * c02;
  if (!(Math.abs(det) > 0) || !Number.isFinite(det)) return;
  const a = c00 / det,
    b = c01 / det,
    c = c02 / det;
  let sum = 0;
  for (let j = 0; j < used; j++) {
    const w = Math.max(0, weight[v * K + j] * (a + b * u[j] + c * t[j]));
    u[j] = w;
    sum += w;
  }
  if (!(sum > 0) || !Number.isFinite(sum)) return;
  for (let j = 0; j < used; j++) weight[v * K + j] = u[j] / sum;
}

export interface WarpPointBinding {
  node: number[];
  weight: number[];
  /**
   * Weighted rest position per influencing node, before applying that node's rotation: where the
   * node's rigid transform carries the point from, as the binding's trapezoid offsets give it.
   */
  restByNode: Vec3[];
  /** Contribution from triangle corners which stay at rest. */
  fixed: Vec3;
}

export function bindPoint(
  region: WarpRegion,
  binding: WarpBinding,
  restWorld: Float32Array | Float64Array,
  face: number,
  barycentric: Vec3,
): WarpPointBinding {
  const triangle = regionTriangleOf(region, face);
  if (triangle < 0) throw new Error('Face is not in the warp region.');
  return bindTrianglePoint(region, binding, restWorld, triangle, barycentric);
}

/** A point on the baked triangle is the barycentric sum of its independently skinned corners. */
export function bindTrianglePoint(
  region: WarpRegion,
  binding: WarpBinding,
  restWorld: Float32Array | Float64Array,
  triangle: number,
  barycentric: Vec3,
): WarpPointBinding {
  const contributions = new Map<number, { weight: number; rest: Vec3 }>();
  const fixed: Vec3 = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    if (barycentric[c] === 0) continue;
    const v = region.triangles[triangle * 3 + c];
    let total = 0;
    if (region.role[v] === WarpRole.Interior)
      for (let j = 0; j < K; j++)
        if (binding.node[v * K + j] !== none) total += binding.weight[v * K + j];
    if (!(total > 0)) {
      for (let a = 0; a < 3; a++) fixed[a] += barycentric[c] * restWorld[v * 3 + a];
      continue;
    }
    for (let j = 0; j < K; j++) {
      const n = binding.node[v * K + j];
      const w = (binding.weight[v * K + j] * barycentric[c]) / total;
      if (n === none || w === 0) continue;
      let entry = contributions.get(n);
      if (!entry) contributions.set(n, (entry = { weight: 0, rest: [0, 0, 0] }));
      entry.weight += w;
      // The rest position node n carries: its own rest plus the vertex's offset from it.
      for (let a = 0; a < 3; a++)
        entry.rest[a] += w * (binding.base[v * 3 + a] + binding.half[n * 3 + a]);
    }
  }
  const entries = [...contributions.values()];
  return {
    node: [...contributions.keys()],
    weight: entries.map(({ weight }) => weight),
    restByNode: entries.map(({ weight, rest }) => rest.map((x) => x / weight) as Vec3),
    fixed,
  };
}
