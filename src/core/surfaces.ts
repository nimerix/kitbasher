import { BufferAttribute, BufferGeometry, Matrix3, Sphere, Triangle, Vector3 } from 'three';
import { partMatrix, triangleCount, vec, worldNormal, worldPoint } from './geometry';
import type { Part, SurfacePair, SurfacePatch, SurfacePoint } from './types';

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

/** A world-size brush, clipped to faces oriented toward the picked surface. */
export function facesUnderBrush(part: Part, hit: SurfacePoint, radius: number, seedFace: number) {
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
  const localSphere = new Sphere(vec(hit.point), radius / Math.min(...part.scale.map(Math.abs)));
  const closest = new Vector3(),
    candidateNormal = new Vector3(),
    world = new Triangle();
  const faces: number[] = [];
  const test = (triangle: Triangle, face: number) => {
    triangle.getNormal(candidateNormal).applyMatrix3(normalMatrix).normalize();
    if (candidateNormal.dot(normal) < 0.2) return false;
    world.a.copy(triangle.a).applyMatrix4(matrix);
    world.b.copy(triangle.b).applyMatrix4(matrix);
    world.c.copy(triangle.c).applyMatrix4(matrix);
    world.closestPointToPoint(center, closest);
    if (closest.distanceToSquared(center) <= radius * radius) faces.push(face);
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
  return faces.sort((a, b) => a - b);
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
