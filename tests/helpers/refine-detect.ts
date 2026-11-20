import { BufferAttribute, BufferGeometry, Triangle, Vector3 } from 'three';
import type { GuidePoint } from '../../src/core/refine-band';
import { drawnCurve } from '../../src/core/refine-curve';
import type { RefineProposal } from '../../src/core/refine-detect';
import type { EdgeInput } from '../../src/core/refine-edge';
import type { RefineMesh } from '../../src/core/refine-mesh';
import type { Vec3 } from '../../src/core/types';

export type EdgeProposal = Extract<RefineProposal, { type: 'edge' }>;

/** Every guide point of an edge proposal. */
export function guidePoints(input: EdgeInput): GuidePoint[] {
  return input.segments.flatMap((segment) => segment.points);
}

/** Distance from `p` to the segment from `a` to `b`. */
function segmentDistance(p: Vec3, a: Vec3, b: Vec3) {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const w = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const t = Math.min(
    1,
    Math.max(0, (w[0] * d[0] + w[1] * d[1] + w[2] * d[2]) / (d[0] ** 2 + d[1] ** 2 + d[2] ** 2)),
  );
  return Math.hypot(w[0] - t * d[0], w[1] - t * d[1], w[2] - t * d[2]);
}

/** The 12 edges of the sharp box of `half` centred on the origin. */
function boxEdges(half: Vec3): [Vec3, Vec3][] {
  const edges: [Vec3, Vec3][] = [];
  for (let axis = 0; axis < 3; axis++)
    for (const s of [-1, 1])
      for (const t of [-1, 1]) {
        const [u, w] = [(axis + 1) % 3, (axis + 2) % 3];
        const a = [0, 0, 0] as Vec3,
          b = [0, 0, 0] as Vec3;
        a[axis] = -half[axis];
        b[axis] = half[axis];
        a[u] = b[u] = s * half[u];
        a[w] = b[w] = t * half[w];
        edges.push([a, b]);
      }
  return edges;
}

/**
 * Number of edge proposals matched one to one with true edges of the sharp box of `half`: a
 * proposal matches an edge when every one of its guide points lies within `tolerance` of it.
 */
export function matchedBoxEdges(edges: EdgeProposal[], half: Vec3, tolerance: number) {
  const truth = boxEdges(half);
  const taken = new Set<number>();
  let matched = 0;
  for (const edge of edges) {
    const points = guidePoints(edge.input).map((p) => p.position);
    const k = truth.findIndex(
      ([a, b], i) => !taken.has(i) && points.every((p) => segmentDistance(p, a, b) <= tolerance),
    );
    if (k < 0) continue;
    taken.add(k);
    matched++;
  }
  return matched;
}

/** Welded vertices on the crests of softBox's four fillets along x, at least `inset` from the corners. */
export function boxCrestVertices(mesh: RefineMesh, half: Vec3, fillet: number, inset = 0.5) {
  const crest: number[] = [];
  for (let v = 0; v < mesh.weldedCount; v++) {
    const [x, y, z] = mesh.position.subarray(v * 3, v * 3 + 3);
    if (Math.abs(x) > half[0] - fillet - inset) continue;
    const dy = Math.abs(y) - (half[1] - fillet),
      dz = Math.abs(z) - (half[2] - fillet);
    if (dy <= 0 || dz <= 0) continue;
    if (Math.abs(Math.atan2(dy, dz) - Math.PI / 4) < (4 * Math.PI) / 180) crest.push(v);
  }
  return crest;
}

/** Triangles whose three corners all satisfy `keep`. */
export function trianglesWhere(
  mesh: RefineMesh,
  keep: (x: number, y: number, z: number) => boolean,
) {
  const found: number[] = [];
  for (let t = 0; t < mesh.triangleCount; t++) {
    let all = true;
    for (let k = 0; k < 3 && all; k++) {
      const w = mesh.weldOf[mesh.corners[t * 3 + k]] * 3;
      all = keep(mesh.position[w], mesh.position[w + 1], mesh.position[w + 2]);
    }
    if (all) found.push(t);
  }
  return Uint32Array.from(found);
}

/** Every position a proposal names: guide points of an edge, triangle corners of a region. */
export function proposalPositions(mesh: RefineMesh, proposal: RefineProposal): Vec3[] {
  if (proposal.type === 'edge') return guidePoints(proposal.input).map((p) => p.position);
  const positions: Vec3[] = [];
  for (const t of proposal.input.triangles)
    for (let k = 0; k < 3; k++) {
      const w = mesh.weldOf[mesh.corners[t * 3 + k]] * 3;
      positions.push([mesh.position[w], mesh.position[w + 1], mesh.position[w + 2]]);
    }
  return positions;
}

/** The guide as drawn: a closed arc as its full circle, any other guide by `drawnCurve`. */
export function drawnPoints(input: EdgeInput): Vec3[] {
  const [segment] = input.segments;
  const flat = segment.points.flatMap((p) => p.position);
  if (!input.closed) {
    const { points } = drawnCurve(segment.kind, flat, 0.02);
    return Array.from({ length: points.length / 3 }, (_, i) => [
      points[i * 3],
      points[i * 3 + 1],
      points[i * 3 + 2],
    ]);
  }
  // The circle through the three points, drawn whole.
  const [a, b, c] = segment.points.map((p) => p.position);
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
    v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const nn = n[0] ** 2 + n[1] ** 2 + n[2] ** 2;
  const uu = u[0] ** 2 + u[1] ** 2 + u[2] ** 2,
    vv = v[0] ** 2 + v[1] ** 2 + v[2] ** 2;
  // Offset of the centre from a: (|u|^2 (v x n) + |v|^2 (n x u)) / (2 |n|^2).
  const o = [0, 1, 2].map(
    (k) =>
      (uu * (v[(k + 1) % 3] * n[(k + 2) % 3] - v[(k + 2) % 3] * n[(k + 1) % 3]) +
        vv * (n[(k + 1) % 3] * u[(k + 2) % 3] - n[(k + 2) % 3] * u[(k + 1) % 3])) /
      (2 * nn),
  );
  const radius = Math.hypot(o[0], o[1], o[2]);
  const e1 = o.map((x) => -x / radius);
  const nl = Math.sqrt(nn);
  const e2 = [0, 1, 2].map(
    (k) => (n[(k + 1) % 3] * e1[(k + 2) % 3] - n[(k + 2) % 3] * e1[(k + 1) % 3]) / nl,
  );
  const count = Math.ceil((2 * Math.PI * radius) / 0.02);
  return Array.from({ length: count + 1 }, (_, i) => {
    const t = (2 * Math.PI * i) / count;
    return [0, 1, 2].map(
      (k) => a[k] + o[k] + radius * (Math.cos(t) * e1[k] + Math.sin(t) * e2[k]),
    ) as Vec3;
  });
}

/** Length of a polyline. */
export function polylineLength(points: Vec3[]) {
  let length = 0;
  for (let i = 1; i < points.length; i++)
    length += Math.hypot(
      points[i][0] - points[i - 1][0],
      points[i][1] - points[i - 1][1],
      points[i][2] - points[i - 1][2],
    );
  return length;
}

/** Height of a dome of radius 3 over the origin, with a round dent of depth 0.25 and radius 0.8 at (0.3, 0.2). */
export function dentedDome(x: number, z: number) {
  const u = Math.hypot(x - 0.3, z - 0.2) / 0.8;
  return Math.sqrt(9 - x * x - z * z) - 3 - (u < 1 ? 0.25 * (1 - u * u) ** 2 : 0);
}

/** Height of a plate with a round pocket 0.3 deep and 0.9 in radius at the origin, its wall 0.1 wide. */
export function pocketedPlate(x: number, z: number) {
  const t = Math.min(1, Math.max(0, (0.95 - Math.hypot(x, z)) / 0.1));
  return -0.3 * t * t * (3 - 2 * t);
}

/** Radius and height of the crests of `collar`'s two outer rims. */
export const collarCrest = {
  radius: 1.5 - 0.1 + 0.1 / Math.SQRT2,
  heights: [0.1 - 0.1 / Math.SQRT2, 0.4 + 0.1 / Math.SQRT2],
};

/**
 * A tube of radius 1 about y with a collar of radius 1.5 from y = 0 to 0.5, all four profile
 * corners rounded by 0.1, open at y = -1.2 and 1.7. Within `slot` radians of +x the collar is cut
 * away by a slot with steep walls.
 */
export function collar(slot = 0) {
  const fillet = 0.1,
    step = 0.05;
  const corners: [number, number][] = [
    [1, -1.2],
    [1, 0],
    [1.5, 0],
    [1.5, 0.5],
    [1, 0.5],
    [1, 1.7],
  ];
  // The profile in (r, y) as a polyline sampled `step` apart, each inner corner a circular arc.
  const profile: [number, number][] = [];
  const emit = (p: [number, number]) => {
    const last = profile[profile.length - 1];
    if (!last) return profile.push(p);
    const length = Math.hypot(p[0] - last[0], p[1] - last[1]);
    const count = Math.ceil(length / step);
    for (let k = 1; k <= count; k++)
      profile.push([
        last[0] + ((p[0] - last[0]) * k) / count,
        last[1] + ((p[1] - last[1]) * k) / count,
      ]);
  };
  emit(corners[0]);
  for (let i = 1; i < corners.length - 1; i++) {
    const [a, b, c] = [corners[i - 1], corners[i], corners[i + 1]];
    const d1 = [Math.sign(b[0] - a[0]), Math.sign(b[1] - a[1])],
      d2 = [Math.sign(c[0] - b[0]), Math.sign(c[1] - b[1])];
    const from: [number, number] = [b[0] - d1[0] * fillet, b[1] - d1[1] * fillet];
    const centre = [from[0] + d2[0] * fillet, from[1] + d2[1] * fillet];
    emit(from);
    const start = Math.atan2(from[1] - centre[1], from[0] - centre[0]);
    const turn = Math.sign(d1[0] * d2[1] - d1[1] * d2[0]) * (Math.PI / 2);
    const count = Math.ceil((fillet * Math.PI) / 2 / (step / 2));
    for (let k = 1; k <= count; k++) {
      const angle = start + (turn * k) / count;
      profile.push([centre[0] + fillet * Math.cos(angle), centre[1] + fillet * Math.sin(angle)]);
    }
  }
  emit(corners[corners.length - 1]);
  const around = Math.round((2 * Math.PI * 1.5) / step);
  // Within `slot` of +x the collar is cut away down to 5 % of its height, with walls 0.06 rad wide.
  const kept = (angle: number) => {
    const t = Math.min(1, Math.max(0, (Math.abs(angle) - slot) / 0.06));
    return Math.max(0.05, slot > 0 ? t * t * (3 - 2 * t) : 1);
  };
  const at = (i: number, j: number) => {
    const angle = (2 * Math.PI * j) / around;
    const [r, y] = profile[i];
    const radius = 1 + (r - 1) * kept(Math.atan2(Math.sin(angle), Math.cos(angle)));
    return [radius * Math.cos(angle), y, radius * Math.sin(angle)];
  };
  const triangles: number[] = [];
  for (let i = 0; i + 1 < profile.length; i++)
    for (let j = 0; j < around; j++) {
      const [a, b, c, d] = [at(i, j), at(i, j + 1), at(i + 1, j + 1), at(i + 1, j)];
      // Outward faces: the profile runs up the outside of the tube.
      triangles.push(...a, ...c, ...b, ...a, ...d, ...c);
    }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(Float32Array.from(triangles), 3));
  return geometry;
}

/** Raises a strap 0.34 mm proud across `collar`'s rings within `half` radians of +x, in place. */
export function strapped(geometry: BufferGeometry, half: number) {
  const position = geometry.getAttribute('position');
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i),
      z = position.getZ(i);
    const t = Math.min(1, Math.max(0, (Math.abs(Math.atan2(z, x)) - half) / 0.04));
    const f = 1 + (0.34 * (1 - t * t * (3 - 2 * t))) / Math.hypot(x, z);
    position.setX(i, x * f);
    position.setZ(i, z * f);
  }
  return geometry;
}

/** Distance from `p` to the nearest of `triangles`. */
export function distanceToTriangles(mesh: RefineMesh, p: Vec3, triangles: ArrayLike<number>) {
  let best = Infinity;
  const corner = (t: number, k: number): Vec3 => {
    const w = mesh.weldOf[mesh.corners[t * 3 + k]] * 3;
    return [mesh.position[w], mesh.position[w + 1], mesh.position[w + 2]];
  };
  for (let i = 0; i < triangles.length; i++) {
    const t = triangles[i];
    const q = new Triangle(
      new Vector3(...corner(t, 0)),
      new Vector3(...corner(t, 1)),
      new Vector3(...corner(t, 2)),
    ).closestPointToPoint(new Vector3(...p), new Vector3());
    best = Math.min(best, q.distanceTo(new Vector3(...p)));
  }
  return best;
}

/**
 * An open tube of radius 2 about y, 32 rings of 16 at y = 0.06 apart, continued by 20 more rings
 * about an axis `offset` along x: two cylinders that meet along a seam. Each ring has a seeded
 * ripple, 0.003 mm on the first and 0.012 mm on the second.
 */
export function offsetPipe(offset: number) {
  const first = 32,
    second = 20,
    around = 16;
  const at = (i: number, j: number): Vec3 => {
    const a = (j * Math.PI * 2) / around;
    const right = i >= first;
    const r = 2 + (right ? 0.012 : 0.003) * Math.sin(41 * (right ? i - first : i) + 39 * j);
    return [(right ? offset : 0) + r * Math.cos(a), (i - first + 1) * 0.06, r * Math.sin(a)];
  };
  const xyz: number[] = [];
  for (let i = 0; i < first + second - 1; i++)
    for (let j = 0; j < around; j++) {
      const k = (j + 1) % around;
      xyz.push(
        ...at(i, j),
        ...at(i + 1, j),
        ...at(i, k),
        ...at(i + 1, j),
        ...at(i + 1, k),
        ...at(i, k),
      );
    }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(Float32Array.from(xyz), 3));
  return geometry;
}
