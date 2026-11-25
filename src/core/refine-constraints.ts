import { Matrix, pseudoInverse } from 'ml-matrix';
import type { GuidePoint } from './refine-band';
import type { GuideKind } from './refine-curve';
import { type SketchPlane, planeCoordinates, planePoint } from './refine-sketch';
import type { Vec3 } from './types';

/** Constraints between two segments of a guide. */
export type PairKind =
  'parallel' | 'perpendicular' | 'collinear' | 'equal' | 'tangent' | 'concentric';
/** Constraints on one line of a guide. */
export type LineKind = 'horizontal' | 'vertical';
/** A point of a guide, by segment and index; a point two segments share is either. */
export interface PointRef {
  segment: number;
  index: number;
}
/**
 * A constraint of a guide on a sketch plane, solved in the plane's (u, v): between two segments;
 * on one line, along u (horizontal) or v (vertical); or a point level with another, its v taken
 * (horizontal) or its u (vertical). A fixed point is the point's own lock.
 */
export type GuideConstraint =
  | { id: string; kind: PairKind; segments: [number, number] }
  | { id: string; kind: LineKind; segments: [number] }
  | { id: string; kind: 'align'; axis: LineKind; points: [PointRef, PointRef] };

export const pairKinds: PairKind[] = [
  'parallel',
  'perpendicular',
  'collinear',
  'equal',
  'tangent',
  'concentric',
];
export const constraintLabels: Record<GuideConstraint['kind'], string> = {
  parallel: 'Parallel',
  perpendicular: 'Perpendicular',
  collinear: 'Collinear',
  equal: 'Equal',
  tangent: 'Tangent',
  concentric: 'Concentric',
  horizontal: 'Horizontal',
  vertical: 'Vertical',
  align: 'Align',
};

/** The most any constraint may miss by, mm, for a solve to count. */
export const constraintTolerance = 1e-6;
/** Weight of the moved point's coordinates against the others' in the least change. */
const movedWeight = 1e4;
const iterations = 200;

/** A guide's points and segments as a constraint solve reads them. */
export interface GuideShape {
  segments: { kind: GuideKind; points: GuidePoint[] }[];
  plane?: SketchPlane | null;
  constraints?: GuideConstraint[];
}

/** Whether two guide points are one: the same triangle and position. */
export const samePoint = (a: GuidePoint, b: GuidePoint) =>
  a.triangle === b.triangle && a.position.every((x, k) => x === b.position[k]);

/** Whether a pair constraint applies to two segments of these kinds. */
export function pairFits(kind: PairKind, a: GuideKind, b: GuideKind) {
  const lines = a === 'line' && b === 'line',
    arcs = a === 'arc' && b === 'arc';
  switch (kind) {
    case 'parallel':
    case 'perpendicular':
    case 'collinear':
      return lines;
    case 'equal':
      return lines || arcs;
    case 'tangent':
      return (a === 'line' && b === 'arc') || (a === 'arc' && b === 'line') || arcs;
    case 'concentric':
      return arcs;
  }
}

/** The point two segments share, as an index of each, or null. */
export function sharedPoint(shape: GuideShape, i: number, j: number) {
  const [a, b] = [shape.segments[i].points, shape.segments[j].points];
  for (const [p, x] of a.entries())
    for (const [q, y] of b.entries()) if (samePoint(x, y)) return [p, q] as const;
  return null;
}

/** Why a constraint cannot be put on the guide, or null when it can. */
export function constraintRefusal(shape: GuideShape, constraint: GuideConstraint): string | null {
  if (!shape.plane)
    return 'Constraints hold on a guide on a sketch plane. Lock the guide to a plane.';
  const kindOf = (i: number) => shape.segments[i]?.kind;
  if (constraint.kind === 'align') {
    const [p, q] = constraint.points.map((r) => shape.segments[r.segment]?.points[r.index]);
    if (!p || !q) return 'Pick a point of the same guide.';
    return samePoint(p, q) ? 'Pick another point to align with.' : null;
  }
  if (constraint.kind === 'horizontal' || constraint.kind === 'vertical')
    return kindOf(constraint.segments[0]) === 'line'
      ? null
      : 'Only a line can be horizontal or vertical.';
  const [i, j] = constraint.segments as [number, number];
  if (i === j || kindOf(i) === undefined || kindOf(j) === undefined)
    return 'Pick another segment of the same guide.';
  if (!pairFits(constraint.kind, kindOf(i)!, kindOf(j)!))
    return `${constraintLabels[constraint.kind]} does not apply to a ${kindOf(i)} and a ${kindOf(j)}.`;
  if (constraint.kind === 'tangent' && !sharedPoint(shape, i, j))
    return 'Tangent applies to two segments that meet.';
  return null;
}

/** Circumcentre and radius of three 2D points; null when they are in a line. */
function circle2(a: number[], b: number[], c: number[]) {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (!(Math.abs(d) > 1e-12)) return null;
  const sq = (p: number[]) => p[0] * p[0] + p[1] * p[1];
  const x = (sq(a) * (b[1] - c[1]) + sq(b) * (c[1] - a[1]) + sq(c) * (a[1] - b[1])) / d;
  const y = (sq(a) * (c[0] - b[0]) + sq(b) * (a[0] - c[0]) + sq(c) * (b[0] - a[0])) / d;
  return { centre: [x, y], radius: Math.hypot(a[0] - x, a[1] - y) };
}

/** What a solve is asked for: a point moved toward a target, and points held heavily in place. */
export interface SolveRequest {
  moved?: { point: GuidePoint; target: Vec3 };
  /** Points that move as little as the moved one; a fixed point never moves. */
  heavy?: GuidePoint[];
}

/**
 * The guide's points solved so that every constraint, and every point's line lock, holds within
 * `constraintTolerance`, in the plane's (u, v): the moved point as near its target as they allow,
 * the rest moved as little as possible, fixed points not at all. The new position of each of the
 * guide's points, by its index in `points`, or null when the constraints cannot all hold.
 */
export function solveGuide(shape: GuideShape, request: SolveRequest = {}) {
  const plane = shape.plane;
  const constraints = shape.constraints ?? [];
  // Each distinct point once.
  const points: GuidePoint[] = [];
  const indexOf = (p: GuidePoint) => {
    const k = points.findIndex((q) => samePoint(q, p));
    if (k >= 0) return k;
    points.push(p);
    return points.length - 1;
  };
  const ids = shape.segments.map((s) => s.points.map(indexOf));
  const moved = request.moved ? indexOf(request.moved.point) : -1;
  const heavy = new Set((request.heavy ?? []).map(indexOf));
  if (!plane) {
    if (moved < 0) return points.map((p) => p.position);
    return points.map((p, k) => (k === moved ? request.moved!.target : p.position));
  }
  const n = points.length;
  const start = points.map((p) => planeCoordinates(plane, p.position));
  if (moved >= 0) start[moved] = planeCoordinates(plane, request.moved!.target);
  const fixed = points.map((p) => p.lock?.kind === 'fixed');
  // Variables: u and v of every point that is not fixed.
  const slot = new Int32Array(n).fill(-1);
  let count = 0;
  for (let k = 0; k < n; k++) if (!fixed[k]) slot[k] = count++;
  const weight = new Float64Array(count * 2).fill(1);
  for (let k = 0; k < n; k++)
    if (slot[k] >= 0 && (k === moved || heavy.has(k)))
      weight[slot[k] * 2] = weight[slot[k] * 2 + 1] = movedWeight;
  const coordinates = (x: Float64Array) =>
    start.map((p, k) => (slot[k] < 0 ? p : [x[slot[k] * 2], x[slot[k] * 2 + 1]]));
  const lines = points.map((p) => {
    if (p.lock?.kind !== 'line') return null;
    const o = planeCoordinates(plane, p.lock.origin);
    const e = planeCoordinates(plane, [
      p.lock.origin[0] + p.lock.direction[0],
      p.lock.origin[1] + p.lock.direction[1],
      p.lock.origin[2] + p.lock.direction[2],
    ]);
    const d = [e[0] - o[0], e[1] - o[1]];
    const length = Math.hypot(d[0], d[1]);
    return length > 1e-12 ? { o, d: [d[0] / length, d[1] / length] } : null;
  });
  const residuals = (x: Float64Array) => {
    const p = coordinates(x);
    const out: number[] = [];
    const ends = (s: number) => [p[ids[s][0]], p[ids[s][ids[s].length - 1]]];
    const direction = (s: number) => {
      const [a, b] = ends(s);
      return [b[0] - a[0], b[1] - a[1]];
    };
    const unitOf = (d: number[]) => {
      const length = Math.hypot(d[0], d[1]) || 1;
      return [d[0] / length, d[1] / length];
    };
    const arc = (s: number) => {
      const q = ids[s];
      return circle2(p[q[0]], p[q[q.length >> 1]], p[q[q.length - 1]]);
    };
    for (const [k, line] of lines.entries())
      if (line && slot[k] >= 0)
        out.push(line.d[0] * (p[k][1] - line.o[1]) - line.d[1] * (p[k][0] - line.o[0]));
    for (const c of constraints) {
      if (c.kind === 'align') {
        const [a, b] = c.points.map((r) => p[ids[r.segment][r.index]]);
        out.push(c.axis === 'horizontal' ? a[1] - b[1] : a[0] - b[0]);
        continue;
      }
      if (c.kind === 'horizontal' || c.kind === 'vertical') {
        const d = direction(c.segments[0]);
        out.push(c.kind === 'horizontal' ? d[1] : d[0]);
        continue;
      }
      const [i, j] = c.segments as [number, number];
      const [si, sj] = [shape.segments[i].kind, shape.segments[j].kind];
      if (c.kind === 'parallel' || c.kind === 'perpendicular') {
        const [a, b] = [unitOf(direction(i)), direction(j)];
        out.push(c.kind === 'parallel' ? a[0] * b[1] - a[1] * b[0] : a[0] * b[0] + a[1] * b[1]);
      } else if (c.kind === 'collinear') {
        const a = unitOf(direction(i));
        const o = ends(i)[0];
        for (const q of ends(j)) out.push(a[0] * (q[1] - o[1]) - a[1] * (q[0] - o[0]));
      } else if (c.kind === 'equal') {
        if (si === 'line') out.push(Math.hypot(...direction(i)) - Math.hypot(...direction(j)));
        else out.push((arc(i)?.radius ?? NaN) - (arc(j)?.radius ?? NaN));
      } else if (c.kind === 'concentric') {
        const [a, b] = [arc(i), arc(j)];
        out.push((a?.centre[0] ?? NaN) - (b?.centre[0] ?? NaN));
        out.push((a?.centre[1] ?? NaN) - (b?.centre[1] ?? NaN));
      } else if (c.kind === 'tangent') {
        const shared = sharedPoint(shape, i, j);
        if (!shared) {
          out.push(NaN);
          continue;
        }
        const at = p[ids[i][shared[0]]];
        if (si === 'line' || sj === 'line') {
          const [line, round] = si === 'line' ? [i, j] : [j, i];
          const d = unitOf(direction(line));
          const centre = arc(round)?.centre ?? [NaN, NaN];
          out.push(d[0] * (at[0] - centre[0]) + d[1] * (at[1] - centre[1]));
        } else {
          const [a, b] = [arc(i)?.centre ?? [NaN, NaN], arc(j)?.centre ?? [NaN, NaN]];
          const [ra, rb] = [
            [at[0] - a[0], at[1] - a[1]],
            [at[0] - b[0], at[1] - b[1]],
          ];
          out.push((ra[0] * rb[1] - ra[1] * rb[0]) / (Math.hypot(rb[0], rb[1]) || 1));
        }
      }
    }
    return out;
  };
  const x = new Float64Array(count * 2);
  for (let k = 0; k < n; k++) if (slot[k] >= 0) [x[slot[k] * 2], x[slot[k] * 2 + 1]] = start[k];
  const largest = (r: number[]) => r.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  let r = residuals(x);
  const solved = () => r.every((v) => Number.isFinite(v)) && largest(r) <= constraintTolerance / 10;
  const squares = (values: number[]) => values.reduce((sum, v) => sum + v * v, 0);
  let damping = 1e-3;
  for (let step = 0; step < iterations && r.length && count && !solved(); step++) {
    if (!r.every((v) => Number.isFinite(v))) return null;
    // Jacobian by central differences.
    const m = r.length,
      h = 1e-7;
    const jacobian = Array.from({ length: m }, () => new Float64Array(count * 2));
    for (let v = 0; v < count * 2; v++) {
      const keep = x[v];
      x[v] = keep + h;
      const ahead = residuals(x);
      x[v] = keep - h;
      const behind = residuals(x);
      x[v] = keep;
      for (let i = 0; i < m; i++) jacobian[i][v] = (ahead[i] - behind[i]) / (2 * h);
    }
    // The least weighted change, damped: dx = -W^-1 J^T (J W^-1 J^T + lambda I)^+ r. The
    // pseudo-inverse passes over constraints that repeat others, as two arcs tangent to two
    // parallel lines make their radii equal already; the damping grows while a step would make the
    // miss larger, so the guide eases into shape rather than collapsing into a degenerate one.
    const a = Array.from({ length: m }, (_, i) =>
      Array.from({ length: m }, (_, j) => {
        let sum = 0;
        for (let v = 0; v < count * 2; v++) sum += (jacobian[i][v] * jacobian[j][v]) / weight[v];
        return sum;
      }),
    );
    const scale = Math.max(1e-12, ...a.map((row, i) => Math.abs(row[i])));
    const before = squares(r);
    const from = Float64Array.from(x);
    let improved = false;
    for (let tries = 0; tries < 30 && !improved; tries++) {
      const damped = a.map((row, i) =>
        row.map((value, j) => value + (i === j ? damping * scale : 0)),
      );
      const b = pseudoInverse(new Matrix(damped), 1e-12 * scale)
        .mmul(Matrix.columnVector(r))
        .to1DArray();
      for (let v = 0; v < count * 2; v++) {
        let sum = 0;
        for (let i = 0; i < m; i++) sum += jacobian[i][v] * b[i];
        x[v] = from[v] - sum / weight[v];
      }
      const next = residuals(x);
      if (next.every((v) => Number.isFinite(v)) && squares(next) < before) {
        r = next;
        improved = true;
        damping = Math.max(1e-12, damping / 4);
      } else damping *= 4;
    }
    if (!improved) {
      x.set(from);
      break;
    }
  }
  if (r.length && !solved()) return null;
  const solvedAt = coordinates(x);
  return points.map((p, k): Vec3 =>
    slot[k] < 0 ? p.position : planePoint(plane, solvedAt[k][0], solvedAt[k][1]),
  );
}

/**
 * The guide's segments with every point at its solved position, or null when the constraints
 * cannot hold. `place` gives each moved point its triangle.
 */
export function solvedSegments<S extends GuideShape>(
  shape: S,
  request: SolveRequest,
  place: (from: GuidePoint, position: Vec3) => GuidePoint,
): S['segments'] | null {
  const solved = solveGuide(shape, request);
  if (!solved) return null;
  const points: GuidePoint[] = [];
  for (const s of shape.segments)
    for (const p of s.points) if (!points.some((q) => samePoint(q, p))) points.push(p);
  const moved = points.map((p, k) =>
    solved[k].every((x, a) => x === p.position[a]) ? p : place(p, solved[k]),
  );
  return shape.segments.map((s) => ({
    ...s,
    points: s.points.map((p) => moved[points.findIndex((q) => samePoint(q, p))]),
  }));
}
