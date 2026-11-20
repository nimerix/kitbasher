import {
  BufferAttribute,
  BufferGeometry,
  ConeGeometry,
  DataUtils,
  Float16BufferAttribute,
  type InterleavedBufferAttribute,
  Matrix4,
  SphereGeometry,
  Vector3,
} from 'three';
import { Matrix, solve } from 'ml-matrix';
import { hasClosedEdges, weldedPositionIndex } from '../../src/core/mesh-topology';
import { BandZone, type EdgeBand, type GuidePoint } from '../../src/core/refine-band';
import { type Shape, estimateNoise, noiseRings } from '../../src/core/refine-fit';
import {
  type RefineMesh,
  addGeometryVertex,
  addTriangle,
  addWeldedVertex,
  buildRefineMesh,
  buildTopology,
  medianEdgeLength,
  setTriangle,
  triangleNormal,
  vertexNormal,
  weldedCorner,
} from '../../src/core/refine-mesh';
import type { Vec3 } from '../../src/core/types';

function corner(geometry: BufferGeometry, triangle: number, k: number) {
  const vertex = geometry.index ? geometry.index.getX(triangle * 3 + k) : triangle * 3 + k;
  const position = geometry.getAttribute('position');
  return [position.getX(vertex), position.getY(vertex), position.getZ(vertex)];
}

function edgeLengths(geometry: BufferGeometry) {
  const triangles = (geometry.index?.count ?? geometry.getAttribute('position').count) / 3;
  const lengths = new Float64Array(triangles * 3);
  for (let t = 0; t < triangles; t++)
    for (let k = 0; k < 3; k++) {
      const a = corner(geometry, t, k),
        b = corner(geometry, t, (k + 1) % 3);
      lengths[t * 3 + k] = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    }
  return lengths;
}

/** Median length of every triangle edge. */
export function medianEdge(geometry: BufferGeometry) {
  const lengths = edgeLengths(geometry).sort();
  return lengths[Math.floor(lengths.length / 2)];
}

/** Length of the longest triangle edge. */
export function maxEdge(geometry: BufferGeometry) {
  return edgeLengths(geometry).reduce((longest, length) => Math.max(longest, length), 0);
}

/** Area of the smallest triangle. */
export function minTriangleArea(geometry: BufferGeometry) {
  const triangles = (geometry.index?.count ?? geometry.getAttribute('position').count) / 3;
  let smallest = Infinity;
  for (let t = 0; t < triangles; t++) {
    const [a, b, c] = [0, 1, 2].map((k) => corner(geometry, t, k));
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
      v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const area =
      Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) /
      2;
    smallest = Math.min(smallest, area);
  }
  return smallest;
}

/** Farthest any vertex lies from the surface of the box centred on the origin with `half`. */
export function maxBoxDistance(geometry: BufferGeometry, half: Vec3) {
  const position = geometry.getAttribute('position');
  let farthest = 0;
  for (let i = 0; i < position.count; i++) {
    const d = [position.getX(i), position.getY(i), position.getZ(i)].map(
      (value, axis) => Math.abs(value) - half[axis],
    );
    const outside = Math.hypot(...d.map((value) => Math.max(value, 0)));
    const distance = outside > 0 ? outside : -Math.max(...d);
    farthest = Math.max(farthest, distance);
  }
  return farthest;
}

/** Distance from the origin of each welded vertex. */
export function radii(geometry: BufferGeometry) {
  const position = geometry.getAttribute('position');
  const { indices, vertices } = weldedPositionIndex(geometry);
  const result = new Array<number>(vertices);
  for (let i = 0; i < indices.length; i++) {
    const vertex = geometry.index ? geometry.index.getX(i) : i;
    result[indices[i]] ??= Math.hypot(
      position.getX(vertex),
      position.getY(vertex),
      position.getZ(vertex),
    );
  }
  return result;
}

/** The working model the Refine modules take: mesh, topology, noise and median edge length. */
export function modelFrom(mesh: RefineMesh) {
  const topology = buildTopology(mesh);
  const step = medianEdgeLength(mesh);
  return {
    mesh,
    topology,
    noise: estimateNoise(mesh, topology, undefined, noiseRings(step)),
    step,
  };
}

export function modelOf(geometry: BufferGeometry, matrix = new Matrix4()) {
  return modelFrom(buildRefineMesh(geometry, matrix));
}

/** True when every welded edge is shared by exactly two triangles. */
export function closed(geometry: BufferGeometry) {
  const { indices, vertices } = weldedPositionIndex(geometry);
  return hasClosedEdges(indices, vertices);
}

const bits = (array: ArrayLike<number>) => {
  const floats = array as Float32Array;
  return new Uint32Array(floats.buffer, floats.byteOffset, floats.length);
};

/** True when every written vertex of one welded vertex has the same position bits. */
export function duplicatesAgree(geometry: BufferGeometry, mesh: RefineMesh) {
  const position = bits(geometry.getAttribute('position').array);
  const first = new Map<number, number>();
  for (let i = 0; i < mesh.triangleCount * 3; i++) {
    const vertex = geometry.index ? geometry.index.getX(i) : i;
    const welded = mesh.weldOf[mesh.corners[i]];
    const seen = first.get(welded);
    if (seen === undefined) first.set(welded, vertex);
    else
      for (let axis = 0; axis < 3; axis++)
        if (position[seen * 3 + axis] !== position[vertex * 3 + axis]) return false;
  }
  return true;
}

/** Source vertices whose written position or normal bits differ from the source. */
export function changedVertices(source: BufferGeometry, written: BufferGeometry) {
  const changed: number[] = [];
  const attributes = ['position', 'normal'].map((name) => [
    bits(source.getAttribute(name).array),
    bits(written.getAttribute(name).array),
  ]);
  for (let vertex = 0; vertex < source.getAttribute('position').count; vertex++)
    if (
      attributes.some(([before, after]) =>
        [0, 1, 2].some((axis) => before[vertex * 3 + axis] !== after[vertex * 3 + axis]),
      )
    )
      changed.push(vertex);
  return changed;
}

/** Size of the bounding box of the first `count` points of a position array. */
export function extent(position: Float32Array | Float64Array, count = position.length / 3) {
  const low = [Infinity, Infinity, Infinity],
    high = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++)
    for (let axis = 0; axis < 3; axis++) {
      low[axis] = Math.min(low[axis], position[i * 3 + axis]);
      high[axis] = Math.max(high[axis], position[i * 3 + axis]);
    }
  return high.map((value, axis) => value - low[axis]);
}

/** Fraction of triangles whose normal points away from `centre`. */
export function outwardFraction(mesh: RefineMesh, centre: Vec3) {
  const normal = new Float32Array(3);
  let outward = 0;
  for (let t = 0; t < mesh.triangleCount; t++) {
    triangleNormal(mesh, t, normal);
    let dot = 0;
    for (let axis = 0; axis < 3; axis++) {
      let centroid = 0;
      for (const k of [0, 1, 2] as const)
        centroid += mesh.position[weldedCorner(mesh, t, k) * 3 + axis] / 3;
      dot += normal[axis] * (centroid - centre[axis]);
    }
    if (dot > 0) outward++;
  }
  return outward / mesh.triangleCount;
}

/** Closed regular tetrahedron with outward winding and flat normals per face. */
export function tetrahedron(indexed: boolean) {
  const points = [1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1];
  const faces = [0, 1, 2, 0, 3, 1, 0, 2, 3, 1, 3, 2];
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(points), 3));
  geometry.setIndex(faces);
  const result = indexed ? geometry : geometry.toNonIndexed();
  result.computeVertexNormals();
  return result;
}

/**
 * Splits the welded edge from corner 0 to corner 1 of `triangle` at its midpoint, replacing both
 * triangles on it with two each. Returns the new welded vertex and the other triangle on the edge.
 */
export function splitEdge(mesh: RefineMesh, triangle: number) {
  const a = weldedCorner(mesh, triangle, 0),
    b = weldedCorner(mesh, triangle, 1);
  let other = -1,
    k = 0;
  for (let t = 0; t < mesh.triangleCount && other < 0; t++)
    for (k = 0; k < 3; k++)
      if (
        weldedCorner(mesh, t, k as 0 | 1 | 2) === b &&
        weldedCorner(mesh, t, ((k + 1) % 3) as 0 | 1 | 2) === a
      ) {
        other = t;
        break;
      }
  const p = (v: number) => [0, 1, 2].map((axis) => mesh.position[v * 3 + axis]);
  const [pa, pb] = [p(a), p(b)];
  const middle = addWeldedVertex(mesh, ...(pa.map((v, axis) => (v + pb[axis]) / 2) as Vec3));
  const size = mesh.colorSize;
  const color = (g: number) => mesh.color?.slice(g * size, g * size + size);
  const split = (t: number, first: number) => {
    const g = [0, 1, 2].map((i) => mesh.corners[t * 3 + ((first + i) % 3)]);
    const [ca, cb] = [color(g[0]), color(g[1])];
    const m = addGeometryVertex(
      mesh,
      middle,
      ca?.map((value, k) => (value + cb![k]) / 2),
    );
    // The new triangle names fresh duplicates of its untouched corners, as an unindexed cut would.
    const [b, c] = [g[1], g[2]].map((v) => addGeometryVertex(mesh, mesh.weldOf[v], color(v)));
    setTriangle(mesh, t, g[0], m, g[2]);
    addTriangle(mesh, m, b, c);
  };
  split(triangle, 0);
  split(other, k);
  return { middle, other };
}

/** True when any value of the arrays is NaN. */
export function hasNaN(...arrays: ArrayLike<number>[]) {
  return arrays.some((array) => Array.prototype.some.call(array, Number.isNaN));
}

/** Corner `k` of triangle `t` as written: its output vertex. */
const outputVertex = (geometry: BufferGeometry, t: number, k: number) =>
  geometry.index ? geometry.index.getX(t * 3 + k) : t * 3 + k;

/** Source triangles, other than `except`, whose written corners differ from the source in any bit. */
export function changedTriangles(
  source: BufferGeometry,
  written: BufferGeometry,
  except: number[],
) {
  const changed: number[] = [];
  const triangles = (source.index?.count ?? source.getAttribute('position').count) / 3;
  for (let t = 0; t < triangles; t++) {
    if (except.includes(t)) continue;
    const same = [0, 1, 2].every((k) =>
      ['position', 'normal'].every((name) => {
        const before = source.getAttribute(name).array,
          after = written.getAttribute(name).array;
        const i = outputVertex(source, t, k),
          j = outputVertex(written, t, k);
        return [0, 1, 2].every((axis) => Object.is(before[i * 3 + axis], after[j * 3 + axis]));
      }),
    );
    if (!same) changed.push(t);
  }
  return changed;
}

/** Angle in degrees between the written normal at each corner of `welded` and the area-weighted
 * normal of the written faces around it. Returns the largest. */
export function fanNormalError(written: BufferGeometry, mesh: RefineMesh, welded: number) {
  const position = written.getAttribute('position'),
    normal = written.getAttribute('normal');
  const at = (v: number) => new Vector3().fromBufferAttribute(position, v);
  const sum = new Vector3();
  const corners: number[] = [];
  for (let t = 0; t < mesh.triangleCount; t++)
    for (const k of [0, 1, 2] as const)
      if (weldedCorner(mesh, t, k) === welded) {
        const [a, b, c] = [0, 1, 2].map((i) => at(outputVertex(written, t, i)));
        sum.add(b.sub(a).cross(c.sub(a)));
        corners.push(outputVertex(written, t, k));
      }
  sum.normalize();
  return Math.max(
    ...corners.map(
      (v) => (new Vector3().fromBufferAttribute(normal, v).angleTo(sum) * 180) / Math.PI,
    ),
  );
}

/**
 * A flat hexagonal fan around the origin, 2e-5 across, cut along the x axis by a seam whose
 * duplicate vertices on the far side sit 4.9e-6 higher: close enough to weld.
 */
export function nearWeldSeam(indexed: boolean) {
  const r = 2e-5,
    lift = 4.9e-6;
  const ring = Array.from({ length: 6 }, (_, i) => [
    r * Math.cos((i * Math.PI) / 3),
    r * Math.sin((i * Math.PI) / 3),
    0,
  ]);
  // Vertices: 0 centre, 1-6 ring, 7 centre below, 8 and 9 ring 0 and 3 below.
  const points = [[0, 0, 0], ...ring, [0, 0, lift], [r, 0, lift], [-r, 0, lift]];
  const faces = [0, 1, 2, 0, 2, 3, 0, 3, 4, 7, 9, 5, 7, 5, 6, 7, 6, 8];
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(points.flat()), 3));
  geometry.setIndex(faces);
  const result = indexed ? geometry : geometry.toNonIndexed();
  result.computeVertexNormals();
  return result;
}

/** An indexed flat fan of `count` triangles around one centre vertex. */
export function wideFan(count: number) {
  const points = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    const angle = (i * 2 * Math.PI) / count;
    points.push(Math.cos(angle), Math.sin(angle), 0);
  }
  const faces: number[] = [];
  for (let i = 0; i < count; i++) faces.push(0, 1 + i, 1 + ((i + 1) % count));
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(points), 3));
  geometry.setIndex(faces);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Closed tetrahedron on the corners of the unit cube at the origin, with outward winding. Its
 * position attribute is built by `store` from the flat coordinates.
 */
export function cornerTetrahedron(
  indexed: boolean,
  store: (points: number[]) => BufferAttribute | InterleavedBufferAttribute = (points) =>
    new BufferAttribute(new Float32Array(points), 3),
) {
  const geometry = new BufferGeometry();
  const points = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  geometry.setAttribute('position', new BufferAttribute(points, 3));
  geometry.setIndex([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
  const result = indexed ? geometry : geometry.toNonIndexed();
  result.setAttribute('position', store(Array.from(result.getAttribute('position').array)));
  result.computeVertexNormals();
  return result;
}

/** A half-float attribute holding `values`, encoded. */
export function halfFloats(values: number[], itemSize: number) {
  return new Float16BufferAttribute(Uint16Array.from(values, DataUtils.toHalfFloat), itemSize);
}

type Attribute = BufferAttribute | InterleavedBufferAttribute;
const getters = ['getX', 'getY', 'getZ', 'getW'] as const;

/** Component `k` of item `i`, decoded by the attribute's own accessors. */
export const decodedComponent = (attribute: Attribute, i: number, k: number) =>
  attribute[getters[k]](i);

/** Output vertex of the first corner of `welded`. */
export function writtenVertexOf(written: BufferGeometry, mesh: RefineMesh, welded: number) {
  for (let c = 0; c < mesh.triangleCount * 3; c++)
    if (mesh.weldOf[mesh.corners[c]] === welded)
      return outputVertex(written, Math.floor(c / 3), c % 3);
  return -1;
}

/** Pairs of output vertex and the source geometry vertex it was written from. */
function writtenFromSource(written: BufferGeometry, mesh: RefineMesh) {
  const pairs: [number, number][] = [];
  if (written.index) for (let g = 0; g < mesh.sourceVertexCount; g++) pairs.push([g, g]);
  else
    for (let c = 0; c < mesh.triangleCount * 3; c++)
      if (mesh.corners[c] < mesh.sourceVertexCount) pairs.push([c, mesh.corners[c]]);
  return pairs;
}

/** Written vertices of source vertices off `chain` whose position or normal bits differ from the source. */
export function offChainMismatches(
  source: BufferGeometry,
  written: BufferGeometry,
  mesh: RefineMesh,
  chain: Uint32Array,
) {
  const on = new Set(chain);
  const [position, normal] = ['position', 'normal'].map((name) => [
    bits(source.getAttribute(name).array),
    bits(written.getAttribute(name).array),
  ]);
  let mismatches = 0;
  for (const [i, g] of writtenFromSource(written, mesh)) {
    if (on.has(mesh.weldOf[g])) continue;
    if (
      [position, normal].some(([before, after]) =>
        [0, 1, 2].some((axis) => before[g * 3 + axis] !== after[i * 3 + axis]),
      )
    )
      mismatches++;
  }
  return mismatches;
}

/**
 * Components of untouched source vertices whose written value decodes differently from the source.
 * A Float32 output is held to the Float32 rounding of the decoded source value.
 */
export function untouchedMismatches(
  source: BufferGeometry,
  written: BufferGeometry,
  mesh: RefineMesh,
  name: string,
) {
  const before = source.getAttribute(name),
    after = written.getAttribute(name);
  const round = after.array instanceof Float32Array ? Math.fround : (v: number) => v;
  let mismatches = 0;
  for (const [i, g] of writtenFromSource(written, mesh)) {
    if (mesh.touched[mesh.weldOf[g]]) continue;
    for (let k = 0; k < before.itemSize; k++)
      if (decodedComponent(after, i, k) !== round(decodedComponent(before, g, k))) mismatches++;
  }
  return mismatches;
}

/** Stored components of source vertices whose written colour differs from the source in any bit. */
export function colorMismatches(source: BufferGeometry, written: BufferGeometry, mesh: RefineMesh) {
  const before = source.getAttribute('color'),
    after = written.getAttribute('color');
  const size = before.itemSize;
  let mismatches = 0;
  for (const [i, g] of writtenFromSource(written, mesh))
    for (let k = 0; k < size; k++)
      if (!Object.is(after.array[i * size + k], before.array[g * size + k])) mismatches++;
  return mismatches;
}

/**
 * An open, uneven fan of five triangles, 0.02 mm in radius, around a centre at x = 1e5 where
 * Float32 steps by 0.0078: its edges span a few rounding steps. Open, so its normal follows the centre.
 */
export function farFan(indexed: boolean) {
  const heights = [0.01, 0, -0.01, 0.005, 0, 0.002];
  const ring = heights.map((z, i) => [
    1e5 + 0.02 * Math.cos((i * Math.PI) / 3),
    0.02 * Math.sin((i * Math.PI) / 3),
    z,
  ]);
  const faces: number[] = [];
  for (let i = 0; i < 5; i++) faces.push(0, 1 + i, 1 + ((i + 1) % 6));
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([1e5, 0, 0, ...ring.flat()]), 3),
  );
  geometry.setIndex(faces);
  const result = indexed ? geometry : geometry.toNonIndexed();
  result.computeVertexNormals();
  return result;
}

/** Welded vertex ids of every triangle corner, in corner order. */
const weldedCorners = (mesh: RefineMesh) =>
  Uint32Array.from({ length: mesh.triangleCount * 3 }, (_, c) => mesh.weldOf[mesh.corners[c]]);

/** True when every welded edge of the mesh is shared by exactly two triangles. */
export function closedMesh(mesh: RefineMesh) {
  return hasClosedEdges(weldedCorners(mesh), mesh.weldedCount);
}

/** Area of the smallest triangle of the mesh, in world space. */
export function meshMinTriangleArea(mesh: RefineMesh) {
  const p = mesh.position;
  let smallest = Infinity;
  for (let t = 0; t < mesh.triangleCount; t++) {
    const [a, b, c] = ([0, 1, 2] as const).map((k) => weldedCorner(mesh, t, k) * 3);
    const u = [0, 1, 2].map((axis) => p[b + axis] - p[a + axis]),
      v = [0, 1, 2].map((axis) => p[c + axis] - p[a + axis]);
    const area =
      Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) /
      2;
    smallest = Math.min(smallest, area);
  }
  return smallest;
}

/** Ids of triangles with one corner above `tolerance` and another below `-tolerance` of `fn`. */
export function straddlingTriangles(
  mesh: RefineMesh,
  fn: (x: number, y: number, z: number) => number,
  tolerance: number,
) {
  const result: number[] = [];
  for (let t = 0; t < mesh.triangleCount; t++) {
    const values = ([0, 1, 2] as const).map((k) => {
      const v = weldedCorner(mesh, t, k) * 3;
      return fn(mesh.position[v], mesh.position[v + 1], mesh.position[v + 2]);
    });
    if (values.some((f) => f > tolerance) && values.some((f) => f < -tolerance)) result.push(t);
  }
  return result;
}

/** Triangles with one corner above `tolerance` and another below `-tolerance` of `fn`. */
export function straddling(
  mesh: RefineMesh,
  fn: (x: number, y: number, z: number) => number,
  tolerance: number,
) {
  return straddlingTriangles(mesh, fn, tolerance).length;
}

/** Triangles whose three corners all lie in `chain`. */
export function trianglesWhollyOn(mesh: RefineMesh, chain: Uint32Array) {
  const on = new Set(chain);
  let count = 0;
  for (let t = 0; t < mesh.triangleCount; t++)
    if (([0, 1, 2] as const).every((k) => on.has(weldedCorner(mesh, t, k)))) count++;
  return count;
}

/**
 * Sizes of the connected pieces of the graph of mesh edges joining two `chain` vertices, or -1 for
 * a piece that is not a simple loop because some vertex in it has other than two such edges.
 */
export function loops(mesh: RefineMesh, chain: Uint32Array) {
  const on = new Set(chain);
  const next = new Map([...chain].map((v) => [v, new Set<number>()]));
  const corners = weldedCorners(mesh);
  for (let c = 0; c < corners.length; c++) {
    const a = corners[c],
      b = corners[c % 3 === 2 ? c - 2 : c + 1];
    if (a !== b && on.has(a) && on.has(b)) {
      next.get(a)!.add(b);
      next.get(b)!.add(a);
    }
  }
  const seen = new Set<number>();
  const sizes: number[] = [];
  for (const start of chain) {
    if (seen.has(start)) continue;
    const piece = [start];
    seen.add(start);
    for (let i = 0; i < piece.length; i++)
      for (const w of next.get(piece[i])!)
        if (!seen.has(w)) {
          seen.add(w);
          piece.push(w);
        }
    sizes.push(piece.every((v) => next.get(v)!.size === 2) ? piece.length : -1);
  }
  return sizes;
}

/**
 * Sizes of the connected pieces of the graph of `edges` (pairs of welded ids) over `chain`, or -1
 * for a piece that is not a simple loop because some vertex in it is in other than two segments.
 */
export function edgeLoops(edges: Uint32Array, chain: Uint32Array) {
  const next = new Map([...chain].map((v) => [v, [] as number[]]));
  for (let i = 0; i < edges.length; i += 2) {
    const [a, b] = [edges[i], edges[i + 1]];
    if (!next.has(a) || !next.has(b)) return [-1];
    next.get(a)!.push(b);
    next.get(b)!.push(a);
  }
  const seen = new Set<number>();
  const sizes: number[] = [];
  for (const start of chain) {
    if (seen.has(start)) continue;
    const piece = [start];
    seen.add(start);
    for (let i = 0; i < piece.length; i++)
      for (const w of next.get(piece[i])!)
        if (!seen.has(w)) {
          seen.add(w);
          piece.push(w);
        }
    sizes.push(piece.every((v) => next.get(v)!.length === 2) ? piece.length : -1);
  }
  return sizes;
}

/** Closed regular octahedron with vertices on the unit axes and outward winding. */
export function octahedron(indexed: boolean) {
  // Vertices: 0 +x, 1 -x, 2 +y, 3 -y, 4 +z, 5 -z.
  const points = [1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1];
  const faces = [0, 2, 4, 2, 1, 4, 1, 3, 4, 3, 0, 4, 2, 0, 5, 1, 2, 5, 3, 1, 5, 0, 3, 5];
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(points), 3));
  geometry.setIndex(faces);
  const result = indexed ? geometry : geometry.toNonIndexed();
  result.computeVertexNormals();
  return result;
}

/** Welded vertices of `before`, outside `chain`, whose position in `after` differs in any bit. */
export function movedOutside(before: RefineMesh, after: RefineMesh, chain: Uint32Array) {
  const on = new Set(chain);
  let moved = 0;
  for (let v = 0; v < before.weldedCount; v++)
    if (
      !on.has(v) &&
      [0, 1, 2].some(
        (axis) => !Object.is(before.position[v * 3 + axis], after.position[v * 3 + axis]),
      )
    )
      moved++;
  return moved;
}

/** Points and unit normals as flat arrays, in the order a fit takes them. */
export type SurfaceSample = [points: Float32Array, normals: Float32Array];

/** Welded vertices of the geometry that `keep` accepts, with their area-weighted normals. */
export function surfaceWhere(
  geometry: BufferGeometry,
  keep: (x: number, y: number, z: number) => boolean,
) {
  const { mesh, topology } = modelOf(geometry);
  const points: number[] = [],
    normals: number[] = [];
  const normal = new Float32Array(3);
  for (let v = 0; v < mesh.weldedCount; v++) {
    const [x, y, z] = mesh.position.subarray(v * 3, v * 3 + 3);
    if (!keep(x, y, z)) continue;
    vertexNormal(mesh, topology, v, normal);
    points.push(x, y, z);
    normals.push(...normal);
  }
  return [new Float32Array(points), new Float32Array(normals)] as SurfaceSample;
}

/** Accepts points of the upper face: above mid-height and at least `inset` inside the box in x and z. */
export function onTopFace(geometry: BufferGeometry, inset = 0.35) {
  geometry.computeBoundingBox();
  const { min, max } = geometry.boundingBox!;
  const middle = (min.y + max.y) / 2;
  return (x: number, y: number, z: number) =>
    y > middle && x > min.x + inset && x < max.x - inset && z > min.z + inset && z < max.z - inset;
}

/** Vertices of the upper face, see `onTopFace`. */
export function topFace(geometry: BufferGeometry, inset = 0.35) {
  return surfaceWhere(geometry, onTopFace(geometry, inset));
}

/** Accepts points with |y| below `half`: the straight wall of a capped shape about Y. */
export const onWall =
  (half = 0.6) =>
  (_: number, y: number) =>
    Math.abs(y) < half;

/** Vertices of the straight wall, see `onWall`. */
export function wall(geometry: BufferGeometry, half = 0.6) {
  return surfaceWhere(geometry, onWall(half));
}

/** `estimateNoise` over the welded vertices that `keep` accepts. */
export function noiseWhere(
  geometry: BufferGeometry,
  keep: (x: number, y: number, z: number) => boolean,
) {
  const { mesh, topology } = modelOf(geometry);
  const vertices: number[] = [];
  for (let v = 0; v < mesh.weldedCount; v++)
    if (keep(mesh.position[v * 3], mesh.position[v * 3 + 1], mesh.position[v * 3 + 2]))
      vertices.push(v);
  return estimateNoise(mesh, topology, Uint32Array.from(vertices));
}

/** Vertices within `radius` of the vertex nearest the middle of the topmost 0.1 mm band. */
export function patch(geometry: BufferGeometry, radius = 2.5) {
  geometry.computeBoundingBox();
  const top = geometry.boundingBox!.max.y - 0.1;
  const [band] = surfaceWhere(geometry, (_, y) => y > top);
  const count = band.length / 3;
  const middle = [0, 1, 2].map((axis) => {
    let sum = 0;
    for (let i = 0; i < count; i++) sum += band[i * 3 + axis];
    return sum / count;
  });
  let seed = 0;
  const distance = (i: number, to: number[]) =>
    Math.hypot(band[i * 3] - to[0], band[i * 3 + 1] - to[1], band[i * 3 + 2] - to[2]);
  for (let i = 1; i < count; i++) if (distance(i, middle) < distance(seed, middle)) seed = i;
  const centre = [band[seed * 3], band[seed * 3 + 1], band[seed * 3 + 2]];
  return surfaceWhere(
    geometry,
    (x, y, z) => Math.hypot(x - centre[0], y - centre[1], z - centre[2]) < radius,
  );
}

/**
 * The open side of a ConeGeometry (apex at y = height / 2, opening down -Y), each vertex moved
 * along its normal by a seeded uniform offset of up to `jitter`.
 */
export function coneSide(radius: number, height: number, jitter: number, seed = 1) {
  const geometry = new ConeGeometry(radius, height, 64, 32, true);
  const position = geometry.getAttribute('position'),
    normal = geometry.getAttribute('normal');
  const points = new Float32Array(position.count * 3),
    normals = new Float32Array(position.count * 3);
  let state = seed;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  for (let i = 0; i < position.count; i++) {
    const offset = jitter * (2 * next() - 1);
    for (let axis = 0; axis < 3; axis++) {
      const n = normal.array[i * 3 + axis];
      normals[i * 3 + axis] = n;
      points[i * 3 + axis] = position.array[i * 3 + axis] + n * offset;
    }
  }
  return [points, normals] as SurfaceSample;
}

/** Angle in degrees between two directions. */
export function angleDeg(a: ArrayLike<number>, b: ArrayLike<number>) {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = Math.hypot(
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  );
  return (Math.atan2(cross, dot) * 180) / Math.PI;
}

/** Farthest any of the flat xyz points lies by the distance function `fn`. */
export function maxDistance(
  points: ArrayLike<number>,
  fn: (x: number, y: number, z: number) => number,
) {
  let farthest = 0;
  for (let i = 0; i < points.length; i += 3)
    farthest = Math.max(farthest, fn(points[i], points[i + 1], points[i + 2]));
  return farthest;
}

/** Root mean square of the distance function `fn` over the points of a curve. */
export function rms(
  curve: { points: ArrayLike<number> },
  fn: (x: number, y: number, z: number) => number,
) {
  let sum = 0;
  for (let i = 0; i < curve.points.length; i += 3)
    sum += fn(curve.points[i], curve.points[i + 1], curve.points[i + 2]) ** 2;
  return Math.sqrt(sum / (curve.points.length / 3));
}

/** A seeded uniform generator in [-1, 1), so noisy samples are the same on every run. */
function signedRandom(seed: number) {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state / 4294967296) * 2 - 1;
  };
}

/** Samples 0.05 apart from `from` to `to`, each moved off the line by up to `noise` per axis. */
export function noisyLine(from: Vec3, to: Vec3, noise: number, seed = 1) {
  const next = signedRandom(seed);
  const d = [0, 1, 2].map((axis) => to[axis] - from[axis]);
  const length = Math.hypot(...d);
  const u = d.map((value) => value / length);
  // Two unit directions across the line.
  const helper = Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const a = normalized(cross(u, helper)),
    b = cross(u, a);
  const count = Math.ceil(length / 0.05);
  const points: number[] = [];
  for (let i = 0; i <= count; i++) {
    const [p, q] = [next() * noise, next() * noise];
    for (let axis = 0; axis < 3; axis++)
      points.push(from[axis] + (d[axis] * i) / count + a[axis] * p + b[axis] * q);
  }
  return new Float32Array(points);
}

function cross(a: number[], b: number[]) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalized(v: number[]) {
  const length = Math.hypot(...v);
  return v.map((value) => value / length);
}

/**
 * Samples 0.05 apart along the arc of `radius` about the origin in the XZ plane, from angle `from`
 * to `to` (x = r cos, z = r sin), moved radially and in y by up to `noise`. A full turn does not
 * repeat its first sample.
 */
export function noisyArc(radius: number, from: number, to: number, noise: number, seed = 2) {
  const next = signedRandom(seed);
  const full = Math.abs(to - from) >= Math.PI * 2 - 1e-9;
  const count = Math.ceil((radius * Math.abs(to - from)) / 0.05);
  const points: number[] = [];
  for (let i = 0; i < (full ? count : count + 1); i++) {
    const angle = from + ((to - from) * i) / count;
    const r = radius + next() * noise;
    points.push(r * Math.cos(angle), next() * noise, r * Math.sin(angle));
  }
  return new Float32Array(points);
}

/** Samples 0.05 apart in x along y = 0.5 sin(x), x from 0 to 12, moved by up to `noise` in y and z. */
export function noisyWave(noise: number, seed = 3) {
  const next = signedRandom(seed);
  const points: number[] = [];
  for (let i = 0; i <= 240; i++) {
    const x = i * 0.05;
    points.push(x, 0.5 * Math.sin(x) + next() * noise, next() * noise);
  }
  return new Float32Array(points);
}

/** Distance from a point to the curve y = 0.5 sin(x), z = 0. */
export function waveDistance(x: number, y: number, z: number) {
  let nearest = Infinity;
  for (let t = x - 1; t <= x + 1; t += 0.0005)
    nearest = Math.min(nearest, Math.hypot(x - t, y - 0.5 * Math.sin(t), z));
  return nearest;
}

/**
 * The four sides, in order around the loop, of a `width` by `depth` rectangle centred on the
 * origin in the XZ plane, each as noisy samples that stop 0.3 short of the corners.
 */
export function rectangleSides(width: number, depth: number, noise: number) {
  const [w, d] = [width / 2, depth / 2];
  const corners: Vec3[] = [
    [-w, 0, -d],
    [w, 0, -d],
    [w, 0, d],
    [-w, 0, d],
  ];
  return corners.map((from, i) => {
    const to = corners[(i + 1) % 4];
    const length = Math.hypot(to[0] - from[0], to[2] - from[2]);
    const inset = (a: Vec3, b: Vec3) =>
      [0, 1, 2].map((axis) => a[axis] + ((b[axis] - a[axis]) * 0.3) / length) as Vec3;
    return noisyLine(inset(from, to), inset(to, from), noise, i + 11);
  });
}

/** Points of a curve marked as sharp corners. */
export function cornersOf(curve: { points: ArrayLike<number>; corner: Uint8Array }) {
  const result: Vec3[] = [];
  curve.corner.forEach((sharp, i) => {
    if (sharp) result.push([curve.points[i * 3], curve.points[i * 3 + 1], curve.points[i * 3 + 2]]);
  });
  return result;
}

/** Distance from `point` to the nearest corner of the rectangle of `rectangleSides`. */
export function nearestRectangleCorner(point: Vec3, width: number, depth: number) {
  return Math.min(
    ...[-1, 1].flatMap((sx) =>
      [-1, 1].map((sz) =>
        Math.hypot(point[0] - (sx * width) / 2, point[1], point[2] - (sz * depth) / 2),
      ),
    ),
  );
}

/** Longest distance between consecutive points of a curve, including the closing span. */
export function largestGap(curve: { points: ArrayLike<number>; closed: boolean }) {
  const p = curve.points,
    count = p.length / 3;
  let largest = 0;
  for (let i = 0; i < (curve.closed ? count : count - 1); i++) {
    const j = (i + 1) % count;
    largest = Math.max(
      largest,
      Math.hypot(p[j * 3] - p[i * 3], p[j * 3 + 1] - p[i * 3 + 1], p[j * 3 + 2] - p[i * 3 + 2]),
    );
  }
  return largest;
}

/**
 * A 25 x 25 grid 0.04 apart on y = 0 and a 12 x 12 cap 0.02 apart standing 0.5 above it off
 * centre, every point jittered in y by up to 0.002, all with normals +Y.
 */
export function cappedFlat(seed = 3) {
  const next = signedRandom(seed);
  const points: number[] = [];
  for (let i = 0; i < 25; i++)
    for (let j = 0; j < 25; j++) points.push(i * 0.04, next() * 0.002, j * 0.04);
  for (let i = 0; i < 12; i++)
    for (let j = 0; j < 12; j++) points.push(0.7 + i * 0.02, 0.5 + next() * 0.002, 0.7 + j * 0.02);
  const normals = Array.from({ length: points.length }, (_, k) => (k % 3 === 1 ? 1 : 0));
  return [new Float32Array(points), new Float32Array(normals)] as SurfaceSample;
}

/**
 * A narrow `coneSide(0.05, 2, 0.0002)` (apex (0, 1, 0)) followed by 24 points on a ring of radius
 * 0.001 about its axis, 0.395 behind the apex, with radial normals.
 */
export function coneBehindApex() {
  const [side, sideNormals] = coneSide(0.05, 2, 0.0002);
  const points = Array.from(side),
    normals = Array.from(sideNormals);
  for (let k = 0; k < 24; k++) {
    const turn = (k / 24) * Math.PI * 2;
    points.push(0.001 * Math.cos(turn), 1.395, 0.001 * Math.sin(turn));
    normals.push(Math.cos(turn), 0, Math.sin(turn));
  }
  return {
    sample: [new Float32Array(points), new Float32Array(normals)] as SurfaceSample,
    clean: side.length / 3,
  };
}

/** Three rings of 360 points about Y at y = -height / 2, 0 and height / 2, with radial normals. */
export function band(radius: number, height: number) {
  const points: number[] = [],
    normals: number[] = [];
  for (const y of [-height / 2, 0, height / 2])
    for (let k = 0; k < 360; k++) {
      const turn = (k / 360) * Math.PI * 2;
      points.push(radius * Math.cos(turn), y, radius * Math.sin(turn));
      normals.push(Math.cos(turn), 0, Math.sin(turn));
    }
  return [new Float32Array(points), new Float32Array(normals)] as SurfaceSample;
}

/**
 * A tube about Y from y = -0.5 to 0.5 whose radius grows from `radius` at the bottom at `taper`
 * radians, 48 points round by 21 high, moved along their normals by up to `jitter`.
 */
export function taperedTube(radius: number, taper: number, jitter: number, seed = 5) {
  const next = signedRandom(seed);
  const points: number[] = [],
    normals: number[] = [];
  for (let j = 0; j <= 20; j++) {
    const y = -0.5 + j / 20;
    const r = radius + (y + 0.5) * Math.tan(taper);
    for (let k = 0; k < 48; k++) {
      const turn = (k / 48) * Math.PI * 2;
      const n = [
        Math.cos(turn) * Math.cos(taper),
        -Math.sin(taper),
        Math.sin(turn) * Math.cos(taper),
      ];
      const offset = next() * jitter;
      points.push(
        r * Math.cos(turn) + n[0] * offset,
        y + n[1] * offset,
        r * Math.sin(turn) + n[2] * offset,
      );
      normals.push(...n);
    }
  }
  return [new Float32Array(points), new Float32Array(normals)] as SurfaceSample;
}

/** Root mean square of `shapeDistance` over the first `count` points. */
export function shapeRms(
  distance: (x: number, y: number, z: number) => number,
  points: Float32Array,
  count = points.length / 3,
) {
  let sum = 0;
  for (let i = 0; i < count; i++)
    sum += distance(points[i * 3], points[i * 3 + 1], points[i * 3 + 2]) ** 2;
  return Math.sqrt(sum / count);
}

/** An open fan: a centre vertex and six about it at radius 1 in XZ, with the given y heights. */
export function sevenVertexFan(heights: number[]) {
  const points = [0, heights[0], 0];
  for (let k = 0; k < 6; k++) {
    const turn = (k / 6) * Math.PI * 2;
    points.push(Math.cos(turn), heights[k + 1], -Math.sin(turn));
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(points), 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 5, 0, 5, 6, 0, 6, 1]);
  geometry.computeVertexNormals();
  return geometry;
}

/** Unit normal pointing a seeded random way. */
function randomDirection(next: () => number) {
  for (;;) {
    const d = [next(), next(), next()];
    const length = Math.hypot(d[0], d[1], d[2]);
    if (length > 0.1 && length <= 1) return d.map((v) => v / length);
  }
}

/** A clean cap of a sphere about +Y, to 60 degrees from the pole, with radial normals. */
export function sphereCap(radius: number) {
  const geometry = new SphereGeometry(radius, 32, 16, 0, Math.PI * 2, 0, Math.PI / 3);
  return [
    Float32Array.from(geometry.getAttribute('position').array),
    Float32Array.from(geometry.getAttribute('normal').array),
  ] as SurfaceSample;
}

/**
 * `rows` x `columns` points (600 by default) on a cone with apex (0, 1, 0) opening down -Y at half
 * angle atan(0.5), moved along their outward normals by up to `jitter`, followed by strays up to
 * `total` points, each at least 0.05 off the cone. The strays fill the box about the cone with
 * random normals, or with `sheet` lie on y = -1.2 (moved by up to `jitter`) facing +Y.
 */
export function coneWithStrays(
  seed = 7,
  rows = 20,
  columns = 30,
  total = 1000,
  jitter = 0.002,
  sheet = false,
) {
  const next = signedRandom(seed);
  const half = Math.atan(0.5);
  const points: number[] = [],
    normals: number[] = [];
  for (let j = 0; j < rows; j++) {
    const t = 0.1 + (j / (rows - 1)) * 1.9;
    for (let k = 0; k < columns; k++) {
      const turn = (k / columns) * Math.PI * 2;
      const n = [Math.cos(turn) * Math.cos(half), Math.sin(half), Math.sin(turn) * Math.cos(half)];
      const offset = next() * jitter;
      const r = t * Math.tan(half);
      points.push(
        r * Math.cos(turn) + n[0] * offset,
        1 - t + n[1] * offset,
        r * Math.sin(turn) + n[2] * offset,
      );
      normals.push(...n);
    }
  }
  const coneDistance = (x: number, y: number, z: number) => {
    const h = 1 - y,
      rho = Math.hypot(x, z);
    if (h * Math.cos(half) + rho * Math.sin(half) < 0) return Math.hypot(x, h, z);
    return Math.abs(rho * Math.cos(half) - h * Math.sin(half));
  };
  while (points.length < total * 3) {
    const [x, y, z] = sheet
      ? [next() * 1.5, -1.2 + next() * jitter, next() * 1.5]
      : [next() * 1.2, next() * 1.2, next() * 1.2];
    if (coneDistance(x, y, z) < 0.05) continue;
    points.push(x, y, z);
    normals.push(...(sheet ? [0, 1, 0] : randomDirection(next)));
  }
  return [new Float32Array(points), new Float32Array(normals)] as SurfaceSample;
}

/**
 * Points of a cylinder of radius 1.5 about Z (`sweep`, a quarter turn by default, from its top
 * toward +X) and of the plane y = 1.5 tangent to it there (1.5 wide toward -X), `rows` rows along
 * z in [0, 1]: `cylinder`
 * and `plane` points in all, moved along their normals by up to 0.001.
 */
export function tangentPatch(
  cylinder: number,
  plane: number,
  seed = 9,
  sweep = Math.PI / 2,
  rows = 20,
) {
  const next = signedRandom(seed);
  const radius = 1.5;
  const points: number[] = [],
    normals: number[] = [];
  const arc = cylinder / rows,
    flat = plane / rows;
  for (let j = 0; j < rows; j++) {
    const z = j / (rows - 1);
    for (let k = 0; k < arc; k++) {
      const turn = ((k + 0.5) / arc) * sweep;
      const n = [Math.sin(turn), Math.cos(turn), 0];
      const offset = next() * 0.001;
      points.push(n[0] * (radius + offset), n[1] * (radius + offset), z);
      normals.push(...n);
    }
    for (let k = 0; k < flat; k++) {
      points.push(-((k + 0.5) / flat) * 1.5, radius + next() * 0.001, z);
      normals.push(0, 1, 0);
    }
  }
  return [new Float32Array(points), new Float32Array(normals)] as SurfaceSample;
}

/**
 * A 7 x 5 grid 0.1 apart along x and 0.0001 apart along z, its heights moved by up to 0.00002: a
 * narrow strip of 35 vertices whose quadric height field has full rank.
 */
export function narrowStrip(seed = 13) {
  const next = signedRandom(seed);
  const points: number[] = [],
    index: number[] = [];
  for (let j = 0; j < 5; j++)
    for (let i = 0; i < 7; i++) points.push(i * 0.1, next() * 0.00002, j * 0.0001);
  for (let j = 0; j < 4; j++)
    for (let i = 0; i < 6; i++) {
      const a = j * 7 + i;
      index.push(a, a + 7, a + 1, a + 1, a + 7, a + 8);
    }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(points), 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * RMS residual over every vertex of the least squares quadric height field in the frame of the
 * mean vertex normal, solved with `ml-matrix`.
 */
export function quadricRms(geometry: BufferGeometry) {
  const mesh = buildRefineMesh(geometry, new Matrix4());
  const topology = buildTopology(mesh);
  const count = mesh.weldedCount;
  const normal = new Float32Array(3);
  const sum = [0, 0, 0],
    centre = [0, 0, 0];
  for (let v = 0; v < count; v++) {
    vertexNormal(mesh, topology, v, normal);
    for (let k = 0; k < 3; k++) {
      sum[k] += normal[k];
      centre[k] += mesh.position[v * 3 + k] / count;
    }
  }
  const n = new Vector3(...sum).normalize();
  const u = new Vector3(1, 0, 0).cross(n).normalize(),
    w = n.clone().cross(u);
  const rows: number[][] = [],
    heights: number[][] = [];
  for (let v = 0; v < count; v++) {
    const d = new Vector3(...[0, 1, 2].map((k) => mesh.position[v * 3 + k] - centre[k]));
    const [x, y] = [d.dot(u), d.dot(w)];
    rows.push([1, x, y, x * x, x * y, y * y]);
    heights.push([d.dot(n)]);
  }
  const design = new Matrix(rows);
  const residual = design.mmul(solve(design, new Matrix(heights))).sub(new Matrix(heights));
  return Math.sqrt(residual.to1DArray().reduce((a, r) => a + r * r, 0) / count);
}

/** The points of a sample, with their normals, in the order of `indices`. */
export function reordered([points, normals]: SurfaceSample, indices: ArrayLike<number>) {
  const p = new Float32Array(indices.length * 3),
    n = new Float32Array(indices.length * 3);
  for (let j = 0; j < indices.length; j++)
    for (let k = 0; k < 3; k++) {
      p[j * 3 + k] = points[indices[j] * 3 + k];
      n[j * 3 + k] = normals[indices[j] * 3 + k];
    }
  return [p, n] as SurfaceSample;
}

/**
 * 600 points exactly on the cone of `coneWithStrays` with outward normals, followed by 400 points
 * on a sheet whose normal is `tilt` radians from +Y toward +X at `offset` from the origin, facing
 * along that normal, each at least 0.05 off the cone.
 */
export function coneBesideSheet(tilt = 0.8, offset = 1.2, seed = 7) {
  const next = signedRandom(seed);
  const half = Math.atan(0.5);
  const points: number[] = [],
    normals: number[] = [];
  for (let j = 0; j < 20; j++) {
    const t = 0.1 + (j / 19) * 1.9;
    for (let k = 0; k < 30; k++) {
      const turn = (k / 30) * Math.PI * 2;
      const r = t * Math.tan(half);
      points.push(r * Math.cos(turn), 1 - t, r * Math.sin(turn));
      normals.push(
        Math.cos(turn) * Math.cos(half),
        Math.sin(half),
        Math.sin(turn) * Math.cos(half),
      );
    }
  }
  const normal = [Math.sin(tilt), Math.cos(tilt), 0],
    along = [Math.cos(tilt), -Math.sin(tilt), 0];
  while (points.length < 1000 * 3) {
    const [a, b] = [next() * 1.5, next() * 1.5];
    const [x, y, z] = [normal[0] * offset + along[0] * a, normal[1] * offset + along[1] * a, b];
    const h = 1 - y,
      rho = Math.hypot(x, z);
    const distance =
      h * Math.cos(half) + rho * Math.sin(half) < 0
        ? Math.hypot(x, h, z)
        : Math.abs(rho * Math.cos(half) - h * Math.sin(half));
    if (distance < 0.05) continue;
    points.push(x, y, z);
    normals.push(...normal);
  }
  return [new Float32Array(points), new Float32Array(normals)] as SurfaceSample;
}

/** The indices 0 to count - 1 in a seeded Fisher-Yates order. */
export function shuffled(count: number, seed: number) {
  const indices = Array.from({ length: count }, (_, i) => i);
  let state = seed;
  for (let i = count - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices;
}

/** A shape's parameters as one list, to compare two fits number by number. */
export function shapeParameters(shape: Shape) {
  switch (shape.kind) {
    case 'plane':
      return [...shape.point, ...shape.normal];
    case 'sphere':
      return [...shape.center, shape.radius];
    case 'cylinder':
      return [...shape.point, ...shape.axis, shape.radius];
    case 'cone':
      return [...shape.apex, ...shape.axis, shape.angle];
  }
}

/** Closest point to `p` on triangle a, b, c (Ericson, Real-Time Collision Detection 5.1.5). */
function closestOnTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const sub = (u: Vec3, v: Vec3): Vec3 => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
  const dot = (u: Vec3, v: Vec3) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const along = (from: Vec3, d: Vec3, t: number): Vec3 => [
    from[0] + d[0] * t,
    from[1] + d[1] * t,
    from[2] + d[2] * t,
  ];
  const ab = sub(b, a),
    ac = sub(c, a),
    ap = sub(p, a);
  const d1 = dot(ab, ap),
    d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b);
  const d3 = dot(ab, bp),
    d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return along(a, ab, d1 / (d1 - d3));
  const cp = sub(p, c);
  const d5 = dot(ab, cp),
    d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return along(a, ac, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0)
    return along(b, sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6)));
  const denominator = 1 / (va + vb + vc);
  const v = vb * denominator,
    w = vc * denominator;
  return [0, 1, 2].map((k) => a[k] + ab[k] * v + ac[k] * w) as Vec3;
}

/** The surface point nearest `p`, by brute force over every triangle, as a clicked guide point. */
export function pointOn(mesh: RefineMesh, p: Vec3): GuidePoint {
  const at = (t: number, k: 0 | 1 | 2): Vec3 => {
    const w = weldedCorner(mesh, t, k) * 3;
    return [mesh.position[w], mesh.position[w + 1], mesh.position[w + 2]];
  };
  let best: GuidePoint = { triangle: 0, position: p },
    nearest = Infinity;
  for (let t = 0; t < mesh.triangleCount; t++) {
    const q = closestOnTriangle(p, at(t, 0), at(t, 1), at(t, 2));
    const d = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
    if (d < nearest) {
      nearest = d;
      best = { triangle: t, position: q };
    }
  }
  return best;
}

/** Number of band vertices in `zone`. */
export function zoneCount(band: EdgeBand, zone: BandZone) {
  return band.zone.reduce((count, z) => count + +(z === zone), 0);
}

/** Farthest a vertex of `zone` lies from a face, given as the distance of a point to it. */
export function maxZoneDistance(
  mesh: RefineMesh,
  band: EdgeBand,
  zone: BandZone,
  face: (p: Vec3) => number,
) {
  let worst = 0;
  band.vertices.forEach((v, i) => {
    if (band.zone[i] !== zone) return;
    const p = mesh.position;
    worst = Math.max(worst, face([p[v * 3], p[v * 3 + 1], p[v * 3 + 2]]));
  });
  return worst;
}

/** Number of band vertices in one of `zones` at a point that `where` accepts. */
export function countWhere(
  mesh: RefineMesh,
  band: EdgeBand,
  zones: BandZone[],
  where: (p: Vec3) => boolean,
) {
  let count = 0;
  band.vertices.forEach((v, i) => {
    const p = mesh.position;
    if (zones.includes(band.zone[i]) && where([p[v * 3], p[v * 3 + 1], p[v * 3 + 2]])) count++;
  });
  return count;
}

/** Farthest a point of polyline `b` (xyz triples) lies from polyline `a`. */
export function polylineGap(a: ArrayLike<number>, b: ArrayLike<number>) {
  let worst = 0;
  for (let k = 0; k < b.length; k += 3) {
    let best = Infinity;
    for (let j = 0; j + 3 < a.length || j === 0; j += 3) {
      const d = [0, 1, 2].map((m) => (j + 3 < a.length ? a[j + 3 + m] - a[j + m] : 0));
      const w = [0, 1, 2].map((m) => b[k + m] - a[j + m]);
      const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
      const t =
        dd > 0 ? Math.min(1, Math.max(0, (w[0] * d[0] + w[1] * d[1] + w[2] * d[2]) / dd)) : 0;
      best = Math.min(best, Math.hypot(w[0] - t * d[0], w[1] - t * d[1], w[2] - t * d[2]));
      if (j + 3 >= a.length) break;
    }
    worst = Math.max(worst, best);
  }
  return worst;
}
