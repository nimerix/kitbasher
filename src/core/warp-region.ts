import type { BufferGeometry } from 'three';
import { weldedPositionIndex } from './mesh-topology';
import { triangleCount } from './geometry';

export const enum WarpRole {
  Outside = 0,
  Border = 1,
  Interior = 2,
}

export interface WarpRegion {
  /** Welded vertex of each geometry vertex; 0xffffffff when no face uses it. */
  weldOf: Uint32Array;
  weldedCount: number;
  /** Mesh-local rest position per welded vertex (its first-used geometry vertex). */
  rest: Float32Array;
  /** WarpRole per welded vertex. */
  role: Uint8Array;
  /** Region triangles as welded vertex triples, and the geometry face of each. */
  triangles: Uint32Array;
  faces: Uint32Array;
  /** CSR adjacency over welded ids, built from region triangles only. */
  adjacencyStart: Uint32Array;
  adjacency: Uint32Array;
  interiorCount: number;
  /** Interior welded vertices, ascending. */
  interior: Uint32Array;
  /** Geometry vertices of interior welded vertices, ascending: the only ones a warp moves. */
  interiorVertices: Uint32Array;
}

/** `pinned` welded vertices are border wherever the region uses them, even with no outside face. */
export function buildWarpRegion(
  geometry: BufferGeometry,
  faces: ArrayLike<number> | null,
  weld: { indices: Uint32Array; vertices: number } = weldedPositionIndex(geometry),
  pinned?: Uint8Array,
): WarpRegion {
  const position = geometry.getAttribute('position');
  const index = geometry.index;
  const { indices: corner, vertices: weldedCount } = weld;
  const faceCount = triangleCount(geometry);

  const weldOf = new Uint32Array(position.count).fill(0xffffffff);
  const rest = new Float32Array(weldedCount * 3);
  const seen = new Uint8Array(weldedCount);
  for (let i = 0; i < corner.length; i++) {
    const vertex = index ? index.getX(i) : i;
    const welded = corner[i];
    weldOf[vertex] = welded;
    if (!seen[welded]) {
      seen[welded] = 1;
      rest[welded * 3] = position.getX(vertex);
      rest[welded * 3 + 1] = position.getY(vertex);
      rest[welded * 3 + 2] = position.getZ(vertex);
    }
  }

  const inRegion = new Uint8Array(faceCount);
  let regionCount = faceCount;
  if (faces) {
    for (let i = 0; i < faces.length; i++) inRegion[faces[i]] = 1;
    regionCount = 0;
    for (let f = 0; f < faceCount; f++) regionCount += inRegion[f];
  } else inRegion.fill(1);

  const used = new Uint8Array(weldedCount);
  const outside = new Uint8Array(weldedCount);
  const triangles = new Uint32Array(regionCount * 3);
  const regionFaces = new Uint32Array(regionCount);
  let t = 0;
  for (let f = 0; f < faceCount; f++) {
    const a = corner[f * 3],
      b = corner[f * 3 + 1],
      c = corner[f * 3 + 2];
    if (inRegion[f]) {
      triangles[t * 3] = a;
      triangles[t * 3 + 1] = b;
      triangles[t * 3 + 2] = c;
      regionFaces[t++] = f;
      used[a] = used[b] = used[c] = 1;
    } else outside[a] = outside[b] = outside[c] = 1;
  }

  const role = new Uint8Array(weldedCount);
  let interiorCount = 0;
  for (let v = 0; v < weldedCount; v++) {
    if (!used[v]) continue;
    if (outside[v] || pinned?.[v]) role[v] = WarpRole.Border;
    else {
      role[v] = WarpRole.Interior;
      interiorCount++;
    }
  }
  const interior = new Uint32Array(interiorCount);
  for (let v = 0, i = 0; v < weldedCount; v++) if (role[v] === WarpRole.Interior) interior[i++] = v;
  let vertexCount = 0;
  for (let g = 0; g < weldOf.length; g++)
    if (weldOf[g] !== 0xffffffff && role[weldOf[g]] === WarpRole.Interior) vertexCount++;
  const interiorVertices = new Uint32Array(vertexCount);
  for (let g = 0, i = 0; g < weldOf.length; g++)
    if (weldOf[g] !== 0xffffffff && role[weldOf[g]] === WarpRole.Interior)
      interiorVertices[i++] = g;

  // Each triangle edge is stored in both directions, then sorted and deduplicated per vertex.
  const start = new Uint32Array(weldedCount + 1);
  for (let i = 0; i < triangles.length; i += 3)
    for (let k = 0; k < 3; k++) {
      const a = triangles[i + k],
        b = triangles[i + ((k + 1) % 3)];
      if (a === b) continue;
      start[a + 1]++;
      start[b + 1]++;
    }
  for (let v = 0; v < weldedCount; v++) start[v + 1] += start[v];
  const raw = new Uint32Array(start[weldedCount]);
  const fill = start.slice(0, weldedCount);
  for (let i = 0; i < triangles.length; i += 3)
    for (let k = 0; k < 3; k++) {
      const a = triangles[i + k],
        b = triangles[i + ((k + 1) % 3)];
      if (a === b) continue;
      raw[fill[a]++] = b;
      raw[fill[b]++] = a;
    }
  const adjacencyStart = new Uint32Array(weldedCount + 1);
  let written = 0;
  for (let v = 0; v < weldedCount; v++) {
    const row = raw.subarray(start[v], start[v + 1]).sort();
    adjacencyStart[v] = written;
    for (let i = 0; i < row.length; i++)
      if (i === 0 || row[i] !== row[i - 1]) raw[written++] = row[i];
  }
  adjacencyStart[weldedCount] = written;

  return {
    weldOf,
    weldedCount,
    rest,
    role,
    triangles,
    faces: regionFaces,
    adjacencyStart,
    adjacency: raw.slice(0, written),
    interiorCount,
    interior,
    interiorVertices,
  };
}

/** Position of a geometry face among the region's triangles, or -1 when it is not in the region. */
export function regionTriangleOf(region: WarpRegion, face: number) {
  const { faces } = region;
  let lo = 0,
    hi = faces.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (faces[mid] < face) lo = mid + 1;
    else hi = mid;
  }
  return faces.length && faces[lo] === face ? lo : -1;
}
