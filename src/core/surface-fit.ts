import { BufferAttribute, BufferGeometry, Matrix3, Matrix4, Triangle, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { partMatrix, rigidAlignment, triangleCount } from './geometry';
import { completedSurfacePairs, readFace } from './surfaces';
import type { AssemblyOperation, Part, SurfacePatch } from './types';

type Sample = { point: Vector3; normal: Vector3 };
type Patch = {
  geometry: BufferGeometry;
  tree: MeshBVH;
  samples: Sample[];
  center: Vector3;
  normal: Vector3;
  area: number;
};
type Pair = { source: Patch; target: Patch; normalLength: number };
const sampleCount = 96;

/** Area-stratified samples avoid giving denser scan tessellation more influence. */
function buildPatch(part: Part, patch: SurfacePatch): Patch {
  const matrix = partMatrix(part),
    normalMatrix = new Matrix3().getNormalMatrix(matrix);
  const triangles: Triangle[] = [],
    areas: number[] = [],
    normals: Vector3[] = [];
  const center = new Vector3(),
    normal = new Vector3();
  let area = 0;
  for (const face of new Set(patch.faces)) {
    if (!Number.isInteger(face) || face < 0 || face >= triangleCount(part.geometry))
      throw new Error('A painted patch contains a missing triangle. Repaint this pair.');
    const triangle = readFace(part.geometry, face);
    const faceNormal = triangle.getNormal(new Vector3()).applyMatrix3(normalMatrix).normalize();
    triangle.a.applyMatrix4(matrix);
    triangle.b.applyMatrix4(matrix);
    triangle.c.applyMatrix4(matrix);
    const weight = triangle.getArea();
    if (weight < 1e-12) continue;
    area += weight;
    center.addScaledVector(triangle.getMidpoint(new Vector3()), weight);
    normal.addScaledVector(faceNormal, weight);
    triangles.push(triangle);
    normals.push(faceNormal);
    areas.push(area);
  }
  if (!triangles.length)
    throw new Error('Paint a patch with a measurable surface area on each part.');
  center.divideScalar(area);
  normal.normalize();
  const positions = new Float32Array(triangles.length * 9);
  triangles.forEach((triangle, i) => {
    triangle.a.toArray(positions, i * 9);
    triangle.b.toArray(positions, i * 9 + 3);
    triangle.c.toArray(positions, i * 9 + 6);
  });
  const geometry = new BufferGeometry().setAttribute('position', new BufferAttribute(positions, 3));
  const tree = new MeshBVH(geometry, { indirect: true });
  const samples: Sample[] = [];
  let face = 0;
  for (let i = 0; i < sampleCount; i++) {
    const position = ((i + 0.5) / sampleCount) * area;
    while (areas[face] < position) face++;
    const triangle = triangles[face];
    const u = Math.sqrt(((i + 1) * 0.7548776662466927) % 1),
      v = ((i + 1) * 0.5698402909980532) % 1;
    const point = triangle.a
      .clone()
      .multiplyScalar(1 - u)
      .addScaledVector(triangle.b, u * (1 - v))
      .addScaledVector(triangle.c, u * v);
    samples.push({ point, normal: normals[face].clone() });
  }
  // Normals are indexed by the original (indirect) face index.
  geometry.userData.normals = normals;
  return { geometry, tree, samples, center, normal, area };
}

function buildPairs(source: Part, target: Part, operation: AssemblyOperation) {
  const complete = completedSurfacePairs(operation.surfacePairs);
  if (complete.length < 3)
    throw new Error('Paint at least three complete pairs of contact surfaces.');
  if (complete.length !== operation.surfacePairs.length)
    throw new Error('Finish or remove the incomplete surface pair before fitting.');
  return complete.map((pair) => {
    if (pair.source!.partId !== source.id || pair.target!.partId !== target.id)
      throw new Error('Every surface pair must use the same moving and target parts.');
    const a = buildPatch(source, pair.source!),
      b = buildPatch(target, pair.target!);
    return {
      source: a,
      target: b,
      normalLength: Math.max(Math.sqrt(Math.min(a.area, b.area)) * 0.3, 0.01),
    };
  });
}

function nearest(patch: Patch, point: Vector3) {
  const hit = patch.tree.closestPointToPoint(point)!;
  return {
    point: hit.point,
    normal: (patch.geometry.userData.normals as Vector3[])[hit.faceIndex],
  };
}

function correspondences(pairs: Pair[], matrix: Matrix4, offset: number) {
  const inverse = matrix.clone().invert(),
    normalMatrix = new Matrix3().getNormalMatrix(matrix);
  return pairs.map((pair) => {
    const matches: { source: Sample; target: Sample; error: number }[] = [];
    for (const sample of pair.source.samples) {
      const placed = sample.point.clone().applyMatrix4(matrix);
      const match = nearest(pair.target, placed);
      const target = {
        point: match.point.clone().addScaledVector(match.normal, offset),
        normal: match.normal,
      };
      matches.push({ source: sample, target, error: placed.distanceToSquared(target.point) });
    }
    for (const sample of pair.target.samples) {
      const target = {
        point: sample.point.clone().addScaledVector(sample.normal, offset),
        normal: sample.normal,
      };
      const match = nearest(pair.source, target.point.clone().applyMatrix4(inverse));
      const source = { point: match.point, normal: match.normal };
      matches.push({
        source,
        target,
        error: source.point.clone().applyMatrix4(matrix).distanceToSquared(target.point),
      });
    }
    return { ...pair, matches, normalMatrix };
  });
}

function metrics(pairs: Pair[], matrix: Matrix4, operation: AssemblyOperation) {
  const matches = correspondences(pairs, matrix, operation.offset);
  let squared = 0,
    normalSquared = 0,
    count = 0;
  for (const pair of matches)
    for (const match of pair.matches) {
      squared += match.error;
      const normal = match.source.normal.clone().applyMatrix3(pair.normalMatrix).normalize();
      const expected = match.target.normal.clone().multiplyScalar(operation.flipNormal ? -1 : 1);
      normalSquared += normal.distanceToSquared(expected) * pair.normalLength ** 2;
      count++;
    }
  return { rms: Math.sqrt(squared / count), score: (squared + (normalSquared * 2) / 3) / count };
}

/** Symmetric, pair-restricted ICP on the actual painted triangles, with mating normals. */
export function surfaceAlignment(source: Part, target: Part, operation: AssemblyOperation) {
  const pairs = buildPairs(source, target, operation);
  try {
    const sourceCenters = pairs.map((pair) => pair.source.center),
      targetCenters = pairs.map((pair) =>
        pair.target.center.clone().addScaledVector(pair.target.normal, operation.offset),
      );
    const seeds: Matrix4[] = [];
    try {
      seeds.push(rigidAlignment(sourceCenters, targetCenters).matrix);
    } catch {
      /* Surface normals can resolve a line of patch centers. */
    }
    const a: Vector3[] = [],
      b: Vector3[] = [];
    pairs.forEach((pair, i) => {
      a.push(
        sourceCenters[i],
        ...[-1, 1].map((sign) =>
          sourceCenters[i].clone().addScaledVector(pair.source.normal, sign * pair.normalLength),
        ),
      );
      b.push(
        targetCenters[i],
        ...[-1, 1].map((sign) =>
          targetCenters[i]
            .clone()
            .addScaledVector(
              pair.target.normal,
              sign * pair.normalLength * (operation.flipNormal ? -1 : 1),
            ),
        ),
      );
    });
    try {
      seeds.push(rigidAlignment(a, b).matrix);
    } catch {
      /* Report an actionable registration error below. */
    }
    if (!seeds.length)
      throw new Error(
        'Spread your painted pairs across different areas or face directions to define a stable fit.',
      );
    let best = { matrix: seeds[0], ...metrics(pairs, seeds[0], operation) };
    for (const seed of seeds) {
      let matrix = seed;
      for (let iteration = 0; iteration < 35; iteration++) {
        const from: Vector3[] = [],
          to: Vector3[] = [];
        for (const pair of correspondences(pairs, matrix, operation.offset)) {
          // Trim only the refinement correspondences; the reported RMS includes every sample.
          const matches = pair.matches
            .sort((a, b) => a.error - b.error)
            .slice(0, Math.ceil(pair.matches.length * 0.9));
          for (const match of matches) {
            from.push(match.source.point);
            to.push(match.target.point);
            for (const sign of [-1, 1]) {
              from.push(
                match.source.point
                  .clone()
                  .addScaledVector(match.source.normal, sign * pair.normalLength),
              );
              to.push(
                match.target.point
                  .clone()
                  .addScaledVector(
                    match.target.normal,
                    sign * pair.normalLength * (operation.flipNormal ? -1 : 1),
                  ),
              );
            }
          }
        }
        const next = rigidAlignment(from, to).matrix;
        const result = metrics(pairs, next, operation);
        if (result.score < best.score) best = { matrix: next, ...result };
        const change = next.elements.reduce(
          (max, value, i) => Math.max(max, Math.abs(value - matrix.elements[i])),
          0,
        );
        matrix = next;
        if (change < 1e-6) break;
      }
    }
    return best;
  } finally {
    pairs.forEach((pair) => {
      pair.source.geometry.dispose();
      pair.target.geometry.dispose();
    });
  }
}

/** Measure the achieved, constrained placement instead of reporting an unconstrained promise. */
export function surfaceResidual(source: Part, target: Part, operation: AssemblyOperation) {
  const pairs = buildPairs(source, target, operation);
  try {
    return metrics(pairs, new Matrix4(), operation).rms;
  } finally {
    pairs.forEach((pair) => {
      pair.source.geometry.dispose();
      pair.target.geometry.dispose();
    });
  }
}
