import type { GuidePoint } from './refine-band';
import type { GuideJoint, GuideKind } from './refine-curve';
import { type RefineMesh, type RefineTopology, vertexNormal, weldedCorner } from './refine-mesh';
import { nextMark } from './refine-paint';
import {
  type Circle,
  corners,
  fitCircle,
  lineRms,
  onCircle,
  pointAt,
  principalAxes,
  stations,
} from './refine-polyline';
import type { Vec3 } from './types';

// Tracing a rough stroke onto the rounded edge beside it, then fitting that edge with lines and arcs.

/** The surface is read this many brush radii either side of the stroke. */
export const traceReach = 1.5;
/** Degrees the surface must turn across the stroke, from flank to flank, for a slice to hold an edge. */
const minTurn = 20;
/** Fraction of a slice's normals at each end of its turn left out as strays. */
const strayFraction = 0.1;
/** Degrees past which a vertex's normal faces away from the stroke's surface: the back of the part. */
const backAngle = 120;
/** Degrees the edge turns within a brush radius to count as a corner. */
const cornerTurn = 40;
/** Degrees between two pieces' directions where they meet within which the joint is smooth. */
const smoothTurn = 25;
/** Costs of a piece in the fewest-pieces fit: an arc is a little dearer than a line. */
const lineCost = 1;
const arcCost = 1.25;
/** A spline costs this, plus one per `splineReach` brush radii of its length. */
const splineCost = 3;
const splineReach = 6;
/** Most degrees an arc piece may sweep; a whole ring is a closed path of one arc. */
const longestSweep = 330;
/** Most points a line or arc is fitted to. */
const fitPoints = 48;
/** Most points a traced spline may have. */
const maximumSplinePoints = 32;

const sub = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const length = (a: ArrayLike<number>) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: ArrayLike<number>): Vec3 => {
  const l = length(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};
const mix = (a: ArrayLike<number>, b: ArrayLike<number>, t: number): Vec3 => [
  a[0] + t * (b[0] - a[0]),
  a[1] + t * (b[1] - a[1]),
  a[2] + t * (b[2] - a[2]),
];

/**
 * Where the rounded edge runs beside a stroke: one point per point of `path`, or null where the
 * surface there does not turn. `path` is the stroke smoothed and evenly spaced, each point with its
 * triangle. The surface within `traceReach` brush radii of the path is read in a slice across each
 * point: there the vertex normals turn about the path from one flank to the other, and the edge is
 * where they have turned half way, the middle of the rounding. Reading the turn rather than the
 * stroke finds the edge from either flank, as long as the rounding lies within reach.
 */
export function edgeUnderStroke(
  mesh: RefineMesh,
  topology: RefineTopology,
  path: GuidePoint[],
  radius: number,
  step: number,
): (GuidePoint | null)[] {
  const count = path.length;
  const found: (GuidePoint | null)[] = path.map(() => null);
  if (count < 2 || !(radius > 0)) return found;
  const at = path.map((p) => p.position);
  const s = new Float64Array(count);
  for (let i = 1; i < count; i++) s[i] = s[i - 1] + length(sub(at[i], at[i - 1]));
  const total = s[count - 1];
  if (!(total > 0)) return found;
  const half = Math.max(total / (count - 1) / 2, 1.5 * step);
  const reach = traceReach * radius;
  const facing = path.map((p) => faceNormal(mesh, p.triangle));
  const back = Math.cos((backAngle * Math.PI) / 180);

  // The vertices within reach, connected over the surface to the stroke, and not facing away.
  const { position } = mesh;
  const { neighbourStart, neighbours } = topology;
  const { vertex: stamp, mark } = nextMark(mesh, topology);
  const queue: number[] = [];
  for (const { triangle } of path)
    for (const k of [0, 1, 2] as const) {
      const v = weldedCorner(mesh, triangle, k);
      if (stamp[v] === mark) continue;
      stamp[v] = mark;
      queue.push(v);
    }
  const read: number[] = [];
  const station: number[] = [];
  const normals: number[] = [];
  const normal = new Float32Array(3);
  for (let q = 0; q < queue.length; q++) {
    const v = queue[q];
    const near = nearestOnPath(at, s, position[v * 3], position[v * 3 + 1], position[v * 3 + 2]);
    if (near.distance > reach || near.beyond > half) continue;
    vertexNormal(mesh, topology, v, normal);
    if (dot(normal, facing[near.index]) < back) continue;
    read.push(v);
    station.push(near.station);
    normals.push(normal[0], normal[1], normal[2]);
    for (let j = neighbourStart[v]; j < neighbourStart[v + 1]; j++) {
      const w = neighbours[j];
      if (stamp[w] === mark) continue;
      stamp[w] = mark;
      queue.push(w);
    }
  }
  const order = read.map((_, i) => i).sort((a, b) => station[a] - station[b]);
  const sorted = Float64Array.from(order, (i) => station[i]);
  const firstAt = (value: number) => {
    let lo = 0,
      hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const threshold = (minTurn * Math.PI) / 180;
  for (let i = 0; i < count; i++) {
    const from = firstAt(s[i] - half),
      to = firstAt(s[i] + half);
    if (to - from < 6) continue;
    const slice = order.slice(from, to);
    const t = unit(sub(at[Math.min(i + 1, count - 1)], at[Math.max(i - 1, 0)]));
    // The slice's mean normal across the path, and the direction across it.
    const mean: Vec3 = [0, 0, 0];
    for (const k of slice) for (let a = 0; a < 3; a++) mean[a] += normals[k * 3 + a];
    const along = dot(mean, t);
    const b = unit(sub(mean, [along * t[0], along * t[1], along * t[2]]));
    if (!length(b)) continue;
    const c = cross(t, b);
    const angle = slice.map((k) => {
      const n = [normals[k * 3], normals[k * 3 + 1], normals[k * 3 + 2]];
      return Math.atan2(dot(n, c), dot(n, b));
    });
    const ranked = angle.slice().sort((x, y) => x - y);
    const lo = ranked[Math.floor(strayFraction * (ranked.length - 1))],
      hi = ranked[Math.ceil((1 - strayFraction) * (ranked.length - 1))];
    const turn = hi - lo;
    if (!(turn >= threshold)) continue;
    const middle = (lo + hi) / 2;
    const rounding = slice.filter((_, j) => Math.abs(angle[j] - middle) <= turn / 4);
    if (rounding.length < 3) continue;
    // One strip of the rounding: those near the median of where they lie across the path.
    const across = rounding.map((k) => {
      const d = sub(position.subarray(read[k] * 3, read[k] * 3 + 3), at[i]);
      return [dot(d, c), dot(d, b)];
    });
    const mx = median(across.map((x) => x[0])),
      my = median(across.map((x) => x[1]));
    const kept = rounding.filter(
      (_, j) => Math.hypot(across[j][0] - mx, across[j][1] - my) <= radius / 2,
    );
    if (kept.length < 2) continue;
    const point: Vec3 = [0, 0, 0];
    for (const k of kept)
      for (let a = 0; a < 3; a++) point[a] += position[read[k] * 3 + a] / kept.length;
    let seed = read[kept[0]],
      nearest = Infinity;
    for (const k of kept) {
      const d = length(sub(position.subarray(read[k] * 3, read[k] * 3 + 3), point));
      if (d < nearest) {
        nearest = d;
        seed = read[k];
      }
    }
    found[i] = { triangle: topology.trianglesOf[topology.triangleStart[seed]], position: point };
  }
  return found;
}

function median(values: number[]) {
  const sorted = values.slice().sort((a, b) => a - b);
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

function faceNormal(mesh: RefineMesh, t: number): Vec3 {
  const corner = (k: 0 | 1 | 2) => {
    const w = weldedCorner(mesh, t, k) * 3;
    return mesh.position.subarray(w, w + 3);
  };
  const a = corner(0);
  return unit(cross(sub(corner(1), a), sub(corner(2), a)));
}

/**
 * The nearest point of a polyline to (x, y, z): its distance, its station, the polyline point nearer
 * it, and how far past an end of the polyline (x, y, z) lies along it.
 */
function nearestOnPath(at: Vec3[], s: Float64Array, x: number, y: number, z: number) {
  let best = Infinity,
    station = 0,
    index = 0,
    beyond = 0;
  for (let i = 0; i + 1 < at.length; i++) {
    const a = at[i],
      b = at[i + 1];
    const dx = b[0] - a[0],
      dy = b[1] - a[1],
      dz = b[2] - a[2];
    const span = dx * dx + dy * dy + dz * dz;
    const raw = span > 0 ? ((x - a[0]) * dx + (y - a[1]) * dy + (z - a[2]) * dz) / span : 0;
    const t = Math.min(1, Math.max(0, raw));
    const ex = a[0] + t * dx - x,
      ey = a[1] + t * dy - y,
      ez = a[2] + t * dz - z;
    const d = ex * ex + ey * ey + ez * ez;
    if (d < best) {
      best = d;
      station = s[i] + t * (s[i + 1] - s[i]);
      index = t < 0.5 ? i : i + 1;
      const past = i === 0 && raw < 0 ? -raw : i + 2 === at.length && raw > 1 ? raw - 1 : 0;
      beyond = past * Math.sqrt(span);
    }
  }
  return { distance: Math.sqrt(best), station, index, beyond };
}

// ---------------------------------------------------------------------------------------------
// Fitting the traced edge

export interface TracedSegment {
  kind: GuideKind;
  /** A line's two ends, an arc's start, middle and end, or a spline's points. */
  points: Vec3[];
}
export interface TracedPath {
  segments: TracedSegment[];
  /** One per joint between consecutive segments, plus one closing joint when `closed`. */
  joints: GuideJoint[];
  closed: boolean;
}

/** A fitted stretch of the points, `from` to `to` inclusive. */
interface Piece {
  kind: GuideKind;
  from: number;
  to: number;
  line?: { mean: Vec3; direction: Vec3 };
  circle?: Circle;
}

/**
 * The edge through `points`, in pieces: lines and arcs where they fit within `tolerance` RMS, over at
 * least a brush radius each, in as few pieces as the costs allow, and splines where none does.
 * Where the points turn sharply within a brush radius the path has a corner: the pieces either side
 * are fitted clear of it and meet there at a sharp joint. Pieces that meet with one direction join
 * smoothly. A closed path that is a circle is one arc.
 */
export function fitTrace(
  points: Vec3[],
  closed: boolean,
  tolerance: number,
  radius: number,
): TracedPath | null {
  const count = points.length;
  if (count < 2) return null;
  if (closed && count < 6) closed = false;
  const flat = points.flat();
  if (closed) {
    const circle = fitCircle(flat);
    if (circle && circle.rms <= tolerance && circle.radius >= radius) {
      const s = stations(flat, true);
      const total = s[count];
      return {
        segments: [
          {
            kind: 'arc',
            points: [0, 1, 2].map((k) => onCircle(circle, pointAt(flat, s, (k * total) / 3, true))),
          },
        ],
        joints: ['smooth'],
        closed: true,
      };
    }
  }
  let cuts = corners(flat, closed, radius, cornerTurn);
  // `at` runs from the path's start, or on a closed path from a corner or a joint, to its end, which
  // on a closed path is its start again.
  let at = points;
  if (closed) {
    let start = cuts[0] ?? 0;
    if (!cuts.length) {
      // With no corner, start where a first fit puts a joint, so the closing joint is a real one.
      const loop = [...points, points[0]];
      const first = fewestPieces(loop, stations(loop.flat(), false), 0, count, tolerance, radius);
      start = first.length > 1 ? first[0].to % count : 0;
    }
    at = [...points.slice(start), ...points.slice(0, start + 1)];
    cuts = cuts.map((c) => (c - start + count) % count);
  }
  const s = stations(at.flat(), false);
  const last = at.length - 1;
  const corner = new Set(cuts.filter((c) => c > 0 && c < last));
  const bounds = [0, ...[...corner].sort((a, b) => a - b), last];
  const atCorner = (i: number) => corner.has(i) || (closed && cuts.length > 0);
  const pieces: Piece[] = [];
  const sharp: boolean[] = [];
  for (let r = 0; r + 1 < bounds.length; r++) {
    const from = bounds[r],
      to = bounds[r + 1];
    // Clear of a corner by a brush radius, where that leaves enough to fit.
    let lo = from,
      hi = to;
    if (atCorner(from)) while (lo < to && s[lo] - s[from] < radius) lo++;
    if (atCorner(to)) while (hi > from && s[to] - s[hi] < radius) hi--;
    if (hi - lo < 2) {
      lo = from;
      hi = to;
    }
    const run = fewestPieces(at, s, lo, hi, tolerance, radius);
    run[0].from = from;
    run[run.length - 1].to = to;
    run.forEach((piece, k) => {
      if (pieces.length) sharp.push(k === 0);
      pieces.push(piece);
    });
  }
  if (closed) {
    sharp.push(cuts.length > 0);
    // A closed path of one segment must be a circle: a ring no arc fits is two splines.
    if (pieces.length === 1) {
      const middle = last >> 1;
      pieces.splice(
        0,
        1,
        { kind: 'spline', from: 0, to: middle },
        {
          kind: 'spline',
          from: middle,
          to: last,
        },
      );
      sharp.splice(0, 1, false, false);
    }
  }
  return assemble(at, pieces, sharp, closed, radius);
}

/**
 * The pieces over points `lo` to `hi` of `at` in the fewest by cost: each line or arc spans at least
 * a brush radius and fits within `tolerance`; a spline spans anything.
 */
function fewestPieces(
  at: Vec3[],
  s: Float64Array,
  lo: number,
  hi: number,
  tolerance: number,
  radius: number,
): Piece[] {
  // A run one line or arc fits is that piece, whatever its length.
  const whole = fitPiece(at.slice(lo, hi + 1), tolerance, radius);
  if (whole) return [{ ...whole, from: lo, to: hi }];
  const n = hi - lo + 1;
  const cost = new Float64Array(n).fill(Infinity);
  const previous = new Int32Array(n).fill(-1);
  const choice: (Piece | null)[] = new Array(n).fill(null);
  cost[0] = 0;
  for (let j = 1; j < n; j++) {
    for (let i = 0; i < j; i++) {
      const span = s[lo + j] - s[lo + i];
      // Every piece spans a brush radius, unless the run is shorter.
      if (span < radius && !(i === 0 && j === n - 1)) continue;
      const spline = cost[i] + splineCost + span / (splineReach * radius);
      if (spline < cost[j]) {
        cost[j] = spline;
        previous[j] = i;
        choice[j] = { kind: 'spline', from: lo + i, to: lo + j };
      }
    }
    for (let i = j - 2; i >= 0; i--) {
      if (s[lo + j] - s[lo + i] < radius) continue;
      const piece = fitPiece(at.slice(lo + i, lo + j + 1), tolerance, radius);
      if (!piece) break;
      const total = cost[i] + (piece.kind === 'line' ? lineCost : arcCost);
      if (total < cost[j]) {
        cost[j] = total;
        previous[j] = i;
        choice[j] = { ...piece, from: lo + i, to: lo + j };
      }
    }
  }
  const run: Piece[] = [];
  for (let j = n - 1; j > 0; j = previous[j]) run.unshift(choice[j]!);
  return run;
}

/** A line, else an arc, through `points` within `tolerance`; null when neither fits. */
function fitPiece(points: Vec3[], tolerance: number, radius: number): Piece | null {
  // A long piece is judged on an even subset of its points, its ends included.
  if (points.length > fitPoints) {
    const stride = (points.length - 1) / (fitPoints - 1);
    points = Array.from({ length: fitPoints }, (_, i) => points[Math.round(i * stride)]);
  }
  const flat = points.flat();
  if (lineRms(flat) <= tolerance) {
    const { mean, vectors } = principalAxes(flat);
    return { kind: 'line', from: 0, to: 0, line: { mean, direction: vectors[0] } };
  }
  const circle = fitCircle(flat);
  if (!circle || circle.rms > tolerance || circle.radius < radius) return null;
  if (Math.abs(signedSweep(circle, points)) > (longestSweep * Math.PI) / 180) return null;
  return { kind: 'arc', from: 0, to: 0, circle };
}

/** Angle of `p` round the circle, from its `u` axis toward `v`. */
function angleOn(circle: Circle, p: Vec3) {
  const w = sub(p, circle.centre);
  return Math.atan2(dot(w, circle.v), dot(w, circle.u));
}

/** Signed angle the points travel round the circle, start to end. */
function signedSweep(circle: Circle, points: Vec3[]) {
  let sweep = 0;
  for (let i = 1; i < points.length; i++) {
    let d = angleOn(circle, points[i]) - angleOn(circle, points[i - 1]);
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    sweep += d;
  }
  return sweep;
}

/** The point of an arc half way round from `start` to `end`, the way `points` travel. */
function arcMiddle(circle: Circle, points: Vec3[], start: Vec3, end: Vec3): Vec3 {
  const from = angleOn(circle, start);
  let sweep = angleOn(circle, end) - from;
  const travel = signedSweep(circle, points);
  while (travel >= 0 && sweep < 0) sweep += 2 * Math.PI;
  while (travel < 0 && sweep > 0) sweep -= 2 * Math.PI;
  const angle = from + sweep / 2;
  const { centre, radius, u, v } = circle;
  return [0, 1, 2].map(
    (k) => centre[k] + radius * (Math.cos(angle) * u[k] + Math.sin(angle) * v[k]),
  ) as Vec3;
}

/** Where a piece's fit passes the point `p`. */
function onPiece(piece: Piece, p: Vec3): Vec3 {
  if (piece.line) {
    const { mean, direction } = piece.line;
    const t = dot(sub(p, mean), direction);
    return [0, 1, 2].map((k) => mean[k] + t * direction[k]) as Vec3;
  }
  if (piece.circle) return onCircle(piece.circle, p);
  return p;
}

/** A piece's direction at its point nearest `p`, `at` running from its start to its end. */
function directionAt(piece: Piece, at: Vec3[], p: Vec3): Vec3 {
  const forward = sub(at[piece.to], at[piece.from]);
  if (piece.line) {
    const d = piece.line.direction;
    return dot(d, forward) < 0 ? [-d[0], -d[1], -d[2]] : d;
  }
  if (piece.circle) {
    const { centre, u, v } = piece.circle;
    const normal = cross(u, v);
    let d = unit(cross(normal, sub(p, centre)));
    // Turning the way the points do.
    const mid = at[(piece.from + piece.to) >> 1];
    const turning = dot(cross(sub(mid, at[piece.from]), sub(at[piece.to], mid)), normal);
    if (turning < 0) d = [-d[0], -d[1], -d[2]];
    return d;
  }
  return unit(forward);
}

/** Where two pieces meet at a corner: the nearest approach of two lines, else the corner point. */
function cornerPoint(a: Piece, b: Piece, corner: Vec3, radius: number): Vec3 {
  if (!a.line || !b.line) return corner;
  const { mean: p, direction: d } = a.line,
    { mean: q, direction: e } = b.line;
  const w = sub(p, q);
  const bb = dot(d, e),
    dd = dot(d, w),
    ee = dot(e, w);
  const denominator = 1 - bb * bb;
  if (denominator < 1e-6) return corner;
  const t = (bb * ee - dd) / denominator,
    u = (ee - bb * dd) / denominator;
  const meet = mix(
    [p[0] + t * d[0], p[1] + t * d[1], p[2] + t * d[2]],
    [q[0] + u * e[0], q[1] + u * e[1], q[2] + u * e[2]],
    0.5,
  );
  return length(sub(meet, corner)) <= 2 * radius ? meet : corner;
}

/**
 * Where a line and an arc, or two arcs, touch: the foot of the arc's centre on the line, or the point
 * of an arc on the line through both centres. Null when that is not within a brush radius of `near`.
 */
function tangentPoint(a: Piece, b: Piece, near: Vec3, radius: number): Vec3 | null {
  let touch: Vec3 | null = null;
  const line = a.line ?? b.line,
    circle = a.circle ?? b.circle;
  if (line && circle) {
    const { mean, direction } = line;
    const t = dot(sub(circle.centre, mean), direction);
    touch = [0, 1, 2].map((k) => mean[k] + t * direction[k]) as Vec3;
  } else if (a.circle && b.circle) {
    const towards = unit(sub(b.circle.centre, a.circle.centre));
    if (!length(towards)) return null;
    const { centre, radius: r } = a.circle;
    const [p, q] = [r, -r].map((d) => [0, 1, 2].map((k) => centre[k] + d * towards[k]) as Vec3);
    touch = length(sub(p, near)) <= length(sub(q, near)) ? p : q;
  }
  return touch && length(sub(touch, near)) <= radius ? touch : null;
}

/** The segments of the fitted pieces, meeting at shared points, with their joints. */
function assemble(
  at: Vec3[],
  pieces: Piece[],
  sharp: boolean[],
  closed: boolean,
  radius: number,
): TracedPath {
  const n = pieces.length;
  // The shared point at each joint; joint k is between pieces k and k + 1 (on a closed path, n - 1
  // closes back to 0).
  const meets: Vec3[] = [];
  const joints: GuideJoint[] = [];
  const jointCount = closed ? n : n - 1;
  for (let k = 0; k < jointCount; k++) {
    const a = pieces[k],
      b = pieces[(k + 1) % n];
    const corner = at[a.to];
    if (sharp[k]) {
      meets.push(cornerPoint(a, b, corner, radius));
      joints.push('sharp');
      continue;
    }
    const meet =
      tangentPoint(a, b, corner, radius) ?? mix(onPiece(a, corner), onPiece(b, corner), 0.5);
    meets.push(meet);
    const turn = Math.acos(
      Math.min(1, Math.max(-1, dot(directionAt(a, at, meet), directionAt(b, at, meet)))),
    );
    joints.push(turn <= (smoothTurn * Math.PI) / 180 ? 'smooth' : 'sharp');
  }
  const segments = pieces.map((piece, k): TracedSegment => {
    const start = k > 0 ? meets[k - 1] : closed ? meets[n - 1] : onPiece(piece, at[piece.from]);
    const end = k < jointCount ? meets[k] : onPiece(piece, at[piece.to]);
    if (piece.kind === 'line') return { kind: 'line', points: [start, end] };
    const flat = at.slice(piece.from, piece.to + 1).flat();
    const local = stations(flat, false);
    const span = local[local.length - 1];
    if (piece.kind === 'arc')
      return {
        kind: 'arc',
        points: [
          start,
          arcMiddle(piece.circle!, at.slice(piece.from, piece.to + 1), start, end),
          end,
        ],
      };
    const count = Math.min(maximumSplinePoints, Math.ceil(span / (4 * radius)) + 3);
    const smooth = smoothed(flat, local, radius / 2);
    const inner = Array.from({ length: count - 2 }, (_, i) =>
      pointAt(smooth, local, ((i + 1) * span) / (count - 1), false),
    );
    return { kind: 'spline', points: [start, ...inner, end] };
  });
  return { segments, joints, closed };
}

/** Each point of a polyline replaced by the mean of the points within `reach` of it along it. */
function smoothed(flat: number[], s: Float64Array, reach: number) {
  const count = flat.length / 3;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const mean = [0, 0, 0];
    let n = 0;
    for (let j = 0; j < count; j++) {
      if (Math.abs(s[j] - s[i]) > reach) continue;
      n++;
      for (let a = 0; a < 3; a++) mean[a] += flat[j * 3 + a];
    }
    out.push(...mean.map((m) => m / n));
  }
  return out;
}
