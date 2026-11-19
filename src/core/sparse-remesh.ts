/**
 * Sparse voxel remesher for resolutions above meshoptimizer's dense 256³ grid.
 *
 * This follows meshoptimizer's `meshopt_remesh` (v1.3): surface sampling into voxels,
 * flood-filled interior, and corner-connected cube triangulation with the same case
 * tables and octant decider. It stores only occupied voxels and the empty runs between
 * them, so memory grows with surface area instead of the cube of the resolution, and it
 * returns an indexed mesh whose vertices are the occupied voxels.
 */

// Triangles are three corner codes in three nibbles; corner bits are XYZ.
const baseCases: [code: number, altmode: number, triangles: number[], alternate: number[]][] = [
  [0x00, 0, [], []],
  [0x01, 0, [], []],
  [0x03, 0, [], []],
  [0x06, 0, [], []],
  [0x07, 0, [0x120], []],
  [0x0f, 2, [0x130, 0x032], [0x321, 0x120]],
  [0x16, 1, [0x124, 0x142], []],
  [0x17, 0, [0x124], []],
  [0x18, 0, [], []],
  [0x19, 1, [0x043, 0x403], []],
  [0x1b, 1, [0x134, 0x430], [0x410, 0x013]],
  [0x1d, 1, [0x243, 0x340], [0x320, 0x024]],
  [0x1e, 1, [0x142, 0x432, 0x341], [0x132]],
  [0x1f, 2, [0x412, 0x213], [0x134, 0x432]],
  [0x3c, 1, [0x345, 0x324, 0x543, 0x423], []],
  [0x3d, 1, [0x253, 0x524, 0x350], [0x240, 0x504, 0x320]],
  [0x3f, 2, [0x325, 0x524], [0x243, 0x345]],
  [0x69, 1, [0x035, 0x560, 0x306, 0x536], []],
  [0x6b, 1, [0x063, 0x605, 0x365], [0x305]],
  [0x6f, 1, [0x365, 0x560], [0x530, 0x036]],
  [0x7e, 0, [0x142, 0x536], []],
  [0x7f, 0, [0x365], []],
  [0xf0, 2, [0x547, 0x746], [0x465, 0x567]],
  [0xff, 0, [], []],
];

const triangleTable: [number[], number[]][] = new Array(256);
const triangleAlt = new Uint8Array(256);

{
  const rotations = [
    [2, 3, 6, 7, 0, 1, 4, 5],
    [4, 0, 6, 2, 5, 1, 7, 3],
  ];
  const filled = new Uint8Array(256);
  for (const [code, altmode, triangles, alternate] of baseCases) {
    triangleTable[code] = [triangles, altmode ? alternate : triangles];
    triangleAlt[code] = altmode;
    filled[code] = 1;
  }
  for (let pass = 0; pass < 3; pass++)
    for (let code = 0; code < 256; code++) {
      if (filled[code] !== 1) continue;
      for (const rotation of rotations) {
        let rotated = 0;
        for (let i = 0; i < 8; i++) rotated |= ((code >> i) & 1) << rotation[i];
        if (filled[rotated]) continue;
        const rotate = (tri: number) =>
          (rotation[(tri >> 8) & 0xf] << 8) |
          (rotation[(tri >> 4) & 0xf] << 4) |
          rotation[tri & 0xf];
        triangleTable[rotated] = [
          triangleTable[code][0].map(rotate),
          triangleTable[code][1].map(rotate),
        ];
        triangleAlt[rotated] = triangleAlt[code];
        filled[rotated] = 1;
      }
      filled[code] = 2;
    }
}

export interface SparseRemeshOptions {
  /** Place each vertex at its voxel's quadric minimizer instead of the sample centroid. */
  solve?: boolean;
  maxTriangles?: number;
  maxVoxels?: number;
}

export class RemeshLimitError extends Error {
  constructor(readonly limit: 'voxels' | 'triangles') {
    super(`The remesh exceeded its ${limit === 'voxels' ? 'voxel' : 'triangle'} limit.`);
  }
}

const EMPTY = 0xffffffff;

/** Open-addressed map from packed voxel coordinates (below 2^30) to voxel indices. */
class VoxelTable {
  keys: Uint32Array;
  values: Int32Array;
  mask: number;
  size = 0;
  constructor(capacity: number) {
    const size = 2 ** Math.ceil(Math.log2(Math.max(1024, capacity * 2)));
    this.keys = new Uint32Array(size).fill(EMPTY);
    this.values = new Int32Array(size);
    this.mask = size - 1;
  }
  get(key: number) {
    const keys = this.keys,
      mask = this.mask;
    let slot = Math.imul(key, 0x9e3779b1) & mask;
    for (;;) {
      const k = keys[slot];
      if (k === key) return this.values[slot];
      if (k === EMPTY) return -1;
      slot = (slot + 1) & mask;
    }
  }
  /** Returns the existing index, or stores `value` and returns -1. */
  insert(key: number, value: number) {
    if ((this.size + 1) * 2 > this.keys.length) this.grow();
    const keys = this.keys,
      mask = this.mask;
    let slot = Math.imul(key, 0x9e3779b1) & mask;
    for (;;) {
      const k = keys[slot];
      if (k === key) return this.values[slot];
      if (k === EMPTY) {
        keys[slot] = key;
        this.values[slot] = value;
        this.size++;
        return -1;
      }
      slot = (slot + 1) & mask;
    }
  }
  private grow() {
    const { keys, values } = this;
    this.keys = new Uint32Array(keys.length * 2).fill(EMPTY);
    this.values = new Int32Array(keys.length * 2);
    this.mask = this.keys.length - 1;
    this.size = 0;
    for (let i = 0; i < keys.length; i++) if (keys[i] !== EMPTY) this.insert(keys[i], values[i]);
  }
}

/** Growable struct-of-arrays storage for per-voxel accumulators. */
class VoxelStore {
  count = 0;
  keys = new Uint32Array(0);
  octants = new Uint8Array(0);
  /** Per voxel: px, py, pz, w, then the quadric a00 a11 a22 a10 a20 a21 b0 b1 b2 c.
   * Single precision matches meshoptimizer and halves the largest allocation. */
  data = new Float32Array(0);
  constructor(
    readonly stride: number,
    private readonly limit: number,
  ) {
    this.reserve(1024);
  }
  reserve(capacity: number) {
    if (capacity <= this.octants.length) return;
    // Grow by half, never past the voxel limit, to bound over-allocation.
    const size = Math.min(Math.max(capacity, Math.ceil(this.octants.length * 1.5)), this.limit);
    const keys = new Uint32Array(size);
    keys.set(this.keys);
    const octants = new Uint8Array(size);
    octants.set(this.octants);
    const data = new Float32Array(size * this.stride);
    data.set(this.data);
    this.keys = keys;
    this.octants = octants;
    this.data = data;
  }
}

function measureGrid(positions: Float32Array, resolution: number) {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3)
    for (let j = 0; j < 3; j++) {
      const v = positions[i + j];
      if (v < min[j]) min[j] = v;
      if (v > max[j]) max[j] = v;
    }
  // Grid placement uses single precision like meshoptimizer, so both kernels sample alike.
  const f = Math.fround;
  let extent = Math.max(f(max[0] - min[0]), f(max[1] - min[1]), f(max[2] - min[2]), 0);
  // Subvoxel padding keeps vertices inside the last valid voxel.
  extent = f(extent * f(f(resolution + f(1e-2)) / resolution));
  // The first and last voxels on each axis are empty padding.
  const scale = extent === 0 ? 0 : f((resolution - 2) / extent);
  const offset = min.map((v, j) => f(v - f(f(extent - f(max[j] - min[j])) * 0.5)));
  return { scale, offset };
}

function solveVoxel(d: Float32Array, o: number, lambda: number, out: Float64Array) {
  const w = d[o + 3];
  const rw = lambda * w;
  const a00 = rw + d[o + 4],
    a11 = rw + d[o + 5],
    a22 = rw + d[o + 6];
  const a10 = d[o + 7],
    a20 = d[o + 8],
    a21 = d[o + 9];
  const x0 = lambda * d[o] - d[o + 10],
    x1 = lambda * d[o + 1] - d[o + 11],
    x2 = lambda * d[o + 2] - d[o + 12];
  const eps = 1e-6 * w;
  const d0 = a00;
  const l10 = a10 / d0,
    l20 = a20 / d0;
  const d1 = a11 - a10 * l10;
  const dl21 = a21 - a20 * l10;
  const l21 = dl21 / d1;
  const d2 = a22 - a20 * l20 - dl21 * l21;
  const y0 = x0,
    y1 = x1 - l10 * y0,
    y2 = x2 - l20 * y0 - l21 * y1;
  const rz = y2 / d2;
  const ry = y1 / d1 - l21 * rz;
  const rx = y0 / d0 - l10 * ry - l20 * rz;
  out[0] = rx;
  out[1] = ry;
  out[2] = rz;
  return Math.abs(d0) > eps && Math.abs(d1) > eps && Math.abs(d2) > eps;
}

function quadricError(q: Float64Array, x: number, y: number, z: number) {
  // q: a00 a11 a22 a10 a20 a21 b0 b1 b2 c
  const rx = (q[6] + q[3] * y) * 2 + q[0] * x;
  const ry = (q[7] + q[5] * z) * 2 + q[1] * y;
  const rz = (q[8] + q[4] * x) * 2 + q[2] * z;
  return Math.abs(q[9] + rx * x + ry * y + rz * z);
}

/**
 * Remesh a closed indexed mesh on a sparse voxel grid of `resolution` cells along its
 * longest axis. Returns an indexed triangle mesh.
 */
export function sparseRemesh(
  indices: Uint32Array,
  positions: Float32Array,
  resolution: number,
  options: SparseRemeshOptions = {},
) {
  const R = resolution;
  // Packed voxel keys stay below 2^30.
  if (!(Number.isInteger(R) && R >= 4 && R <= 1024))
    throw new Error('Voxel resolution is out of range.');
  const solve = !!options.solve;
  const maxTriangles = options.maxTriangles ?? Infinity;
  const maxVoxels = options.maxVoxels ?? Infinity;
  const { scale, offset } = measureGrid(positions, R);
  const stride = solve ? 14 : 4;
  const store = new VoxelStore(stride, Math.min(maxVoxels, 2 ** 31));
  const table = new VoxelTable(1024);
  const RR = R * R;
  const cutoff = R - 3;
  const scale2 = Math.fround(scale * 2);

  // Rasterize triangles by sampling with two samples per voxel edge. Like meshoptimizer,
  // a triangle gets a square grid sized by its longest edge. A sliver instead gets a grid
  // sized by each of its two shorter edges, so a long thin triangle costs samples in
  // proportion to its length instead of its length squared.
  let lastKey = -1,
    lastIndex = -1;
  const corners = new Int32Array(3);
  const lengths = new Float64Array(3);
  const f = Math.fround;
  const length2 = (from: number, to: number) => {
    const dx = f(positions[to] - positions[from]),
      dy = f(positions[to + 1] - positions[from + 1]),
      dz = f(positions[to + 2] - positions[from + 2]);
    return f(f(f(dx * dx) + f(dy * dy)) + f(dz * dz));
  };
  const sampleCount = (length: number) =>
    Math.min(Math.max(Math.trunc(f(f(f(length) * scale) * 2)), 1), R * 2);
  // Round sliver counts up so neither grid step exceeds half a voxel.
  const sliverCount = (length2: number) =>
    Math.min(Math.max(Math.ceil(Math.sqrt(length2) * scale * 2), 1), R * 2);
  for (let i = 0; i < indices.length; i += 3) {
    corners[0] = indices[i] * 3;
    corners[1] = indices[i + 1] * 3;
    corners[2] = indices[i + 2] * 3;
    // Edge k runs from corner k to corner k + 1.
    const l0 = (lengths[0] = length2(corners[0], corners[1])),
      l1 = (lengths[1] = length2(corners[1], corners[2])),
      l2 = (lengths[2] = length2(corners[2], corners[0]));
    const samples = sampleCount(Math.sqrt(Math.max(l0, l1, l2)));
    let origin = 0,
      nu = samples,
      nv = samples;
    // Put the origin opposite the longest edge, keeping the winding.
    const longest = l0 >= l1 && l0 >= l2 ? 0 : l1 >= l2 ? 1 : 2;
    const across = (longest + 2) % 3;
    const su0 = sliverCount(lengths[across]),
      sv0 = sliverCount(lengths[(longest + 1) % 3]);
    // Compare edge lengths, not truncated counts, so ordinary triangles keep the square grid.
    if (lengths[across] * lengths[(longest + 1) % 3] * 16 < Math.max(l0, l1, l2) ** 2) {
      origin = across;
      nu = su0;
      nv = sv0;
    }
    const a = corners[origin],
      b = corners[(origin + 1) % 3],
      c = corners[(origin + 2) % 3];
    const ax = positions[a],
      ay = positions[a + 1],
      az = positions[a + 2];
    // e runs along the edge sampled nu times, f along the one sampled nv times.
    const ex = f(positions[b] - ax),
      ey = f(positions[b + 1] - ay),
      ez = f(positions[b + 2] - az);
    const fx = f(positions[c] - ax),
      fy = f(positions[c + 1] - ay),
      fz = f(positions[c + 2] - az);
    let nx = ey * fz - ez * fy,
      ny = ez * fx - ex * fz,
      nz = ex * fy - ey * fx;
    const area = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!(area > 0)) continue;
    nx /= area;
    ny /= area;
    nz /= area;
    const sx = f(ax - offset[0]),
      sy = f(ay - offset[1]),
      sz = f(az - offset[2]);
    const ur = nu > 1 ? f(1 / nu) : 1,
      vr = nv > 1 ? f(1 / nv) : 1;
    let count = 0;
    for (let u = 0; u <= nu; u++) count += Math.floor(((nu - u) * nv) / nu) + 1;
    const weight = area / (2 * count);
    for (let u = 0; u <= nu; u++) {
      const last = Math.floor(((nu - u) * nv) / nu);
      for (let v = 0; v <= last; v++) {
        // Single-precision sample positions decide voxels exactly as meshoptimizer does.
        const su = f(u * ur),
          sv = f(v * vr);
        const px = f(f(sx + f(su * ex)) + f(sv * fx));
        const py = f(f(sy + f(su * ey)) + f(sv * fy));
        const pz = f(f(sz + f(su * ez)) + f(sv * fz));
        const hx = Math.trunc(f(px * scale2)),
          hy = Math.trunc(f(py * scale2)),
          hz = Math.trunc(f(pz * scale2));
        let x = hx >> 1,
          y = hy >> 1,
          z = hz >> 1;
        x = x < 0 ? 0 : x > cutoff ? cutoff : x;
        y = y < 0 ? 0 : y > cutoff ? cutoff : y;
        z = z < 0 ? 0 : z > cutoff ? cutoff : z;
        // Grid coordinates include one voxel of empty padding.
        const key = x + 1 + R * (y + 1) + RR * (z + 1);
        let index: number;
        if (key === lastKey) index = lastIndex;
        else {
          index = table.insert(key, store.count);
          if (index < 0) {
            index = store.count++;
            if (index >= maxVoxels) throw new RemeshLimitError('voxels');
            store.reserve(store.count);
            store.keys[index] = key;
          }
          lastKey = key;
          lastIndex = index;
        }
        store.octants[index] |= 1 << ((hx & 1) | ((hy & 1) << 1) | ((hz & 1) << 2));
        const d = store.data,
          o = index * stride;
        d[o] += px * weight;
        d[o + 1] += py * weight;
        d[o + 2] += pz * weight;
        d[o + 3] += weight;
        if (solve) {
          const dist = -(nx * px + ny * py + nz * pz);
          const aw = nx * weight,
            bw = ny * weight,
            cw = nz * weight,
            dw = dist * weight;
          d[o + 4] += nx * aw;
          d[o + 5] += ny * bw;
          d[o + 6] += nz * cw;
          d[o + 7] += nx * bw;
          d[o + 8] += nx * cw;
          d[o + 9] += ny * cw;
          d[o + 10] += nx * dw;
          d[o + 11] += ny * dw;
          d[o + 12] += nz * dw;
          d[o + 13] += dist * dw;
        }
      }
    }
  }
  const voxelCount = store.count;
  const data = store.data;

  // Group occupied voxels into rows along X, sorted by X.
  const order = store.keys.slice(0, voxelCount).sort();
  const rowOf = new Int32Array(RR).fill(-1);
  const rowFirst: number[] = [],
    rowLast: number[] = [];
  const intervalStart: number[] = [],
    intervalEnd: number[] = [],
    rowIntervals: number[] = [0];
  const intervalRow: number[] = [];
  for (let i = 0; i < voxelCount;) {
    const row = Math.floor(order[i] / R);
    const r = rowFirst.length;
    rowOf[row] = r;
    let previous = order[i] - row * R;
    rowFirst.push(previous);
    let j = i + 1;
    for (; j < voxelCount && Math.floor(order[j] / R) === row; j++) {
      const x = order[j] - row * R;
      if (x > previous + 1) {
        intervalStart.push(previous + 1);
        intervalEnd.push(x - 1);
        intervalRow.push(r);
      }
      previous = x;
    }
    rowLast.push(previous);
    rowIntervals.push(intervalStart.length);
    i = j;
  }
  const rowKeys = new Int32Array(rowFirst.length);
  for (let row = 0; row < RR; row++) if (rowOf[row] >= 0) rowKeys[rowOf[row]] = row;

  // Interval state: 1 is enclosed (inside), 0 is reachable from the grid boundary.
  const inside = new Uint8Array(intervalStart.length).fill(1);
  const queue = new Int32Array(intervalStart.length);
  let head = 0,
    tail = 0;
  const neighbourRows = (row: number, visit: (neighbour: number) => void) => {
    const y = row % R,
      z = (row - y) / R;
    if (y > 0) visit(row - 1);
    if (y < R - 1) visit(row + 1);
    if (z > 0) visit(row - R);
    if (z < R - 1) visit(row + R);
  };
  /** First interval index in row `r` whose end is at or after `x`. */
  const firstInterval = (r: number, x: number) => {
    let lo = rowIntervals[r],
      hi = rowIntervals[r + 1];
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (intervalEnd[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  for (let i = 0; i < intervalStart.length; i++) {
    const a = intervalStart[i],
      b = intervalEnd[i];
    let outside = false;
    neighbourRows(rowKeys[intervalRow[i]], (neighbour) => {
      if (outside) return;
      const r = rowOf[neighbour];
      // Rows without occupied voxels are empty and reachable from the boundary.
      if (r < 0 || a < rowFirst[r] || b > rowLast[r]) outside = true;
    });
    if (outside) {
      inside[i] = 0;
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const i = queue[head++];
    const a = intervalStart[i],
      b = intervalEnd[i];
    neighbourRows(rowKeys[intervalRow[i]], (neighbour) => {
      const r = rowOf[neighbour];
      if (r < 0) return;
      const end = rowIntervals[r + 1];
      for (let k = firstInterval(r, a); k < end && intervalStart[k] <= b; k++)
        if (inside[k]) {
          inside[k] = 0;
          queue[tail++] = k;
        }
    });
  }

  /** 0: empty, 1: enclosed, 2 + index: occupied voxel. */
  const state = (x: number, y: number, z: number) => {
    const index = table.get(x + R * y + RR * z);
    if (index >= 0) return 2 + index;
    const r = rowOf[y + R * z];
    if (r < 0 || x < rowFirst[r] || x > rowLast[r]) return 0;
    const k = firstInterval(r, x);
    return k < rowIntervals[r + 1] && intervalStart[k] <= x ? inside[k] : 0;
  };

  // Final vertex positions, relative to the grid offset.
  const rscale = 1 / scale;
  const solved = new Float64Array(3);
  const regularization = 3e-2;
  const solveCutoff = 3 / (scale * scale);
  for (let i = 0; i < voxelCount; i++) {
    const o = i * stride;
    const w = data[o + 3];
    let px = data[o] / w,
      py = data[o + 1] / w,
      pz = data[o + 2] / w;
    if (solve && solveVoxel(data, o, regularization, solved)) {
      const [sx, sy, sz] = solved;
      const d = (sx - px) ** 2 + (sy - py) ** 2 + (sz - pz) ** 2;
      if (d < solveCutoff) {
        // Clamp to the voxel to reduce intersections.
        const key = store.keys[i],
          gx = key % R,
          gy = ((key - gx) / R) % R,
          gz = Math.floor(key / RR);
        const cx = (gx - 1) * rscale,
          cy = (gy - 1) * rscale,
          cz = (gz - 1) * rscale;
        px = Math.min(Math.max(sx, cx), cx + rscale);
        py = Math.min(Math.max(sy, cy), cy + rscale);
        pz = Math.min(Math.max(sz, cz), cz + rscale);
      }
    }
    data[o] = px;
    data[o + 1] = py;
    data[o + 2] = pz;
  }

  // Polygonize every cell that has an occupied corner, visiting each cell once from
  // its lowest occupied corner.
  let triangles = new Uint32Array(Math.min(Math.max(1024, voxelCount * 6), maxTriangles * 3));
  let triangleLength = 0;
  const corner = new Int32Array(8);
  const quadric = new Float64Array(10);
  const octantDecider = (cube: number) => {
    for (let c = 0; c < 8; c++)
      if (cube & (1 << c) && corner[c] >= 2 && store.octants[corner[c] - 2] & (1 << (7 - c)))
        return 0;
    return 1;
  };
  const quadricDecider = (cube: number) => {
    const [t0, t1] = triangleTable[cube][0];
    const quad = (t0 << 4) | (t1 & 0xf);
    const q = [0, 1, 2, 3].map((i) => corner[(quad >> (12 - i * 4)) & 0xf] - 2);
    quadric.fill(0);
    let w = 0;
    for (const index of [q[0], q[3], q[1], q[2]]) {
      const o = index * stride;
      for (let k = 0; k < 10; k++) quadric[k] += data[o + 4 + k];
      w += data[o + 3];
    }
    const mid = (p: number, r: number, k: number) =>
      (data[p * stride + k] + data[r * stride + k]) * 0.5;
    const error0 = quadricError(
      quadric,
      mid(q[1], q[2], 0),
      mid(q[1], q[2], 1),
      mid(q[1], q[2], 2),
    );
    const error1 = quadricError(
      quadric,
      mid(q[0], q[3], 0),
      mid(q[0], q[3], 1),
      mid(q[0], q[3], 2),
    );
    return error0 > w * (0.1 * 0.1 * rscale * rscale) && error1 < error0 * (0.85 * 0.85) ? 1 : 0;
  };
  for (let s = 0; s < voxelCount; s++) {
    const key = order[s];
    const vx = key % R,
      rest = (key - vx) / R,
      vy = rest % R,
      vz = (rest - vy) / R;
    for (let c = 0; c < 8; c++) {
      const x = vx - (c & 1),
        y = vy - ((c >> 1) & 1),
        z = vz - ((c >> 2) & 1);
      let cube = 0,
        owned = true;
      for (let k = 0; k < 8; k++) {
        const value =
          k === c ? 2 + table.get(key) : state(x + (k & 1), y + ((k >> 1) & 1), z + ((k >> 2) & 1));
        if (k < c && value >= 2) {
          owned = false;
          break;
        }
        corner[k] = value;
        if (value) cube |= 1 << k;
      }
      if (!owned || cube === 0xff) continue;
      const altmode = triangleAlt[cube];
      const alt =
        altmode === 1 ? octantDecider(cube) : altmode === 2 && solve ? quadricDecider(cube) : 0;
      for (const tri of triangleTable[cube][alt]) {
        if (triangleLength / 3 >= maxTriangles) throw new RemeshLimitError('triangles');
        if (triangleLength + 3 > triangles.length) {
          const grown = new Uint32Array(Math.min(triangles.length * 2, maxTriangles * 3));
          grown.set(triangles);
          triangles = grown;
        }
        triangles[triangleLength++] = corner[(tri >> 8) & 0xf] - 2;
        triangles[triangleLength++] = corner[(tri >> 4) & 0xf] - 2;
        triangles[triangleLength++] = corner[tri & 0xf] - 2;
      }
    }
  }

  // Keep only voxels that became vertices.
  const remap = new Int32Array(voxelCount).fill(-1);
  const outIndices = new Uint32Array(triangleLength);
  let vertices = 0;
  for (let i = 0; i < triangleLength; i++) {
    const v = triangles[i];
    if (remap[v] < 0) remap[v] = vertices++;
    outIndices[i] = remap[v];
  }
  const outPositions = new Float32Array(vertices * 3);
  for (let v = 0; v < voxelCount; v++) {
    const r = remap[v];
    if (r < 0) continue;
    outPositions[r * 3] = data[v * stride] + offset[0];
    outPositions[r * 3 + 1] = data[v * stride + 1] + offset[1];
    outPositions[r * 3 + 2] = data[v * stride + 2] + offset[2];
  }
  return { positions: outPositions, indices: outIndices, voxels: voxelCount };
}
