import { EigenvalueDecomposition, Matrix } from 'ml-matrix';
import { Matrix3, Triangle, Vector3 } from 'three';
import { partMatrix, triangleCount, vec } from './geometry';
import { readFace } from './surfaces';
import type { Part, PlaneFrame, SurfacePatch } from './types';

export function worldPlane(part: Part, plane: PlaneFrame) {
  const matrix = partMatrix(part);
  return {
    point: vec(plane.point).applyMatrix4(matrix),
    normal: vec(plane.normal).applyMatrix3(new Matrix3().getNormalMatrix(matrix)).normalize(),
  };
}

/** Exact triangle area moments make the plane independent of scan tessellation. */
export function fitPatchPlane(part: Part, patch: SurfacePatch) {
  const matrix = partMatrix(part),
    triangle = new Triangle(),
    center = new Vector3(),
    normal = new Vector3();
  const triangles: { vertices: Vector3[]; area: number }[] = [];
  let area = 0;
  for (const face of new Set(patch.faces)) {
    if (!Number.isInteger(face) || face < 0 || face >= triangleCount(part.geometry))
      throw new Error('A painted plane contains a missing triangle. Repaint this patch.');
    readFace(part.geometry, face, triangle);
    const orientation = triangle
      .getNormal(new Vector3())
      .applyMatrix3(new Matrix3().getNormalMatrix(matrix))
      .normalize();
    const vertices = [triangle.a, triangle.b, triangle.c].map((v) =>
      v.clone().applyMatrix4(matrix),
    );
    const world = new Triangle(...(vertices as [Vector3, Vector3, Vector3])),
      weight = world.getArea();
    if (weight < 1e-12) continue;
    center.addScaledVector(world.getMidpoint(new Vector3()), weight);
    normal.addScaledVector(orientation, weight);
    triangles.push({ vertices, area: weight });
    area += weight;
  }
  if (!area) throw new Error('Paint a patch with measurable area to define a plane.');
  center.divideScalar(area);
  // Center before accumulating covariance to avoid cancellation on distant scan origins.
  const covariance = Matrix.zeros(3, 3);
  for (const triangle of triangles) {
    const values = triangle.vertices.map((v) => v.clone().sub(center).toArray());
    const sum = values[0].map((_, i) => values.reduce((total, v) => total + v[i], 0));
    for (let row = 0; row < 3; row++)
      for (let col = 0; col < 3; col++)
        covariance.set(
          row,
          col,
          covariance.get(row, col) +
            (triangle.area / (12 * area)) *
              (sum[row] * sum[col] + values.reduce((total, v) => total + v[row] * v[col], 0)),
        );
  }
  const eigen = new EigenvalueDecomposition(covariance, { assumeSymmetric: true });
  const order = eigen.realEigenvalues
    .map((value, i) => ({ value: Math.max(0, value), i }))
    .sort((a, b) => a.value - b.value);
  if (order[1].value <= Math.max(1e-14, order[2].value * 1e-10))
    throw new Error('Paint a wider patch; these points do not define a stable plane.');
  if (order[1].value - order[0].value <= Math.max(1e-14, order[2].value * 1e-6))
    throw new Error('Paint a flatter patch; these surfaces do not define a unique plane.');
  const axis = new Vector3(
    ...(eigen.eigenvectorMatrix.getColumn(order[0].i) as [number, number, number]),
  ).normalize();
  if (axis.dot(normal) < 0) axis.negate();
  const local: PlaneFrame = {
    point: center.clone().applyMatrix4(matrix.clone().invert()).toArray(),
    normal: axis
      .clone()
      .applyMatrix3(new Matrix3().getNormalMatrix(matrix).invert())
      .normalize()
      .toArray(),
  };
  return { plane: local, rms: Math.sqrt(order[0].value), area };
}
