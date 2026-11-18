import type { Vec3 } from './types';
import type { WarpGrid } from './warp-grid';

export interface WarpConstraint {
  node: ArrayLike<number>;
  weight: ArrayLike<number>;
  /** World rest position of the constrained point. */
  rest: Vec3;
  target: Vec3;
  restByNode?: Vec3[];
  fixed?: Vec3;
}

/**
 * Soft per-node targets: each entry adds `stiffness × |p − target|²` to the energy. Nodes and
 * stiffnesses shape the system; targets may change every frame without rebuilding it.
 */
export interface WarpGuides {
  node: ArrayLike<number>;
  stiffness: ArrayLike<number>;
  /** World target per entry, three values each. */
  target: ArrayLike<number>;
}

export interface WarpState {
  /** World position per node. */
  positions: Float64Array;
  /** Rotation quaternion (x, y, z, w) per node. */
  rotations: Float64Array;
}

export const warpConstraintStrength = 1000;
export const warpDragIterations = 3;
export const warpSettleIterations = 50;
export const warpSettleTolerance = 1e-4;

/**
 * How firmly a node's skin map holds to its rotation where its grid edges do not fix the stretch,
 * as a share of the edges' summed squared length.
 */
export const warpStretchRidge = 0.01;

const rotationIterations = 20;
const solverTolerance = 1e-8;
const solverIterations = 200;

export function createWarpState(restNodes: Float64Array): WarpState {
  const rotations = new Float64Array((restNodes.length / 3) * 4);
  for (let i = 3; i < rotations.length; i += 4) rotations[i] = 1;
  return { positions: restNodes.slice(), rotations };
}

/**
 * Global-step matrix over the free nodes for one grid and one set of constraint nodes and
 * weights. The unknowns are displacements from rest, so fixed nodes contribute nothing.
 */
interface WarpSystem {
  /** Per valid constraint: its index, entry count, nodes, then their weights. */
  key: Float64Array;
  /** Guide nodes, then their stiffnesses. */
  guideKey: Float64Array;
  /** Matrix row of each node, -1 when fixed. */
  row: Int32Array;
  /** Node of each matrix row. */
  freeNodes: Uint32Array;
  diagonal: Float64Array;
  inverseDiagonal: Float64Array;
  /** Off-diagonal entries in CSR. */
  rowStart: Uint32Array;
  columns: Uint32Array;
  values: Float64Array;
  /** Row-major rotation matrix per node. */
  rotation: Float64Array;
  rhs: Float64Array;
  x: Float64Array;
  r: Float64Array;
  z: Float64Array;
  p: Float64Array;
  q: Float64Array;
}

const systems = new WeakMap<WarpGrid, WarpSystem>();

/**
 * What each valid constraint adds to the system. A skinned point is linear in the node positions
 * for given rotations: Σ_k a_k p_k + Σ_n R_n r_n. The coefficients `a_k`, over the bound nodes and
 * their grid neighbours, shape the matrix; `rotated` holds the r_n, and `rest` is Σ a_k g_k.
 */
interface ConstraintTerm {
  index: number;
  rotatedNode: number[];
  rotated: number[];
  rest: Vec3;
}

/** The key of the system's constraint rows: per valid constraint, its index, count, nodes, a_k. */
function constraintTerms(
  constraints: WarpConstraint[],
  grid: WarpGrid,
  restNodes: Float64Array,
): { key: number[]; terms: ConstraintTerm[] } {
  const key: number[] = [],
    terms: ConstraintTerm[] = [];
  const { edgeStart, edges } = grid;
  const inverse = stretchInverse(grid, restNodes);
  for (let c = 0; c < constraints.length; c++) {
    const { node, weight, rest, restByNode } = constraints[c];
    let sum = 0;
    for (let k = 0; k < node.length; k++) sum += weight[k];
    if (!Number.isFinite(sum) || sum === 0) continue;
    const coefficient = new Map<number, number>();
    const add = (n: number, a: number) => coefficient.set(n, (coefficient.get(n) ?? 0) + a);
    const term: ConstraintTerm = { index: c, rotatedNode: [], rotated: [], rest: [0, 0, 0] };
    for (let k = 0; k < node.length; k++) {
      const n = node[k],
        w = restByNode ? weight[k] : weight[k] / sum;
      const p = restByNode?.[k] ?? rest;
      const ox = p[0] - restNodes[n * 3],
        oy = p[1] - restNodes[n * 3 + 1],
        oz = p[2] - restNodes[n * 3 + 2];
      add(n, w);
      term.rotatedNode.push(n);
      const i = n * 9;
      if (!stretches(grid, inverse, n)) {
        term.rotated.push(w * ox, w * oy, w * oz);
        continue;
      }
      // S_n o = Σ_j (p_n − p_j)(e_j · B o) + μ R_n B o, with B = (E + μI)⁻¹.
      const bx = inverse[i] * ox + inverse[i + 1] * oy + inverse[i + 2] * oz,
        by = inverse[i + 3] * ox + inverse[i + 4] * oy + inverse[i + 5] * oz,
        bz = inverse[i + 6] * ox + inverse[i + 7] * oy + inverse[i + 8] * oz;
      let mu = 0;
      for (let e = edgeStart[n]; e < edgeStart[n + 1]; e++) {
        const j = edges[e];
        const ex = restNodes[n * 3] - restNodes[j * 3],
          ey = restNodes[n * 3 + 1] - restNodes[j * 3 + 1],
          ez = restNodes[n * 3 + 2] - restNodes[j * 3 + 2];
        mu += ex * ex + ey * ey + ez * ez;
        const a = w * (ex * bx + ey * by + ez * bz);
        add(n, a);
        add(j, -a);
      }
      mu *= warpStretchRidge * w;
      term.rotated.push(mu * bx, mu * by, mu * bz);
    }
    key.push(c, coefficient.size);
    for (const n of coefficient.keys()) key.push(n);
    for (const [n, a] of coefficient) {
      key.push(a);
      for (let d = 0; d < 3; d++) term.rest[d] += a * restNodes[n * 3 + d];
    }
    terms.push(term);
  }
  return { key, terms };
}

function guideKey(guides: WarpGuides | undefined) {
  const key: number[] = [];
  if (!guides) return key;
  const { node, stiffness } = guides;
  for (let g = 0; g < node.length; g++) key.push(node[g]);
  for (let g = 0; g < node.length; g++) key.push(stiffness[g]);
  return key;
}

function sameKey(a: Float64Array, b: number[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function buildSystem(grid: WarpGrid, key: number[], guides: number[]): WarpSystem {
  const { fixed, edgeStart, edges } = grid;
  const count = fixed.length;
  const row = new Int32Array(count).fill(-1);
  let free = 0;
  for (let n = 0; n < count; n++) if (!fixed[n]) row[n] = free++;
  const freeNodes = new Uint32Array(free);
  const diagonal = new Float64Array(free);
  for (let n = 0; n < count; n++)
    if (row[n] >= 0) {
      freeNodes[row[n]] = n;
      diagonal[row[n]] = 2 * (edgeStart[n + 1] - edgeStart[n]);
    }

  const coupled = new Map<number, Map<number, number>>();
  for (let i = 0; i < key.length;) {
    const length = key[i + 1];
    const nodes = i + 2,
      weights = nodes + length;
    for (let a = 0; a < length; a++) {
      const ra = row[key[nodes + a]];
      if (ra < 0) continue;
      for (let b = 0; b < length; b++) {
        const rb = row[key[nodes + b]];
        if (rb < 0) continue;
        const value = warpConstraintStrength * key[weights + a] * key[weights + b];
        if (ra === rb) diagonal[ra] += value;
        else {
          let entries = coupled.get(ra);
          if (!entries) coupled.set(ra, (entries = new Map()));
          entries.set(rb, (entries.get(rb) ?? 0) + value);
        }
      }
    }
    i = weights + length;
  }
  const guided = guides.length / 2;
  for (let g = 0; g < guided; g++) {
    const k = row[guides[g]];
    if (k >= 0) diagonal[k] += guides[guided + g];
  }

  const rowStart = new Uint32Array(free + 1);
  const columns: number[] = [];
  const values: number[] = [];
  for (let k = 0; k < free; k++) {
    const n = freeNodes[k];
    const entries = coupled.get(k);
    for (let e = edgeStart[n]; e < edgeStart[n + 1]; e++) {
      const column = row[edges[e]];
      if (column < 0) continue;
      columns.push(column);
      values.push(-2 + (entries?.get(column) ?? 0));
      entries?.delete(column);
    }
    if (entries)
      for (const [column, value] of entries) {
        columns.push(column);
        values.push(value);
      }
    rowStart[k + 1] = columns.length;
  }

  const inverseDiagonal = new Float64Array(free);
  for (let k = 0; k < free; k++) inverseDiagonal[k] = diagonal[k] > 0 ? 1 / diagonal[k] : 0;
  return {
    key: Float64Array.from(key),
    guideKey: Float64Array.from(guides),
    row,
    freeNodes,
    diagonal,
    inverseDiagonal,
    rowStart,
    columns: Uint32Array.from(columns),
    values: Float64Array.from(values),
    rotation: new Float64Array(count * 9),
    rhs: new Float64Array(free * 3),
    x: new Float64Array(free * 3),
    r: new Float64Array(free * 3),
    z: new Float64Array(free * 3),
    p: new Float64Array(free * 3),
    q: new Float64Array(free * 3),
  };
}

export function writeRotation(
  out: Float64Array,
  o: number,
  x: number,
  y: number,
  z: number,
  w: number,
) {
  out[o] = 1 - 2 * (y * y + z * z);
  out[o + 1] = 2 * (x * y - z * w);
  out[o + 2] = 2 * (x * z + y * w);
  out[o + 3] = 2 * (x * y + z * w);
  out[o + 4] = 1 - 2 * (x * x + z * z);
  out[o + 5] = 2 * (y * z - x * w);
  out[o + 6] = 2 * (x * z - y * w);
  out[o + 7] = 2 * (y * z + x * w);
  out[o + 8] = 1 - 2 * (x * x + y * y);
}

/** Right-hand side for the current rotations and targets. */
function assemble(
  grid: WarpGrid,
  system: WarpSystem,
  restNodes: Float64Array,
  constraints: WarpConstraint[],
  terms: ConstraintTerm[],
  guides: WarpGuides | undefined,
) {
  const { edgeStart, edges } = grid;
  const { key, row, freeNodes, rotation: R, rhs } = system;
  // Edges in both directions: Σ_j (R_i + R_j − 2I)(g_i − g_j).
  for (let k = 0; k < freeNodes.length; k++) {
    const i = freeNodes[k];
    const gx = restNodes[i * 3],
      gy = restNodes[i * 3 + 1],
      gz = restNodes[i * 3 + 2];
    let sx = 0,
      sy = 0,
      sz = 0,
      bx = 0,
      by = 0,
      bz = 0;
    for (let e = edgeStart[i]; e < edgeStart[i + 1]; e++) {
      const j = edges[e],
        m = j * 9;
      const ex = gx - restNodes[j * 3],
        ey = gy - restNodes[j * 3 + 1],
        ez = gz - restNodes[j * 3 + 2];
      sx += ex;
      sy += ey;
      sz += ez;
      bx += R[m] * ex + R[m + 1] * ey + R[m + 2] * ez;
      by += R[m + 3] * ex + R[m + 4] * ey + R[m + 5] * ez;
      bz += R[m + 6] * ex + R[m + 7] * ey + R[m + 8] * ez;
    }
    const m = i * 9;
    rhs[k * 3] = bx + R[m] * sx + R[m + 1] * sy + R[m + 2] * sz - 2 * sx;
    rhs[k * 3 + 1] = by + R[m + 3] * sx + R[m + 4] * sy + R[m + 5] * sz - 2 * sy;
    rhs[k * 3 + 2] = bz + R[m + 6] * sx + R[m + 7] * sy + R[m + 8] * sz - 2 * sz;
  }

  // Constraints: λ a_k (t − Σ_k a_k g_k − Σ_n R_n r_n), the skinned point at rest displacement.
  for (let i = 0, c = 0; i < key.length; c++) {
    const { rotatedNode, rotated, rest } = terms[c];
    const { target, fixed } = constraints[terms[c].index];
    const length = key[i + 1];
    const nodes = i + 2,
      weights = nodes + length;
    let dx = target[0] - (fixed?.[0] ?? 0) - rest[0],
      dy = target[1] - (fixed?.[1] ?? 0) - rest[1],
      dz = target[2] - (fixed?.[2] ?? 0) - rest[2];
    for (let s = 0; s < rotatedNode.length; s++) {
      const m = rotatedNode[s] * 9;
      const ox = rotated[s * 3],
        oy = rotated[s * 3 + 1],
        oz = rotated[s * 3 + 2];
      dx -= R[m] * ox + R[m + 1] * oy + R[m + 2] * oz;
      dy -= R[m + 3] * ox + R[m + 4] * oy + R[m + 5] * oz;
      dz -= R[m + 6] * ox + R[m + 7] * oy + R[m + 8] * oz;
    }
    for (let s = 0; s < length; s++) {
      const k = row[key[nodes + s]];
      if (k < 0) continue;
      const f = warpConstraintStrength * key[weights + s];
      rhs[k * 3] += f * dx;
      rhs[k * 3 + 1] += f * dy;
      rhs[k * 3 + 2] += f * dz;
    }
    i = weights + length;
  }

  // Guides: s (t − g).
  if (guides)
    for (let g = 0; g < guides.node.length; g++) {
      const n = guides.node[g],
        k = row[n];
      if (k < 0) continue;
      const s = guides.stiffness[g];
      rhs[k * 3] += s * (guides.target[g * 3] - restNodes[n * 3]);
      rhs[k * 3 + 1] += s * (guides.target[g * 3 + 1] - restNodes[n * 3 + 1]);
      rhs[k * 3 + 2] += s * (guides.target[g * 3 + 2] - restNodes[n * 3 + 2]);
    }
}

/** q = A p; returns p·q per axis in `dot`. */
function multiply(system: WarpSystem, p: Float64Array, q: Float64Array, dot: number[]) {
  const { diagonal, rowStart, columns, values } = system;
  let d0 = 0,
    d1 = 0,
    d2 = 0;
  for (let k = 0, o = 0; k < diagonal.length; k++, o += 3) {
    const a = diagonal[k];
    let y0 = a * p[o],
      y1 = a * p[o + 1],
      y2 = a * p[o + 2];
    for (let e = rowStart[k]; e < rowStart[k + 1]; e++) {
      const c = columns[e] * 3,
        v = values[e];
      y0 += v * p[c];
      y1 += v * p[c + 1];
      y2 += v * p[c + 2];
    }
    q[o] = y0;
    q[o + 1] = y1;
    q[o + 2] = y2;
    d0 += p[o] * y0;
    d1 += p[o + 1] * y1;
    d2 += p[o + 2] * y2;
  }
  dot[0] = d0;
  dot[1] = d1;
  dot[2] = d2;
}

/**
 * Jacobi-preconditioned conjugate gradient, one recurrence per axis sharing each product,
 * starting from `x` and stopping when the residual over all axes is within tolerance of `rhs`.
 */
function conjugateGradient(system: WarpSystem) {
  const { inverseDiagonal: m, rhs, x, r, z, p, q } = system;
  const dot = [0, 0, 0];
  multiply(system, x, q, dot);
  let rz0 = 0,
    rz1 = 0,
    rz2 = 0,
    rr = 0,
    bb = 0;
  for (let k = 0, o = 0; k < m.length; k++, o += 3) {
    const r0 = rhs[o] - q[o],
      r1 = rhs[o + 1] - q[o + 1],
      r2 = rhs[o + 2] - q[o + 2];
    const z0 = r0 * m[k],
      z1 = r1 * m[k],
      z2 = r2 * m[k];
    r[o] = r0;
    r[o + 1] = r1;
    r[o + 2] = r2;
    z[o] = p[o] = z0;
    z[o + 1] = p[o + 1] = z1;
    z[o + 2] = p[o + 2] = z2;
    rz0 += r0 * z0;
    rz1 += r1 * z1;
    rz2 += r2 * z2;
    rr += r0 * r0 + r1 * r1 + r2 * r2;
    bb += rhs[o] * rhs[o] + rhs[o + 1] * rhs[o + 1] + rhs[o + 2] * rhs[o + 2];
  }
  const limit = solverTolerance * solverTolerance * bb;
  let on0 = true,
    on1 = true,
    on2 = true;
  for (let step = 0; step < solverIterations; step++) {
    if (rr <= limit) return;
    on0 &&= rz0 > 0;
    on1 &&= rz1 > 0;
    on2 &&= rz2 > 0;
    if (!on0 && !on1 && !on2) return;
    multiply(system, p, q, dot);
    on0 &&= dot[0] > 0;
    on1 &&= dot[1] > 0;
    on2 &&= dot[2] > 0;
    const a0 = on0 ? rz0 / dot[0] : 0,
      a1 = on1 ? rz1 / dot[1] : 0,
      a2 = on2 ? rz2 / dot[2] : 0;
    let n0 = 0,
      n1 = 0,
      n2 = 0;
    rr = 0;
    for (let k = 0, o = 0; k < m.length; k++, o += 3) {
      x[o] += a0 * p[o];
      x[o + 1] += a1 * p[o + 1];
      x[o + 2] += a2 * p[o + 2];
      const r0 = (r[o] -= a0 * q[o]),
        r1 = (r[o + 1] -= a1 * q[o + 1]),
        r2 = (r[o + 2] -= a2 * q[o + 2]);
      const z0 = (z[o] = r0 * m[k]),
        z1 = (z[o + 1] = r1 * m[k]),
        z2 = (z[o + 2] = r2 * m[k]);
      n0 += r0 * z0;
      n1 += r1 * z1;
      n2 += r2 * z2;
      rr += r0 * r0 + r1 * r1 + r2 * r2;
    }
    const b0 = on0 ? n0 / rz0 : 0,
      b1 = on1 ? n1 / rz1 : 0,
      b2 = on2 ? n2 / rz2 : 0;
    rz0 = n0;
    rz1 = n1;
    rz2 = n2;
    for (let o = 0; o < p.length; o += 3) {
      p[o] = z[o] + b0 * p[o];
      p[o + 1] = z[o + 1] + b1 * p[o + 1];
      p[o + 2] = z[o + 2] + b2 * p[o + 2];
    }
  }
}

const stretchFrames = new WeakMap<WarpGrid, { rest: Float64Array; inverse: Float64Array }>();

/** Per node, (E + μI)⁻¹ with E = Σ e eᵀ over its grid edges at rest and μ the ridge. */
function stretchInverse(grid: WarpGrid, restNodes: Float64Array) {
  let frame = stretchFrames.get(grid);
  if (frame?.rest === restNodes) return frame.inverse;
  const { edgeStart, edges } = grid;
  const count = edgeStart.length - 1;
  const inverse = new Float64Array(count * 9);
  for (let i = 0; i < count; i++) {
    let e00 = 0,
      e01 = 0,
      e02 = 0,
      e11 = 0,
      e12 = 0,
      e22 = 0;
    for (let e = edgeStart[i]; e < edgeStart[i + 1]; e++) {
      const j = edges[e];
      const x = restNodes[i * 3] - restNodes[j * 3],
        y = restNodes[i * 3 + 1] - restNodes[j * 3 + 1],
        z = restNodes[i * 3 + 2] - restNodes[j * 3 + 2];
      e00 += x * x;
      e01 += x * y;
      e02 += x * z;
      e11 += y * y;
      e12 += y * z;
      e22 += z * z;
    }
    const mu = warpStretchRidge * (e00 + e11 + e22);
    if (!(mu > 0)) continue;
    e00 += mu;
    e11 += mu;
    e22 += mu;
    const c00 = e11 * e22 - e12 * e12,
      c01 = e02 * e12 - e01 * e22,
      c02 = e01 * e12 - e02 * e11,
      c11 = e00 * e22 - e02 * e02,
      c12 = e01 * e02 - e00 * e12,
      c22 = e00 * e11 - e01 * e01;
    const det = e00 * c00 + e01 * c01 + e02 * c02;
    const o = i * 9;
    inverse[o] = c00 / det;
    inverse[o + 1] = inverse[o + 3] = c01 / det;
    inverse[o + 2] = inverse[o + 6] = c02 / det;
    inverse[o + 4] = c11 / det;
    inverse[o + 5] = inverse[o + 7] = c12 / det;
    inverse[o + 8] = c22 / det;
  }
  stretchFrames.set(grid, (frame = { rest: restNodes, inverse }));
  return inverse;
}

/** Whether node n's skin map stretches with its edges; otherwise it is its rotation. */
const stretches = (grid: WarpGrid, inverse: Float64Array, n: number) =>
  !grid.fixed[n] && grid.edgeStart[n] !== grid.edgeStart[n + 1] && inverse[n * 9] !== 0;

/**
 * Node n's skin map into `out` at `o`: the linear map that best carries its grid edges from rest
 * to `positions`, (Σ f eᵀ + μR)(Σ e eᵀ + μI)⁻¹, held toward its rotation R in directions the edges
 * do not span, such as the normal. Neighbouring nodes then agree on the vertices between them to
 * first order wherever the surface stretches, which their rotations alone cannot. A fixed node,
 * or one without edges, keeps its rotation.
 */
function writeSkinMap(
  grid: WarpGrid,
  restNodes: Float64Array,
  positions: ArrayLike<number>,
  rotation: Float64Array,
  r: number,
  inverse: Float64Array,
  n: number,
  out: Float64Array,
  o: number,
) {
  const { edgeStart, edges } = grid;
  const i = n * 9;
  if (!stretches(grid, inverse, n)) {
    for (let k = 0; k < 9; k++) out[o + k] = rotation[r + k];
    return;
  }
  let mu = 0,
    a00 = 0,
    a01 = 0,
    a02 = 0,
    a10 = 0,
    a11 = 0,
    a12 = 0,
    a20 = 0,
    a21 = 0,
    a22 = 0;
  const n3 = n * 3;
  for (let e = edgeStart[n]; e < edgeStart[n + 1]; e++) {
    const j3 = edges[e] * 3;
    const ex = restNodes[n3] - restNodes[j3],
      ey = restNodes[n3 + 1] - restNodes[j3 + 1],
      ez = restNodes[n3 + 2] - restNodes[j3 + 2];
    const fx = positions[n3] - positions[j3],
      fy = positions[n3 + 1] - positions[j3 + 1],
      fz = positions[n3 + 2] - positions[j3 + 2];
    mu += ex * ex + ey * ey + ez * ez;
    a00 += fx * ex;
    a01 += fx * ey;
    a02 += fx * ez;
    a10 += fy * ex;
    a11 += fy * ey;
    a12 += fy * ez;
    a20 += fz * ex;
    a21 += fz * ey;
    a22 += fz * ez;
  }
  mu *= warpStretchRidge;
  a00 += mu * rotation[r];
  a01 += mu * rotation[r + 1];
  a02 += mu * rotation[r + 2];
  a10 += mu * rotation[r + 3];
  a11 += mu * rotation[r + 4];
  a12 += mu * rotation[r + 5];
  a20 += mu * rotation[r + 6];
  a21 += mu * rotation[r + 7];
  a22 += mu * rotation[r + 8];
  const b = inverse;
  out[o] = a00 * b[i] + a01 * b[i + 3] + a02 * b[i + 6];
  out[o + 1] = a00 * b[i + 1] + a01 * b[i + 4] + a02 * b[i + 7];
  out[o + 2] = a00 * b[i + 2] + a01 * b[i + 5] + a02 * b[i + 8];
  out[o + 3] = a10 * b[i] + a11 * b[i + 3] + a12 * b[i + 6];
  out[o + 4] = a10 * b[i + 1] + a11 * b[i + 4] + a12 * b[i + 7];
  out[o + 5] = a10 * b[i + 2] + a11 * b[i + 5] + a12 * b[i + 8];
  out[o + 6] = a20 * b[i] + a21 * b[i + 3] + a22 * b[i + 6];
  out[o + 7] = a20 * b[i + 1] + a21 * b[i + 4] + a22 * b[i + 7];
  out[o + 8] = a20 * b[i + 2] + a21 * b[i + 5] + a22 * b[i + 8];
}

/**
 * Every node's skin map from `rotation` (row-major per node) and `positions`: what skinning and the
 * solver's model of a control point both apply to a node's offsets.
 */
export function writeSkinMaps(
  grid: WarpGrid,
  restNodes: Float64Array,
  positions: ArrayLike<number>,
  rotation: Float64Array,
  out: Float64Array,
) {
  const inverse = stretchInverse(grid, restNodes);
  for (let n = 0; n < grid.fixed.length; n++)
    writeSkinMap(grid, restNodes, positions, rotation, n * 9, inverse, n, out, n * 9);
}

/** One node's skin map, as `writeSkinMaps` gives it, from the state's quaternions. */
export function skinMapOf(
  grid: WarpGrid,
  restNodes: Float64Array,
  state: WarpState,
  n: number,
  out: Float64Array,
) {
  const { rotations: q, positions } = state;
  const rotation = new Float64Array(9);
  writeRotation(rotation, 0, q[n * 4], q[n * 4 + 1], q[n * 4 + 2], q[n * 4 + 3]);
  writeSkinMap(grid, restNodes, positions, rotation, 0, stretchInverse(grid, restNodes), n, out, 0);
  return out;
}

/**
 * Local step: per free node, the rotation of Σ_j (g'_i − g'_j)(g_i − g_j)ᵀ by Müller et al.
 * 2016, warm-started from the node's quaternion.
 */
function fitRotations(
  grid: WarpGrid,
  system: WarpSystem,
  restNodes: Float64Array,
  state: WarpState,
) {
  const { edgeStart, edges } = grid;
  const { freeNodes, rotation } = system;
  const { positions: P, rotations: Q } = state;
  for (let k = 0; k < freeNodes.length; k++) {
    const i = freeNodes[k];
    if (edgeStart[i] === edgeStart[i + 1]) continue;
    const i3 = i * 3;
    let a00 = 0,
      a01 = 0,
      a02 = 0,
      a10 = 0,
      a11 = 0,
      a12 = 0,
      a20 = 0,
      a21 = 0,
      a22 = 0;
    for (let e = edgeStart[i]; e < edgeStart[i + 1]; e++) {
      const j3 = edges[e] * 3;
      const ex = restNodes[i3] - restNodes[j3],
        ey = restNodes[i3 + 1] - restNodes[j3 + 1],
        ez = restNodes[i3 + 2] - restNodes[j3 + 2];
      const fx = P[i3] - P[j3],
        fy = P[i3 + 1] - P[j3 + 1],
        fz = P[i3 + 2] - P[j3 + 2];
      a00 += fx * ex;
      a01 += fx * ey;
      a02 += fx * ez;
      a10 += fy * ex;
      a11 += fy * ey;
      a12 += fy * ez;
      a20 += fz * ex;
      a21 += fz * ey;
      a22 += fz * ez;
    }
    let qx = Q[i * 4],
      qy = Q[i * 4 + 1],
      qz = Q[i * 4 + 2],
      qw = Q[i * 4 + 3];
    for (let s = 0; s < rotationIterations; s++) {
      const r00 = 1 - 2 * (qy * qy + qz * qz),
        r01 = 2 * (qx * qy - qz * qw),
        r02 = 2 * (qx * qz + qy * qw),
        r10 = 2 * (qx * qy + qz * qw),
        r11 = 1 - 2 * (qx * qx + qz * qz),
        r12 = 2 * (qy * qz - qx * qw),
        r20 = 2 * (qx * qz - qy * qw),
        r21 = 2 * (qy * qz + qx * qw),
        r22 = 1 - 2 * (qx * qx + qy * qy);
      // ω = Σ_c R_c × A_c / (|Σ_c R_c · A_c| + ε) over columns c.
      const scale =
        1 /
        (Math.abs(
          r00 * a00 +
            r10 * a10 +
            r20 * a20 +
            r01 * a01 +
            r11 * a11 +
            r21 * a21 +
            r02 * a02 +
            r12 * a12 +
            r22 * a22,
        ) +
          1e-9);
      const ox = (r10 * a20 - r20 * a10 + r11 * a21 - r21 * a11 + r12 * a22 - r22 * a12) * scale,
        oy = (r20 * a00 - r00 * a20 + r21 * a01 - r01 * a21 + r22 * a02 - r02 * a22) * scale,
        oz = (r00 * a10 - r10 * a00 + r01 * a11 - r11 * a01 + r02 * a12 - r12 * a02) * scale;
      const angle = Math.sqrt(ox * ox + oy * oy + oz * oz);
      if (angle < 1e-9) break;
      const sine = Math.sin(angle / 2) / angle,
        px = ox * sine,
        py = oy * sine,
        pz = oz * sine,
        pw = Math.cos(angle / 2);
      const nx = pw * qx + px * qw + py * qz - pz * qy,
        ny = pw * qy - px * qz + py * qw + pz * qx,
        nz = pw * qz + px * qy - py * qx + pz * qw,
        nw = pw * qw - px * qx - py * qy - pz * qz;
      const length = Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw);
      qx = nx / length;
      qy = ny / length;
      qz = nz / length;
      qw = nw / length;
    }
    Q[i * 4] = qx;
    Q[i * 4 + 1] = qy;
    Q[i * 4 + 2] = qz;
    Q[i * 4 + 3] = qw;
    writeRotation(rotation, i * 9, qx, qy, qz, qw);
  }
}

/**
 * Warm-starts from and updates `state`. Returns the largest node move in the last iteration, mm.
 * Several guides on one node add.
 */
export function solveWarp(
  grid: WarpGrid,
  restNodes: Float64Array,
  constraints: WarpConstraint[],
  state: WarpState,
  iterations: number,
  guides?: WarpGuides,
): number {
  const { key, terms } = constraintTerms(constraints, grid, restNodes);
  const guiding = guideKey(guides);
  if (!key.length && !guiding.length && !grid.fixed.includes(1)) return 0;
  let system = systems.get(grid);
  if (!system || !sameKey(system.key, key) || !sameKey(system.guideKey, guiding))
    systems.set(grid, (system = buildSystem(grid, key, guiding)));

  const { fixed } = grid;
  const { freeNodes, rotation, x } = system;
  const { positions, rotations } = state;
  for (let n = 0; n < fixed.length; n++) {
    const q = n * 4;
    if (fixed[n]) {
      positions[n * 3] = restNodes[n * 3];
      positions[n * 3 + 1] = restNodes[n * 3 + 1];
      positions[n * 3 + 2] = restNodes[n * 3 + 2];
      rotations[q] = rotations[q + 1] = rotations[q + 2] = 0;
      rotations[q + 3] = 1;
    }
    writeRotation(
      rotation,
      n * 9,
      rotations[q],
      rotations[q + 1],
      rotations[q + 2],
      rotations[q + 3],
    );
  }

  let largest = 0;
  for (let iteration = 0; iteration < iterations; iteration++) {
    assemble(grid, system, restNodes, constraints, terms, guides);
    for (let k = 0; k < freeNodes.length; k++) {
      const i3 = freeNodes[k] * 3;
      x[k * 3] = positions[i3] - restNodes[i3];
      x[k * 3 + 1] = positions[i3 + 1] - restNodes[i3 + 1];
      x[k * 3 + 2] = positions[i3 + 2] - restNodes[i3 + 2];
    }
    conjugateGradient(system);
    largest = 0;
    for (let k = 0; k < freeNodes.length; k++) {
      const i3 = freeNodes[k] * 3;
      const px = restNodes[i3] + x[k * 3],
        py = restNodes[i3 + 1] + x[k * 3 + 1],
        pz = restNodes[i3 + 2] + x[k * 3 + 2];
      const dx = px - positions[i3],
        dy = py - positions[i3 + 1],
        dz = pz - positions[i3 + 2];
      largest = Math.max(largest, Math.sqrt(dx * dx + dy * dy + dz * dz));
      positions[i3] = px;
      positions[i3 + 1] = py;
      positions[i3 + 2] = pz;
    }
    fitRotations(grid, system, restNodes, state);
  }
  return largest;
}
