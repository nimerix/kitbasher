import type { GuidePoint } from '../../src/core/refine-band';
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
