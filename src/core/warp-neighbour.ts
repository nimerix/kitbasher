import { Box3, DoubleSide, Matrix3, Matrix4, Ray, Triangle, Vector3 } from 'three';
import type { MeshBVH } from 'three-mesh-bvh';
import { treeOf } from './clipping';
import { partMatrix } from './geometry';
import { readFace } from './surfaces';
import type { Part, SceneDocument, Vec3 } from './types';
import type { WarpOutput } from './warp-evaluate';
import type { WarpModel } from './warp-model';
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
  point: Vector3;
  normal: Vector3;
}

const local = new Vector3();
const triangle = new Triangle();
const normalMatrix = new Matrix3();
const worldTriangle = new Triangle();
const worldHit = new Vector3();
const separation = new Vector3();

const outwardRay = new Ray();

function surfaceGap(point: Vector3, hit: Hit) {
  separation.subVectors(point, hit.point);
  const depth = separation.dot(hit.normal);
  const distance = separation.length();
  if (depth >= -1e-7) return distance;
  if (separation.addScaledVector(hit.normal, -depth).lengthSq() <= 1e-12) return -distance;

  // At an edge the nearest face's plane extends beyond the mesh. A ray toward its outward
  // side must exit an actual face to count penetration. This also handles concave joins.
  const { inverse, tree } = hit.owner;
  const m = inverse.elements;
  const { x, y, z } = hit.normal;
  outwardRay.origin.copy(point).applyMatrix4(inverse);
  outwardRay.direction.set(
    m[0] * x + m[4] * y + m[8] * z,
    m[1] * x + m[5] * y + m[9] * z,
    m[2] * x + m[6] * y + m[10] * z,
  );
  const localDistance = outwardRay.direction.length();
  outwardRay.direction.multiplyScalar(1 / localDistance);
  const exit = tree.raycastFirst(outwardRay, DoubleSide, 0, warpNeighbourRange * localDistance);
  return exit?.face && exit.face.normal.dot(outwardRay.direction) > 0 ? -distance : distance;
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

function closestHit(point: Vector3, neighbours: WarpNeighbour[]): Hit | null {
  const closest: { owner: WarpNeighbour | null; face: number } = { owner: null, face: 0 };
  let bestSquared = warpNeighbourRange ** 2;
  const nearest = new Vector3();
  for (const n of neighbours) {
    const [sx, sy, sz] = n.part.scale.map(Math.abs);
    const [qx, qy, qz, qw] = n.part.quaternion;
    const unit = Math.abs(qx * qx + qy * qy + qz * qz + qw * qw - 1) < 1e-15;
    if (sx === sy && sx === sz && unit) {
      local.copy(point).applyMatrix4(n.inverse);
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
    // Evaluate both bounds and candidates in world space. This accounts for anisotropic
    // scales and the actual linear transform of imported, approximately unit quaternions.
    const m = n.matrix.elements;
    const px = point.x - m[12],
      py = point.y - m[13],
      pz = point.z - m[14];
    n.tree.shapecast({
      boundsTraverseOrder: (box) => worldBoundsDistanceSquared(box, m, px, py, pz),
      intersectsBounds: (_box, _leaf, score) => score! <= bestSquared,
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
  return { owner, point: nearest, normal };
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
    if (grid.fixed[n]) continue;
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

/** Gaps of the region's vertices that face a neighbour in range, as `closeGapTargets` counts them. */
export function* seamMeasurement(
  model: WarpModel,
  out: WarpOutput,
  neighbours: WarpNeighbour[],
): Generator<void, SeamReport | null> {
  const { region, matrix } = model;
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
    if (region.role[v] === WarpRole.Outside || first[v] < 0) continue;
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
