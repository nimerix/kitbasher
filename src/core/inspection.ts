import { Box3, BufferAttribute, BufferGeometry, Matrix4, Triangle, Vector3 } from 'three';
import { Brush, Evaluator, INTERSECTION } from 'three-bvh-csg';
import { ExtendedTriangle, MeshBVH } from 'three-mesh-bvh';
import { assertClosed } from './merge';
import type { InspectionMesh, InspectionRequest, InspectionResult } from './inspection-types';
import type { Part } from './types';

const identity = new Matrix4();
const maxBandTriangles = 250000;
const maxBandQueries = 2000000;

export function inspectionGeometry(mesh: InspectionMesh) {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(mesh.positions.slice(), 3));
  if (mesh.indices) geometry.setIndex(new BufferAttribute(mesh.indices.slice(), 1));
  const matrix = new Matrix4().fromArray(mesh.matrix);
  geometry.applyMatrix4(matrix);
  if (matrix.determinant() < 0) {
    // Reflections reverse winding. Restore outward faces for the solid intersection.
    if (geometry.index) {
      const index = geometry.index;
      for (let i = 0; i < index.count; i += 3) {
        const b = index.getX(i + 1);
        index.setX(i + 1, index.getX(i + 2));
        index.setX(i + 2, b);
      }
    } else {
      const position = geometry.getAttribute('position');
      const vertex = new Vector3();
      for (let i = 0; i < position.count; i += 3) {
        vertex.fromBufferAttribute(position, i + 1);
        position.setXYZ(i + 1, position.getX(i + 2), position.getY(i + 2), position.getZ(i + 2));
        position.setXYZ(i + 2, vertex.x, vertex.y, vertex.z);
      }
    }
  }
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return geometry;
}

function positionsOf(geometry: BufferGeometry) {
  const position = geometry.getAttribute('position');
  const count = geometry.index?.count ?? position.count;
  const result = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const vertex = geometry.index?.getX(i) ?? i;
    result[i * 3] = position.getX(vertex);
    result[i * 3 + 1] = position.getY(vertex);
    result[i * 3 + 2] = position.getZ(vertex);
  }
  return result;
}

/** Translation-independent signed tetrahedra, also for scans far from the origin. */
export function solidVolume(geometry: BufferGeometry) {
  const position = geometry.getAttribute('position');
  if (!position?.count) return 0;
  const origin = new Vector3().fromBufferAttribute(position, 0);
  const a = new Vector3(),
    b = new Vector3(),
    c = new Vector3();
  let volume = 0;
  for (let i = 0, count = geometry.index?.count ?? position.count; i < count; i += 3) {
    a.fromBufferAttribute(position, geometry.index?.getX(i) ?? i).sub(origin);
    b.fromBufferAttribute(position, geometry.index?.getX(i + 1) ?? i + 1).sub(origin);
    c.fromBufferAttribute(position, geometry.index?.getX(i + 2) ?? i + 2).sub(origin);
    volume += a.dot(b.cross(c));
  }
  return Math.abs(volume / 6);
}

interface Sample {
  point: Vector3;
  distance: number;
  face: number;
}
interface BandBudget {
  queries: number;
  triangles: number;
  exhausted: boolean;
}

/** Adaptive surface-distance clipping; exact triangle queries keep coarse faces in the search. */
function surfaceBand(
  geometry: BufferGeometry,
  other: MeshBVH,
  threshold: number,
  resolution: number,
  budget: BandBudget,
) {
  const positions: number[] = [];
  const source = geometry.getAttribute('position');
  const targetBox = other.geometry.boundingBox!.clone().expandByScalar(threshold);
  const box = new Box3();
  const triangle = new ExtendedTriangle();
  const hit = { point: new Vector3(), distance: 0, faceIndex: 0 };
  const sample = (point: Vector3): Sample => {
    budget.queries++;
    other.closestPointToPoint(point, hit);
    return { point, distance: hit.distance, face: hit.faceIndex };
  };
  const emit = (a: Vector3, b: Vector3, c: Vector3) => {
    if (budget.triangles >= maxBandTriangles) {
      budget.exhausted = true;
      return;
    }
    if (new Triangle(a, b, c).getArea() < 1e-12) return;
    positions.push(...a.toArray(), ...b.toArray(), ...c.toArray());
    budget.triangles++;
  };
  const overlapsBand = (a: Sample, b: Sample, c: Sample) => {
    triangle.set(a.point, b.point, c.point);
    triangle.needsUpdate = true;
    box.setFromPoints([a.point, b.point, c.point]).expandByScalar(threshold + 1e-7);
    return other.shapecast({
      intersectsBounds: (bounds) => bounds.intersectsBox(box),
      intersectsTriangle: (otherTriangle) => {
        budget.queries++;
        return otherTriangle.distanceToTriangle(triangle) <= threshold + 1e-7;
      },
    });
  };
  const visit = (a: Sample, b: Sample, c: Sample, depth: number) => {
    if (budget.exhausted) return;
    if (budget.queries > maxBandQueries) {
      budget.exhausted = true;
      return;
    }
    const allInside = [a, b, c].every((v) => v.distance <= threshold + 1e-7);
    const edges = [
      a.point.distanceTo(b.point),
      b.point.distanceTo(c.point),
      c.point.distanceTo(a.point),
    ];
    const longest = Math.max(...edges);
    // Distance to a single triangle is convex, so this whole source face is in range.
    if (
      allInside &&
      ((a.face === b.face && b.face === c.face) ||
        Math.max(a.distance, b.distance, c.distance) + longest <= threshold)
    ) {
      emit(a.point, b.point, c.point);
      return;
    }
    if (!allInside && !overlapsBand(a, b, c)) return;
    if (longest > resolution && depth < 20) {
      if (edges[0] === longest) {
        const mid = sample(a.point.clone().add(b.point).multiplyScalar(0.5));
        visit(a, mid, c, depth + 1);
        visit(mid, b, c, depth + 1);
      } else if (edges[1] === longest) {
        const mid = sample(b.point.clone().add(c.point).multiplyScalar(0.5));
        visit(a, b, mid, depth + 1);
        visit(a, mid, c, depth + 1);
      } else {
        const mid = sample(c.point.clone().add(a.point).multiplyScalar(0.5));
        visit(a, b, mid, depth + 1);
        visit(mid, b, c, depth + 1);
      }
      return;
    }
    const polygon: Vector3[] = [];
    for (const [from, to] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const insideFrom = from.distance <= threshold + 1e-7;
      const insideTo = to.distance <= threshold + 1e-7;
      if (insideFrom) polygon.push(from.point);
      if (insideFrom !== insideTo)
        polygon.push(
          from.point
            .clone()
            .lerp(to.point, (threshold - from.distance) / (to.distance - from.distance)),
        );
    }
    for (let i = 1; i + 1 < polygon.length; i++) emit(polygon[0], polygon[i], polygon[i + 1]);
  };
  for (
    let i = 0, count = geometry.index?.count ?? source.count;
    i < count && !budget.exhausted;
    i += 3
  ) {
    const points = [0, 1, 2].map((j) =>
      new Vector3().fromBufferAttribute(source, geometry.index?.getX(i + j) ?? i + j),
    );
    if (!new Box3().setFromPoints(points).intersectsBox(targetBox)) continue;
    visit(sample(points[0]), sample(points[1]), sample(points[2]), 0);
  }
  return positions;
}

export function inspectMeshes(request: InspectionRequest): InspectionResult {
  if (!Number.isFinite(request.distance) || request.distance < 0)
    throw new Error('Enter a non-negative inspection distance in mm.');
  const geometries = request.meshes.map(inspectionGeometry);
  const brushes: Brush[] = [];
  const result: InspectionResult = {
    overlaps: [],
    surfaces: [],
    pairs: [],
    checkedPairs: 0,
    solidPairs: 0,
    resolution: 0,
    warnings: [],
  };
  try {
    const maxSize = geometries.reduce(
      (size, geometry) => Math.max(size, ...geometry.boundingBox!.getSize(new Vector3()).toArray()),
      1,
    );
    result.resolution = Math.max(request.distance / 4, maxSize / 2048, 0.0001);
    const bvh = geometries.map(
      (geometry) => new MeshBVH(geometry, { indirect: true, maxLeafSize: 8 }),
    );
    geometries.forEach((geometry, i) => {
      geometry.boundsTree = bvh[i];
    });
    const closed = geometries.map((geometry, i) => {
      try {
        assertClosed({ name: request.meshes[i].name, geometry } as Part);
        return true;
      } catch {
        result.warnings.push(
          `${request.meshes[i].name}: solid overlap unavailable for open or non-manifold geometry. Nearby surfaces are still checked.`,
        );
        return false;
      }
    });
    const evaluator = new Evaluator();
    evaluator.attributes = ['position', 'normal'];
    evaluator.useGroups = false;
    const bands = geometries.map(() => [] as number[]);
    const budget: BandBudget = { queries: 0, triangles: 0, exhausted: false };
    for (let a = 0; a < geometries.length; a++) {
      for (let b = a + 1; b < geometries.length; b++) {
        result.checkedPairs++;
        if (closed[a] && closed[b]) result.solidPairs++;
        const geometryA = geometries[a],
          geometryB = geometries[b];
        if (
          !geometryA
            .boundingBox!.clone()
            .expandByScalar(request.distance)
            .intersectsBox(geometryB.boundingBox!)
        )
          continue;
        const one = { point: new Vector3(), distance: 0, faceIndex: 0 };
        const two = { point: new Vector3(), distance: 0, faceIndex: 0 };
        bvh[a].closestPointToGeometry(geometryB, identity, one, two);
        const meshA = request.meshes[a],
          meshB = request.meshes[b];
        let volume: number | null = closed[a] && closed[b] ? 0 : null;
        if (volume !== null && geometryA.boundingBox!.intersectsBox(geometryB.boundingBox!)) {
          let intersection: Brush | null = null;
          try {
            const brushA = (brushes[a] ??= new Brush(geometryA));
            const brushB = (brushes[b] ??= new Brush(geometryB));
            brushA.updateMatrixWorld(true);
            brushB.updateMatrixWorld(true);
            intersection = evaluator.evaluate(brushA, brushB, INTERSECTION);
            volume = solidVolume(intersection.geometry);
            const epsilon = Math.max(
              1e-10,
              Math.min(solidVolume(geometryA), solidVolume(geometryB)) * 1e-9,
            );
            if (volume > epsilon)
              result.overlaps.push({
                a: meshA.id,
                b: meshB.id,
                positions: positionsOf(intersection.geometry),
              });
            else volume = 0;
          } catch {
            volume = null;
            result.solidPairs--;
            result.warnings.push(
              `${meshA.name} / ${meshB.name}: solid intersection failed. Nearby surfaces are still checked.`,
            );
          } finally {
            intersection?.geometry.dispose();
          }
        }
        if (one.distance <= request.distance + 1e-7 || volume === null || volume > 0) {
          result.pairs.push({
            a: meshA.id,
            b: meshB.id,
            nameA: meshA.name,
            nameB: meshB.name,
            volume,
            distance: one.distance,
            points: [one.point.toArray(), two.point.toArray()],
          });
        }
        if (one.distance <= request.distance + 1e-7) {
          for (const value of surfaceBand(
            geometryA,
            bvh[b],
            request.distance,
            result.resolution,
            budget,
          ))
            bands[a].push(value);
          for (const value of surfaceBand(
            geometryB,
            bvh[a],
            request.distance,
            result.resolution,
            budget,
          ))
            bands[b].push(value);
        }
      }
    }
    if (budget.exhausted)
      result.warnings.push(
        'Surface band is incomplete: the scan exceeded the inspection detail budget. Inspect fewer selected parts or simplify the scan. Solid overlap results are separate.',
      );
    bands.forEach((positions, i) => {
      if (positions.length)
        result.surfaces.push({ id: request.meshes[i].id, positions: new Float32Array(positions) });
    });
    return result;
  } finally {
    brushes.forEach((brush) => brush?.disposeCacheData());
    geometries.forEach((geometry) => geometry.dispose());
  }
}
