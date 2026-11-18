import { Box3, Matrix3, Matrix4, Triangle, Vector3 } from 'three';
import type { MeshBVH } from 'three-mesh-bvh';
import { treeOf } from './clipping';
import { partMatrix } from './geometry';
import { readFace } from './surfaces';
import type { Part, SceneDocument, Vec3 } from './types';
import type { WarpOutput } from './warp-evaluate';
import { isPaintedNode, type WarpModel } from './warp-model';
import { WarpRole, type WarpRegion } from './warp-region';
import { writeRotation, type WarpState } from './warp-solve';

export const warpNeighbourRange = 5;
/**
 * A surface faces a neighbour when its normal is within 60° of directly opposing the neighbour's
 * outward normal. Mating scan surfaces roughly oppose; a side wall leaning toward the neighbour
 * runs alongside it and is neither pulled into it nor reported as a gap.
 */
export const warpFacingCosine = 0.5;

export interface WarpNeighbour {
  part: Part;
  tree: MeshBVH;
  matrix: Matrix4;
  inverse: Matrix4;
}

export function warpNeighbours(
  scene: SceneDocument,
  partId: string,
  bounds: Box3,
): { neighbours: WarpNeighbour[]; indexing: string[] } {
  const near = bounds.clone().expandByScalar(warpNeighbourRange);
  const neighbours: WarpNeighbour[] = [];
  const indexing: string[] = [];
  for (const part of scene.parts) {
    if (part.id === partId || !part.visible) continue;
    const matrix = partMatrix(part);
    if (!part.geometry.boundingBox) part.geometry.computeBoundingBox();
    const box = part.geometry.boundingBox;
    if (!box || !box.clone().applyMatrix4(matrix).intersectsBox(near)) continue;
    const tree = treeOf(part.geometry);
    if (!tree) {
      indexing.push(part.name);
      continue;
    }
    neighbours.push({ part, tree, matrix, inverse: matrix.clone().invert() });
  }
  return { neighbours, indexing };
}

interface Hit {
  owner: WarpNeighbour;
  face: number;
  point: Vector3;
  normal: Vector3;
}

const local = new Vector3();
const triangle = new Triangle();
const normalMatrix = new Matrix3();
const worldTriangle = new Triangle();
const worldHit = new Vector3();
const separation = new Vector3();

const featureTolerance = 1e-5;
const featureToleranceSquared = featureTolerance ** 2;
const barycentric = new Vector3();
const cornerNormal = new Vector3();
const featureNormal = new Vector3();
const linear = new Matrix3();
const edgeA = new Vector3();
const edgeB = new Vector3();

const sameVertex = (a: Vector3, b: Vector3) => a.distanceToSquared(b) <= featureToleranceSquared;

/** The signed side of a shared edge or a closed vertex fan. Open boundaries have no inside. */
function featureSide(hit: Hit, difference: Vector3, faceSide: number) {
  const { owner } = hit;
  local.copy(hit.point).applyMatrix4(owner.inverse);
  readFace(owner.part.geometry, hit.face, triangle);
  const weights = triangle.getBarycoord(local, barycentric);
  if (!weights) return faceSide;
  const feature = [triangle.a, triangle.b, triangle.c].filter(
    (_, i) => weights.getComponent(i) > 1e-7,
  );
  if (feature.length === 3) return faceSide;
  const [first, second] = feature;
  if (!first) return 0;

  featureNormal.set(0, 0, 0);
  normalMatrix.getNormalMatrix(owner.matrix);
  linear.setFromMatrix4(owner.matrix);
  let faces = 0;
  let edgeDirection = 0;
  const vertexEdges: { point: Vector3; count: number; direction: number }[] = [];
  const addEdge = (point: Vector3, direction: number) => {
    let edge = vertexEdges.find((entry) => sameVertex(entry.point, point));
    if (!edge) vertexEdges.push((edge = { point: point.clone(), count: 0, direction: 0 }));
    edge.count++;
    edge.direction += direction;
  };
  owner.tree.shapecast({
    intersectsBounds: (box) => box.distanceToPoint(local) <= featureTolerance,
    intersectsTriangle: (tri) => {
      const corners = [tri.a, tri.b, tri.c];
      const i = corners.findIndex((p) => sameVertex(p, first));
      if (i < 0) return false;
      const next = corners[(i + 1) % 3],
        prev = corners[(i + 2) % 3];
      let weight = 1;
      if (second) {
        // The two incident faces must traverse the shared edge in opposite directions.
        if (sameVertex(next, second)) edgeDirection++;
        else if (sameVertex(prev, second)) edgeDirection--;
        else return false;
      } else {
        addEdge(next, 1);
        addEdge(prev, -1);
        edgeA.subVectors(next, corners[i]).applyMatrix3(linear);
        edgeB.subVectors(prev, corners[i]).applyMatrix3(linear);
        weight = edgeA.angleTo(edgeB);
      }
      faces++;
      tri.getNormal(cornerNormal).applyMatrix3(normalMatrix).normalize();
      featureNormal.addScaledVector(cornerNormal, weight);
      return false;
    },
  });
  const shared = second
    ? faces === 2 && edgeDirection === 0
    : faces >= 3 && vertexEdges.every(({ count, direction }) => count === 2 && direction === 0);
  return shared ? featureNormal.normalize().dot(difference) : 0;
}

function surfaceGap(point: Vector3, hit: Hit) {
  separation.subVectors(point, hit.point);
  const depth = separation.dot(hit.normal);
  const distanceSquared = separation.lengthSq();
  const side = distanceSquared - depth ** 2 <= 1e-12 ? depth : featureSide(hit, separation, depth);
  return (side < -1e-7 ? -1 : 1) * Math.sqrt(distanceSquared);
}

/** Squared distance to a world AABB enclosing the affine image of a local BVH box. */
function worldBoundsDistanceSquared(box: Box3, m: number[], px: number, py: number, pz: number) {
  const x = (box.min.x + box.max.x) / 2,
    hx = box.max.x - x;
  const y = (box.min.y + box.max.y) / 2,
    hy = box.max.y - y;
  const z = (box.min.z + box.max.z) / 2,
    hz = box.max.z - z;
  const dx = Math.max(
    0,
    Math.abs(px - (m[0] * x + m[4] * y + m[8] * z)) -
      (Math.abs(m[0]) * hx + Math.abs(m[4]) * hy + Math.abs(m[8]) * hz),
  );
  const dy = Math.max(
    0,
    Math.abs(py - (m[1] * x + m[5] * y + m[9] * z)) -
      (Math.abs(m[1]) * hx + Math.abs(m[5]) * hy + Math.abs(m[9]) * hz),
  );
  const dz = Math.max(
    0,
    Math.abs(pz - (m[2] * x + m[6] * y + m[10] * z)) -
      (Math.abs(m[2]) * hx + Math.abs(m[6]) * hy + Math.abs(m[10]) * hz),
  );
  return dx * dx + dy * dy + dz * dz;
}

/** Orthogonal transform axes make this exact even for a rotated, non-uniformly scaled box. */
function scaledBoundsDistanceSquared(
  box: Box3,
  point: Vector3,
  sx: number,
  sy: number,
  sz: number,
) {
  const dx = sx * Math.max(0, box.min.x - point.x, point.x - box.max.x);
  const dy = sy * Math.max(0, box.min.y - point.y, point.y - box.max.y);
  const dz = sz * Math.max(0, box.min.z - point.z, point.z - box.max.z);
  return dx * dx + dy * dy + dz * dz;
}

function closestHit(point: Vector3, neighbours: WarpNeighbour[]): Hit | null {
  const closest: { owner: WarpNeighbour | null; face: number } = { owner: null, face: 0 };
  let bestSquared = warpNeighbourRange ** 2;
  const nearest = new Vector3();
  for (const n of neighbours) {
    const [sx, sy, sz] = n.part.scale.map(Math.abs);
    const [qx, qy, qz, qw] = n.part.quaternion;
    const unit = Math.abs(qx * qx + qy * qy + qz * qz + qw * qw - 1) < 1e-15;
    if (unit) local.copy(point).applyMatrix4(n.inverse);
    if (sx === sy && sx === sz && unit) {
      const hit = n.tree.closestPointToPoint(
        local,
        undefined,
        0,
        (Math.sqrt(bestSquared) + 1e-12) / sx,
      );
      if (!hit) continue;
      const world = hit.point.applyMatrix4(n.matrix);
      const distanceSquared = world.distanceToSquared(point);
      if (distanceSquared > bestSquared) continue;
      bestSquared = distanceSquared;
      closest.owner = n;
      closest.face = hit.faceIndex;
      nearest.copy(world);
      continue;
    }
    // For orthogonal axes, use distances along the scaled axes. For a more general affine
    // transform, bound with the enclosing world AABB and test exact triangle distances.
    const m = n.matrix.elements;
    const px = point.x - m[12],
      py = point.y - m[13],
      pz = point.z - m[14];
    n.tree.shapecast({
      boundsTraverseOrder: unit
        ? (box) => scaledBoundsDistanceSquared(box, local, sx, sy, sz)
        : (box) => worldBoundsDistanceSquared(box, m, px, py, pz),
      intersectsBounds: (_box, _leaf, score) => score! <= bestSquared + 1e-10,
      intersectsTriangle: (tri, index) => {
        worldTriangle.a.copy(tri.a).applyMatrix4(n.matrix);
        worldTriangle.b.copy(tri.b).applyMatrix4(n.matrix);
        worldTriangle.c.copy(tri.c).applyMatrix4(n.matrix);
        worldTriangle.closestPointToPoint(point, worldHit);
        const distanceSquared = worldHit.distanceToSquared(point);
        if (distanceSquared <= bestSquared) {
          bestSquared = distanceSquared;
          closest.owner = n;
          closest.face = index;
          nearest.copy(worldHit);
        }
        return distanceSquared === 0;
      },
    });
  }
  const { owner, face } = closest;
  if (!owner) return null;
  const normal = readFace(owner.part.geometry, face, triangle).getNormal(new Vector3());
  normal.applyMatrix3(normalMatrix.getNormalMatrix(owner.matrix)).normalize();
  return { owner, face, point: nearest, normal };
}

/** Closest neighbour surface point within range, pushed `overlap` inside along its outward normal. */
export function snapToNeighbour(
  point: Vector3,
  neighbours: WarpNeighbour[],
  overlap: number,
): Vector3 | null {
  const hit = closestHit(point, neighbours);
  return hit ? hit.point.addScaledVector(hit.normal, -overlap) : null;
}

const restNormals = new WeakMap<WarpModel, Float64Array>();

function restNormalsOf(model: WarpModel) {
  let normals = restNormals.get(model);
  if (normals) return normals;
  const { region, grid, restWorld } = model;
  const sums = new Float64Array(region.weldedCount * 3);
  const { triangles } = region;
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t] * 3,
      b = triangles[t + 1] * 3,
      c = triangles[t + 2] * 3;
    const ux = restWorld[b] - restWorld[a],
      uy = restWorld[b + 1] - restWorld[a + 1],
      uz = restWorld[b + 2] - restWorld[a + 2];
    const vx = restWorld[c] - restWorld[a],
      vy = restWorld[c + 1] - restWorld[a + 1],
      vz = restWorld[c + 2] - restWorld[a + 2];
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    for (const o of [a, b, c]) {
      sums[o] += nx;
      sums[o + 1] += ny;
      sums[o + 2] += nz;
    }
  }
  const m = model.matrix;
  const det =
    m[0] * (m[5] * m[10] - m[9] * m[6]) -
    m[4] * (m[1] * m[10] - m[9] * m[2]) +
    m[8] * (m[1] * m[6] - m[5] * m[2]);
  // A mirrored part has reversed world winding, which flips the cross products.
  const sign = det < 0 ? -1 : 1;
  normals = new Float64Array(grid.nodes.length * 3);
  for (let n = 0; n < grid.nodes.length; n++) {
    const o = grid.nodes[n] * 3;
    const length = Math.hypot(sums[o], sums[o + 1], sums[o + 2]) || 1;
    for (let a = 0; a < 3; a++) normals[n * 3 + a] = (sign * sums[o + a]) / length;
  }
  restNormals.set(model, normals);
  return normals;
}

export function closeGapTargets(
  model: WarpModel,
  state: WarpState,
  neighbours: WarpNeighbour[],
  overlap: number,
): { node: number; target: Vec3 }[] {
  const { grid } = model;
  const normals = restNormalsOf(model);
  const rotation = new Float64Array(9);
  const point = new Vector3();
  const result: { node: number; target: Vec3 }[] = [];
  for (let n = 0; n < grid.nodes.length; n++) {
    // A feather band carries the bend to the outer border, so only painted nodes are pulled.
    if (grid.fixed[n] || !isPaintedNode(model, n)) continue;
    point.fromArray(state.positions, n * 3);
    const hit = closestHit(point, neighbours);
    if (!hit) continue;
    writeRotation(
      rotation,
      0,
      state.rotations[n * 4],
      state.rotations[n * 4 + 1],
      state.rotations[n * 4 + 2],
      state.rotations[n * 4 + 3],
    );
    const x = normals[n * 3],
      y = normals[n * 3 + 1],
      z = normals[n * 3 + 2];
    const facing =
      (rotation[0] * x + rotation[1] * y + rotation[2] * z) * hit.normal.x +
      (rotation[3] * x + rotation[4] * y + rotation[5] * z) * hit.normal.y +
      (rotation[6] * x + rotation[7] * y + rotation[8] * z) * hit.normal.z;
    if (facing >= -warpFacingCosine || surfaceGap(point, hit) <= -overlap) continue;
    result.push({ node: n, target: hit.point.addScaledVector(hit.normal, -overlap).toArray() });
  }
  return result;
}

export interface SeamReport {
  largestGap: number;
  vertices: Uint32Array;
  gaps: Float32Array;
}

/**
 * Area-weighted normal of each welded region vertex on the deformed surface, in mesh-local space.
 * Welded, so duplicates along split normals or in unindexed scans share one.
 */
function* deformedNormals(region: WarpRegion, positions: Float32Array, first: Int32Array) {
  const normals = new Float32Array(region.weldedCount * 3);
  const { triangles } = region;
  for (let t = 0; t < triangles.length; t += 3) {
    if (t % 3072 === 0) yield;
    const a = first[triangles[t]] * 3,
      b = first[triangles[t + 1]] * 3,
      c = first[triangles[t + 2]] * 3;
    const ux = positions[b] - positions[a],
      uy = positions[b + 1] - positions[a + 1],
      uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a],
      vy = positions[c + 1] - positions[a + 1],
      vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    for (let k = 0; k < 3; k++) {
      const o = triangles[t + k] * 3;
      normals[o] += nx;
      normals[o + 1] += ny;
      normals[o + 2] += nz;
    }
  }
  return normals;
}

/**
 * Gaps of the region's painted vertices that face a neighbour in range, as `closeGapTargets`
 * counts them. A feather band is not measured, since Close gap does not pull it.
 */
export function* seamMeasurement(
  model: WarpModel,
  out: WarpOutput,
  neighbours: WarpNeighbour[],
): Generator<void, SeamReport | null> {
  const { region, matrix, blend } = model;
  const m = new Matrix4().fromArray(matrix);
  const first = new Int32Array(region.weldedCount).fill(-1);
  for (let g = 0; g < region.weldOf.length; g++) {
    if ((g & 4095) === 0) yield;
    const w = region.weldOf[g];
    if (w !== 0xffffffff && first[w] < 0) first[w] = g;
  }
  const normals = yield* deformedNormals(region, out.positions, first);
  // Local normals go to world by the normal matrix, which also turns them out on mirrored parts.
  const toWorld = new Matrix3().getNormalMatrix(m);
  const vertices: number[] = [];
  const gaps: number[] = [];
  const point = new Vector3(),
    normal = new Vector3();
  let largest = -Infinity;
  for (let v = 0; v < region.weldedCount; v++) {
    if (region.role[v] === WarpRole.Outside || first[v] < 0 || (blend && blend[v] !== 1)) continue;
    yield;
    point.fromArray(out.positions, first[v] * 3).applyMatrix4(m);
    const hit = closestHit(point, neighbours);
    if (!hit) continue;
    // Surface beside the seam, such as a side face running up to the wall, is not part of it.
    normal
      .fromArray(normals, v * 3)
      .applyMatrix3(toWorld)
      .normalize();
    if (normal.dot(hit.normal) >= -warpFacingCosine) continue;
    const d = surfaceGap(point, hit);
    vertices.push(v);
    gaps.push(d);
    if (d > largest) largest = d;
  }
  if (!vertices.length) return null;
  return {
    largestGap: largest,
    vertices: Uint32Array.from(vertices),
    gaps: Float32Array.from(gaps),
  };
}

export function measureSeam(model: WarpModel, out: WarpOutput, neighbours: WarpNeighbour[]) {
  const measurement = seamMeasurement(model, out, neighbours);
  let result = measurement.next();
  while (!result.done) result = measurement.next();
  return result.value;
}
