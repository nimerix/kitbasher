import type { Vec3 } from './types';
import type { WarpGrid } from './warp-grid';
import { WarpRole, type WarpRegion } from './warp-region';

export const warpBindingNodes = 4;

export interface WarpBinding {
  /** warpBindingNodes node ids per welded vertex, padded with 0xffffffff. */
  node: Uint32Array;
  weight: Float32Array;
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
  restWorld: Float32Array,
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
    for (let j = 0; j < used; j++) weight[v * K + j] /= sum;
  }
  return { node, weight };
}

export function bindPoint(
  region: WarpRegion,
  _grid: WarpGrid,
  binding: WarpBinding,
  face: number,
  barycentric: Vec3,
): { node: number[]; weight: number[] } {
  const { faces, triangles } = region;
  let lo = 0,
    hi = faces.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (faces[mid] < face) lo = mid + 1;
    else hi = mid;
  }
  if (!faces.length || faces[lo] !== face) throw new Error('Face is not in the warp region.');

  const merged = new Map<number, number>();
  for (let c = 0; c < 3; c++) {
    const v = triangles[lo * 3 + c];
    for (let j = 0; j < K; j++) {
      const n = binding.node[v * K + j];
      if (n === none) continue;
      merged.set(n, (merged.get(n) ?? 0) + binding.weight[v * K + j] * barycentric[c]);
    }
  }
  const best = [...merged].sort((a, b) => b[1] - a[1]).slice(0, K);
  const sum = best.reduce((s, [, w]) => s + w, 0);
  return { node: best.map(([n]) => n), weight: best.map(([, w]) => w / sum) };
}
