import type { WarpModel } from './warp-model';

/**
 * Grid edges laid on the surface. Between its two nodes each edge passes through points on mesh
 * edges, found by walking the region's triangles along the plane through the edge's chord and
 * the surface normal, so every piece of it lies on the surface. Where that walk fails, the edge
 * follows the region's mesh edges instead, or is not drawn.
 */
export interface WarpGridPath {
  /** Node pairs, two per drawn grid edge. */
  ends: Uint32Array;
  /** Where each grid edge's points begin, with one entry past the last edge. */
  start: Uint32Array;
  /**
   * Geometry vertices at either end of the mesh edge each point lies on, and how far along it.
   * They are corners of the triangle the line enters there, so their normals are that surface's.
   */
  from: Uint32Array;
  to: Uint32Array;
  t: Float32Array;
  /** How far along its grid edge each point lies: 0 at the first node, 1 at the second. */
  along: Float32Array;
  /** World rest length of each grid edge. */
  length: Float32Array;
  /** 1 for each edge along the grid's outline: its fixed border or the part's open edge. */
  outline: Uint8Array;
  /** The geometry vertex holding each node's written position; null until traced. */
  nodeVertex: Uint32Array | null;
  /** Per edge, two geometry vertices whose normals the line takes at its nodes; null until traced. */
  endVertex: Uint32Array | null;
  /**
   * Every point the trace found along each edge, in order and laid out as the kept ones are: what
   * a drawing chooses from again once the surface bends. Null until traced.
   */
  crossings: WarpGridCrossings | null;
  /** Grid edges whose walk across the triangles failed. */
  failed: number;
  /** Of those, edges drawn along mesh edges instead. The rest are not drawn. */
  rerouted: number;
  /** False for chords drawn before a trace is done. */
  traced: boolean;
}

export interface WarpGridCrossings {
  start: Uint32Array;
  from: Uint32Array;
  to: Uint32Array;
  t: Float32Array;
  along: Float32Array;
}

export const warpGridPathLimits = {
  /**
   * Points every edge keeps, evenly spaced: all it crosses, up to this many, while `total` holds
   * them, so a long edge flat at rest follows the surface as soon as it bends. A short edge
   * crosses few.
   */
  perEdge: 256,
  /** Points an edge may keep once chosen again on a bent surface, within the same total. */
  bentPerEdge: 512,
  /** Points kept over the whole grid. Beyond it, every edge's are spaced further apart. */
  total: 32_000,
  /** Triangles a walk may cross before it gives up. */
  steps: 4096,
  /** A walk or a mesh-edge path longer than this many times its chord has lost its way. */
  stray: 3,
  /** Vertices a mesh-edge path may visit. */
  reroute: 32_768,
  /** A point chosen again that bends the line by less than this share of its edge is left out. */
  tolerance: 1e-3,
};

const none = 0xffffffff;

/** Evenly spaced points an edge with `crossings` points keeps: `spacing` apart, or all for 0. */
export const warpGridEvenCount = (
  length: number,
  crossings: number,
  spacing: number,
  limits = warpGridPathLimits,
) =>
  Math.min(
    limits.perEdge,
    crossings,
    spacing > 0 ? Math.max(0, Math.ceil(length / spacing) - 1) : Infinity,
  );

/**
 * How far apart every edge's evenly spaced points are: 0, for all of them, while the total holds
 * them, or else the closest spacing it holds.
 */
export function warpGridEvenSpacing(
  lengths: ArrayLike<number>,
  crossings: (edge: number) => number,
  limits = warpGridPathLimits,
) {
  const needed = (spacing: number) => {
    let count = 0;
    for (let e = 0; e < lengths.length; e++)
      count += warpGridEvenCount(lengths[e], crossings(e), spacing, limits);
    return count;
  };
  if (needed(0) <= limits.total) return 0;
  let low = 0,
    high = 1;
  while (needed(high) > limits.total) high *= 2;
  for (let i = 0; i < 40; i++) {
    const middle = (low + high) / 2;
    if (needed(middle) > limits.total) low = middle;
    else high = middle;
  }
  return high;
}

/**
 * Visits, in order, the points from `begin` to `end` nearest `count` even shares of their edge,
 * by how far along it each lies: all of them when there are no more.
 */
export function warpGridEvenPoints(
  along: ArrayLike<number>,
  begin: number,
  end: number,
  count: number,
  visit: (point: number) => void,
) {
  if (count >= end - begin) {
    for (let i = begin; i < end; i++) visit(i);
    return;
  }
  let last = -1;
  for (let j = 1, i = begin; j <= count; j++) {
    const share = j / (count + 1);
    while (i + 1 < end && along[i + 1] <= share) i++;
    const point = i + 1 < end && along[i + 1] - share < share - along[i] ? i + 1 : i;
    if (point !== last) visit((last = point));
  }
}

/**
 * Lines a node inside the grid draws to its outline at most, and the least angle between any two
 * of its lines for one more to be drawn.
 */
export const warpGridRimLimits = { lines: 4, apart: (40 * Math.PI) / 180 };

/**
 * The grid edges drawn, as node pairs, and which lie along its outline. The grid keeps every
 * vertex of its fixed border and of the part's open edge, so where its inside is sparse against
 * them, a node inside would draw a fan of lines out to dozens of them. Edges between nodes inside,
 * and along the outline, are all drawn; from each node inside, only a few to the outline, each as
 * far as can be from its other lines, shortest first; edges across the inside between two outline
 * nodes, none.
 */
export function warpGridDrawnEdges(model: WarpModel, limits = warpGridRimLimits) {
  const { edgeStart, edges, triangles, fixed } = model.grid;
  const rest = model.restNodes;
  const nodeCount = edgeStart.length - 1;
  // Grid triangles at each edge, to find the outline: edges of one triangle.
  const at = (n: number, m: number) => {
    for (let k = edgeStart[n]; k < edgeStart[n + 1]; k++) if (edges[k] === m) return k;
    return -1;
  };
  const faces = new Uint8Array(edges.length);
  const normal = new Float64Array(nodeCount * 3);
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t],
      b = triangles[t + 1],
      c = triangles[t + 2];
    for (const [n, m] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      for (const k of [at(n, m), at(m, n)]) if (k >= 0 && faces[k] < 255) faces[k]++;
    }
    const ux = rest[b * 3] - rest[a * 3],
      uy = rest[b * 3 + 1] - rest[a * 3 + 1],
      uz = rest[b * 3 + 2] - rest[a * 3 + 2],
      vx = rest[c * 3] - rest[a * 3],
      vy = rest[c * 3 + 1] - rest[a * 3 + 1],
      vz = rest[c * 3 + 2] - rest[a * 3 + 2];
    const x = uy * vz - uz * vy,
      y = uz * vx - ux * vz,
      z = ux * vy - uy * vx;
    for (const n of [a, b, c]) {
      normal[n * 3] += x;
      normal[n * 3 + 1] += y;
      normal[n * 3 + 2] += z;
    }
  }
  const rim = new Uint8Array(nodeCount);
  for (let n = 0; n < nodeCount; n++) {
    if (fixed[n]) rim[n] = 1;
    for (let k = edgeStart[n]; k < edgeStart[n + 1]; k++)
      if (faces[k] === 1) rim[n] = rim[edges[k]] = 1;
  }
  const length = (n: number, m: number) =>
    Math.hypot(
      rest[m * 3] - rest[n * 3],
      rest[m * 3 + 1] - rest[n * 3 + 1],
      rest[m * 3 + 2] - rest[n * 3 + 2],
    );
  // Per node inside, the outline nodes it draws a line to.
  const chosen = new Set<number>();
  const angles: number[] = [],
    candidates: { m: number; angle: number; length: number }[] = [];
  const turn = (a: number, b: number) => {
    const d = Math.abs(a - b) % (2 * Math.PI);
    return Math.min(d, 2 * Math.PI - d);
  };
  for (let n = 0; n < nodeCount; n++) {
    if (rim[n]) continue;
    angles.length = candidates.length = 0;
    // Directions in the plane across the node's normal.
    let nx = normal[n * 3],
      ny = normal[n * 3 + 1],
      nz = normal[n * 3 + 2];
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    const ax = Math.abs(nx) < 0.9 ? 1 : 0,
      ay = ax ? 0 : 1;
    let ux = ay * nz,
      uy = -ax * nz,
      uz = ax * ny - ay * nx;
    const lu = Math.hypot(ux, uy, uz) || 1;
    ux /= lu;
    uy /= lu;
    uz /= lu;
    const vx = ny * uz - nz * uy,
      vy = nz * ux - nx * uz,
      vz = nx * uy - ny * ux;
    for (let k = edgeStart[n]; k < edgeStart[n + 1]; k++) {
      const m = edges[k];
      const dx = rest[m * 3] - rest[n * 3],
        dy = rest[m * 3 + 1] - rest[n * 3 + 1],
        dz = rest[m * 3 + 2] - rest[n * 3 + 2];
      const angle = Math.atan2(dx * vx + dy * vy + dz * vz, dx * ux + dy * uy + dz * uz);
      if (rim[m]) candidates.push({ m, angle, length: length(n, m) });
      else angles.push(angle);
    }
    candidates.sort((p, q) => p.length - q.length);
    for (let drawn = 0; drawn < limits.lines; drawn++) {
      let best = -1,
        widest = -1;
      for (let c = 0; c < candidates.length; c++) {
        if (candidates[c].m < 0) continue;
        let least = Infinity;
        for (const angle of angles) least = Math.min(least, turn(angle, candidates[c].angle));
        if (least > widest) {
          widest = least;
          best = c;
        }
      }
      if (best < 0 || widest < limits.apart) break;
      angles.push(candidates[best].angle);
      chosen.add(n * nodeCount + candidates[best].m);
      candidates[best].m = -1;
    }
  }
  const pairs: number[] = [],
    outline: number[] = [];
  for (let n = 0; n < nodeCount; n++)
    for (let k = edgeStart[n]; k < edgeStart[n + 1]; k++) {
      const m = edges[k];
      if (m <= n) continue;
      const along = faces[k] === 1;
      if (rim[n] && rim[m] && !along) continue;
      if (rim[n] !== rim[m] && !chosen.has(rim[n] ? m * nodeCount + n : n * nodeCount + m))
        continue;
      pairs.push(n, m);
      outline.push(along ? 1 : 0);
    }
  return { ends: Uint32Array.from(pairs), outline: Uint8Array.from(outline) };
}

/** The grid's drawn edges as straight chords: what is drawn until a path is traced. */
export function warpGridChords(model: WarpModel): WarpGridPath {
  const { ends, outline } = warpGridDrawnEdges(model);
  const count = outline.length;
  const length = new Float32Array(count);
  const rest = model.restNodes;
  for (let e = 0; e < count; e++) {
    const n = ends[e * 2],
      m = ends[e * 2 + 1];
    length[e] = Math.hypot(
      rest[m * 3] - rest[n * 3],
      rest[m * 3 + 1] - rest[n * 3 + 1],
      rest[m * 3 + 2] - rest[n * 3 + 2],
    );
  }
  return {
    ends,
    start: new Uint32Array(count + 1),
    from: new Uint32Array(0),
    to: new Uint32Array(0),
    t: new Float32Array(0),
    along: new Float32Array(0),
    length,
    outline,
    nodeVertex: null,
    endVertex: null,
    crossings: null,
    failed: 0,
    rerouted: 0,
    traced: false,
  };
}

/** Grows typed arrays as points are added. */
class Points {
  from = new Uint32Array(1024);
  to = new Uint32Array(1024);
  t = new Float32Array(1024);
  along = new Float32Array(1024);
  size = 0;

  push(from: number, to: number, t: number, along: number) {
    if (this.size === this.from.length) {
      const grow = <T extends Uint32Array | Float32Array | Float64Array>(a: T) => {
        const b = new (a.constructor as new (n: number) => T)(a.length * 2);
        b.set(a);
        return b;
      };
      this.from = grow(this.from);
      this.to = grow(this.to);
      this.t = grow(this.t);
      this.along = grow(this.along);
    }
    const i = this.size++;
    this.from[i] = from;
    this.to[i] = to;
    this.t[i] = t;
    this.along[i] = along;
  }
}

/** A min-heap of vertices by distance, for mesh-edge paths. */
class Heap {
  key = new Float64Array(256);
  value = new Uint32Array(256);
  size = 0;

  push(key: number, value: number) {
    if (this.size === this.key.length) {
      const key = new Float64Array(this.size * 2),
        values = new Uint32Array(this.size * 2);
      key.set(this.key);
      values.set(this.value);
      this.key = key;
      this.value = values;
    }
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.key[parent] <= key) break;
      this.key[i] = this.key[parent];
      this.value[i] = this.value[parent];
      i = parent;
    }
    this.key[i] = key;
    this.value[i] = value;
  }

  /** Removes the nearest entry and returns its vertex; its distance is left in `top`. */
  top = 0;
  pop() {
    const value = this.value[0];
    this.top = this.key[0];
    const last = --this.size;
    const key = this.key[last],
      moved = this.value[last];
    let i = 0;
    for (;;) {
      let child = i * 2 + 1;
      if (child >= last) break;
      if (child + 1 < last && this.key[child + 1] < this.key[child]) child++;
      if (this.key[child] >= key) break;
      this.key[i] = this.key[child];
      this.value[i] = this.value[child];
      i = child;
    }
    this.key[i] = key;
    this.value[i] = moved;
    return value;
  }
}

/**
 * Traces the grid's edges over the surface, a slice at a time: each `next()` does a bounded
 * amount of work, so a caller can spread a large region over several frames.
 */
export function* traceWarpGridPath(
  model: WarpModel,
  limits = warpGridPathLimits,
): Generator<void, WarpGridPath> {
  const chords = warpGridChords(model);
  const { ends, length, outline } = chords;
  const { region, grid, restWorld: p, index } = model;
  const { weldOf, weldedCount, triangles, faces, adjacencyStart, adjacency } = region;
  const slice = 1 << 16;
  const corner = (face: number, k: number) => (index ? index[face * 3 + k] : face * 3 + k);

  // The first geometry vertex of each welded vertex holds its written position.
  const first = new Uint32Array(weldedCount).fill(none);
  for (let g = 0; g < weldOf.length; g++) {
    const w = weldOf[g];
    if (w !== none && first[w] === none) first[w] = g;
    if ((g & (slice - 1)) === slice - 1) yield;
  }

  // Region triangles around each welded vertex, leaving out those with no area.
  const triangleCount = triangles.length / 3;
  const around = new Uint32Array(weldedCount + 1);
  const flat = new Uint8Array(triangleCount);
  for (let t = 0; t < triangleCount; t++) {
    const a = triangles[t * 3] * 3,
      b = triangles[t * 3 + 1] * 3,
      c = triangles[t * 3 + 2] * 3;
    const ux = p[b] - p[a],
      uy = p[b + 1] - p[a + 1],
      uz = p[b + 2] - p[a + 2],
      vx = p[c] - p[a],
      vy = p[c + 1] - p[a + 1],
      vz = p[c + 2] - p[a + 2];
    const cross = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    const longest = Math.max(
      ux * ux + uy * uy + uz * uz,
      vx * vx + vy * vy + vz * vz,
      (vx - ux) ** 2 + (vy - uy) ** 2 + (vz - uz) ** 2,
    );
    if (a === b || b === c || a === c || !(cross > 1e-9 * longest)) flat[t] = 1;
    else for (let k = 0; k < 3; k++) around[triangles[t * 3 + k] + 1]++;
    if ((t & (slice - 1)) === slice - 1) yield;
  }
  for (let v = 0; v < weldedCount; v++) around[v + 1] += around[v];
  const incident = new Uint32Array(around[weldedCount]);
  const fill = around.slice(0, weldedCount);
  for (let t = 0; t < triangleCount; t++) {
    if (!flat[t]) for (let k = 0; k < 3; k++) incident[fill[triangles[t * 3 + k]]++] = t;
    if ((t & (slice - 1)) === slice - 1) yield;
  }

  yield;
  // Area-weighted world normal at each node.
  const nodeCount = grid.nodes.length;
  const normals = new Float64Array(nodeCount * 3);
  for (let n = 0; n < nodeCount; n++) {
    const v = grid.nodes[n];
    let x = 0,
      y = 0,
      z = 0;
    for (let i = around[v]; i < around[v + 1]; i++) {
      const t = incident[i] * 3;
      const a = triangles[t] * 3,
        b = triangles[t + 1] * 3,
        c = triangles[t + 2] * 3;
      const ux = p[b] - p[a],
        uy = p[b + 1] - p[a + 1],
        uz = p[b + 2] - p[a + 2],
        vx = p[c] - p[a],
        vy = p[c + 1] - p[a + 1],
        vz = p[c + 2] - p[a + 2];
      x += uy * vz - uz * vy;
      y += uz * vx - ux * vz;
      z += ux * vy - uy * vx;
    }
    const s = 1 / (Math.hypot(x, y, z) || 1);
    normals[n * 3] = x * s;
    normals[n * 3 + 1] = y * s;
    normals[n * 3 + 2] = z * s;
  }

  yield;
  // One edge's points: mesh edge (as geometry vertices), parameter, world position.
  let cu = new Uint32Array(256),
    cv = new Uint32Array(256),
    ct = new Float64Array(256),
    cp = new Float64Array(256 * 3);
  const grow = <T extends Uint32Array | Float64Array>(a: T, n: number) => {
    const b = new (a.constructor as new (n: number) => T)(n);
    b.set(a);
    return b;
  };
  const room = (count: number) => {
    if (count < cu.length) return;
    cu = grow(cu, count * 2);
    cv = grow(cv, count * 2);
    ct = grow(ct, count * 2);
    cp = grow(cp, count * 6);
  };
  // Geometry vertices for the line's normal at each node of the edge being traced.
  let startCopy = none,
    endCopy = none;
  let arc = new Float64Array(256);

  const contains = (t: number, v: number) =>
    triangles[t * 3] === v || triangles[t * 3 + 1] === v || triangles[t * 3 + 2] === v;
  /** The geometry vertex of welded `v` in region triangle `t`. */
  const copyOf = (t: number, v: number) => {
    for (let k = 0; k < 3; k++) if (triangles[t * 3 + k] === v) return corner(faces[t], k);
    return first[v];
  };
  /** Unit geometric normal of region triangle `t` into `out`. */
  const faceNormal = (t: number, out: Float64Array) => {
    const a = triangles[t * 3] * 3,
      b = triangles[t * 3 + 1] * 3,
      c = triangles[t * 3 + 2] * 3;
    const ux = p[b] - p[a],
      uy = p[b + 1] - p[a + 1],
      uz = p[b + 2] - p[a + 2],
      vx = p[c] - p[a],
      vy = p[c + 1] - p[a + 1],
      vz = p[c + 2] - p[a + 2];
    const x = uy * vz - uz * vy,
      y = uz * vx - ux * vz,
      z = ux * vy - uy * vx;
    const s = 1 / (Math.hypot(x, y, z) || 1);
    out[0] = x * s;
    out[1] = y * s;
    out[2] = z * s;
  };
  const here = new Float64Array(3),
    there = new Float64Array(3);

  /**
   * Points from node a to node b by walking triangles; 0 when they share one, -1 on failure. The
   * cutting plane holds the nodes' averaged normal, or node `own`'s.
   */
  const walk = (na: number, nb: number, own = -1) => {
    const a = grid.nodes[na],
      b = grid.nodes[nb];
    for (let i = around[a]; i < around[a + 1]; i++)
      if (contains(incident[i], b)) {
        startCopy = copyOf(incident[i], a);
        endCopy = copyOf(incident[i], b);
        return 0;
      }
    const ax = p[a * 3],
      ay = p[a * 3 + 1],
      az = p[a * 3 + 2];
    const dx = p[b * 3] - ax,
      dy = p[b * 3 + 1] - ay,
      dz = p[b * 3 + 2] - az;
    const l2 = dx * dx + dy * dy + dz * dz;
    if (!(l2 > 0)) return -1;
    let nx = normals[na * 3] + normals[nb * 3],
      ny = normals[na * 3 + 1] + normals[nb * 3 + 1],
      nz = normals[na * 3 + 2] + normals[nb * 3 + 2];
    if (own >= 0 || nx * nx + ny * ny + nz * nz < 1e-6) {
      const n = own >= 0 ? own : na;
      nx = normals[n * 3];
      ny = normals[n * 3 + 1];
      nz = normals[n * 3 + 2];
    }
    // The cutting plane holds the chord and the surface normal.
    let px = dy * nz - dz * ny,
      py = dz * nx - dx * nz,
      pz = dx * ny - dy * nx;
    const pl = Math.hypot(px, py, pz);
    if (!(pl > 1e-12 * l2)) return -1;
    px /= pl;
    py /= pl;
    pz /= pl;
    const side = (v: number) =>
      (p[v * 3] - ax) * px + (p[v * 3 + 1] - ay) * py + (p[v * 3 + 2] - az) * pz;

    // Leave a through the edge of its fan that the plane crosses toward b.
    let u = none,
      v = none,
      from = none,
      best = 0;
    for (let i = around[a]; i < around[a + 1]; i++) {
      const t = incident[i];
      let s = none,
        r = none;
      for (let k = 0; k < 3; k++) {
        const w = triangles[t * 3 + k];
        if (w === a) continue;
        if (s === none) s = w;
        else r = w;
      }
      const ss = side(s),
        sr = side(r);
      if (ss > 0 === sr > 0) continue;
      const f = ss / (ss - sr);
      const x = p[s * 3] + f * (p[r * 3] - p[s * 3]) - ax,
        y = p[s * 3 + 1] + f * (p[r * 3 + 1] - p[s * 3 + 1]) - ay,
        z = p[s * 3 + 2] + f * (p[r * 3 + 2] - p[s * 3 + 2]) - az;
      const toward = (x * dx + y * dy + z * dz) / (Math.hypot(x, y, z) || 1);
      if (toward > best) {
        best = toward;
        u = s;
        v = r;
        from = t;
      }
    }
    if (from === none) return -1;
    startCopy = copyOf(from, a);

    const length = Math.sqrt(l2);
    let travelled = 0,
      lx = ax,
      ly = ay,
      lz = az;
    for (let count = 0; count < limits.steps; count++) {
      const su = side(u),
        sv = side(v);
      const f = su / (su - sv);
      const x = p[u * 3] + f * (p[v * 3] - p[u * 3]),
        y = p[u * 3 + 1] + f * (p[v * 3 + 1] - p[u * 3 + 1]),
        z = p[u * 3 + 2] + f * (p[v * 3 + 2] - p[u * 3 + 2]);
      // A walk that strays well off the chord, or goes much further than it, has lost its way.
      const along = ((x - ax) * dx + (y - ay) * dy + (z - az) * dz) / length;
      const ox = x - ax - (along * dx) / length,
        oy = y - ay - (along * dy) / length,
        oz = z - az - (along * dz) / length;
      if (along < -0.25 * length || along > 1.25 * length || ox * ox + oy * oy + oz * oz > l2)
        return -1;
      travelled += Math.hypot(x - lx, y - ly, z - lz);
      if (travelled > limits.stray * length) return -1;
      lx = x;
      ly = y;
      lz = z;

      // Cross into the triangle on the other side of u–v that carries on the sheet: where the
      // mesh is not a manifold, the one that turns least from this one.
      let next = none;
      faceNormal(from, here);
      let straightest = -Infinity;
      for (let i = around[u]; i < around[u + 1]; i++) {
        const t = incident[i];
        if (t === from || !contains(t, v)) continue;
        faceNormal(t, there);
        const turn = here[0] * there[0] + here[1] * there[1] + here[2] * there[2];
        if (turn > straightest) {
          straightest = turn;
          next = t;
        }
      }
      if (next === none) return -1;
      room(count);
      cu[count] = copyOf(next, u);
      cv[count] = copyOf(next, v);
      ct[count] = f;
      cp[count * 3] = x;
      cp[count * 3 + 1] = y;
      cp[count * 3 + 2] = z;
      let w = none;
      for (let k = 0; k < 3; k++) {
        const c = triangles[next * 3 + k];
        if (c !== u && c !== v) w = c;
      }
      if (w === b) {
        endCopy = copyOf(next, b);
        return count + 1;
      }
      if (side(w) > 0 === su > 0) u = w;
      else v = w;
      from = next;
    }
    return -1;
  };

  // Mesh-edge paths, for edges whose walk fails.
  const distance = new Float64Array(weldedCount),
    previous = new Uint32Array(weldedCount),
    visited = new Uint32Array(weldedCount);
  let stamp = 0;
  const heap = new Heap();
  /** Points along the shortest bounded path over mesh edges from node a to node b, or -1. */
  const reroute = (na: number, nb: number) => {
    const a = grid.nodes[na],
      b = grid.nodes[nb];
    const bound = limits.stray * length[e];
    stamp++;
    heap.size = 0;
    distance[a] = 0;
    previous[a] = none;
    visited[a] = stamp;
    const bx = p[b * 3],
      by = p[b * 3 + 1],
      bz = p[b * 3 + 2];
    // A*: ordered by distance so far plus the straight distance left, which never overestimates.
    const left = (v: number) => Math.hypot(p[v * 3] - bx, p[v * 3 + 1] - by, p[v * 3 + 2] - bz);
    heap.push(left(a), a);
    let reached = false,
      seen = 0;
    while (heap.size) {
      const v = heap.pop();
      if (heap.top > distance[v] + left(v) + 1e-12) continue;
      if (v === b) {
        reached = true;
        break;
      }
      if (++seen > limits.reroute) break;
      for (let k = adjacencyStart[v]; k < adjacencyStart[v + 1]; k++) {
        const w = adjacency[k];
        const d =
          distance[v] +
          Math.hypot(p[w * 3] - p[v * 3], p[w * 3 + 1] - p[v * 3 + 1], p[w * 3 + 2] - p[v * 3 + 2]);
        if (visited[w] === stamp && d >= distance[w]) continue;
        const estimate = d + left(w);
        if (estimate > bound) continue;
        visited[w] = stamp;
        distance[w] = d;
        previous[w] = v;
        heap.push(estimate, w);
      }
    }
    work += seen;
    if (!reached) return -1;
    let count = 0;
    for (let v = previous[b]; v !== a; v = previous[v]) count++;
    room(count);
    let i = count;
    for (let v = previous[b]; v !== a; v = previous[v]) {
      i--;
      cu[i] = cv[i] = first[v];
      ct[i] = 0;
      cp[i * 3] = p[v * 3];
      cp[i * 3 + 1] = p[v * 3 + 1];
      cp[i * 3 + 2] = p[v * 3 + 2];
    }
    startCopy = first[a];
    endCopy = first[b];
    return count;
  };

  const every = new Points();
  const edgeCount = ends.length / 2;
  const everyCounts = new Uint32Array(edgeCount),
    drawn = new Uint8Array(edgeCount),
    endVertex = new Uint32Array(edgeCount * 2);
  let failed = 0,
    rerouted = 0,
    work = 0,
    e = 0;
  for (e = 0; e < edgeCount; e++) {
    const na = ends[e * 2],
      nb = ends[e * 2 + 1];
    // A walk can find its way from one end and not the other, or by one node's normal alone.
    let m = walk(na, nb);
    if (m < 0) m = walk(na, nb, na);
    if (m < 0) m = walk(na, nb, nb);
    if (m < 0) {
      m = walk(nb, na);
      if (m < 0) m = walk(nb, na, nb);
      if (m < 0) m = walk(nb, na, na);
      if (m > 0) {
        for (let i = 0, j = m - 1; i < j; i++, j--) {
          [cu[i], cu[j]] = [cu[j], cu[i]];
          [cv[i], cv[j]] = [cv[j], cv[i]];
          [ct[i], ct[j]] = [ct[j], ct[i]];
          for (let axis = 0; axis < 3; axis++)
            [cp[i * 3 + axis], cp[j * 3 + axis]] = [cp[j * 3 + axis], cp[i * 3 + axis]];
        }
      }
      if (m >= 0) [startCopy, endCopy] = [endCopy, startCopy];
    }
    if (m < 0) {
      failed++;
      m = reroute(na, nb);
      if (m >= 0) rerouted++;
    }
    work += 64;
    if (m < 0) continue;
    drawn[e] = 1;
    endVertex[e * 2] = startCopy;
    endVertex[e * 2 + 1] = endCopy;
    if (m > 0) {
      const a = grid.nodes[na] * 3,
        b = grid.nodes[nb] * 3;
      const position = (k: number, axis: number) =>
        k < 0 ? p[a + axis] : k >= m ? p[b + axis] : cp[k * 3 + axis];
      // Arc length along the whole path, for each point.
      if (arc.length <= m) arc = new Float64Array(m * 2 + 2);
      let total = 0;
      for (let k = 0; k <= m; k++) {
        total += Math.hypot(
          position(k, 0) - position(k - 1, 0),
          position(k, 1) - position(k - 1, 1),
          position(k, 2) - position(k - 1, 2),
        );
        arc[k] = total;
      }
      for (let k = 0; k < m; k++) every.push(cu[k], cv[k], ct[k], arc[k] / total);
      everyCounts[e] = m;
      work += m;
    }
    if (work > 4096) {
      work = 0;
      yield;
    }
  }

  // Every point each edge crosses, or where the total cannot hold them, evenly spaced ones.
  const spacing = warpGridEvenSpacing(length, (e) => everyCounts[e], limits);
  const kept = new Points();
  let drawnCount = 0;
  for (let i = 0; i < edgeCount; i++) drawnCount += drawn[i];
  const outEnds = new Uint32Array(drawnCount * 2),
    outLength = new Float32Array(drawnCount),
    outOutline = new Uint8Array(drawnCount),
    outEndVertex = new Uint32Array(drawnCount * 2),
    start = new Uint32Array(drawnCount + 1);
  const crossings: WarpGridCrossings = {
    start: new Uint32Array(drawnCount + 1),
    from: every.from.slice(0, every.size),
    to: every.to.slice(0, every.size),
    t: every.t.slice(0, every.size),
    along: every.along.slice(0, every.size),
  };
  const keep = (i: number) => kept.push(every.from[i], every.to[i], every.t[i], every.along[i]);
  for (let e = 0, d = 0, c = 0; e < edgeCount; e++) {
    if (!drawn[e]) continue;
    crossings.start[d] = c;
    const count = warpGridEvenCount(length[e], everyCounts[e], spacing, limits);
    warpGridEvenPoints(every.along, c, c + everyCounts[e], count, keep);
    c += everyCounts[e];
    crossings.start[d + 1] = c;
    outEnds[d * 2] = ends[e * 2];
    outEnds[d * 2 + 1] = ends[e * 2 + 1];
    outEndVertex[d * 2] = endVertex[e * 2];
    outEndVertex[d * 2 + 1] = endVertex[e * 2 + 1];
    outLength[d] = length[e];
    outOutline[d] = outline[e];
    start[++d] = kept.size;
  }
  const nodeVertex = new Uint32Array(nodeCount);
  for (let n = 0; n < nodeCount; n++) nodeVertex[n] = first[grid.nodes[n]];
  return {
    ends: outEnds,
    start,
    from: kept.from.slice(0, kept.size),
    to: kept.to.slice(0, kept.size),
    t: kept.t.slice(0, kept.size),
    along: kept.along.slice(0, kept.size),
    length: outLength,
    outline: outOutline,
    nodeVertex,
    endVertex: outEndVertex,
    crossings,
    failed,
    rerouted,
    traced: true,
  };
}

/** Runs a trace to the end at once. */
export function traceWarpGridPathNow(model: WarpModel, limits = warpGridPathLimits) {
  const trace = traceWarpGridPath(model, limits);
  for (;;) {
    const step = trace.next();
    if (step.done) return step.value;
  }
}

/** Segments one path draws: one more per edge than it has points. */
export const warpGridSegments = (path: WarpGridPath) => path.ends.length / 2 + path.from.length;

/**
 * Writes the path as segment pairs, six floats each, in the part's local space. `nodes` are
 * local node positions; `written` the surface the preview holds. `shift`, when given, is how far
 * each node has moved since the surface was written, carried to the points between them.
 */
export function writeWarpGridPath(
  path: Pick<WarpGridPath, 'ends' | 'start' | 'from' | 'to' | 't' | 'along'>,
  nodes: ArrayLike<number>,
  written: ArrayLike<number>,
  shift: ArrayLike<number> | null,
  out: Float32Array,
) {
  const { ends, start, from, to, t, along } = path;
  let o = 0;
  for (let e = 0; e < ends.length / 2; e++) {
    const a = ends[e * 2] * 3,
      b = ends[e * 2 + 1] * 3;
    let x = nodes[a],
      y = nodes[a + 1],
      z = nodes[a + 2];
    for (let i = start[e]; i < start[e + 1]; i++) {
      const f = from[i] * 3,
        g = to[i] * 3,
        s = t[i];
      let nx = written[f] + s * (written[g] - written[f]),
        ny = written[f + 1] + s * (written[g + 1] - written[f + 1]),
        nz = written[f + 2] + s * (written[g + 2] - written[f + 2]);
      if (shift) {
        const w = along[i];
        nx += shift[a] + w * (shift[b] - shift[a]);
        ny += shift[a + 1] + w * (shift[b + 1] - shift[a + 1]);
        nz += shift[a + 2] + w * (shift[b + 2] - shift[a + 2]);
      }
      out[o] = x;
      out[o + 1] = y;
      out[o + 2] = z;
      out[o + 3] = x = nx;
      out[o + 4] = y = ny;
      out[o + 5] = z = nz;
      o += 6;
    }
    out[o] = x;
    out[o + 1] = y;
    out[o + 2] = z;
    out[o + 3] = nodes[b];
    out[o + 4] = nodes[b + 1];
    out[o + 5] = nodes[b + 2];
    o += 6;
  }
}

/**
 * Writes, per segment, the two nodes of its grid edge and how far along the edge each of its
 * ends lies, four floats each: what carries a move of the nodes to the points between them.
 */
export function writeWarpGridWeights(
  path: Pick<WarpGridPath, 'ends' | 'start' | 'along'>,
  out: Float32Array,
) {
  const { ends, start, along } = path;
  let o = 0;
  for (let e = 0; e < ends.length / 2; e++) {
    let w = 0;
    for (let i = start[e]; i <= start[e + 1]; i++) {
      const next = i < start[e + 1] ? along[i] : 1;
      out[o] = ends[e * 2];
      out[o + 1] = ends[e * 2 + 1];
      out[o + 2] = w;
      out[o + 3] = w = next;
      o += 4;
    }
  }
}

/**
 * Writes the written surface's normal at each end of each segment, laid out as the segments
 * are. Leaves `out` alone for a path that is not yet traced.
 */
export function writeWarpGridNormals(
  path: Pick<WarpGridPath, 'ends' | 'start' | 'from' | 'to' | 't' | 'endVertex'>,
  normals: ArrayLike<number>,
  out: Float32Array,
) {
  const { ends, start, from, to, t, endVertex } = path;
  if (!endVertex) return;
  let o = 0;
  for (let e = 0; e < ends.length / 2; e++) {
    const a = endVertex[e * 2] * 3,
      b = endVertex[e * 2 + 1] * 3;
    let x = normals[a],
      y = normals[a + 1],
      z = normals[a + 2];
    for (let i = start[e]; i < start[e + 1]; i++) {
      const f = from[i] * 3,
        g = to[i] * 3,
        s = t[i];
      out[o] = x;
      out[o + 1] = y;
      out[o + 2] = z;
      out[o + 3] = x = normals[f] + s * (normals[g] - normals[f]);
      out[o + 4] = y = normals[f + 1] + s * (normals[g + 1] - normals[f + 1]);
      out[o + 5] = z = normals[f + 2] + s * (normals[g + 2] - normals[f + 2]);
      o += 6;
    }
    out[o] = x;
    out[o + 1] = y;
    out[o + 2] = z;
    out[o + 3] = normals[b];
    out[o + 4] = normals[b + 1];
    out[o + 5] = normals[b + 2];
    o += 6;
  }
}

/** Shifts smaller than this, in mm, are rounding: the shader need not read any. */
export const warpGridShiftFloor = 1e-5;

/** Nodes per row of the texture that carries their shifts to the GPU. */
export const warpGridShiftWidth = 1024;

/**
 * Coarser nets of the grid's own edges, drawn at full strength while the grid's own cells are too
 * small on screen to show: `levels` at most, each kept only while it has `sites` nodes or more.
 */
export const warpGridLevelLimits = { levels: 3, sites: 8 };

/** The middle of a grid's edge lengths. */
export function typicalLength(lengths: ArrayLike<number>) {
  const sorted = Float64Array.from(lengths).sort();
  return sorted[sorted.length >> 1] || 1;
}

/**
 * A path's typical cell: the middle of its edges' lengths, leaving out its outline, which keeps
 * every border vertex and so runs at the mesh's own resolution.
 */
export function warpGridCell(path: Pick<WarpGridPath, 'length' | 'outline'>) {
  const inside = path.length.filter((_, e) => !path.outline[e]);
  return typicalLength(inside.length ? inside : path.length);
}

/**
 * Per drawn edge, the coarsest level whose net holds it: 0 for the grid alone. Level k picks
 * nodes of level k - 1's net about 2^k typical edges apart along it, gives each of its nodes to
 * the nearest, and joins each two whose shares meet by the shortest way along it through the two.
 * Each level is so a connected net of real grid edges, within the level below, with cells about
 * 2^k times as large.
 */
export function warpGridLevels(
  path: WarpGridPath,
  nodeCount: number,
  limits = warpGridLevelLimits,
) {
  const { ends, length } = path;
  const edgeCount = ends.length / 2;
  const levels = new Uint8Array(edgeCount);
  if (!edgeCount) return levels;
  // Edges at each node.
  const at = new Uint32Array(nodeCount + 1);
  for (let i = 0; i < ends.length; i++) at[ends[i] + 1]++;
  for (let n = 0; n < nodeCount; n++) at[n + 1] += at[n];
  const incident = new Uint32Array(ends.length),
    fill = at.slice(0, nodeCount);
  for (let e = 0; e < edgeCount; e++) {
    incident[fill[ends[e * 2]]++] = e;
    incident[fill[ends[e * 2 + 1]]++] = e;
  }
  const cell = warpGridCell(path);
  const distance = new Float64Array(nodeCount),
    near = new Float64Array(nodeCount),
    owner = new Int32Array(nodeCount),
    via = new Int32Array(nodeCount);
  const heap = new Heap();
  // Edges of the net being refined: those of the level below.
  let floor = 0;
  /** Grows shortest paths from the queued nodes, no further than `bound`. */
  const grow = (into: Float64Array, bound: number, owned: boolean) => {
    while (heap.size) {
      const n = heap.pop();
      if (heap.top > into[n]) continue;
      for (let k = at[n]; k < at[n + 1]; k++) {
        const e = incident[k];
        if (levels[e] < floor) continue;
        const m = ends[e * 2] === n ? ends[e * 2 + 1] : ends[e * 2];
        const d = into[n] + length[e];
        if (d >= into[m] || d >= bound) continue;
        into[m] = d;
        if (owned) {
          owner[m] = owner[n];
          via[m] = e;
        }
        heap.push(d, m);
      }
    }
  };
  const onNet = (n: number) => {
    for (let k = at[n]; k < at[n + 1]; k++) if (levels[incident[k]] >= floor) return true;
    return false;
  };
  for (let level = 1; level <= limits.levels; level++) {
    floor = level - 1;
    const spacing = cell * 2 ** level;
    // Nodes at least the spacing apart along the net, taken in order.
    near.fill(Infinity);
    const sites: number[] = [];
    for (let n = 0; n < nodeCount; n++) {
      if (near[n] < spacing || !onNet(n)) continue;
      sites.push(n);
      near[n] = 0;
      heap.size = 0;
      heap.push(0, n);
      grow(near, spacing, false);
    }
    if (sites.length < limits.sites) break;
    // Each node's nearest site, and the edge it is reached by.
    distance.fill(Infinity);
    owner.fill(-1);
    via.fill(-1);
    heap.size = 0;
    for (const n of sites) {
      distance[n] = 0;
      owner[n] = n;
      heap.push(0, n);
    }
    grow(distance, Infinity, true);
    // The shortest way between each two sites whose shares meet.
    const best = new Map<number, number>();
    for (let e = 0; e < edgeCount; e++) {
      const a = owner[ends[e * 2]],
        b = owner[ends[e * 2 + 1]];
      if (levels[e] < floor || a < 0 || b < 0 || a === b) continue;
      const key = Math.min(a, b) * nodeCount + Math.max(a, b);
      const cost = distance[ends[e * 2]] + length[e] + distance[ends[e * 2 + 1]];
      const held = best.get(key);
      if (held === undefined) best.set(key, e);
      else {
        const was = distance[ends[held * 2]] + length[held] + distance[ends[held * 2 + 1]];
        if (cost < was) best.set(key, e);
      }
    }
    for (const e of best.values()) {
      levels[e] = level;
      for (const end of [ends[e * 2], ends[e * 2 + 1]])
        for (let n = end; via[n] >= 0;) {
          const step = via[n];
          levels[step] = level;
          n = ends[step * 2] === n ? ends[step * 2 + 1] : ends[step * 2];
        }
    }
  }
  return levels;
}

/**
 * Grid edges with the points drawn along each, laid out as a path's, and per point how far it
 * bent the line when it was chosen: a point that bends it by less than the detail a view can show
 * is left out of that view.
 */
type WarpGridSelection = Pick<
  WarpGridPath,
  'ends' | 'start' | 'from' | 'to' | 't' | 'along' | 'endVertex'
> & { bend: Float32Array };

/**
 * What the GPU draws for a path, in the part's local space. Segment ends sit on the surface as it
 * was last written; between writes only the nodes' shifts change, and the vertex shader carries
 * them along each edge. `atWrite` is where the nodes were when the surface was written: read from
 * the written surface itself for a traced path, so a path that replaces another part way through
 * a drag starts from that same surface.
 *
 * Edges are drawn coarsest level first, so drawing the first `levelEnd[k]` segments draws every
 * edge of level k and coarser. Which of an edge's points are drawn is first the trace's choice;
 * where `straying` finds the line off the surface as written, `refine` chooses again on it, and
 * `detail` leaves out those that bend the line by less than a view can show.
 */
export class WarpGridDrawing {
  /** Segments drawn now. */
  segments = 0;
  /** Segments the buffers hold room for. */
  readonly capacity: number;
  /** Segment ends on the written surface, six floats each. */
  readonly base: Float32Array;
  /** Per segment: its edge's two nodes and how far along it each end lies. */
  readonly weights: Float32Array;
  /** The written surface's normal at each segment end, six floats each. */
  readonly normals: Float32Array;
  /** Per segment, its cells' size against the grid's own: 2^level. */
  readonly cells: Float32Array;
  /** Per segment, the path's edge it draws. */
  readonly edgeOf: Uint32Array;
  /** Per level, the segments of its edges and every coarser level's, which come first. */
  readonly levelEnd: Uint32Array;
  /** Per node, how far it has moved since the surface was written, as RGBA texels. */
  readonly shifts: Float32Array;
  readonly atWrite: Float32Array;
  /** Whether any node has moved since the surface was written. */
  shifted = false;
  /**
   * The surface version last written, and the last one the drawn points were checked against
   * and, if they strayed from it, chosen again on.
   */
  written = Number.NaN;
  refined = Number.NaN;
  /** How many times points chosen again have been drawn. */
  adopted = 0;
  /** Path edges in drawing order, and each one's level. */
  readonly order: Uint32Array;
  readonly levels: Uint8Array;
  /** The points chosen, and of them the ones drawn at the present detail. */
  private chosen: WarpGridSelection;
  private selection: WarpGridSelection;
  /** The detail drawn: points that bend the line by less are left out. */
  shown = 0;

  constructor(
    readonly path: WarpGridPath,
    nodeCount: number,
    levels: Uint8Array | null = null,
    limits = warpGridPathLimits,
  ) {
    const edgeCount = path.ends.length / 2;
    this.levels = levels ?? new Uint8Array(edgeCount);
    const top = this.levels.reduce((a, b) => Math.max(a, b), 0);
    this.order = new Uint32Array(edgeCount);
    for (let level = top, o = 0; level >= 0; level--)
      for (let e = 0; e < edgeCount; e++) if (this.levels[e] === level) this.order[o++] = e;
    this.levelEnd = new Uint32Array(top + 1);
    const chosen = path.crossings
      ? Math.max(path.from.length, Math.min(limits.total, path.crossings.from.length))
      : path.from.length;
    this.capacity = edgeCount + chosen;
    this.base = new Float32Array(this.capacity * 6);
    this.weights = new Float32Array(this.capacity * 4);
    this.normals = new Float32Array(this.capacity * 6);
    this.cells = new Float32Array(this.capacity);
    this.edgeOf = new Uint32Array(this.capacity);
    this.atWrite = new Float32Array(nodeCount * 3);
    const rows = Math.max(1, Math.ceil(nodeCount / warpGridShiftWidth));
    this.shifts = new Float32Array(rows * warpGridShiftWidth * 4);
    // The trace's own choice, in drawing order.
    const start = new Uint32Array(edgeCount + 1);
    for (let o = 0; o < edgeCount; o++) {
      const e = this.order[o];
      start[o + 1] = start[o] + path.start[e + 1] - path.start[e];
    }
    const pick = new Uint32Array(path.from.length);
    for (let o = 0; o < edgeCount; o++) {
      const e = this.order[o];
      for (let k = 0; k < start[o + 1] - start[o]; k++) pick[start[o] + k] = path.start[e] + k;
    }
    this.chosen = this.ordered(start, pick, path, null);
    this.selection = this.chosen;
    this.lay();
  }

  /** A selection in drawing order from point indices into `source`, `start` per drawn edge. */
  private ordered(
    start: Uint32Array,
    pick: Uint32Array,
    source: Pick<WarpGridPath, 'from' | 'to' | 't' | 'along'>,
    bends: Float64Array | null,
  ): WarpGridSelection {
    const { path, order } = this;
    const edgeCount = order.length;
    const ends = new Uint32Array(edgeCount * 2),
      endVertex = path.endVertex ? new Uint32Array(edgeCount * 2) : null;
    for (let o = 0; o < edgeCount; o++) {
      const e = order[o];
      ends[o * 2] = path.ends[e * 2];
      ends[o * 2 + 1] = path.ends[e * 2 + 1];
      if (endVertex) {
        endVertex[o * 2] = path.endVertex![e * 2];
        endVertex[o * 2 + 1] = path.endVertex![e * 2 + 1];
      }
    }
    const from = new Uint32Array(pick.length),
      to = new Uint32Array(pick.length),
      t = new Float32Array(pick.length),
      along = new Float32Array(pick.length),
      bend = new Float32Array(pick.length).fill(Infinity);
    for (let i = 0; i < pick.length; i++) {
      from[i] = source.from[pick[i]];
      to[i] = source.to[pick[i]];
      t[i] = source.t[pick[i]];
      along[i] = source.along[pick[i]];
      if (bends) bend[i] = bends[pick[i]];
    }
    return { ends, start, from, to, t, along, endVertex, bend };
  }

  /** The chosen points that bend the line by at least the present detail. */
  private filtered() {
    const { chosen, shown } = this;
    if (!(shown > 0)) return chosen;
    const edgeCount = chosen.start.length - 1;
    const start = new Uint32Array(edgeCount + 1);
    let kept = 0;
    for (let i = 0; i < chosen.bend.length; i++) if (chosen.bend[i] >= shown) kept++;
    const from = new Uint32Array(kept),
      to = new Uint32Array(kept),
      t = new Float32Array(kept),
      along = new Float32Array(kept),
      bend = new Float32Array(kept);
    for (let o = 0, k = 0; o < edgeCount; o++) {
      for (let i = chosen.start[o]; i < chosen.start[o + 1]; i++)
        if (chosen.bend[i] >= shown) {
          from[k] = chosen.from[i];
          to[k] = chosen.to[i];
          t[k] = chosen.t[i];
          along[k] = chosen.along[i];
          bend[k++] = chosen.bend[i];
        }
      start[o + 1] = k;
    }
    return { ends: chosen.ends, endVertex: chosen.endVertex, start, from, to, t, along, bend };
  }

  /**
   * Draws only the chosen points that bend the line by `detail` or more, in the part's space, on
   * the surface last written, which `written` and `normals` must hold. Returns which buffers
   * changed.
   */
  detail(detail: number, written: ArrayLike<number>, normals: ArrayLike<number> | null) {
    const changed = { base: false, normals: false, shifts: false, layout: false };
    if (detail === this.shown) return changed;
    this.shown = detail;
    const selection = this.filtered();
    if (selection.from.length === this.selection.from.length) {
      this.selection = selection;
      return changed;
    }
    this.selection = selection;
    this.lay();
    if (this.written === this.written) this.write(written, normals, changed);
    changed.layout = true;
    return changed;
  }

  /** Lays out the per-segment buffers that depend on the selection alone. */
  private lay() {
    const { selection, order, levels } = this;
    this.segments = order.length + selection.from.length;
    writeWarpGridWeights(selection, this.weights);
    this.levelEnd.fill(0);
    for (let o = 0, s = 0; o < order.length; o++) {
      const e = order[o],
        level = levels[e];
      for (let k = selection.start[o]; k <= selection.start[o + 1]; k++, s++) {
        this.edgeOf[s] = e;
        this.cells[s] = 2 ** level;
      }
      for (let l = 0; l <= level; l++) this.levelEnd[l] = s;
    }
  }

  /**
   * Brings the buffers up to date with `nodes`, local node positions, and the surface written at
   * `version`. Returns which buffers changed.
   */
  update(
    nodes: ArrayLike<number>,
    written: ArrayLike<number>,
    normals: ArrayLike<number> | null,
    version: number,
  ) {
    const { path, atWrite, shifts } = this;
    const changed = { base: false, normals: false, shifts: false, layout: false };
    if (version !== this.written) {
      this.written = version;
      const { nodeVertex } = path;
      if (nodeVertex)
        for (let n = 0; n < nodeVertex.length; n++)
          for (let a = 0; a < 3; a++) atWrite[n * 3 + a] = written[nodeVertex[n] * 3 + a];
      else for (let i = 0; i < atWrite.length; i++) atWrite[i] = nodes[i];
      this.write(written, normals, changed);
    }
    let shifted = false;
    for (let n = 0; n < atWrite.length / 3; n++)
      for (let a = 0; a < 3; a++) {
        const shift = Math.fround(nodes[n * 3 + a] - atWrite[n * 3 + a]);
        if (Math.abs(shift) > warpGridShiftFloor) shifted = true;
        if (shifts[n * 4 + a] !== shift) {
          shifts[n * 4 + a] = shift;
          changed.shifts = true;
        }
      }
    this.shifted = shifted;
    return changed;
  }

  private write(
    written: ArrayLike<number>,
    normals: ArrayLike<number> | null,
    changed: { base: boolean; normals: boolean },
  ) {
    writeWarpGridPath(this.selection, this.atWrite, written, null, this.base);
    changed.base = true;
    if (normals && this.selection.endVertex) {
      writeWarpGridNormals(this.selection, normals, this.normals);
      changed.normals = true;
    }
  }

  /**
   * The furthest any point the trace found lies from the line drawn through it, on the surface
   * written last, which `written` must hold: how far the line strays from it. A slice at a time.
   */
  *straying(written: ArrayLike<number>): Generator<void, number> {
    const { path, atWrite, order, selection } = this;
    const crossings = path.crossings;
    if (!crossings) return 0;
    const at = (f: number, g: number, s: number, out: Float64Array) => {
      for (let a = 0; a < 3; a++) out[a] = written[f + a] + s * (written[g + a] - written[f + a]);
    };
    const from = new Float64Array(3),
      to = new Float64Array(3),
      point = new Float64Array(3);
    let worst = 0,
      work = 0;
    for (let o = 0; o < order.length; o++) {
      const e = order[o];
      const b = path.ends[e * 2 + 1] * 3;
      for (let a = 0; a < 3; a++) from[a] = atWrite[path.ends[e * 2] * 3 + a];
      let k = selection.start[o];
      const end = selection.start[o + 1];
      /** The far end of the drawn segment from `from`, and how far along the edge it lies. */
      const reach = () => {
        if (k < end) at(selection.from[k] * 3, selection.to[k] * 3, selection.t[k], to);
        else for (let a = 0; a < 3; a++) to[a] = atWrite[b + a];
        return k < end ? selection.along[k] : 1;
      };
      let ahead = reach();
      for (let i = crossings.start[e]; i < crossings.start[e + 1]; i++) {
        while (k < end && crossings.along[i] >= ahead) {
          from.set(to);
          k++;
          ahead = reach();
        }
        at(crossings.from[i] * 3, crossings.to[i] * 3, crossings.t[i], point);
        const lx = to[0] - from[0],
          ly = to[1] - from[1],
          lz = to[2] - from[2],
          qx = point[0] - from[0],
          qy = point[1] - from[1],
          qz = point[2] - from[2];
        const ll = lx * lx + ly * ly + lz * lz;
        const f = ll > 0 ? Math.min(1, Math.max(0, (qx * lx + qy * ly + qz * lz) / ll)) : 0;
        worst = Math.max(worst, Math.hypot(qx - f * lx, qy - f * ly, qz - f * lz));
      }
      work += crossings.start[e + 1] - crossings.start[e] + 1;
      if (work > 0xffff) {
        work = 0;
        yield;
      }
    }
    return worst;
  }

  /**
   * Chooses the points drawn along each edge again, on the surface written last, a slice at a
   * time: each edge first keeps evenly spaced points within half the budget, so it can follow the
   * surface as it bends again, then the points furthest from the line drawn so far go in, wherever
   * on the grid they are, while any lies further than the tolerance and the budget lasts. Returns
   * false for a path not yet traced.
   */
  *refining(written: ArrayLike<number>, limits = warpGridPathLimits): Generator<void, boolean> {
    const { path, atWrite } = this;
    const crossings = path.crossings;
    if (!crossings || !path.nodeVertex) return false;
    const edgeCount = path.ends.length / 2;
    const count = crossings.from.length;
    const { start, from, to, t, along } = crossings;
    // Positions of every point, then two more per edge: its nodes.
    const position = new Float64Array((count + edgeCount * 2) * 3);
    for (let i = 0; i < count; i++) {
      const f = from[i] * 3,
        g = to[i] * 3,
        s = t[i];
      for (let a = 0; a < 3; a++)
        position[i * 3 + a] = written[f + a] + s * (written[g + a] - written[f + a]);
      if ((i & 0xffff) === 0xffff) yield;
    }
    for (let e = 0; e < edgeCount; e++)
      for (let end = 0; end < 2; end++) {
        const n = path.ends[e * 2 + end];
        for (let a = 0; a < 3; a++) position[(count + e * 2 + end) * 3 + a] = atWrite[n * 3 + a];
      }
    // Kept points of each edge as a list from its first node's slot to its second's.
    const slots = count + edgeCount * 2;
    const next = new Int32Array(slots),
      gapAt = new Int32Array(slots).fill(-1),
      gapBend = new Float64Array(slots);
    const edgeOfPoint = new Uint32Array(count);
    const kept = new Uint32Array(edgeCount),
      tolerance = new Float64Array(edgeCount);
    for (let e = 0; e < edgeCount; e++) {
      for (let i = start[e]; i < start[e + 1]; i++) edgeOfPoint[i] = e;
      const a = (count + e * 2) * 3,
        b = a + 3;
      next[count + e * 2] = count + e * 2 + 1;
      next[count + e * 2 + 1] = -1;
      tolerance[e] =
        limits.tolerance *
        Math.hypot(
          position[b] - position[a],
          position[b + 1] - position[a + 1],
          position[b + 2] - position[a + 2],
        );
    }
    const edgeOfSlot = (slot: number) => (slot < count ? edgeOfPoint[slot] : (slot - count) >> 1);
    // The points between a kept slot and the next: from the first after it to the last before.
    const first = (slot: number) => (slot < count ? slot + 1 : start[(slot - count) >> 1]);
    const last = (slot: number) => (slot < count ? slot : start[((slot - count) >> 1) + 1]);
    let budget = limits.total;
    // How far each kept point bent the line when it went in. Evenly spaced points count as
    // bending it without end, so every view draws them.
    const bends = new Float64Array(count);
    const insert = (i: number, bend: number) => {
      const e = edgeOfPoint[i];
      let slot = count + e * 2;
      while (next[slot] < count && next[slot] < i) slot = next[slot];
      if (next[slot] === i) {
        bends[i] = Math.max(bends[i], bend);
        return false;
      }
      if (kept[e] >= limits.bentPerEdge || budget <= 0) return false;
      // At least as far as it lies off the line it splits, so leaving it out never cuts more.
      const end = next[slot];
      const sx = position[slot * 3],
        sy = position[slot * 3 + 1],
        sz = position[slot * 3 + 2];
      const lx = position[end * 3] - sx,
        ly = position[end * 3 + 1] - sy,
        lz = position[end * 3 + 2] - sz,
        qx = position[i * 3] - sx,
        qy = position[i * 3 + 1] - sy,
        qz = position[i * 3 + 2] - sz;
      const ll = lx * lx + ly * ly + lz * lz;
      const f = ll > 0 ? Math.min(1, Math.max(0, (qx * lx + qy * ly + qz * lz) / ll)) : 0;
      next[i] = end;
      next[slot] = i;
      bends[i] = Math.max(bend, Math.hypot(qx - f * lx, qy - f * ly, qz - f * lz));
      kept[e]++;
      budget--;
      return true;
    };
    /** The point between a kept slot and the next that lies furthest from the line between them. */
    const heap = new Heap();
    const measure = (slot: number) => {
      const end = next[slot];
      const e = edgeOfSlot(slot);
      const sx = position[slot * 3],
        sy = position[slot * 3 + 1],
        sz = position[slot * 3 + 2];
      const lx = position[end * 3] - sx,
        ly = position[end * 3 + 1] - sy,
        lz = position[end * 3 + 2] - sz;
      const ll = lx * lx + ly * ly + lz * lz;
      let most = tolerance[e],
        at = -1;
      for (let i = first(slot), stop = last(end); i < stop; i++) {
        const qx = position[i * 3] - sx,
          qy = position[i * 3 + 1] - sy,
          qz = position[i * 3 + 2] - sz;
        const f = ll > 0 ? Math.min(1, Math.max(0, (qx * lx + qy * ly + qz * lz) / ll)) : 0;
        const bend = Math.hypot(qx - f * lx, qy - f * ly, qz - f * lz);
        if (bend > most) {
          most = bend;
          at = i;
        }
      }
      gapAt[slot] = at;
      gapBend[slot] = most;
      // A max-heap by bend.
      if (at >= 0) heap.push(-most, slot);
    };
    const half = { ...limits, total: limits.total / 2 };
    const spacing = warpGridEvenSpacing(path.length, (e) => start[e + 1] - start[e], half);
    for (let e = 0; e < edgeCount; e++) {
      const even = warpGridEvenCount(path.length[e], start[e + 1] - start[e], spacing, half);
      warpGridEvenPoints(along, start[e], start[e + 1], even, (i) => insert(i, Infinity));
    }
    yield;
    for (let e = 0; e < edgeCount; e++) {
      for (let slot = count + e * 2; next[slot] >= 0; slot = next[slot]) measure(slot);
      if ((e & 0x3ff) === 0x3ff) yield;
    }
    let work = 0;
    while (heap.size && budget > 0) {
      const slot = heap.pop();
      const bend = -heap.top;
      if (gapAt[slot] < 0 || gapBend[slot] !== bend) continue;
      const i = gapAt[slot];
      gapAt[slot] = -1;
      if (!insert(i, bend)) continue;
      measure(slot);
      measure(i);
      if ((++work & 0xff) === 0) yield;
    }
    // The choice, in drawing order.
    const order = this.order;
    const chosen = new Uint32Array(edgeCount + 1);
    for (let o = 0; o < edgeCount; o++) chosen[o + 1] = chosen[o] + kept[order[o]];
    const pick = new Uint32Array(chosen[edgeCount]);
    for (let o = 0; o < edgeCount; o++) {
      const e = order[o];
      let k = chosen[o];
      for (let slot = next[count + e * 2]; slot < count; slot = next[slot]) pick[k++] = slot;
    }
    this.pending = this.ordered(chosen, pick, crossings, bends);
    return true;
  }

  private pending: WarpGridSelection | null = null;

  /**
   * Draws the points `refining` chose, on the surface it chose them on, which `written` and
   * `normals` must still hold. Returns which buffers changed.
   */
  adopt(written: ArrayLike<number>, normals: ArrayLike<number> | null) {
    const changed = { base: false, normals: false, shifts: false, layout: false };
    if (!this.pending) return changed;
    this.chosen = this.pending;
    this.selection = this.filtered();
    this.pending = null;
    this.refined = this.written;
    this.adopted++;
    this.lay();
    this.write(written, normals, changed);
    changed.layout = true;
    return changed;
  }

  /** Chooses the drawn points again on `written` and draws them, all at once. */
  refine(
    written: ArrayLike<number>,
    normals: ArrayLike<number> | null,
    limits = warpGridPathLimits,
  ) {
    const job = this.refining(written, limits);
    while (!job.next().done);
    return this.adopt(written, normals);
  }

  /** Segment ends as drawn, six floats each: what the vertex shader computes. */
  drawn(out = new Float32Array(this.segments * 6)) {
    const { base, weights, shifts } = this;
    for (let s = 0; s < this.segments; s++) {
      const a = weights[s * 4] * 4,
        b = weights[s * 4 + 1] * 4;
      for (let end = 0; end < 2; end++) {
        const w = weights[s * 4 + 2 + end];
        for (let axis = 0; axis < 3; axis++)
          out[s * 6 + end * 3 + axis] =
            base[s * 6 + end * 3 + axis] +
            shifts[a + axis] +
            w * (shifts[b + axis] - shifts[a + axis]);
      }
    }
    return out;
  }
}
