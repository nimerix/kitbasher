import { BufferAttribute, BufferGeometry, Matrix3, Sphere, Triangle, Vector3 } from 'three';
import { partMatrix, triangleCount, vec, worldNormal, worldPoint } from './geometry';
import type { BrushPlaneSettings, Part, SurfacePair, SurfacePatch, SurfacePoint } from './types';

export const contactColors = ['#eda763', '#80cbc4', '#bba3ed', '#e8bf67', '#88b4f1', '#e38faf'];

export function readFace(geometry: BufferGeometry, face: number, triangle = new Triangle()) {
  const positions = geometry.getAttribute('position'),
    index = geometry.index;
  const offset = face * 3;
  triangle.a.fromBufferAttribute(positions, index ? index.getX(offset) : offset);
  triangle.b.fromBufferAttribute(positions, index ? index.getX(offset + 1) : offset + 1);
  triangle.c.fromBufferAttribute(positions, index ? index.getX(offset + 2) : offset + 2);
  return triangle;
}

/** Weld duplicate scan vertices only at shared edges, never by brush proximity. */
const adjacencyCache = new WeakMap<BufferGeometry, number[][]>();
export function faceAdjacency(geometry: BufferGeometry) {
  const cached = adjacencyCache.get(geometry);
  if (cached) return cached;
  const count = triangleCount(geometry),
    positions = geometry.getAttribute('position');
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const epsilon = Math.max(1e-7, geometry.boundingBox!.getSize(new Vector3()).length() * 1e-8);
  const vertices = new Map<string, number>(),
    welded: number[] = [];
  for (let i = 0; i < positions.count; i++) {
    const key = `${Math.round(positions.getX(i) / epsilon)},${Math.round(positions.getY(i) / epsilon)},${Math.round(positions.getZ(i) / epsilon)}`;
    let id = vertices.get(key);
    if (id === undefined) {
      id = vertices.size;
      vertices.set(key, id);
    }
    welded.push(id);
  }
  const edges = new Map<string, number[]>(),
    adjacency = Array.from({ length: count }, () => [] as number[]);
  for (let face = 0; face < count; face++) {
    const ids = [0, 1, 2].map(
      (i) => welded[geometry.index ? geometry.index.getX(face * 3 + i) : face * 3 + i],
    );
    for (let i = 0; i < 3; i++) {
      const a = ids[i],
        b = ids[(i + 1) % 3];
      if (a === b) continue;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const neighbors = edges.get(key) ?? [];
      for (const other of neighbors) {
        adjacency[face].push(other);
        adjacency[other].push(face);
      }
      neighbors.push(face);
      edges.set(key, neighbors);
    }
  }
  adjacencyCache.set(geometry, adjacency);
  return adjacency;
}

export function connectedFaces(geometry: BufferGeometry, eligible: Set<number>, seed: number) {
  if (!eligible.has(seed)) return [];
  const adjacency = faceAdjacency(geometry),
    visited = new Set([seed]),
    queue = [seed];
  for (let i = 0; i < queue.length; i++)
    for (const neighbor of adjacency[queue[i]] ?? [])
      if (eligible.has(neighbor) && !visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
  return queue.sort((a, b) => a - b);
}

/** Erasure must not leave islands, even if it removes the original seed. */
export function contiguousRemainder(geometry: BufferGeometry, faces: number[], seed?: number) {
  const remaining = new Set(faces);
  if (seed !== undefined && remaining.has(seed)) return connectedFaces(geometry, remaining, seed);
  let largest: number[] = [];
  while (remaining.size) {
    const component = connectedFaces(geometry, remaining, remaining.values().next().value!);
    if (component.length > largest.length) largest = component;
    for (const face of component) remaining.delete(face);
  }
  return largest;
}

/** A connected world-size brush, optionally clipped to the patch's fixed seed plane. */
export function facesUnderBrush(
  part: Part,
  hit: SurfacePoint,
  radius: number,
  seedFace: number,
  options: { plane?: BrushPlaneSettings; patch?: SurfacePatch } = {},
) {
  if (
    !Number.isFinite(radius) ||
    radius <= 0 ||
    seedFace < 0 ||
    seedFace >= triangleCount(part.geometry)
  )
    return [];
  const matrix = partMatrix(part),
    normalMatrix = new Matrix3().getNormalMatrix(matrix);
  const center = worldPoint(part, hit),
    normal = worldNormal(part, hit);
  const reference = options.patch?.seed ?? hit;
  const planePoint = worldPoint(part, reference),
    planeNormal = worldNormal(part, reference);
  const plane = options.plane,
    cosine = Math.cos(((plane?.angle ?? 20) * Math.PI) / 180);
  const localSphere = new Sphere(vec(hit.point), radius / Math.min(...part.scale.map(Math.abs)));
  const closest = new Vector3(),
    candidateNormal = new Vector3(),
    world = new Triangle();
  const eligible = new Set<number>();
  const test = (triangle: Triangle, face: number) => {
    if (triangle.getArea() < 1e-14) return false;
    triangle.getNormal(candidateNormal).applyMatrix3(normalMatrix).normalize();
    if (candidateNormal.dot(normal) < 0.2) return false;
    world.a.copy(triangle.a).applyMatrix4(matrix);
    world.b.copy(triangle.b).applyMatrix4(matrix);
    world.c.copy(triangle.c).applyMatrix4(matrix);
    if (
      plane?.enabled &&
      (candidateNormal.dot(planeNormal) < cosine - 1e-10 ||
        [world.a, world.b, world.c].some(
          (v) => Math.abs(v.clone().sub(planePoint).dot(planeNormal)) > plane.distance + 1e-8,
        ))
    )
      return false;
    world.closestPointToPoint(center, closest);
    if (closest.distanceToSquared(center) <= radius * radius) eligible.add(face);
    return false;
  };
  if (part.geometry.boundsTree) {
    part.geometry.boundsTree.shapecast({
      intersectsBounds: (box) => localSphere.intersectsBox(box),
      intersectsTriangle: test,
    });
  } else {
    const triangle = new Triangle();
    for (let i = 0; i < triangleCount(part.geometry); i++)
      test(readFace(part.geometry, i, triangle), i);
  }
  const faces = connectedFaces(part.geometry, eligible, seedFace);
  const previous = options.patch?.faces;
  if (previous?.length) {
    const adjacency = faceAdjacency(part.geometry),
      selected = new Set(previous);
    // A stroke can grow an existing patch but cannot start another island.
    if (
      !faces.some(
        (face) => selected.has(face) || adjacency[face].some((neighbor) => selected.has(neighbor)),
      )
    )
      return [];
  }
  return faces;
}

export function patchGeometry(geometry: BufferGeometry, faces: number[]) {
  const positions = new Float32Array(faces.length * 9),
    triangle = new Triangle();
  faces.forEach((face, i) => {
    readFace(geometry, face, triangle);
    triangle.a.toArray(positions, i * 9);
    triangle.b.toArray(positions, i * 9 + 3);
    triangle.c.toArray(positions, i * 9 + 6);
  });
  return new BufferGeometry().setAttribute('position', new BufferAttribute(positions, 3));
}

export function patchCenter(part: Part, patch: SurfacePatch) {
  const center = new Vector3(),
    triangle = new Triangle(),
    midpoint = new Vector3();
  let area = 0;
  for (const face of patch.faces) {
    readFace(part.geometry, face, triangle);
    const weight = triangle.getArea();
    center.addScaledVector(triangle.getMidpoint(midpoint), weight);
    area += weight;
  }
  return area ? center.divideScalar(area) : null;
}

export const completedSurfacePairs = (pairs: SurfacePair[]) =>
  pairs.filter((pair) => pair.source?.faces.length && pair.target?.faces.length);
