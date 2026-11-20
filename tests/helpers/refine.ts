import { type BufferGeometry, Matrix4 } from 'three';
import { hasClosedEdges, weldedPositionIndex } from '../../src/core/mesh-topology';
import {
  type RefineMesh,
  buildRefineMesh,
  buildTopology,
  triangleNormal,
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

/** The working model the Refine modules take: mesh, topology and noise. */
export function modelFrom(mesh: RefineMesh) {
  return { mesh, topology: buildTopology(mesh), noise: 0.004 };
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
export function extent(position: Float32Array, count = position.length / 3) {
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
