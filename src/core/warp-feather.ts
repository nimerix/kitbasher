import { WarpRole, type WarpRegion } from './warp-region';

/** Min-heap of (distance, vertex) pairs on typed arrays that grow as needed. */
class DistanceHeap {
  private dist = new Float64Array(1024);
  private vertex = new Uint32Array(1024);
  size = 0;
  /** Distance of the entry `pop` last removed. */
  top = 0;

  push(d: number, v: number) {
    if (this.size === this.dist.length) {
      const dist = new Float64Array(this.size * 2),
        vertex = new Uint32Array(this.size * 2);
      dist.set(this.dist);
      vertex.set(this.vertex);
      this.dist = dist;
      this.vertex = vertex;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.dist[p] <= d) break;
      this.dist[i] = this.dist[p];
      this.vertex[i] = this.vertex[p];
      i = p;
    }
    this.dist[i] = d;
    this.vertex[i] = v;
  }

  /** Removes the nearest entry and returns its vertex; its distance is left in `top`. */
  pop() {
    const v = this.vertex[0];
    this.top = this.dist[0];
    const last = --this.size;
    const d = this.dist[last],
      u = this.vertex[last];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= last) break;
      if (c + 1 < last && this.dist[c + 1] < this.dist[c]) c++;
      if (this.dist[c] >= d) break;
      this.dist[i] = this.dist[c];
      this.vertex[i] = this.vertex[c];
      i = c;
    }
    this.dist[i] = d;
    this.vertex[i] = u;
    return v;
  }
}

export interface WarpGrowth {
  /** Painted and joined faces, ascending. */
  faces: Uint32Array;
  /** 1 for each painted geometry face. */
  paintedFace: Uint8Array;
  /** 1 for each welded vertex of a painted face. */
  paintedVertex: Uint8Array;
  /** Unpainted faces that joined. */
  joined: number;
}

/**
 * Grows painted faces outward by `width` mm of world surface distance. A bounded Dijkstra runs
 * from the painted edge through unpainted vertices, and an unpainted face joins when all three of
 * its corners are within the width.
 */
export function growWarpRegion(
  corner: Uint32Array,
  weldedCount: number,
  positions: Float32Array,
  index: Uint32Array | null,
  matrix: number[],
  faces: ArrayLike<number>,
  width: number,
): WarpGrowth {
  const faceCount = corner.length / 3;
  const paintedFace = new Uint8Array(faceCount);
  for (let i = 0; i < faces.length; i++) paintedFace[faces[i]] = 1;
  const paintedVertex = new Uint8Array(weldedCount);
  for (let f = 0; f < faceCount; f++)
    if (paintedFace[f])
      paintedVertex[corner[f * 3]] =
        paintedVertex[corner[f * 3 + 1]] =
        paintedVertex[corner[f * 3 + 2]] =
          1;

  // Welded vertex to unpainted face incidence.
  const start = new Uint32Array(weldedCount + 1);
  for (let f = 0; f < faceCount; f++)
    if (!paintedFace[f]) for (let k = 0; k < 3; k++) start[corner[f * 3 + k] + 1]++;
  for (let v = 0; v < weldedCount; v++) start[v + 1] += start[v];
  const incident = new Uint32Array(start[weldedCount]);
  const fill = start.slice(0, weldedCount);
  for (let f = 0; f < faceCount; f++)
    if (!paintedFace[f]) for (let k = 0; k < 3; k++) incident[fill[corner[f * 3 + k]]++] = f;

  const dist = new Float64Array(weldedCount).fill(Infinity);
  const heap = new DistanceHeap();
  for (let v = 0; v < weldedCount; v++)
    if (paintedVertex[v] && start[v + 1] > start[v]) {
      dist[v] = 0;
      heap.push(0, v);
    }

  const m = matrix;
  const vertexOf = (f: number, k: number) => (index ? index[f * 3 + k] : f * 3 + k);
  while (heap.size) {
    const u = heap.pop(),
      d = heap.top;
    if (d > dist[u]) continue;
    for (let e = start[u]; e < start[u + 1]; e++) {
      const f = incident[e];
      let ku = 0;
      while (corner[f * 3 + ku] !== u) ku++;
      const gu = vertexOf(f, ku) * 3;
      for (let k = 0; k < 3; k++) {
        const w = corner[f * 3 + k];
        if (w === u || paintedVertex[w]) continue;
        const gw = vertexOf(f, k) * 3;
        const x = positions[gw] - positions[gu],
          y = positions[gw + 1] - positions[gu + 1],
          z = positions[gw + 2] - positions[gu + 2];
        const length = Math.hypot(
          m[0] * x + m[4] * y + m[8] * z,
          m[1] * x + m[5] * y + m[9] * z,
          m[2] * x + m[6] * y + m[10] * z,
        );
        const next = d + length;
        if (next <= width && next < dist[w]) {
          dist[w] = next;
          heap.push(next, w);
        }
      }
    }
  }

  let joined = 0,
    count = 0;
  const member = new Uint8Array(faceCount);
  for (let f = 0; f < faceCount; f++) {
    if (paintedFace[f]) member[f] = 1;
    else if (
      dist[corner[f * 3]] <= width &&
      dist[corner[f * 3 + 1]] <= width &&
      dist[corner[f * 3 + 2]] <= width
    ) {
      member[f] = 1;
      joined++;
    }
    count += member[f];
  }
  const grown = new Uint32Array(count);
  for (let f = 0, i = 0; f < faceCount; f++) if (member[f]) grown[i++] = f;
  return { faces: grown, paintedFace, paintedVertex, joined };
}

const belowOne = 1 - 2 ** -24;

/**
 * Per welded vertex: 1 on every vertex of a painted face, 0 on the rest of the outer border, and
 * across the band a smooth step of t = d_out / (d_in + d_out), the surface distances to the outer
 * border and to the painted edge. Band values stay below 1, so 1 marks painted vertices exactly.
 */
export function featherBlend(
  region: WarpRegion,
  restWorld: Float64Array,
  paintedVertex: Uint8Array,
): Float32Array {
  const { weldedCount, role } = region;
  const blend = new Float32Array(weldedCount);
  for (let v = 0; v < weldedCount; v++) if (paintedVertex[v]) blend[v] = 1;
  const band = (v: number) => role[v] === WarpRole.Interior && !paintedVertex[v];
  const inner = distancesInto(
    region,
    restWorld,
    (v) => paintedVertex[v] === 1 && role[v] === WarpRole.Interior,
    band,
  );
  const outer = distancesInto(region, restWorld, (v) => role[v] === WarpRole.Border, band);
  for (let v = 0; v < weldedCount; v++) {
    if (!band(v)) continue;
    const din = inner[v],
      dout = outer[v];
    const t = !(din < Infinity) ? 0 : !(dout < Infinity) ? 1 : dout / (din + dout);
    // Written displacement is b × D, and D itself falls about linearly across the band. This step
    // makes that product meet the painted side with matching slope and curvature, and the outer
    // border flat: b(t) = t²(6 − 8t + 3t²), with b′ = 12t(1 − t)².
    blend[v] = Math.min(Math.fround(t * t * (6 - 8 * t + 3 * t * t)), belowOne);
  }
  return blend;
}

/** Multi-source surface distances from `source` vertices into `into` vertices. */
function distancesInto(
  region: WarpRegion,
  restWorld: Float64Array,
  source: (v: number) => boolean,
  into: (v: number) => boolean,
) {
  const { weldedCount, adjacencyStart, adjacency } = region;
  const dist = new Float64Array(weldedCount).fill(Infinity);
  const heap = new DistanceHeap();
  for (let v = 0; v < weldedCount; v++) {
    if (!source(v)) continue;
    for (let e = adjacencyStart[v]; e < adjacencyStart[v + 1]; e++)
      if (into(adjacency[e])) {
        dist[v] = 0;
        heap.push(0, v);
        break;
      }
  }
  while (heap.size) {
    const u = heap.pop(),
      d = heap.top;
    if (d > dist[u]) continue;
    for (let e = adjacencyStart[u]; e < adjacencyStart[u + 1]; e++) {
      const w = adjacency[e];
      if (!into(w)) continue;
      const next =
        d +
        Math.hypot(
          restWorld[w * 3] - restWorld[u * 3],
          restWorld[w * 3 + 1] - restWorld[u * 3 + 1],
          restWorld[w * 3 + 2] - restWorld[u * 3 + 2],
        );
      if (next < dist[w]) {
        dist[w] = next;
        heap.push(next, w);
      }
    }
  }
  return dist;
}
