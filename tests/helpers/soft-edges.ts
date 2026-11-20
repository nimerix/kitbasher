import { BufferAttribute, BufferGeometry, ShapeUtils, Vector2 } from 'three';
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

function filletedBox(half: Vec3, fillet: number, options: SoftOptions | undefined, raise?: Raise) {
  const surface = new Surface(options);
  const counts = half.map((h) => Math.max(1, Math.round((2 * h) / surface.options.step))) as Vec3;
  boxLattice(surface, counts, (c) => {
    const p = c.map((v, a) => -half[a] + (v * 2 * half[a]) / counts[a]);
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

/** Closes a polygon's outline with triangles, counter-clockwise, using every outline point. */
function capTriangles(outline: Vec2[]) {
  const n = outline.length;
  const faces = ShapeUtils.triangulateShape(
    outline.map(([x, y]) => new Vector2(x, y)),
    [],
  );
  const used = new Uint8Array(n);
  for (const face of faces) for (const i of face) used[i] = 1;
  const area = (a: number, b: number, c: number) => {
    const [p, q, r] = [outline[a], outline[b], outline[c]];
    return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  };
  const result: number[] = [];
  for (const [a, b, c] of faces) {
    const corners = area(a, b, c) > 0 ? [a, b, c] : [a, c, b];
    // Earcut drops points that lie on a straight run of the outline, so fan them back in.
    const skipped = corners.map((from, k) => {
      const to = corners[(k + 1) % 3],
        run: number[] = [];
      let i = (from + 1) % n;
      for (; i !== to && !used[i]; i = (i + 1) % n) run.push(i);
      return i === to ? run : [];
    });
    const edge = skipped.findIndex((run) => run.length > 0);
    if (edge < 0) {
      result.push(...corners);
      continue;
    }
    if (skipped.filter((run) => run.length > 0).length > 1)
      throw new Error('A cap triangle spans more than one straight run.');
    const chain = [corners[edge], ...skipped[edge], corners[(edge + 1) % 3]];
    const apex = corners[(edge + 2) % 3];
    for (let m = 0; m + 1 < chain.length; m++) result.push(chain[m], chain[m + 1], apex);
  }
  return result;
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
  const outline = Array.from({ length: columns }, (_, i) => path.at(i * spacing).point);
  const cap = capTriangles(outline);
  for (let t = 0; t < cap.length; t += 3) {
    const [a, b, c] = cap.slice(t, t + 3);
    surface.triangle(grid[layers][a], grid[layers][b], grid[layers][c]);
    surface.triangle(grid[0][a], grid[0][c], grid[0][b]);
  }
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
