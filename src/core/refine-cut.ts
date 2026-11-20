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
  /** Pairs of welded ids, one pair per piece of the zero set that now runs along a mesh edge. */
  edges: Uint32Array;
  /** For each triangle that was split: its id and the ids of the triangles that now cover it. */
  children: Map<number, number[]>;
  /** Triangles that still straddle the zero set because a split or snap was dropped. */
  skipped: Uint32Array;
}

/** A split welded edge: the new welded vertex and where it lies from the lower welded end. */
interface Split {
  welded: number;
  t: number;
}

/** A child is collapsed below this fraction of its parent's area, or below `tinyArea`. */
const collapsedFraction = 1e-6;
const tinyArea = 1e-12;

/**
 * Children of a triangle whose edges `cut` (edge k runs from corner k to k + 1) are split. A child
 * names corners 0 to 2 and the split point of edge k as 3 + k. `far` measures two of those points;
 * a quad left by two splits is divided along its shorter diagonal.
 */
function divide(cut: number[], far: (p: number, q: number) => number): number[][] {
  if (cut.length === 0) return [[0, 1, 2]];
  if (cut.length === 1) {
    const k = cut[0];
    const [a, b, c] = [k, (k + 1) % 3, (k + 2) % 3];
    return [
      [a, 3 + k, c],
      [3 + k, b, c],
    ];
  }
  // Two cut edges meet at the apex: a triangle beyond the cut and a quad on this side.
  const k = cut[0] === 0 && cut[1] === 2 ? 0 : cut[1];
  const [a, b, c] = [k, (k + 1) % 3, (k + 2) % 3];
  const ab = 3 + a,
    ca = 3 + c;
  const quad =
    far(ab, c) <= far(b, ca)
      ? [
          [ab, b, c],
          [ab, c, ca],
        ]
      : [
          [ab, b, ca],
          [b, c, ca],
        ];
  return [[a, ab, ca], ...quad];
}

const area = (p: Float64Array) => {
  const ux = p[3] - p[0],
    uy = p[4] - p[1],
    uz = p[5] - p[2];
  const vx = p[6] - p[0],
    vy = p[7] - p[1],
    vz = p[8] - p[2];
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
};

/**
 * Puts a chain of mesh edges on the zero set of `field` among `vertices`.
 * `place` maps a point on the zero set to its final position. The mesh must be a topology clone.
 * `field[i]` is the value at `vertices[i]`; `topology` describes the mesh before the cut.
 * The whole cut is planned on final positions first; a split or snap that would collapse a triangle
 * is revised or dropped, and the triangles left straddling are reported in `skipped`.
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
  const edgeOf = new Map<number, number>();
  for (let a = 0; a < weldedCount; a++) {
    if (Number.isNaN(value[a])) continue;
    for (let i = neighbourStart[a]; i < neighbourStart[a + 1]; i++) {
      const b = neighbours[i];
      if (b <= a || !(value[a] * value[b] < 0)) continue;
      edgeOf.set(a * weldedCount + b, edgeA.length);
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

  // The plan: final positions of placed zero vertices and splits, as Float32 as the mesh stores them.
  const out = new Float32Array(3);
  const at = new Float64Array(3);
  const placed = new Uint8Array(weldedCount);
  const placedAt = new Float32Array(weldedCount * 3);
  for (let v = 0; v < weldedCount; v++) {
    if (!zero[v]) continue;
    place(point[v * 3], point[v * 3 + 1], point[v * 3 + 2], out);
    placedAt.set(out, v * 3);
    placed[v] = 1;
  }
  const splitT = new Float64Array(edgeT.length).fill(NaN);
  const splitAt = new Float32Array(edgeT.length * 3);
  const planSplit = (i: number, t: number) => {
    splitT[i] = t;
    lerp(edgeA[i], edgeB[i], t, at, 0);
    place(at[0], at[1], at[2], out);
    splitAt.set(out, i * 3);
  };
  for (let i = 0; i < edgeT.length; i++)
    if (!zero[edgeA[i]] && !zero[edgeB[i]])
      planSplit(i, clamped[i] ? Math.min(Math.max(edgeT[i], 0.1), 0.9) : edgeT[i]);
  // Planned split of the welded edge from a to b, or -1.
  const splitOf = (a: number, b: number) => {
    const i = edgeOf.get(Math.min(a, b) * weldedCount + Math.max(a, b));
    return i !== undefined && !Number.isNaN(splitT[i]) ? i : -1;
  };

  // Every triangle the plan can touch: those around zero vertices and around split edges.
  const checked = new Uint8Array(triangleCount);
  const touched: number[] = [];
  const around = (v: number) => {
    for (let i = triangleStart[v]; i < triangleStart[v + 1]; i++)
      if (!checked[trianglesOf[i]]) {
        checked[trianglesOf[i]] = 1;
        touched.push(trianglesOf[i]);
      }
  };
  for (let v = 0; v < weldedCount; v++) if (zero[v]) around(v);
  for (let i = 0; i < edgeT.length; i++) if (!Number.isNaN(splitT[i])) around(edgeA[i]);

  const w = [0, 0, 0];
  const corner = (k: number) => w[k % 3];
  const cutOf = () => [0, 1, 2].filter((k) => splitOf(corner(k), corner(k + 1)) >= 0);
  const pointOf = (ref: number, target: Float64Array, offset: number) => {
    let source: Float32Array = mesh.position,
      i = corner(ref) * 3;
    if (ref >= 3) {
      source = splitAt;
      i = splitOf(corner(ref), corner(ref + 1)) * 3;
    } else if (placed[corner(ref)]) source = placedAt;
    for (let axis = 0; axis < 3; axis++) target[offset + axis] = source[i + axis];
  };
  const points = new Float64Array(9);
  const ends = new Float64Array(6);
  const far = (p: number, q: number) => {
    pointOf(p, ends, 0);
    pointOf(q, ends, 3);
    return Math.hypot(ends[0] - ends[3], ends[1] - ends[4], ends[2] - ends[5]);
  };
  // Revises the plan behind a collapsed child: its splits move to the midpoint, then are dropped,
  // then its placed vertices stay where they are. False when nothing is left to revise.
  const revise = (child: number[]) => {
    const splits = child
      .filter((ref) => ref >= 3)
      .map((ref) => splitOf(corner(ref), corner(ref + 1)));
    const off = splits.find((i) => splitT[i] !== 0.5);
    if (off !== undefined) planSplit(off, 0.5);
    else if (splits.length > 0) splitT[splits[0]] = NaN;
    else {
      const v = child.map(corner).find((v) => placed[v]);
      if (v === undefined) return false;
      placed[v] = 0;
      if (value[v] !== 0) zero[v] = 0;
    }
    return true;
  };
  for (let revised = true; revised;) {
    revised = false;
    for (const t of touched) {
      for (let k = 0; k < 3; k++) w[k] = mesh.weldOf[mesh.corners[t * 3 + k]];
      const cut = cutOf();
      if (cut.length === 0 && !w.some((v) => placed[v])) continue;
      for (let k = 0; k < 3; k++)
        for (let axis = 0; axis < 3; axis++) points[k * 3 + axis] = mesh.position[w[k] * 3 + axis];
      const limit = Math.max(area(points) * collapsedFraction, tinyArea);
      for (const child of divide(cut, far)) {
        child.forEach((ref, k) => pointOf(ref, points, k * 3));
        if (area(points) < limit && revise(child)) {
          revised = true;
          break;
        }
      }
    }
  }

  const chain: number[] = [];
  const splits = new Map<number, Split>();
  for (let i = 0; i < edgeT.length; i++) {
    if (Number.isNaN(splitT[i])) continue;
    const welded = addWeldedVertex(mesh, splitAt[i * 3], splitAt[i * 3 + 1], splitAt[i * 3 + 2]);
    mesh.crease[welded] = 1;
    splits.set(edgeA[i] * weldedCount + edgeB[i], { welded, t: splitT[i] });
  }
  for (let v = 0; v < weldedCount; v++) {
    if (!zero[v]) continue;
    if (placed[v]) moveVertex(mesh, v, placedAt[v * 3], placedAt[v * 3 + 1], placedAt[v * 3 + 2]);
    mesh.touched[v] = 1;
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

  const children = new Map<number, number[]>();
  const g = [0, 0, 0];
  const vertexOf = (ref: number) => (ref < 3 ? g[ref] : splitVertex(g[ref - 3], g[(ref - 2) % 3]));
  const distance = (p: number, q: number) => {
    const a = mesh.weldOf[vertexOf(p)] * 3,
      b = mesh.weldOf[vertexOf(q)] * 3;
    return Math.hypot(
      mesh.position[a] - mesh.position[b],
      mesh.position[a + 1] - mesh.position[b + 1],
      mesh.position[a + 2] - mesh.position[b + 2],
    );
  };
  for (let t = 0; t < triangleCount; t++) {
    for (let k = 0; k < 3; k++) {
      g[k] = mesh.corners[t * 3 + k];
      w[k] = mesh.weldOf[g[k]];
    }
    const cut = cutOf();
    if (cut.length === 0) continue;
    const pieces = divide(cut, distance).map((child) => child.map(vertexOf));
    setTriangle(mesh, t, pieces[0][0], pieces[0][1], pieces[0][2]);
    children.set(t, [t, ...pieces.slice(1).map(([a, b, c]) => addTriangle(mesh, a, b, c))]);
  }

  // Sides after the cut: chain vertices are on the zero set, other vertices keep their field sign.
  const total = mesh.weldedCount;
  const onChain = new Uint8Array(total);
  for (const v of chain) onChain[v] = 1;
  const side = (v: number) => (onChain[v] || v >= weldedCount ? 0 : Math.sign(value[v]) || 0);
  const thirds = new Map<number, number[]>();
  const skipped: number[] = [];
  const s = [0, 0, 0];
  for (let t = 0; t < mesh.triangleCount; t++) {
    for (let k = 0; k < 3; k++) {
      w[k] = mesh.weldOf[mesh.corners[t * 3 + k]];
      s[k] = side(w[k]);
    }
    if (s.includes(1) && s.includes(-1)) skipped.push(t);
    for (let k = 0; k < 3; k++) {
      const a = w[k],
        b = w[(k + 1) % 3];
      if (!onChain[a] || !onChain[b]) continue;
      const key = Math.min(a, b) * total + Math.max(a, b);
      const list = thirds.get(key);
      if (list) list.push(s[(k + 2) % 3]);
      else thirds.set(key, [s[(k + 2) % 3]]);
    }
  }
  // The zero set runs along a chain edge only when the triangles on it lie on opposite sides.
  const edges: number[] = [];
  for (const [key, list] of thirds)
    if (list.length === 2 && list[0] * list[1] < 0)
      edges.push(Math.floor(key / total), key % total);

  return {
    chain: Uint32Array.from(chain),
    edges: Uint32Array.from(edges),
    children,
    skipped: Uint32Array.from(skipped),
  };
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
