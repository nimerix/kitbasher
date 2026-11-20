import {
  type RefineMesh,
  type RefineTopology,
  addGeometryVertex,
  addTriangle,
  addWeldedVertex,
  moveVertex,
  setTriangle,
} from './refine-mesh';

export interface CutResult {
  /** Welded ids now on the cut. */
  chain: Uint32Array;
  /** For each triangle that was split: its id and the ids of the triangles that now cover it. */
  children: Map<number, number[]>;
}

/** A split welded edge: the new welded vertex and where it lies from the lower welded end. */
interface Split {
  welded: number;
  t: number;
}

/**
 * Puts a chain of mesh edges on the zero set of `field` among `vertices`.
 * `place` maps a point on the zero set to its final position. The mesh must be a topology clone.
 * `field[i]` is the value at `vertices[i]`; `topology` describes the mesh before the cut.
 */
export function cutAlongField(
  mesh: RefineMesh,
  topology: RefineTopology,
  vertices: Uint32Array,
  field: Float32Array,
  place: (x: number, y: number, z: number, out: Float32Array) => void,
  snap = 0.25,
): CutResult {
  const { neighbourStart, neighbours, triangleStart, trianglesOf } = topology;
  const weldedCount = mesh.weldedCount;
  const vertexCount = mesh.vertexCount;
  const triangleCount = mesh.triangleCount;

  const value = new Float64Array(weldedCount).fill(NaN);
  vertices.forEach((v, i) => (value[v] = field[i]));
  const zero = new Uint8Array(weldedCount);
  // Point on the zero set each zero vertex is placed from.
  const point = new Float64Array(weldedCount * 3);
  const lerp = (a: number, b: number, t: number, out: Float64Array, offset: number) => {
    for (let axis = 0; axis < 3; axis++)
      out[offset + axis] = mesh.position[a * 3 + axis] * (1 - t) + mesh.position[b * 3 + axis] * t;
  };
  for (const v of vertices)
    if (value[v] === 0) {
      zero[v] = 1;
      lerp(v, v, 0, point, v * 3);
    }

  const edgeA: number[] = [],
    edgeB: number[] = [],
    edgeT: number[] = [];
  for (let a = 0; a < weldedCount; a++) {
    if (Number.isNaN(value[a])) continue;
    for (let i = neighbourStart[a]; i < neighbourStart[a + 1]; i++) {
      const b = neighbours[i];
      if (b <= a || !(value[a] * value[b] < 0)) continue;
      edgeA.push(a);
      edgeB.push(b);
      edgeT.push(value[a] / (value[a] - value[b]));
    }
  }

  // A vertex may snap unless some triangle around it would then lie wholly on the zero set.
  const canSnap = (v: number) => {
    for (let i = triangleStart[v]; i < triangleStart[v + 1]; i++) {
      const t = trianglesOf[i] * 3;
      let others = 0;
      for (let k = 0; k < 3; k++) {
        const w = mesh.weldOf[mesh.corners[t + k]];
        if (w !== v && zero[w]) others++;
      }
      if (others === 2) return false;
    }
    return true;
  };
  const clamped = new Uint8Array(edgeT.length);
  const near = (i: number) => Math.min(edgeT[i], 1 - edgeT[i]);
  const candidates = edgeT.map((_, i) => i).filter((i) => near(i) < snap);
  candidates.sort((i, j) => near(i) - near(j) || i - j);
  for (const i of candidates) {
    const a = edgeA[i],
      b = edgeB[i];
    if (zero[a] || zero[b]) continue;
    const v = edgeT[i] < snap ? a : b;
    if (!canSnap(v)) {
      clamped[i] = 1;
      continue;
    }
    zero[v] = 1;
    lerp(a, b, edgeT[i], point, v * 3);
  }

  const out = new Float32Array(3);
  const at = new Float64Array(3);
  const chain: number[] = [];
  const splits = new Map<number, Split>();
  for (let i = 0; i < edgeT.length; i++) {
    const a = edgeA[i],
      b = edgeB[i];
    if (zero[a] || zero[b]) continue;
    const t = clamped[i] ? Math.min(Math.max(edgeT[i], 0.1), 0.9) : edgeT[i];
    lerp(a, b, t, at, 0);
    place(at[0], at[1], at[2], out);
    const welded = addWeldedVertex(mesh, out[0], out[1], out[2]);
    mesh.crease[welded] = 1;
    splits.set(a * weldedCount + b, { welded, t });
  }
  for (let v = 0; v < weldedCount; v++) {
    if (!zero[v]) continue;
    place(point[v * 3], point[v * 3 + 1], point[v * 3 + 2], out);
    moveVertex(mesh, v, out[0], out[1], out[2]);
    mesh.crease[v] = 1;
    chain.push(v);
  }
  for (const split of splits.values()) chain.push(split.welded);

  // One geometry vertex per split welded edge and pair of end geometry vertices.
  const created = new Map<number, number>();
  const size = mesh.colorSize;
  const color = new Float32Array(size);
  const splitVertex = (ga: number, gb: number): number => {
    let wa = mesh.weldOf[ga],
      wb = mesh.weldOf[gb];
    if (wa > wb) {
      [ga, gb] = [gb, ga];
      [wa, wb] = [wb, wa];
    }
    const key = ga * vertexCount + gb;
    let vertex = created.get(key);
    if (vertex !== undefined) return vertex;
    const split = splits.get(wa * weldedCount + wb)!;
    if (mesh.color)
      for (let k = 0; k < size; k++)
        color[k] = mesh.color[ga * size + k] * (1 - split.t) + mesh.color[gb * size + k] * split.t;
    vertex = addGeometryVertex(mesh, split.welded, color);
    created.set(key, vertex);
    return vertex;
  };
  const isSplit = (ga: number, gb: number) => {
    const wa = mesh.weldOf[ga],
      wb = mesh.weldOf[gb];
    return splits.has(Math.min(wa, wb) * weldedCount + Math.max(wa, wb));
  };
  const distance = (ga: number, gb: number) => {
    const a = mesh.weldOf[ga] * 3,
      b = mesh.weldOf[gb] * 3;
    return Math.hypot(
      mesh.position[a] - mesh.position[b],
      mesh.position[a + 1] - mesh.position[b + 1],
      mesh.position[a + 2] - mesh.position[b + 2],
    );
  };

  const children = new Map<number, number[]>();
  for (let t = 0; t < triangleCount; t++) {
    const g = [mesh.corners[t * 3], mesh.corners[t * 3 + 1], mesh.corners[t * 3 + 2]];
    const cut = [0, 1, 2].filter((k) => isSplit(g[k], g[(k + 1) % 3]));
    if (cut.length === 0) continue;
    if (cut.length === 1) {
      const k = cut[0];
      const [a, b, c] = [g[k], g[(k + 1) % 3], g[(k + 2) % 3]];
      const m = splitVertex(a, b);
      setTriangle(mesh, t, a, m, c);
      children.set(t, [t, addTriangle(mesh, m, b, c)]);
      continue;
    }
    // Two cut edges meet at the apex: a triangle beyond the cut and a quad on this side.
    const k = cut[0] === 0 && cut[1] === 2 ? 0 : cut[1];
    const [a, b, c] = [g[k], g[(k + 1) % 3], g[(k + 2) % 3]];
    const ab = splitVertex(a, b),
      ca = splitVertex(c, a);
    setTriangle(mesh, t, a, ab, ca);
    const quad =
      distance(ab, c) <= distance(b, ca)
        ? [addTriangle(mesh, ab, b, c), addTriangle(mesh, ab, c, ca)]
        : [addTriangle(mesh, ab, b, ca), addTriangle(mesh, b, c, ca)];
    children.set(t, [t, ...quad]);
  }

  return { chain: Uint32Array.from(chain), children };
}

/** Replaces split triangles in a painted set with their children. */
export function remapTriangles(
  triangles: Uint32Array,
  children: Map<number, number[]>,
): Uint32Array {
  const result: number[] = [];
  for (const t of triangles) result.push(...(children.get(t) ?? [t]));
  return Uint32Array.from(new Set(result)).sort();
}
