import { type RefineMesh, type RefineTopology, vertexNormal } from './refine-mesh';

export interface Curvature {
  /** Principal curvatures per welded vertex, |k1| >= |k2|, 1/mm. */
  k1: Float32Array;
  k2: Float32Array;
  /** Unit direction of k2 per welded vertex: along an edge. */
  along: Float32Array;
}

/** Unit vertex normals, computed on first use. */
export class VertexNormals {
  readonly normals: Float32Array;
  private readonly done: Uint8Array;
  private readonly scratch = new Float32Array(3);

  constructor(
    private readonly mesh: RefineMesh,
    private readonly topology: RefineTopology,
  ) {
    this.normals = new Float32Array(mesh.weldedCount * 3);
    this.done = new Uint8Array(mesh.weldedCount);
  }

  /** Makes sure the normal of `v` is in `normals`, and returns `normals`. */
  of(v: number): Float32Array {
    if (!this.done[v]) {
      vertexNormal(this.mesh, this.topology, v, this.scratch);
      this.normals.set(this.scratch, v * 3);
      this.done[v] = 1;
    }
    return this.normals;
  }
}

/**
 * Curvature from the change of normals over the ring of radius `scale` around each vertex: the
 * symmetric shape operator that best maps each offset, in the tangent plane, to the change of the
 * normal over it, from the vertices joined over the surface and within `scale`. Positive is convex.
 * With `vertices` the arrays hold one entry per listed vertex, in its order.
 */
export function vertexCurvature(
  mesh: RefineMesh,
  topology: RefineTopology,
  scale: number,
  vertices?: Uint32Array,
  normals: VertexNormals = new VertexNormals(mesh, topology),
  visit?: (done: number) => void,
): Curvature {
  const count = vertices ? vertices.length : mesh.weldedCount;
  const k1 = new Float32Array(count),
    k2 = new Float32Array(count),
    along = new Float32Array(count * 3);
  const { position } = mesh;
  const { neighbourStart, neighbours } = topology;
  const stamp = new Int32Array(mesh.weldedCount).fill(-1);
  let queue = new Uint32Array(256);
  const r2 = scale * scale;
  for (let i = 0; i < count; i++) {
    if (visit && (i & 1023) === 0) visit(i);
    const v = vertices ? vertices[i] : i;
    const n = normals.of(v);
    const nx = n[v * 3],
      ny = n[v * 3 + 1],
      nz = n[v * 3 + 2];
    if (nx === 0 && ny === 0 && nz === 0) continue;
    // Tangent basis (e1, e2) at v.
    const seed = Math.abs(nx) < 0.9 ? 0 : 1;
    const d0 = seed === 0 ? nx : ny;
    let e1x = (seed === 0 ? 1 : 0) - d0 * nx,
      e1y = (seed === 1 ? 1 : 0) - d0 * ny,
      e1z = -d0 * nz;
    const l1 = Math.hypot(e1x, e1y, e1z);
    e1x /= l1;
    e1y /= l1;
    e1z /= l1;
    const e2x = ny * e1z - nz * e1y,
      e2y = nz * e1x - nx * e1z,
      e2z = nx * e1y - ny * e1x;
    const px = position[v * 3],
      py = position[v * 3 + 1],
      pz = position[v * 3 + 2];
    let sxx = 0,
      sxy = 0,
      syy = 0,
      sxu = 0,
      syu = 0,
      sxw = 0,
      syw = 0;
    let head = 0,
      tail = 0;
    queue[tail++] = v;
    stamp[v] = i;
    while (head < tail) {
      const u = queue[head++];
      for (let j = neighbourStart[u]; j < neighbourStart[u + 1]; j++) {
        const w = neighbours[j];
        if (stamp[w] === i) continue;
        stamp[w] = i;
        const dx = position[w * 3] - px,
          dy = position[w * 3 + 1] - py,
          dz = position[w * 3 + 2] - pz;
        if (dx * dx + dy * dy + dz * dz > r2) continue;
        if (tail === queue.length) {
          const grown = new Uint32Array(tail * 2);
          grown.set(queue);
          queue = grown;
        }
        queue[tail++] = w;
        const m = normals.of(w);
        const x = dx * e1x + dy * e1y + dz * e1z,
          y = dx * e2x + dy * e2y + dz * e2z;
        const mx = m[w * 3] - nx,
          my = m[w * 3 + 1] - ny,
          mz = m[w * 3 + 2] - nz;
        const du = mx * e1x + my * e1y + mz * e1z,
          dw = mx * e2x + my * e2y + mz * e2z;
        sxx += x * x;
        sxy += x * y;
        syy += y * y;
        sxu += x * du;
        syu += y * du;
        sxw += x * dw;
        syw += y * dw;
      }
    }
    // Least squares for S = [[a, b], [b, c]] in (a x + b y - du)^2 + (b x + c y - dw)^2.
    const m00 = sxx,
      m01 = sxy,
      m11 = sxx + syy,
      m22 = syy;
    const r0 = sxu,
      r1 = syu + sxw,
      r2v = syw;
    const det = m00 * (m11 * m22 - m01 * m01) - m01 * (m01 * m22);
    if (!(Math.abs(det) > 1e-30)) continue;
    const a = (r0 * (m11 * m22 - m01 * m01) - m01 * (r1 * m22 - m01 * r2v)) / det;
    const b = (m00 * (r1 * m22 - m01 * r2v) - r0 * (m01 * m22)) / det;
    const c = (m00 * (m11 * r2v - m01 * r1) - m01 * (m01 * r2v) + r0 * m01 * m01) / det;
    const mean = (a + c) / 2,
      spread = Math.hypot((a - c) / 2, b);
    const high = mean + spread,
      low = mean - spread;
    const first = Math.abs(high) >= Math.abs(low) ? high : low;
    const second = first === high ? low : high;
    // Eigenvector of `second`: the direction the surface bends least, along an edge.
    let vx = b,
      vy = second - a;
    if (Math.abs(vx) + Math.abs(vy) < 1e-12) {
      vx = second - c;
      vy = b;
    }
    if (Math.abs(vx) + Math.abs(vy) < 1e-12) {
      vx = 1;
      vy = 0;
    }
    const length = Math.hypot(vx, vy);
    vx /= length;
    vy /= length;
    k1[i] = first;
    k2[i] = second;
    along[i * 3] = vx * e1x + vy * e2x;
    along[i * 3 + 1] = vx * e1y + vy * e2y;
    along[i * 3 + 2] = vx * e1z + vy * e2z;
  }
  return { k1, k2, along };
}
