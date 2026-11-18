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
  /** Painted vertices where paint meets unpainted faces across an edge: the edge to feather. */
  edge: number;
  /**
   * 1 for each band vertex that is fixed although no outside face touches it: a mesh boundary or
   * hole rim inside the band, or an anchor kept where the band would have left no fixed edge.
   */
  pinned: Uint8Array;
  /** Connected pieces where the band would have covered everything unpainted. */
  anchored: number;
}

/**
 * Grows painted faces outward by `width` mm of world surface distance. A bounded Dijkstra runs
 * from the painted edge through unpainted vertices, and an unpainted face joins when all three of
 * its corners are within the width.
 *
 * Distance spreads only across shared edges: each welded vertex is split into fans of faces that
 * share an edge there, so growth never crosses onto another surface through a single shared
 * vertex. Band vertices on a mesh boundary are pinned, so a rim or hole inside the band stays put.
 * Where the band would leave an edge-connected piece no fixed boundary edge, its farthest ring
 * stays unjoined as an anchor.
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
  let painted = 0;
  for (let f = 0; f < faceCount; f++)
    if (paintedFace[f]) {
      painted++;
      paintedVertex[corner[f * 3]] =
        paintedVertex[corner[f * 3 + 1]] =
        paintedVertex[corner[f * 3 + 2]] =
          1;
    }

  // Welded vertex to face incidence, every face.
  const start = new Uint32Array(weldedCount + 1);
  for (let i = 0; i < corner.length; i++) start[corner[i] + 1]++;
  for (let v = 0; v < weldedCount; v++) start[v + 1] += start[v];
  const incident = new Uint32Array(corner.length);
  const fill = start.slice(0, weldedCount);
  for (let i = 0; i < corner.length; i++) incident[fill[corner[i]]++] = i;

  // Fans: the corners of a vertex whose faces are joined through edges at that vertex. Also marks
  // vertices on a boundary edge, which only one face uses.
  const fanOf = new Uint32Array(corner.length);
  const rim = new Uint8Array(weldedCount);
  const parent: number[] = [];
  const seen = new Int32Array(weldedCount).fill(-1);
  const uses = new Uint32Array(weldedCount);
  const stamp = new Int32Array(weldedCount).fill(-1);
  const root = (i: number) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  let fans = 0;
  for (let v = 0; v < weldedCount; v++) {
    const first = start[v],
      count = start[v + 1] - first;
    parent.length = count;
    for (let i = 0; i < count; i++) parent[i] = i;
    for (let i = 0; i < count; i++) {
      const c = incident[first + i],
        f = c - (c % 3);
      for (let k = 0; k < 3; k++) {
        const w = corner[f + k];
        if (w === v) continue;
        if (stamp[w] !== v) {
          stamp[w] = v;
          seen[w] = i;
          uses[w] = 0;
        } else {
          const a = root(i),
            b = root(seen[w]);
          if (a !== b) parent[a] = b;
        }
        uses[w]++;
      }
    }
    for (let i = 0; i < count; i++) {
      const c = incident[first + i],
        f = c - (c % 3);
      for (let k = 0; k < 3; k++) if (corner[f + k] !== v && uses[corner[f + k]] === 1) rim[v] = 1;
      if (root(i) === i) fanOf[c] = fans++;
    }
    for (let i = 0; i < count; i++) {
      const r = root(i);
      if (r !== i) fanOf[incident[first + i]] = fanOf[incident[first + r]];
    }
  }

  // Per fan: its vertex, and whether it holds painted and unpainted faces.
  const fanVertex = new Uint32Array(fans);
  const fanPainted = new Uint8Array(fans),
    fanBare = new Uint8Array(fans);
  for (let c = 0; c < corner.length; c++) {
    const fan = fanOf[c];
    fanVertex[fan] = corner[c];
    if (paintedFace[(c - (c % 3)) / 3]) fanPainted[fan] = 1;
    else fanBare[fan] = 1;
  }
  // Corners of each fan, for walking its unpainted faces.
  const fanStart = new Uint32Array(fans + 1);
  for (let c = 0; c < corner.length; c++) fanStart[fanOf[c] + 1]++;
  for (let fan = 0; fan < fans; fan++) fanStart[fan + 1] += fanStart[fan];
  const fanCorners = new Uint32Array(corner.length);
  const fanFill = fanStart.slice(0, fans);
  for (let c = 0; c < corner.length; c++) fanCorners[fanFill[fanOf[c]]++] = c;

  const dist = new Float64Array(fans).fill(Infinity);
  const heap = new DistanceHeap();
  const edgeVertex = new Uint8Array(weldedCount);
  let edge = 0;
  for (let fan = 0; fan < fans; fan++)
    if (fanPainted[fan] && fanBare[fan]) {
      dist[fan] = 0;
      heap.push(0, fan);
      const v = fanVertex[fan];
      if (!edgeVertex[v]) {
        edgeVertex[v] = 1;
        edge++;
      }
    }

  const m = matrix;
  const vertexOf = (c: number) => (index ? index[c] : c);
  while (heap.size) {
    const u = heap.pop(),
      d = heap.top;
    if (d > dist[u]) continue;
    for (let e = fanStart[u]; e < fanStart[u + 1]; e++) {
      const c = fanCorners[e],
        f = c - (c % 3);
      if (paintedFace[f / 3]) continue;
      const gu = vertexOf(c) * 3;
      for (let k = 0; k < 3; k++) {
        const o = f + k;
        if (o === c) continue;
        const w = fanOf[o];
        if (fanPainted[w]) continue;
        const gw = vertexOf(o) * 3;
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

  const join = new Uint8Array(faceCount);
  let joined = 0;
  for (let f = 0; f < faceCount; f++)
    if (
      !paintedFace[f] &&
      dist[fanOf[f * 3]] <= width &&
      dist[fanOf[f * 3 + 1]] <= width &&
      dist[fanOf[f * 3 + 2]] <= width
    ) {
      join[f] = 1;
      joined++;
    }

  const pinned = new Uint8Array(weldedCount);
  let anchored = 0;
  if (joined) {
    // Band vertices on a mesh boundary.
    for (let f = 0; f < faceCount; f++)
      if (join[f])
        for (let k = 0; k < 3; k++) {
          const v = corner[f * 3 + k];
          if (rim[v] && !paintedVertex[v]) pinned[v] = 1;
        }
    anchored = anchorSwallowed(
      corner,
      weldedCount,
      start,
      incident,
      paintedFace,
      join,
      pinned,
      dist,
      fanOf,
      positions,
      index,
      m,
    );
    joined = 0;
    for (let f = 0; f < faceCount; f++) joined += join[f];
  }

  const grown = new Uint32Array(painted + joined);
  for (let f = 0, i = 0; i < grown.length; f++) if (paintedFace[f] || join[f]) grown[i++] = f;
  return { faces: grown, paintedFace, paintedVertex, joined, edge, pinned, anchored };
}

/**
 * For each edge-connected piece of the grown region with no fixed boundary edge, leaves its
 * farthest band ring unjoined so that ring stays fixed. Returns how many pieces.
 *
 * A fixed boundary edge is one region face uses alone, with both ends fixed. Grid simplification
 * locks such edges, so they survive into the grid; a lone fixed vertex may not.
 */
function anchorSwallowed(
  corner: Uint32Array,
  weldedCount: number,
  start: Uint32Array,
  incident: Uint32Array,
  paintedFace: Uint8Array,
  join: Uint8Array,
  pinned: Uint8Array,
  dist: Float64Array,
  fanOf: Uint32Array,
  positions: Float32Array,
  index: Uint32Array | null,
  m: number[],
) {
  const faceCount = paintedFace.length;
  const inRegion = (f: number) => paintedFace[f] === 1 || join[f] === 1;
  // A vertex is fixed when an outside face touches it or it is pinned.
  const fixed = new Uint8Array(weldedCount);
  for (let f = 0; f < faceCount; f++)
    if (!inRegion(f))
      fixed[corner[f * 3]] = fixed[corner[f * 3 + 1]] = fixed[corner[f * 3 + 2]] = 1;
  for (let v = 0; v < weldedCount; v++) if (pinned[v]) fixed[v] = 1;

  const piece = new Int32Array(faceCount).fill(-1);
  const stack: number[] = [];
  let anchored = 0;
  for (let seed = 0; seed < faceCount; seed++) {
    if (!join[seed] || piece[seed] >= 0) continue;
    const members: number[] = [];
    let hasFixed = false;
    piece[seed] = seed;
    stack.push(seed);
    while (stack.length) {
      const f = stack.pop()!;
      members.push(f);
      for (let k = 0; k < 3; k++) {
        const a = corner[f * 3 + k],
          b = corner[f * 3 + ((k + 1) % 3)];
        if (a === b) continue;
        // Region faces across edge ab, this one included.
        let uses = 0;
        for (let e = start[a]; e < start[a + 1]; e++) {
          const g = (incident[e] - (incident[e] % 3)) / 3;
          if (
            !inRegion(g) ||
            (corner[g * 3] !== b && corner[g * 3 + 1] !== b && corner[g * 3 + 2] !== b)
          )
            continue;
          uses++;
          if (piece[g] < 0) {
            piece[g] = seed;
            stack.push(g);
          }
        }
        if (uses === 1 && fixed[a] && fixed[b]) hasFixed = true;
      }
    }
    if (hasFixed) continue;
    let far = -1,
      farthest = -Infinity;
    for (const f of members)
      if (join[f])
        for (let k = 0; k < 3; k++) {
          const d = dist[fanOf[f * 3 + k]];
          if (d > farthest) [farthest, far] = [d, f * 3 + k];
        }
    // The ring: joined faces with a corner within one edge of the farthest vertex's distance.
    const vertexOf = (c: number) => (index ? index[c] : c);
    const v = corner[far];
    let ring = 0;
    for (let e = start[v]; e < start[v + 1]; e++) {
      const c = incident[e],
        f = c - (c % 3);
      const g = vertexOf(c) * 3;
      for (let k = 0; k < 3; k++) {
        const h = vertexOf(f + k) * 3;
        const x = positions[h] - positions[g],
          y = positions[h + 1] - positions[g + 1],
          z = positions[h + 2] - positions[g + 2];
        ring = Math.max(
          ring,
          Math.hypot(
            m[0] * x + m[4] * y + m[8] * z,
            m[1] * x + m[5] * y + m[9] * z,
            m[2] * x + m[6] * y + m[10] * z,
          ),
        );
      }
    }
    for (const f of members)
      if (join[f])
        for (let k = 0; k < 3; k++)
          if (dist[fanOf[f * 3 + k]] >= farthest - ring) {
            join[f] = 0;
            break;
          }
    anchored++;
  }
  return anchored;
}

const belowOne = 1 - 2 ** -24;

/**
 * Per welded vertex: 1 on every vertex of a painted face, 0 on the rest of the outer border, and
 * across the band a smooth step of t = d_out / (d_in + d_out), the surface distances to the outer
 * border and to the painted edge. Band values stay below 1, so 1 marks painted vertices exactly.
 */
export function featherBlend(
  region: WarpRegion,
  matrix: number[],
  paintedVertex: Uint8Array,
): Float32Array {
  const { weldedCount, role, interior } = region;
  const blend = new Float32Array(weldedCount);
  for (let v = 0; v < weldedCount; v++) if (paintedVertex[v]) blend[v] = 1;
  const band = interior.filter((v) => !paintedVertex[v]);
  const inBand = new Uint8Array(weldedCount);
  for (let i = 0; i < band.length; i++) inBand[band[i]] = 1;
  const inner = distancesInto(
    region,
    matrix,
    band,
    inBand,
    (v) => paintedVertex[v] === 1 && role[v] === WarpRole.Interior,
  );
  const outer = distancesInto(region, matrix, band, inBand, (v) => role[v] === WarpRole.Border);
  for (let i = 0; i < band.length; i++) {
    const v = band[i];
    const din = inner[v],
      dout = outer[v];
    // Unreachable paint writes nothing, and band enclosed by paint with no border writes it all.
    // A vertex as near the border as the paint keeps still.
    const t = !(din < Infinity)
      ? 0
      : !(dout < Infinity)
        ? 1
        : din + dout > 0
          ? dout / (din + dout)
          : 0;
    // Written displacement is b × D, and D itself falls about linearly across the band. This step
    // makes that product meet the painted side with matching slope and curvature, and the outer
    // border flat: b(t) = t²(6 − 8t + 3t²), with b′ = 12t(1 − t)².
    blend[v] = Math.min(Math.fround(t * t * (6 - 8 * t + 3 * t * t)), belowOne);
  }
  return blend;
}

/**
 * Surface distances across the band from the `source` vertices beside it. Edge lengths come from
 * transformed local differences, which a large translation cannot erase.
 */
function distancesInto(
  region: WarpRegion,
  m: number[],
  band: Uint32Array,
  inBand: Uint8Array,
  source: (v: number) => boolean,
) {
  const { adjacencyStart, adjacency, rest } = region;
  const dist = new Float64Array(region.weldedCount).fill(Infinity);
  const heap = new DistanceHeap();
  for (let i = 0; i < band.length; i++) {
    const v = band[i];
    for (let e = adjacencyStart[v]; e < adjacencyStart[v + 1]; e++) {
      const u = adjacency[e];
      if (dist[u] !== 0 && !inBand[u] && source(u)) {
        dist[u] = 0;
        heap.push(0, u);
      }
    }
  }
  while (heap.size) {
    const u = heap.pop(),
      d = heap.top;
    if (d > dist[u]) continue;
    for (let e = adjacencyStart[u]; e < adjacencyStart[u + 1]; e++) {
      const w = adjacency[e];
      if (!inBand[w]) continue;
      const x = rest[w * 3] - rest[u * 3],
        y = rest[w * 3 + 1] - rest[u * 3 + 1],
        z = rest[w * 3 + 2] - rest[u * 3 + 2];
      const next =
        d +
        Math.hypot(
          m[0] * x + m[4] * y + m[8] * z,
          m[1] * x + m[5] * y + m[9] * z,
          m[2] * x + m[6] * y + m[10] * z,
        );
      if (next < dist[w]) {
        dist[w] = next;
        heap.push(next, w);
      }
    }
  }
  return dist;
}
