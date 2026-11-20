import type { RefineMesh, RefineTopology } from './refine-mesh';

/** Smooth's reach in mm from the local edge length: ripples shorter than it are removed. */
export const smoothScale = (edge: number) => Math.max(0.6, 10 * edge);

/** An anchor's fit stands for the vertices within this fraction of the scale of it. */
const anchorSpacing = 0.2;

/**
 * Moving least squares. The surface within `scale` of a vertex is fitted, in the frame of its mean
 * normal, by a least-squares quadric height field, and the vertex moves onto it along that
 * normal. Fits are made at anchor vertices spaced a fifth of `scale` apart; each vertex takes the
 * kernel-weighted mean of its projections onto the anchors' quadrics within twice that spacing.
 * Each round runs on the previous round's result. Neighbourhoods read only `vertices`, the painted
 * surface, and do not walk through a vertex marked in `barrier` (per welded vertex). Returns the
 * final positions of `vertices`, three values each; vertices that are not free keep theirs. `position`
 * replaces the mesh's positions as the starting surface when given.
 */
export function smoothTargets(
  mesh: RefineMesh,
  topology: RefineTopology,
  vertices: Uint32Array,
  free: Uint8Array,
  scale: number,
  rounds: number,
  barrier: Uint8Array,
  position: Float64Array = mesh.position,
): Float32Array {
  const count = vertices.length;
  const indexOf = new Int32Array(mesh.weldedCount).fill(-1);
  vertices.forEach((v, i) => (indexOf[v] = i));
  let current = position;
  const next = new Float64Array(count * 3);
  const fitter = new LocalFit(mesh, topology, barrier, indexOf);
  const sum = new Float64Array(count * 3);
  const total = new Float64Array(count);
  const covered = new Uint8Array(count);
  const reach = anchorSpacing * scale;
  for (let round = 0; round < rounds; round++) {
    fitter.reset(current);
    sum.fill(0);
    total.fill(0);
    covered.fill(0);
    for (let i = 0; i < count; i++)
      if (free[i] && !covered[i])
        fitter.anchor(vertices[i], scale, reach, free, covered, sum, total);
    for (let i = 0; i < count; i++) {
      const v = vertices[i] * 3;
      for (let a = 0; a < 3; a++)
        next[i * 3 + a] = total[i] > 0 ? sum[i * 3 + a] / total[i] : current[v + a];
    }
    if (round + 1 < rounds) {
      if (round === 0) current = current.slice();
      for (let i = 0; i < count; i++)
        for (let a = 0; a < 3; a++) current[vertices[i] * 3 + a] = next[i * 3 + a];
    }
  }
  return Float32Array.from(next);
}

/** Local quadric fits and the projections onto them, reusing every buffer between anchors. */
class LocalFit {
  private position: Float64Array;
  private readonly normal: Float64Array;
  private readonly normalDone: Uint8Array;
  private readonly stamp: Uint32Array;
  private mark = 0;
  private gathered = new Uint32Array(1024);
  /** Per gathered vertex: its offset from the centre. */
  private offset = new Float64Array(3072);
  private readonly matrix = new Float64Array(36);
  private readonly rhs = new Float64Array(6);
  /** The last fit: its normal and tangent axes, and its quadric's coefficients in scale units. */
  private readonly frame = new Float64Array(9);
  private readonly coefficients = new Float64Array(6);

  constructor(
    private readonly mesh: RefineMesh,
    private readonly topology: RefineTopology,
    private readonly barrier: Uint8Array,
    /** Welded vertex -> index in the painted vertices, or -1 for one that is not read. */
    private readonly indexOf: Int32Array,
  ) {
    this.position = mesh.position;
    this.normal = new Float64Array(mesh.weldedCount * 3);
    this.normalDone = new Uint8Array(mesh.weldedCount);
    this.stamp = new Uint32Array(mesh.weldedCount);
  }

  reset(position: Float64Array) {
    this.position = position;
    this.normalDone.fill(0);
  }

  /**
   * Fits the surface within `scale` of anchor `v`, then adds each free vertex within `2 * reach`
   * of it its projection onto the fit, weighted, and marks those within `reach` covered.
   */
  anchor(
    v: number,
    scale: number,
    reach: number,
    free: Uint8Array,
    covered: Uint8Array,
    sum: Float64Array,
    total: Float64Array,
  ) {
    const count = this.gather(v, scale);
    const fitted = this.fit(count, scale);
    const { position, frame, coefficients } = this;
    const px = position[v * 3],
      py = position[v * 3 + 1],
      pz = position[v * 3 + 2];
    const [nx, ny, nz, ux, uy, uz, wx, wy, wz] = frame;
    const [c0, c1, c2, c3, c4, c5] = coefficients;
    const inverse = 1 / scale;
    const near = reach * reach,
      far = 4 * near;
    const blended = this.gather(v, 2 * reach);
    const { gathered, offset, indexOf } = this;
    for (let g = 0; g < blended; g++) {
      const i = indexOf[gathered[g]];
      if (!free[i]) continue;
      const dx = offset[g * 3],
        dy = offset[g * 3 + 1],
        dz = offset[g * 3 + 2];
      const d = dx * dx + dy * dy + dz * dz;
      if (d < near) covered[i] = 1;
      if (!fitted) continue;
      const x = (dx * ux + dy * uy + dz * uz) * inverse,
        y = (dx * wx + dy * wy + dz * wz) * inverse,
        h = (dx * nx + dy * ny + dz * nz) * inverse;
      const lift = (c0 + c1 * x + c2 * y + c3 * x * x + c4 * x * y + c5 * y * y - h) * scale;
      const t = 1 - d / far;
      const weight = t * t;
      sum[i * 3] += weight * (px + dx + lift * nx);
      sum[i * 3 + 1] += weight * (py + dy + lift * ny);
      sum[i * 3 + 2] += weight * (pz + dz + lift * nz);
      total[i] += weight;
    }
  }

  /**
   * Walks out from `v` over the surface to the vertices within `radius` of it, not through a
   * barrier vertex, into `gathered`, with their offsets from it in `offset`. Returns how many.
   */
  private gather(v: number, radius: number) {
    const { position, barrier, stamp, indexOf } = this;
    const { neighbourStart, neighbours } = this.topology;
    const px = position[v * 3],
      py = position[v * 3 + 1],
      pz = position[v * 3 + 2];
    const reach = radius * radius;
    const mark = ++this.mark;
    stamp[v] = mark;
    let { gathered, offset } = this;
    gathered[0] = v;
    offset[0] = offset[1] = offset[2] = 0;
    let count = 1;
    for (let g = 0; g < count; g++) {
      const w = gathered[g];
      if (g > 0 && barrier[w]) continue;
      for (let j = neighbourStart[w]; j < neighbourStart[w + 1]; j++) {
        const k = neighbours[j];
        if (stamp[k] === mark || indexOf[k] < 0) continue;
        stamp[k] = mark;
        const dx = position[k * 3] - px,
          dy = position[k * 3 + 1] - py,
          dz = position[k * 3 + 2] - pz;
        if (dx * dx + dy * dy + dz * dz >= reach) continue;
        if (count === gathered.length) {
          this.gathered = gathered = grow(gathered, count * 2);
          this.offset = offset = grow(offset, count * 6);
        }
        gathered[count] = k;
        offset[count * 3] = dx;
        offset[count * 3 + 1] = dy;
        offset[count * 3 + 2] = dz;
        count++;
      }
    }
    return count;
  }

  /** Fits the quadric to the `count` gathered vertices into `frame` and `coefficients`. */
  private fit(count: number, scale: number): boolean {
    const { gathered, offset, normal } = this;
    let nx = 0,
      ny = 0,
      nz = 0;
    for (let g = 0; g < count; g++) {
      const w = gathered[g];
      if (!this.normalDone[w]) this.computeNormal(w);
      nx += normal[w * 3];
      ny += normal[w * 3 + 1];
      nz += normal[w * 3 + 2];
    }
    const length = Math.hypot(nx, ny, nz);
    if (count < 6 || length < 1e-12) return false;
    nx /= length;
    ny /= length;
    nz /= length;
    const helperX = Math.abs(nx) < 0.6 ? 1 : 0,
      helperY = 1 - helperX;
    let ux = -nz * helperY,
      uy = nz * helperX,
      uz = nx * helperY - ny * helperX;
    const ul = Math.hypot(ux, uy, uz);
    ux /= ul;
    uy /= ul;
    uz /= ul;
    const wx = ny * uz - nz * uy,
      wy = nz * ux - nx * uz,
      wz = nx * uy - ny * ux;
    this.frame.set([nx, ny, nz, ux, uy, uz, wx, wy, wz]);
    // Weighted sums of the monomials 1, x, y, x^2, xy, y^2, their products, and with the height.
    let s0 = 0,
      sx = 0,
      sy = 0,
      sxx = 0,
      sxy = 0,
      syy = 0,
      sxxx = 0,
      sxxy = 0,
      sxyy = 0,
      syyy = 0,
      sxxxx = 0,
      sxxxy = 0,
      sxxyy = 0,
      sxyyy = 0,
      syyyy = 0,
      h0 = 0,
      hx = 0,
      hy = 0,
      hxx = 0,
      hxy = 0,
      hyy = 0;
    // Coordinates in units of `scale` keep the normal equations well conditioned.
    const inverse = 1 / scale;
    for (let g = 0; g < count; g++) {
      const dx = offset[g * 3],
        dy = offset[g * 3 + 1],
        dz = offset[g * 3 + 2];
      const x = (dx * ux + dy * uy + dz * uz) * inverse,
        y = (dx * wx + dy * wy + dz * wz) * inverse,
        h = (dx * nx + dy * ny + dz * nz) * inverse;
      const xx = x * x,
        xy = x * y,
        yy = y * y;
      s0++;
      sx += x;
      sy += y;
      sxx += xx;
      sxy += xy;
      syy += yy;
      sxxx += xx * x;
      sxxy += xx * y;
      sxyy += xy * y;
      syyy += yy * y;
      sxxxx += xx * x * x;
      sxxxy += xx * x * y;
      sxxyy += xx * y * y;
      sxyyy += xy * y * y;
      syyyy += yy * y * y;
      h0 += h;
      hx += h * x;
      hy += h * y;
      hxx += h * x * x;
      hxy += h * x * y;
      hyy += h * y * y;
    }
    // prettier-ignore
    this.matrix.set([
      s0, sx, sy, sxx, sxy, syy,
      sx, sxx, sxy, sxxx, sxxy, sxyy,
      sy, sxy, syy, sxxy, sxyy, syyy,
      sxx, sxxx, sxxy, sxxxx, sxxxy, sxxyy,
      sxy, sxxy, sxyy, sxxxy, sxxyy, sxyyy,
      syy, sxyy, syyy, sxxyy, sxyyy, syyyy,
    ]);
    this.rhs.set([h0, hx, hy, hxx, hxy, hyy]);
    return solve6(this.matrix, this.rhs, this.coefficients);
  }

  /** Area-weighted vertex normal of `w` at the current positions, cached. */
  private computeNormal(w: number) {
    const { normal, position, mesh } = this;
    const { triangleStart, trianglesOf } = this.topology;
    const { corners, weldOf } = mesh;
    let x = 0,
      y = 0,
      z = 0;
    for (let i = triangleStart[w]; i < triangleStart[w + 1]; i++) {
      const t = trianglesOf[i] * 3;
      const a = weldOf[corners[t]] * 3,
        b = weldOf[corners[t + 1]] * 3,
        c = weldOf[corners[t + 2]] * 3;
      const e1x = position[b] - position[a],
        e1y = position[b + 1] - position[a + 1],
        e1z = position[b + 2] - position[a + 2];
      const e2x = position[c] - position[a],
        e2y = position[c + 1] - position[a + 1],
        e2z = position[c + 2] - position[a + 2];
      x += e1y * e2z - e1z * e2y;
      y += e1z * e2x - e1x * e2z;
      z += e1x * e2y - e1y * e2x;
    }
    const length = (mesh.flipped ? -1 : 1) * (Math.hypot(x, y, z) || 1);
    normal[w * 3] = x / length;
    normal[w * 3 + 1] = y / length;
    normal[w * 3 + 2] = z / length;
    this.normalDone[w] = 1;
  }
}

/** Solves the 6 x 6 system into `x` by Gaussian elimination with pivoting; false if singular. */
function solve6(a: Float64Array, b: Float64Array, x: Float64Array) {
  const n = 6;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++)
      if (Math.abs(a[r * n + col]) > Math.abs(a[pivot * n + col])) pivot = r;
    if (Math.abs(a[pivot * n + col]) < 1e-12) return false;
    if (pivot !== col) {
      for (let c = 0; c < n; c++) {
        const t = a[col * n + c];
        a[col * n + c] = a[pivot * n + c];
        a[pivot * n + c] = t;
      }
      const t = b[col];
      b[col] = b[pivot];
      b[pivot] = t;
    }
    for (let r = col + 1; r < n; r++) {
      const f = a[r * n + col] / a[col * n + col];
      if (f === 0) continue;
      for (let c = col; c < n; c++) a[r * n + c] -= f * a[col * n + c];
      b[r] -= f * b[col];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < n; c++) s -= a[r * n + c] * x[c];
    x[r] = s / a[r * n + r];
  }
  return x.every(Number.isFinite);
}

function grow<T extends Uint32Array | Float64Array>(array: T, length: number): T {
  const grown = new (array.constructor as new (length: number) => T)(length);
  grown.set(array);
  return grown;
}
