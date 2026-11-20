import { BufferAttribute, BufferGeometry } from 'three';
import type { Vec3 } from '../../src/core/types';

export interface SoftOptions {
  step?: number;
  ripple?: number;
  noise?: number;
  seed?: number;
  indexed?: boolean;
}

export const softDefaults = { step: 0.06, ripple: 0.02, noise: 0.004, seed: 1, indexed: false };

type Vec2 = [number, number];
type Sample = { point: Vec2; normal: Vec2 };

/** A seeded generator, so a fixture is the same on every run. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const normalize = (v: Vec3): Vec3 => {
  const length = Math.hypot(...v);
  return [v[0] / length, v[1] / length, v[2] / length];
};

/** Ripple directions, oblique to every axis so that no flat face sees a constant offset. */
const rippleDirections = [normalize([1, 2, 3]), normalize([3, -1, 2]), normalize([-2, 3, 1])];
const rippleWavelength = 0.4;

/**
 * A closed triangle mesh built on an exact surface. Each vertex is placed once, so jitter, ripple
 * and noise move every corner that shares it together and the mesh stays closed.
 */
class Surface {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly fixed: boolean[] = [];
  readonly triangles: number[] = [];
  readonly next: () => number;
  readonly options: typeof softDefaults;

  constructor(options: SoftOptions | undefined) {
    this.options = { ...softDefaults, ...options };
    this.next = random(this.options.seed);
  }

  /** A random offset of up to a quarter of a sample spacing, for in-plane jitter. */
  wobble() {
    return (this.next() - 0.5) * 0.5;
  }

  /** A vertex on the exact surface. A fixed vertex lies on a sharp crease and is never displaced. */
  add(point: Vec3, normal: Vec3, fixed = false) {
    this.positions.push(...point);
    this.normals.push(...normal);
    this.fixed.push(fixed);
    return this.fixed.length - 1;
  }

  triangle(a: number, b: number, c: number) {
    this.triangles.push(a, b, c);
  }

  /** A counter-clockwise quad, split along a random diagonal. */
  quad(a: number, b: number, c: number, d: number) {
    if (this.next() < 0.5) this.triangles.push(a, b, c, a, c, d);
    else this.triangles.push(a, b, d, b, c, d);
  }

  /**
   * Joins two closed rings sampled at even fractions of a turn, faces outward along A to B
   * crossed with increasing index. A ring of one vertex is a pole.
   */
  stitch(a: number[], b: number[]) {
    let i = 0,
      j = 0;
    while (i < a.length || j < b.length) {
      const nextA = (i + 1) / a.length,
        nextB = (j + 1) / b.length;
      const stepA =
        j >= b.length ||
        (i < a.length && (nextA < nextB || (nextA === nextB && this.next() < 0.5)));
      if (stepA) {
        if (a.length > 1) this.triangle(a[i], b[j % b.length], a[(i + 1) % a.length]);
        i++;
      } else {
        if (b.length > 1) this.triangle(a[i % a.length], b[j], b[(j + 1) % b.length]);
        j++;
      }
    }
  }

  geometry() {
    const { ripple, noise, indexed } = this.options;
    const phases = rippleDirections.map(() => this.next() * Math.PI * 2);
    const k = (Math.PI * 2) / rippleWavelength;
    const positions = new Float32Array(this.positions.length);
    for (let v = 0; v < this.fixed.length; v++) {
      const p = this.positions.slice(v * 3, v * 3 + 3);
      let offset = 0;
      if (!this.fixed[v]) {
        const waves = rippleDirections.reduce(
          (sum, d, m) => sum + Math.sin(k * (d[0] * p[0] + d[1] * p[1] + d[2] * p[2]) + phases[m]),
          0,
        );
        offset = (ripple * waves) / 3 + noise * (2 * this.next() - 1);
      }
      for (let axis = 0; axis < 3; axis++)
        positions[v * 3 + axis] = p[axis] + this.normals[v * 3 + axis] * offset;
    }
    const geometry = new BufferGeometry();
    if (indexed) {
      geometry.setAttribute('position', new BufferAttribute(positions, 3));
      geometry.setIndex(this.triangles);
    } else {
      const expanded = new Float32Array(this.triangles.length * 3);
      this.triangles.forEach((v, i) => expanded.set(positions.subarray(v * 3, v * 3 + 3), i * 3));
      geometry.setAttribute('position', new BufferAttribute(expanded, 3));
    }
    geometry.computeVertexNormals();
    return geometry;
  }
}

/** A 2D path of lines and circular arcs, with its outward normal on the right of travel. */
class Path {
  readonly segments: { length: number; at: (s: number) => Sample }[] = [];
  length = 0;

  constructor(readonly closed: boolean) {}

  line(from: Vec2, to: Vec2) {
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const d: Vec2 = [(to[0] - from[0]) / length, (to[1] - from[1]) / length];
    this.push(length, (s) => ({
      point: [from[0] + d[0] * s, from[1] + d[1] * s],
      normal: [d[1], -d[0]],
    }));
  }

  arc(center: Vec2, radius: number, start: number, sweep: number) {
    const sign = Math.sign(sweep);
    this.push(radius * Math.abs(sweep), (s) => {
      const angle = start + (sign * s) / radius;
      const tangent: Vec2 = [-sign * Math.sin(angle), sign * Math.cos(angle)];
      return {
        point: [center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)],
        normal: [tangent[1], -tangent[0]],
      };
    });
  }

  private push(length: number, at: (s: number) => Sample) {
    if (length > 0) this.segments.push({ length, at });
    this.length += length;
  }

  at(s: number) {
    if (this.closed) s = ((s % this.length) + this.length) % this.length;
    for (const segment of this.segments) {
      if (s <= segment.length) return segment.at(s);
      s -= segment.length;
    }
    const last = this.segments[this.segments.length - 1];
    return last.at(last.length);
  }
}

/** A polyline with each corner replaced by a circular arc of `fillet` tangent to both edges. */
function filletedPath(corners: Vec2[], fillet: number, closed: boolean) {
  const n = corners.length;
  const round = (i: number) => {
    const [prev, v, next] = [corners[(i + n - 1) % n], corners[i], corners[(i + 1) % n]];
    const unit = (a: Vec2, b: Vec2): Vec2 => {
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      return [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
    };
    const d1 = unit(prev, v),
      d2 = unit(v, next);
    const turn = Math.atan2(d1[0] * d2[1] - d1[1] * d2[0], d1[0] * d2[0] + d1[1] * d2[1]);
    const t = fillet * Math.tan(Math.abs(turn) / 2);
    const from: Vec2 = [v[0] - d1[0] * t, v[1] - d1[1] * t];
    const to: Vec2 = [v[0] + d2[0] * t, v[1] + d2[1] * t];
    const side = Math.sign(turn) * fillet;
    const center: Vec2 = [from[0] - d1[1] * side, from[1] + d1[0] * side];
    return { from, to, center, start: Math.atan2(from[1] - center[1], from[0] - center[0]), turn };
  };
  const path = new Path(closed);
  const rounded = corners.map((_, i) => (closed || (i > 0 && i < n - 1) ? round(i) : undefined));
  let at = closed ? rounded[0]!.from : corners[0];
  for (let i = closed ? 0 : 1; i < (closed ? n : n - 1); i++) {
    const corner = rounded[i]!;
    path.line(at, corner.from);
    path.arc(corner.center, fillet, corner.start, corner.turn);
    at = corner.to;
  }
  path.line(at, closed ? rounded[0]!.from : corners[n - 1]);
  return path;
}

/**
 * Covers the surface of a lattice box with quads, each lattice point jittered within its face and
 * mapped onto the surface by `evaluate`.
 */
function boxLattice(
  surface: Surface,
  counts: Vec3,
  evaluate: (c: Vec3) => { point: Vec3; normal: Vec3 },
) {
  const ids = new Map<string, number>();
  const vertex = (c: Vec3) => {
    const key = c.join();
    let id = ids.get(key);
    if (id === undefined) {
      const jittered = c.map((v, a) => (v > 0 && v < counts[a] ? v + surface.wobble() : v));
      const { point, normal } = evaluate(jittered as Vec3);
      id = surface.add(point, normal);
      ids.set(key, id);
    }
    return id;
  };
  for (let a = 0; a < 3; a++)
    for (const side of [0, counts[a]]) {
      const u = (a + 1) % 3,
        v = (a + 2) % 3;
      for (let iu = 0; iu < counts[u]; iu++)
        for (let iv = 0; iv < counts[v]; iv++) {
          const at = (du: number, dv: number) => {
            const c: Vec3 = [0, 0, 0];
            c[a] = side;
            c[u] = iu + du;
            c[v] = iv + dv;
            return vertex(c);
          };
          const [p00, p10, p11, p01] = [at(0, 0), at(1, 0), at(1, 1), at(0, 1)];
          if (side) surface.quad(p00, p10, p11, p01);
          else surface.quad(p00, p01, p11, p10);
        }
    }
}

type Raise = (point: Vec3, normal: Vec3) => void;

/** A box lattice rounded by `fillet`, or by a radius that varies with x. */
function filletedBox(
  half: Vec3,
  rounding: number | ((x: number) => number),
  options: SoftOptions | undefined,
  raise?: Raise,
) {
  const surface = new Surface(options);
  const counts = half.map((h) => Math.max(1, Math.round((2 * h) / surface.options.step))) as Vec3;
  boxLattice(surface, counts, (c) => {
    const p = c.map((v, a) => -half[a] + (v * 2 * half[a]) / counts[a]);
    const fillet = typeof rounding === 'number' ? rounding : rounding(p[0]);
    const q = p.map((v, a) => Math.min(Math.max(v, fillet - half[a]), half[a] - fillet));
    const normal = normalize([p[0] - q[0], p[1] - q[1], p[2] - q[2]]);
    const point = q.map((v, a) => v + fillet * normal[a]) as Vec3;
    raise?.(point, normal);
    return { point, normal };
  });
  return surface;
}

/** Box centred on the origin with every edge filleted. Its true shape is the sharp box of `half`. */
export function softBox(half: Vec3, fillet: number, options?: SoftOptions) {
  return filletedBox(half, fillet, options).geometry();
}

/** softBox with its rounding growing linearly from `from` at x = -half[0] to `to` at x = half[0]. */
export function taperedBox(half: Vec3, from: number, to: number, options?: SoftOptions) {
  return filletedBox(
    half,
    (x) => from + ((to - from) * (x + half[0])) / (2 * half[0]),
    options,
  ).geometry();
}

/**
 * softBox with space lifted by bulge * exp(-(x / 0.5)^2) * (y + half[1]) / (2 * half[1]): the top
 * face y = half[1] carries a smooth bump along x and the edges beside it rise with it, while the
 * faces z = +-half[2] stay flat.
 */
export function bulgedBox(half: Vec3, fillet: number, bulge: number, options?: SoftOptions) {
  return filletedBox(half, fillet, options, (point) => {
    point[1] += (bulge * Math.exp(-((point[0] / 0.5) ** 2)) * (point[1] + half[1])) / (2 * half[1]);
  }).geometry();
}

/** Where a folded strip's layers lie: `gap` apart, folding `reach` mm past the fillet and again at x = `under`. */
export interface Folds {
  gap: number;
  reach: number;
  under: number;
  /** Length of the bottom layer past the farther fold, and height of the wall's top. */
  tail?: number;
  wall?: number;
}

/**
 * An open sheet extruded z -2..2 whose profile folds into three flat layers (y = 0, gap and 2 gap)
 * and turns up into a wall at x = 0 through a concave fillet of radius `fillet`. The folds, of radius
 * gap / 2, run along z: the top layer folds under at x = fillet + reach and the middle layer folds
 * again at x = under. The top and bottom layers face +y.
 */
export function foldedStrip(
  fillet: number,
  options?: SoftOptions,
  { gap, reach, under, tail = 1.5, wall = 1.4 }: Folds = { gap: 0.2, reach: 0.3, under: -0.3 },
) {
  const surface = new Surface(options);
  const { step } = surface.options;
  const fold = gap / 2,
    near = fillet + reach,
    top = 2 * gap;
  const path = new Path(false);
  path.line([Math.max(near, under) + tail, 0], [under, 0]);
  path.arc([under, fold], fold, -Math.PI / 2, -Math.PI);
  path.line([under, gap], [near, gap]);
  path.arc([near, gap + fold], fold, -Math.PI / 2, Math.PI);
  path.line([near, top], [fillet, top]);
  path.arc([fillet, top + fillet], fillet, -Math.PI / 2, -Math.PI / 2);
  path.line([0, top + fillet], [0, wall]);
  const columns = Math.round(path.length / step),
    layers = Math.max(2, Math.round(4 / step));
  const spacing = path.length / columns;
  const grid: number[][] = [];
  for (let l = 0; l <= layers; l++) {
    const row: number[] = [];
    for (let i = 0; i <= columns; i++) {
      const inner = i > 0 && i < columns;
      const { point, normal } = path.at((i + (inner ? surface.wobble() : 0)) * spacing);
      const z = -2 + ((l + (l > 0 && l < layers ? surface.wobble() : 0)) * 4) / layers;
      row.push(surface.add([point[0], point[1], z], [normal[0], normal[1], 0]));
    }
    grid.push(row);
  }
  for (let l = 0; l < layers; l++)
    for (let i = 0; i < columns; i++)
      surface.quad(grid[l][i], grid[l][i + 1], grid[l + 1][i + 1], grid[l + 1][i]);
  return surface.geometry();
}

/** Twice the signed area of triangle a, b, c, positive when counter-clockwise. */
const orient = (a: Vec2, b: Vec2, c: Vec2) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

/** Whether d lies inside the circumcircle of the counter-clockwise triangle a, b, c. */
function inCircle(a: Vec2, b: Vec2, c: Vec2, d: Vec2) {
  const [ax, ay, bx, by, cx, cy] = [
    a[0] - d[0],
    a[1] - d[1],
    b[0] - d[0],
    b[1] - d[1],
    c[0] - d[0],
    c[1] - d[1],
  ];
  const [la, lb, lc] = [ax * ax + ay * ay, bx * bx + by * by, cx * cx + cy * cy];
  return ax * (by * lc - lb * cy) - ay * (bx * lc - lb * cx) + la * (bx * cy - by * cx) > 0;
}

/** A loop, because spreading a fine fixture's points into Math.min overflows the stack. */
function bounds(points: Vec2[]) {
  let x0 = Infinity,
    x1 = -Infinity,
    y0 = Infinity,
    y1 = -Infinity;
  for (const [x, y] of points) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return [x0, x1, y0, y1];
}

/** Counter-clockwise Delaunay triangles of `points`, by Bowyer-Watson insertion with a walk. */
function delaunay(points: Vec2[]) {
  const [x0, x1, y0, y1] = bounds(points);
  const [cx, cy, size] = [(x0 + x1) / 2, (y0 + y1) / 2, 100 * Math.max(x1 - x0, y1 - y0)];
  const n = points.length;
  const all: Vec2[] = [...points, [cx - size, cy - size], [cx + size, cy - size], [cx, cy + size]];
  // Triangle t has corners vertex[3t..3t+2] and, across edge k (corner k to k+1), neighbour[3t+k].
  const vertex = [n, n + 1, n + 2],
    neighbour = [-1, -1, -1],
    alive = [true];
  let last = 0;
  for (let p = 0; p < n; p++) {
    const point = all[p];
    let t = last;
    for (let moved = true; moved;) {
      moved = false;
      for (let k = 0; k < 3; k++) {
        const [a, b] = [vertex[3 * t + k], vertex[3 * t + ((k + 1) % 3)]];
        if (orient(all[a], all[b], point) < 0) {
          t = neighbour[3 * t + k];
          moved = true;
          break;
        }
      }
    }
    const cavity = new Set([t]),
      stack = [t],
      boundary: [number, number, number][] = [];
    while (stack.length) {
      const c = stack.pop()!;
      for (let k = 0; k < 3; k++) {
        const across = neighbour[3 * c + k];
        if (cavity.has(across)) continue;
        const corners = vertex.slice(3 * across, 3 * across + 3).map((v) => all[v]);
        if (across >= 0 && inCircle(corners[0], corners[1], corners[2], point)) {
          cavity.add(across);
          stack.push(across);
        } else boundary.push([vertex[3 * c + k], vertex[3 * c + ((k + 1) % 3)], across]);
      }
    }
    for (const c of cavity) alive[c] = false;
    const startingAt = new Map<number, number>();
    for (const [a, b, outside] of boundary) {
      const created = alive.length;
      vertex.push(a, b, p);
      neighbour.push(outside, -1, -1);
      alive.push(true);
      startingAt.set(a, created);
      if (outside >= 0)
        for (let k = 0; k < 3; k++)
          if (vertex[3 * outside + k] === b && vertex[3 * outside + ((k + 1) % 3)] === a)
            neighbour[3 * outside + k] = created;
      last = created;
    }
    for (const created of startingAt.values()) {
      const following = startingAt.get(vertex[3 * created + 1])!;
      neighbour[3 * created + 1] = following;
      neighbour[3 * following + 2] = created;
    }
  }
  const triangles: number[][] = [];
  for (let t = 0; t < alive.length; t++) {
    const corners = vertex.slice(3 * t, 3 * t + 3);
    if (alive[t] && corners.every((v) => v < n)) triangles.push(corners);
  }
  return triangles;
}

function insidePolygon(polygon: Vec2[], p: Vec2) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [a, b] = [polygon[i], polygon[j]];
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < a[0] + ((p[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1])
    )
      inside = !inside;
  }
  return inside;
}

function segmentDistance(p: Vec2, a: Vec2, b: Vec2) {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const t = Math.min(
    1,
    Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)),
  );
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/**
 * Fills a flat cap at height `z` inside a closed counter-clockwise rim of existing vertices, with
 * jittered interior vertices about `step` apart. Faces +z when `up`, else -z.
 */
function cap(surface: Surface, rim: number[], z: number, up: boolean, step: number) {
  const outline = rim.map((v): Vec2 => [surface.positions[v * 3], surface.positions[v * 3 + 1]]);
  const edge = (i: number): [Vec2, Vec2] => [outline[i], outline[(i + 1) % outline.length]];
  const longest = Math.max(
    ...outline.map((p, i) => Math.hypot(...p.map((v, a) => edge(i)[1][a] - v))),
  );
  // Keeping interior points out of every rim edge's diametral circle makes each rim edge Delaunay.
  const clearance = 0.6 * longest;
  const [x0, x1, y0, y1] = bounds(outline);
  const row = (step * Math.sqrt(3)) / 2;
  const interior: Vec2[] = [];
  for (let j = 0, y = y0; y <= y1; j++, y = y0 + j * row)
    for (let x = x0 + (j % 2) * step * 0.5; x <= x1; x += step) {
      const p: Vec2 = [x + surface.wobble() * step, y + surface.wobble() * row];
      if (!insidePolygon(outline, p)) continue;
      if (outline.every((_, i) => segmentDistance(p, ...edge(i)) > clearance)) interior.push(p);
    }
  const normal: Vec3 = [0, 0, up ? 1 : -1];
  const ids = [...rim, ...interior.map((p) => surface.add([p[0], p[1], z], normal))];
  const points = [...outline, ...interior];
  const faces = delaunay(points).filter((t) => {
    const [a, b, c] = t.map((v) => points[v]);
    return insidePolygon(outline, [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3]);
  });
  const area = faces.reduce((sum, [a, b, c]) => sum + orient(points[a], points[b], points[c]), 0);
  const rimArea = outline.reduce((sum, p, i) => sum + orient([0, 0], p, edge(i)[1]), 0);
  if (Math.abs(area - rimArea) > 1e-9 * Math.abs(rimArea))
    throw new Error('A cap triangulation does not follow its rim.');
  for (const [a, b, c] of faces)
    if (up) surface.triangle(ids[a], ids[b], ids[c]);
    else surface.triangle(ids[a], ids[c], ids[b]);
}

/** L profile in XY, extruded z -2..2: polygon (-2,-1.5) (2,-1.5) (2,0) (0,0) (0,1.5) (-2,1.5), every profile corner filleted. The interior edge is the z axis. */
export function softStep(fillet: number, options?: SoftOptions) {
  const surface = new Surface(options);
  const { step } = surface.options;
  const path = filletedPath(
    [
      [-2, -1.5],
      [2, -1.5],
      [2, 0],
      [0, 0],
      [0, 1.5],
      [-2, 1.5],
    ],
    fillet,
    true,
  );
  const columns = Math.round(path.length / step),
    layers = Math.max(2, Math.round(4 / step));
  const spacing = path.length / columns;
  const grid: number[][] = [];
  for (let l = 0; l <= layers; l++) {
    const crease = l === 0 || l === layers;
    const row: number[] = [];
    for (let i = 0; i < columns; i++) {
      const { point, normal } = path.at((i + surface.wobble()) * spacing);
      const z = -2 + ((l + (crease ? 0 : surface.wobble())) * 4) / layers;
      row.push(surface.add([point[0], point[1], z], [normal[0], normal[1], 0], crease));
    }
    grid.push(row);
  }
  for (let l = 0; l < layers; l++)
    for (let i = 0; i < columns; i++) {
      const i1 = (i + 1) % columns;
      surface.quad(grid[l][i], grid[l][i1], grid[l + 1][i1], grid[l + 1][i]);
    }
  cap(surface, grid[layers], 2, true, step);
  cap(surface, grid[0], -2, false, step);
  return surface.geometry();
}

/** Capped cylinder about Y with filleted rims. */
export function softCylinder(
  radius: number,
  halfHeight: number,
  fillet: number,
  options?: SoftOptions,
) {
  const surface = new Surface(options);
  const { step } = surface.options;
  const path = filletedPath(
    [
      [0, -halfHeight],
      [radius, -halfHeight],
      [radius, halfHeight],
      [0, halfHeight],
    ],
    fillet,
    false,
  );
  const rows = Math.max(2, Math.round(path.length / step));
  const spacing = path.length / rows;
  const rings: number[][] = [];
  for (let i = 0; i <= rows; i++) {
    const pole = i === 0 || i === rows;
    const count = pole
      ? 1
      : Math.max(3, Math.round((2 * Math.PI * path.at(i * spacing).point[0]) / step));
    const ring: number[] = [];
    for (let j = 0; j < count; j++) {
      const { point, normal } = path.at((i + (pole ? 0 : surface.wobble())) * spacing);
      const angle = (2 * Math.PI * (j + (pole ? 0 : surface.wobble()))) / count;
      const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
      ring.push(
        surface.add(
          [point[0] * cos, point[1], point[0] * sin],
          [normal[0] * cos, normal[1], normal[0] * sin],
        ),
      );
    }
    rings.push(ring);
  }
  for (let i = 0; i < rows; i++) surface.stitch(rings[i], rings[i + 1]);
  return surface.geometry();
}

/** softBox([3, 0.5, 2], 0.2) with soft domes on the top face (y = 0.5). */
export function rivetedPlate(options?: SoftOptions) {
  const radius = 0.4,
    height = 0.25;
  const rivets = [-2, 0, 2].flatMap((x) => [-1, 1].map((z) => ({ x, z, radius, height })));
  const surface = filletedBox([3, 0.5, 2], 0.2, options, (point, normal) => {
    if (normal[1] !== 1) return;
    for (const rivet of rivets) {
      const dx = point[0] - rivet.x,
        dz = point[2] - rivet.z;
      const r = Math.hypot(dx, dz),
        u = r / radius;
      if (u >= 1) continue;
      // A dome whose slope falls to zero at its foot: height * (1 - u^2)^2.
      point[1] += height * (1 - u * u) ** 2;
      const slope = r > 0 ? (-4 * height * u * (1 - u * u)) / radius / r : 0;
      const n = normalize([-slope * dx, 1, -slope * dz]);
      normal.splice(0, 3, ...n);
    }
  });
  return { geometry: surface.geometry(), rivets };
}

export function rippledSphere(radius: number, options?: SoftOptions) {
  const surface = new Surface(options);
  const n = Math.max(1, Math.round((Math.PI / 2) * (radius / surface.options.step)));
  boxLattice(surface, [n, n, n], (c) => {
    const normal = normalize(c.map((v) => Math.tan(((v / n) * 2 - 1) * (Math.PI / 4))) as Vec3);
    return { point: normal.map((v) => v * radius) as Vec3, normal };
  });
  return surface.geometry();
}

/** Quarter torus in the XZ plane about the origin, with flat end caps. */
export function softElbow(bend: number, tube: number, options?: SoftOptions) {
  const surface = new Surface(options);
  const { step } = surface.options;
  const sweep = Math.PI / 2;
  const layers = Math.max(2, Math.round((sweep * bend) / step));
  const ringCount = (rho: number) => Math.max(3, Math.round((2 * Math.PI * rho) / step));
  const at = (phi: number, rho: number, psi: number) => {
    const out: Vec3 = [Math.cos(phi), 0, Math.sin(phi)];
    const across: Vec3 = out.map(
      (v, a) => v * Math.cos(psi) + (a === 1 ? Math.sin(psi) : 0),
    ) as Vec3;
    return { point: out.map((v, a) => v * bend + across[a] * rho) as Vec3, across };
  };
  const rings: number[][] = [];
  for (let l = 0; l <= layers; l++) {
    const end = l === 0 || l === layers;
    const count = ringCount(tube);
    const ring: number[] = [];
    for (let j = 0; j < count; j++) {
      const phi = ((l + (end ? 0 : surface.wobble())) / layers) * sweep;
      const { point, across } = at(phi, tube, (2 * Math.PI * (j + surface.wobble())) / count);
      ring.push(surface.add(point, across, end));
    }
    rings.push(ring);
  }
  for (let l = 0; l < layers; l++) surface.stitch(rings[l + 1], rings[l]);
  for (const [phi, rim] of [
    [0, rings[0]],
    [sweep, rings[layers]],
  ] as const) {
    const normal: Vec3 = phi === 0 ? [0, 0, -1] : [-1, 0, 0];
    const steps = Math.max(1, Math.round(tube / step));
    const disc: number[][] = [[surface.add(at(phi, 0, 0).point, normal)]];
    for (let k = 1; k < steps; k++) {
      const count = ringCount((k / steps) * tube);
      const ring: number[] = [];
      for (let j = 0; j < count; j++) {
        const rho = ((k + surface.wobble()) / steps) * tube;
        ring.push(
          surface.add(at(phi, rho, (2 * Math.PI * (j + surface.wobble())) / count).point, normal),
        );
      }
      disc.push(ring);
    }
    disc.push(rim);
    for (let k = 0; k < steps; k++)
      if (phi === 0) surface.stitch(disc[k + 1], disc[k]);
      else surface.stitch(disc[k], disc[k + 1]);
  }
  return surface.geometry();
}

/**
 * An open sheet extruded along z from -length / 2 to length / 2 over a profile in (x, y): the
 * polyline through `corners`, each interior corner rounded by a circular fillet of radius `radii[i]`
 * (0 leaves it sharp). The sheet faces the left of the polyline's direction of travel, so a profile
 * drawn toward +x faces +y. Samples are `step` apart along the profile and along z.
 */
export function extrudedProfile(
  corners: Vec2[],
  radii: number[],
  length: number,
  options?: SoftOptions,
) {
  const surface = new Surface(options);
  const step = surface.options.step;
  type Piece =
    | { line: true; from: Vec2; to: Vec2; length: number }
    | { line: false; centre: Vec2; radius: number; start: number; turn: number; length: number };
  const pieces: Piece[] = [];
  const unit = (a: Vec2, b: Vec2): Vec2 => {
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
  };
  let from = corners[0];
  for (let i = 1; i < corners.length; i++) {
    const corner = corners[i];
    const r = i < corners.length - 1 ? radii[i - 1] : 0;
    if (!r) {
      pieces.push({
        line: true,
        from,
        to: corner,
        length: Math.hypot(corner[0] - from[0], corner[1] - from[1]),
      });
      from = corner;
      continue;
    }
    const d1 = unit(corners[i - 1], corner),
      d2 = unit(corner, corners[i + 1]);
    const turn = Math.atan2(d1[0] * d2[1] - d1[1] * d2[0], d1[0] * d2[0] + d1[1] * d2[1]);
    const tangent = r * Math.tan(Math.abs(turn) / 2);
    const t1: Vec2 = [corner[0] - d1[0] * tangent, corner[1] - d1[1] * tangent];
    const side = Math.sign(turn);
    const centre: Vec2 = [t1[0] - d1[1] * r * side, t1[1] + d1[0] * r * side];
    pieces.push({ line: true, from, to: t1, length: Math.hypot(t1[0] - from[0], t1[1] - from[1]) });
    pieces.push({
      line: false,
      centre,
      radius: r,
      start: Math.atan2(t1[1] - centre[1], t1[0] - centre[0]),
      turn,
      length: r * Math.abs(turn),
    });
    from = [corner[0] + d2[0] * tangent, corner[1] + d2[1] * tangent];
  }
  const total = pieces.reduce((sum, piece) => sum + piece.length, 0);
  const at = (s: number): Sample => {
    for (const piece of pieces) {
      if (s > piece.length && piece !== pieces[pieces.length - 1]) {
        s -= piece.length;
        continue;
      }
      if (piece.line) {
        const d = unit(piece.from, piece.to);
        return {
          point: [piece.from[0] + d[0] * s, piece.from[1] + d[1] * s],
          normal: [-d[1], d[0]],
        };
      }
      const angle = piece.start + (Math.sign(piece.turn) * s) / piece.radius;
      const radial: Vec2 = [Math.cos(angle), Math.sin(angle)];
      // On a left turn the centre lies on the side the sheet faces.
      const facing = piece.turn > 0 ? -1 : 1;
      return {
        point: [
          piece.centre[0] + radial[0] * piece.radius,
          piece.centre[1] + radial[1] * piece.radius,
        ],
        normal: [radial[0] * facing, radial[1] * facing],
      };
    }
    throw new Error('empty profile');
  };
  const columns = Math.round(total / step) + 1,
    rows = Math.round(length / step) + 1;
  const index: number[][] = [];
  for (let i = 0; i < columns; i++) {
    const { point, normal } = at((i * total) / (columns - 1));
    index.push(
      Array.from({ length: rows }, (_, j) =>
        surface.add(
          [point[0], point[1], -length / 2 + (j * length) / (rows - 1)],
          [normal[0], normal[1], 0],
        ),
      ),
    );
  }
  for (let i = 0; i + 1 < columns; i++)
    for (let j = 0; j + 1 < rows; j++)
      surface.quad(index[i][j], index[i][j + 1], index[i + 1][j + 1], index[i + 1][j]);
  return surface.geometry();
}

/** A piece of a profile in (x, y): `length` mm turning by `turn` radians (0 is straight, + is left). */
export interface TurnedPiece {
  length: number;
  turn: number;
}

/** The point and left normal at distance `s` along pieces of constant curvature from the origin, heading +x. */
export function turnedPoint(pieces: TurnedPiece[], s: number): Sample {
  let point: Vec2 = [0, 0],
    heading = 0;
  for (const [k, piece] of pieces.entries()) {
    const ds = k === pieces.length - 1 ? s : Math.min(s, piece.length);
    const turn = (piece.turn * ds) / piece.length;
    if (Math.abs(piece.turn) < 1e-12)
      point = [point[0] + Math.cos(heading) * ds, point[1] + Math.sin(heading) * ds];
    else {
      const radius = piece.length / piece.turn;
      point = [
        point[0] + radius * (Math.sin(heading + turn) - Math.sin(heading)),
        point[1] - radius * (Math.cos(heading + turn) - Math.cos(heading)),
      ];
    }
    heading += turn;
    s -= ds;
    if (s <= 0) break;
  }
  return { point, normal: [-Math.sin(heading), Math.cos(heading)] };
}

/**
 * An open sheet extruded along z from -extent / 2 to extent / 2 over a profile of pieces of constant
 * curvature (`turnedPoint`). The sheet faces the left of travel.
 */
export function turnedProfile(pieces: TurnedPiece[], extent: number, options?: SoftOptions) {
  const surface = new Surface(options);
  const step = surface.options.step;
  const total = pieces.reduce((sum, piece) => sum + piece.length, 0);
  const columns = Math.round(total / step) + 1,
    rows = Math.round(extent / step) + 1;
  const index: number[][] = [];
  for (let i = 0; i < columns; i++) {
    const { point, normal } = turnedPoint(pieces, (i * total) / (columns - 1));
    index.push(
      Array.from({ length: rows }, (_, j) =>
        surface.add(
          [point[0], point[1], -extent / 2 + (j * extent) / (rows - 1)],
          [normal[0], normal[1], 0],
        ),
      ),
    );
  }
  for (let i = 0; i + 1 < columns; i++)
    for (let j = 0; j + 1 < rows; j++)
      surface.quad(index[i][j], index[i][j + 1], index[i + 1][j + 1], index[i + 1][j]);
  return surface.geometry();
}

/** An open sheet y = height(x, z) over |x|, |z| <= half, facing +y. */
export function heightField(
  half: number,
  height: (x: number, z: number) => number,
  options?: SoftOptions,
) {
  const surface = new Surface(options);
  const count = Math.round((2 * half) / surface.options.step);
  const index: number[][] = [];
  const h = 1e-5;
  for (let i = 0; i <= count; i++) {
    index.push([]);
    for (let j = 0; j <= count; j++) {
      const inner = i > 0 && i < count && j > 0 && j < count;
      const x = -half + ((i + (inner ? surface.wobble() : 0)) * 2 * half) / count,
        z = -half + ((j + (inner ? surface.wobble() : 0)) * 2 * half) / count;
      const gx = (height(x + h, z) - height(x - h, z)) / (2 * h),
        gz = (height(x, z + h) - height(x, z - h)) / (2 * h);
      index[i].push(surface.add([x, height(x, z), z], normalize([-gx, 1, -gz])));
    }
  }
  for (let i = 0; i < count; i++)
    for (let j = 0; j < count; j++)
      surface.quad(index[i][j], index[i][j + 1], index[i + 1][j + 1], index[i + 1][j]);
  return surface.geometry();
}

/**
 * A closed outline extruded y 0..height with its top rim filleted and its bottom rim sharp. The
 * outline is a counter-clockwise path in (x, -z); built extruded along z, then turned so z is y.
 */
function extrudedOutline(outline: Path, height: number, fillet: number, options?: SoftOptions) {
  const surface = new Surface(options);
  const { step } = surface.options;
  // The wall's profile in (outward offset, height): up the wall, round the rim, in over the top.
  const profile = filletedPath(
    [
      [0, 0],
      [0, height],
      [-0.5, height],
    ],
    fillet,
    false,
  );
  const columns = Math.round(outline.length / step),
    rows = Math.max(2, Math.round(profile.length / step));
  const grid: number[][] = [];
  for (let i = 0; i <= rows; i++) {
    const rim = i === 0 || i === rows;
    const { point: offset, normal: across } = profile.at(
      (i + (rim ? 0 : surface.wobble())) * (profile.length / rows),
    );
    const row: number[] = [];
    for (let j = 0; j < columns; j++) {
      const { point, normal } = outline.at(((j + surface.wobble()) * outline.length) / columns);
      row.push(
        surface.add(
          [point[0] + normal[0] * offset[0], point[1] + normal[1] * offset[0], offset[1]],
          [normal[0] * across[0], normal[1] * across[0], across[1]],
          i === 0,
        ),
      );
    }
    grid.push(row);
  }
  for (let i = 0; i < rows; i++)
    for (let j = 0; j < columns; j++) {
      const j1 = (j + 1) % columns;
      surface.quad(grid[i][j], grid[i][j1], grid[i + 1][j1], grid[i + 1][j]);
    }
  cap(surface, grid[rows], height, true, step);
  cap(surface, grid[0], 0, false, step);
  return surface.geometry().rotateX(-Math.PI / 2);
}

/**
 * A stadium slot: two semicircles of radius 1 about (+-1.5, 0) joined by lines 3 mm long at
 * z = +-1, extruded y 0..1 with the top rim filleted.
 */
export function softSlot(fillet: number, options?: SoftOptions) {
  const outline = new Path(true);
  outline.line([-1.5, -1], [1.5, -1]);
  outline.arc([1.5, 0], 1, -Math.PI / 2, Math.PI);
  outline.line([1.5, 1], [-1.5, 1]);
  outline.arc([-1.5, 0], 1, Math.PI / 2, Math.PI);
  return extrudedOutline(outline, 1, fillet, options);
}

/**
 * A prism over the polygon `corners` in (x, z), its upright edges rounded by `rounding` (over 0.5,
 * so the top's inner rim, 0.5 in from the wall, stays a simple polygon), extruded y 0..1 with the
 * top rim filleted.
 */
export function softPrism(
  corners: Vec2[],
  rounding: number,
  fillet: number,
  options?: SoftOptions,
) {
  const outline = corners.map(([x, z]): Vec2 => [x, -z]);
  const area = outline.reduce(
    (sum, p, i) => sum + orient([0, 0], p, outline[(i + 1) % outline.length]),
    0,
  );
  if (area < 0) outline.reverse();
  return extrudedOutline(filletedPath(outline, rounding, true), 1, fillet, options);
}
