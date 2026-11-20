import { type RefineMesh, type RefineTopology, weldedCorner } from './refine-mesh';
import type { Vec3 } from './types';

/** Per topology: a visit stamp per welded vertex and per triangle, reused by every brush. */
interface Marks {
  vertex: Uint32Array;
  triangle: Uint32Array;
  mark: number;
}
const marksOf = new WeakMap<RefineTopology, Marks>();

/** A fresh stamp for one walk, without clearing the per-vertex arrays. */
export function nextMark(mesh: RefineMesh, topology: RefineTopology): Marks {
  let marks = marksOf.get(topology);
  if (
    !marks ||
    marks.vertex.length < mesh.weldedCount ||
    marks.triangle.length < mesh.triangleCount ||
    marks.mark === 0xffffffff
  ) {
    marks = {
      vertex: new Uint32Array(mesh.weldedCount),
      triangle: new Uint32Array(mesh.triangleCount),
      mark: 0,
    };
    marksOf.set(topology, marks);
  }
  marks.mark++;
  return marks;
}

/**
 * Welded vertices within `radius` of `center` reached from `seed`'s corners over mesh edges whose
 * both ends are within it, ascending. Surface that is near but not joined to the seed through the
 * brush, such as the far side of a thin plate, is never reached.
 */
function reached(
  mesh: RefineMesh,
  topology: RefineTopology,
  seed: number,
  center: Vec3,
  radius: number,
): Uint32Array {
  if (seed < 0 || seed >= mesh.triangleCount) return new Uint32Array(0);
  const { position } = mesh;
  const { neighbourStart, neighbours } = topology;
  const marks = nextMark(mesh, topology);
  const { vertex: stamp, mark } = marks;
  const [cx, cy, cz] = center;
  const limit = radius * radius;
  const inside = (v: number) => {
    const dx = position[v * 3] - cx,
      dy = position[v * 3 + 1] - cy,
      dz = position[v * 3 + 2] - cz;
    return dx * dx + dy * dy + dz * dz < limit;
  };
  const found: number[] = [];
  for (const k of [0, 1, 2] as const) {
    const v = weldedCorner(mesh, seed, k);
    if (stamp[v] === mark) continue;
    stamp[v] = mark;
    if (inside(v)) found.push(v);
  }
  for (let q = 0; q < found.length; q++) {
    const v = found[q];
    for (let j = neighbourStart[v]; j < neighbourStart[v + 1]; j++) {
      const w = neighbours[j];
      if (stamp[w] === mark) continue;
      stamp[w] = mark;
      if (inside(w)) found.push(w);
    }
  }
  return Uint32Array.from(found).sort();
}

/** Triangles connected to `seed` with a vertex within `radius` of `center`. */
export function trianglesUnderBrush(
  mesh: RefineMesh,
  topology: RefineTopology,
  seed: number,
  center: Vec3,
  radius: number,
): Uint32Array {
  const vertices = reached(mesh, topology, seed, center, radius);
  const { triangle: stamp, mark } = nextMark(mesh, topology);
  const { triangleStart, trianglesOf } = topology;
  const found: number[] = [];
  for (const v of vertices)
    for (let j = triangleStart[v]; j < triangleStart[v + 1]; j++) {
      const t = trianglesOf[j];
      if (stamp[t] === mark) continue;
      stamp[t] = mark;
      found.push(t);
    }
  return Uint32Array.from(found).sort();
}

/** Welded vertices connected to `seed`'s triangle within `radius`, with a (1 - (d/r)^2)^2 falloff each. */
export function verticesUnderBrush(
  mesh: RefineMesh,
  topology: RefineTopology,
  seed: number,
  center: Vec3,
  radius: number,
): { vertices: Uint32Array; falloff: Float32Array } {
  const vertices = reached(mesh, topology, seed, center, radius);
  const { position } = mesh;
  const falloff = Float32Array.from(vertices, (v) => {
    const dx = position[v * 3] - center[0],
      dy = position[v * 3 + 1] - center[1],
      dz = position[v * 3 + 2] - center[2];
    const u = 1 - (dx * dx + dy * dy + dz * dz) / (radius * radius);
    return u * u;
  });
  return { vertices, falloff };
}
