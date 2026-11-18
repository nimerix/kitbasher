import type { WarpModel } from './warp-model';

/**
 * Grid edges laid on the surface. Between its two nodes each edge passes through points on mesh
 * edges, found by walking the region's triangles along the plane through the edge's chord and
 * the surface normal, so every piece of it lies in one triangle.
 */
export interface WarpGridPath {
  /** Node pairs, two per grid edge. */
  ends: Uint32Array;
  /** Where each grid edge's points begin, with one entry past the last edge. */
  start: Uint32Array;
  /** Geometry vertices at either end of the mesh edge each point lies on, and how far along it. */
  from: Uint32Array;
  to: Uint32Array;
  t: Float32Array;
  /** How far along its grid edge each point lies: 0 at the first node, 1 at the second. */
  along: Float32Array;
  /** World rest length of each grid edge. */
  length: Float32Array;
  /** The geometry vertex holding each node's written normal; null until traced. */
  nodeVertex: Uint32Array | null;
  /** Grid edges whose walk failed, drawn as straight chords. */
  failed: number;
  /** False for chords drawn before a trace is done. */
  traced: boolean;
}

export const warpGridPathLimits = {
  /** Points kept per grid edge. */
  perEdge: 32,
  /** Points kept over the whole grid; the ones that matter least go first. */
  total: 64_000,
  /** Triangles a walk may cross before it gives up. */
  steps: 4096,
  /** A point that bends the line by less than this share of its edge's length is left out. */
  tolerance: 1e-3,
};

const none = 0xffffffff;

/** The grid's edges as straight chords: what is drawn until a path is traced. */
export function warpGridChords(model: WarpModel): WarpGridPath {
  const { edgeStart, edges } = model.grid;
  let count = 0;
  for (let n = 0; n + 1 < edgeStart.length; n++)
    for (let k = edgeStart[n]; k < edgeStart[n + 1]; k++) if (edges[k] > n) count++;
  const ends = new Uint32Array(count * 2),
    length = new Float32Array(count);
  const rest = model.restNodes;
  for (let n = 0, e = 0; n + 1 < edgeStart.length; n++)
    for (let k = edgeStart[n]; k < edgeStart[n + 1]; k++) {
      const m = edges[k];
      if (m <= n) continue;
      ends[e * 2] = n;
      ends[e * 2 + 1] = m;
      length[e++] = Math.hypot(
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
    nodeVertex: null,
    failed: 0,
    traced: false,
  };
}

/** Grows typed arrays as points are added. */
class Points {
  from = new Uint32Array(1024);
  to = new Uint32Array(1024);
  t = new Float32Array(1024);
  along = new Float32Array(1024);
  bend = new Float32Array(1024);
  size = 0;

  push(from: number, to: number, t: number, along: number, bend: number) {
    if (this.size === this.from.length) {
      const grow = <T extends Uint32Array | Float32Array>(a: T) => {
        const b = new (a.constructor as new (n: number) => T)(a.length * 2);
        b.set(a);
        return b;
      };
      this.from = grow(this.from);
      this.to = grow(this.to);
      this.t = grow(this.t);
      this.along = grow(this.along);
      this.bend = grow(this.bend);
    }
    const i = this.size++;
    this.from[i] = from;
    this.to[i] = to;
    this.t[i] = t;
    this.along[i] = along;
    this.bend[i] = bend;
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
  const { ends, length } = chords;
  const { region, grid, restWorld: p } = model;
  const { weldOf, weldedCount, triangles } = region;
  const slice = 1 << 16;

  // The first geometry vertex of each welded vertex holds its written position.
  const first = new Uint32Array(weldedCount).fill(none);
  for (let g = 0; g < weldOf.length; g++) {
    const w = weldOf[g];
    if (w !== none && first[w] === none) first[w] = g;
    if ((g & (slice - 1)) === slice - 1) yield;
  }

  // Region triangles around each welded vertex.
  const triangleCount = triangles.length / 3;
  const around = new Uint32Array(weldedCount + 1);
  const degenerate = (t: number) => {
    const a = triangles[t * 3],
      b = triangles[t * 3 + 1],
      c = triangles[t * 3 + 2];
    return a === b || b === c || a === c;
  };
  for (let t = 0; t < triangleCount; t++) {
    if (!degenerate(t)) for (let k = 0; k < 3; k++) around[triangles[t * 3 + k] + 1]++;
    if ((t & (slice - 1)) === slice - 1) yield;
  }
  for (let v = 0; v < weldedCount; v++) around[v + 1] += around[v];
  const incident = new Uint32Array(around[weldedCount]);
  const fill = around.slice(0, weldedCount);
  for (let t = 0; t < triangleCount; t++) {
    if (!degenerate(t)) for (let k = 0; k < 3; k++) incident[fill[triangles[t * 3 + k]]++] = t;
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
  // One walk's crossings: mesh edge, parameter, world position.
  let cu = new Uint32Array(256),
    cv = new Uint32Array(256),
    ct = new Float64Array(256),
    cp = new Float64Array(256 * 3);
  // Greedy refinement scratch: kept crossing indices and the bend each was kept for.
  const keptIndex = new Int32Array(limits.perEdge + 2),
    keptBend = new Float64Array(limits.perEdge + 2),
    gapAt = new Int32Array(limits.perEdge + 2),
    gapBend = new Float64Array(limits.perEdge + 2),
    arc = new Float64Array(limits.steps + 2);

  const contains = (t: number, v: number) =>
    triangles[t * 3] === v || triangles[t * 3 + 1] === v || triangles[t * 3 + 2] === v;

  /** Crossings from node a to node b in cu, cv, ct, cp; 0 along a mesh edge, -1 when it fails. */
  const walk = (na: number, nb: number) => {
    const a = grid.nodes[na],
      b = grid.nodes[nb];
    for (let i = around[a]; i < around[a + 1]; i++) if (contains(incident[i], b)) return 0;
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
    if (nx * nx + ny * ny + nz * nz < 1e-6) {
      nx = normals[na * 3];
      ny = normals[na * 3 + 1];
      nz = normals[na * 3 + 2];
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

    const length = Math.sqrt(l2);
    for (let count = 0; count < limits.steps; count++) {
      const su = side(u),
        sv = side(v);
      const f = su / (su - sv);
      const x = p[u * 3] + f * (p[v * 3] - p[u * 3]),
        y = p[u * 3 + 1] + f * (p[v * 3 + 1] - p[u * 3 + 1]),
        z = p[u * 3 + 2] + f * (p[v * 3 + 2] - p[u * 3 + 2]);
      // A walk that strays well off the chord has lost its way.
      const along = ((x - ax) * dx + (y - ay) * dy + (z - az) * dz) / length;
      const ox = x - ax - (along * dx) / length,
        oy = y - ay - (along * dy) / length,
        oz = z - az - (along * dz) / length;
      if (along < -0.25 * length || along > 1.25 * length || ox * ox + oy * oy + oz * oz > l2)
        return -1;
      if (count === cu.length) {
        const grow = <T extends Uint32Array | Float64Array>(a: T, n: number) => {
          const b = new (a.constructor as new (n: number) => T)(n);
          b.set(a);
          return b;
        };
        cu = grow(cu, count * 2);
        cv = grow(cv, count * 2);
        ct = grow(ct, count * 2);
        cp = grow(cp, count * 6);
      }
      cu[count] = u;
      cv[count] = v;
      ct[count] = f;
      cp[count * 3] = x;
      cp[count * 3 + 1] = y;
      cp[count * 3 + 2] = z;

      // Cross into the triangle on the other side of u–v.
      let next = none;
      for (let i = around[u]; i < around[u + 1]; i++) {
        const t = incident[i];
        if (t !== from && contains(t, v)) {
          next = t;
          break;
        }
      }
      if (next === none) return -1;
      let w = none;
      for (let k = 0; k < 3; k++) {
        const c = triangles[next * 3 + k];
        if (c !== u && c !== v) w = c;
      }
      if (w === b) return count + 1;
      if (side(w) > 0 === su > 0) u = w;
      else v = w;
      from = next;
    }
    return -1;
  };

  /** Distance from crossing i to the segment between kept positions. */
  const bendOf = (
    i: number,
    sx: number,
    sy: number,
    sz: number,
    ex: number,
    ey: number,
    ez: number,
  ) => {
    const qx = cp[i * 3] - sx,
      qy = cp[i * 3 + 1] - sy,
      qz = cp[i * 3 + 2] - sz;
    const lx = ex - sx,
      ly = ey - sy,
      lz = ez - sz;
    const ll = lx * lx + ly * ly + lz * lz;
    const f = ll > 0 ? Math.min(1, Math.max(0, (qx * lx + qy * ly + qz * lz) / ll)) : 0;
    return Math.hypot(qx - f * lx, qy - f * ly, qz - f * lz);
  };

  const points = new Points();
  const edgeCount = ends.length / 2;
  const counts = new Uint32Array(edgeCount);
  let failed = 0,
    work = 0;
  for (let e = 0; e < edgeCount; e++) {
    const na = ends[e * 2],
      nb = ends[e * 2 + 1];
    const m = walk(na, nb);
    if (m < 0) failed++;
    if (m > 0) {
      const a = grid.nodes[na] * 3,
        b = grid.nodes[nb] * 3;
      const position = (k: number, axis: number) =>
        k < 0 ? p[a + axis] : k >= m ? p[b + axis] : cp[k * 3 + axis];
      // Arc length along the whole walk, for each crossing.
      let total = 0;
      for (let k = 0; k <= m; k++) {
        total += Math.hypot(
          position(k, 0) - position(k - 1, 0),
          position(k, 1) - position(k - 1, 1),
          position(k, 2) - position(k - 1, 2),
        );
        arc[k] = total;
      }
      // Keep the crossings that bend the line most until it is straight enough or full. Each
      // gap between kept crossings remembers the crossing in it that bends most.
      const tolerance = limits.tolerance * length[e];
      const best = (slot: number) => {
        const i0 = keptIndex[slot],
          i1 = keptIndex[slot + 1];
        const sx = position(i0, 0),
          sy = position(i0, 1),
          sz = position(i0, 2),
          ex = position(i1, 0),
          ey = position(i1, 1),
          ez = position(i1, 2);
        let most = tolerance,
          at = -1;
        for (let i = i0 + 1; i < i1; i++) {
          const bend = bendOf(i, sx, sy, sz, ex, ey, ez);
          if (bend > most) {
            most = bend;
            at = i;
          }
        }
        gapAt[slot] = at;
        gapBend[slot] = most;
      };
      keptIndex[0] = -1;
      keptIndex[1] = m;
      let kept = 2;
      best(0);
      while (kept - 2 < limits.perEdge) {
        let slot = -1;
        for (let g = 0; g + 1 < kept; g++)
          if (gapAt[g] >= 0 && (slot < 0 || gapBend[g] > gapBend[slot])) slot = g;
        if (slot < 0) break;
        keptIndex.copyWithin(slot + 2, slot + 1, kept);
        keptBend.copyWithin(slot + 2, slot + 1, kept);
        gapAt.copyWithin(slot + 1, slot, kept - 1);
        gapBend.copyWithin(slot + 1, slot, kept - 1);
        keptIndex[slot + 1] = gapAt[slot];
        keptBend[slot + 1] = gapBend[slot] / length[e];
        kept++;
        best(slot);
        best(slot + 1);
      }
      work += m;
      for (let s = 1; s + 1 < kept; s++) {
        const i = keptIndex[s];
        points.push(first[cu[i]], first[cv[i]], ct[i], arc[i] / total, keptBend[s]);
      }
      counts[e] = kept - 2;
    }
    work += 64;
    if (work > 4096) {
      work = 0;
      yield;
    }
  }

  // Over the budget, the points that bend their lines least are left out.
  let cutoff = -1;
  if (points.size > limits.total) {
    const bends = points.bend.slice(0, points.size).sort();
    cutoff = bends[points.size - limits.total - 1];
  }
  let kept = 0;
  for (let i = 0; i < points.size; i++) if (points.bend[i] > cutoff) kept++;
  kept = Math.min(kept, limits.total);
  const start = new Uint32Array(edgeCount + 1),
    from = new Uint32Array(kept),
    to = new Uint32Array(kept),
    t = new Float32Array(kept),
    along = new Float32Array(kept);
  for (let e = 0, i = 0, o = 0; e < edgeCount; e++) {
    start[e] = o;
    for (const end = i + counts[e]; i < end; i++)
      if (points.bend[i] > cutoff && o < kept) {
        from[o] = points.from[i];
        to[o] = points.to[i];
        t[o] = points.t[i];
        along[o++] = points.along[i];
      }
    start[e + 1] = o;
  }
  const nodeVertex = new Uint32Array(nodeCount);
  for (let n = 0; n < nodeCount; n++) nodeVertex[n] = first[grid.nodes[n]];
  return { ends, start, from, to, t, along, length, nodeVertex, failed, traced: true };
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
  path: WarpGridPath,
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
 * Writes the written surface's normal at each end of each segment, laid out as the segments
 * are. Leaves `out` alone for a path that is not yet traced.
 */
export function writeWarpGridNormals(
  path: WarpGridPath,
  normals: ArrayLike<number>,
  out: Float32Array,
) {
  const { ends, start, from, to, t, nodeVertex } = path;
  if (!nodeVertex) return;
  let o = 0;
  for (let e = 0; e < ends.length / 2; e++) {
    const a = nodeVertex[ends[e * 2]] * 3,
      b = nodeVertex[ends[e * 2 + 1]] * 3;
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
