import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  Euler,
  Matrix3,
  Matrix4,
  Quaternion,
  Vector3,
} from 'three';
import { Matrix, SingularValueDecomposition } from 'ml-matrix';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type {
  AssemblyOperation,
  Part,
  Quat,
  SerializedGeometry,
  SurfacePoint,
  Vec3,
} from './types';

export const uid = () => crypto.randomUUID();
export const radians = (value: number) => (value * Math.PI) / 180;
export const degrees = (value: number) => (value * 180) / Math.PI;
export const vec = (value: Vec3) => new Vector3(...value);
export const quat = (value: Quat) => new Quaternion(...value);
export const partMatrix = (part: Part) =>
  new Matrix4().compose(vec(part.position), quat(part.quaternion), vec(part.scale));

export function transformFromMatrix(part: Part, matrix: Matrix4): Part {
  const position = new Vector3(),
    quaternion = new Quaternion(),
    scale = new Vector3();
  matrix.decompose(position, quaternion, scale);
  return {
    ...part,
    position: position.toArray(),
    quaternion: quaternion.toArray(),
    scale: scale.toArray(),
  };
}

/** A connected anchor takes priority over a custom pivot, then the visible mesh center. */
export function partPivot(part: Part, localAnchor?: Vec3): Vector3 {
  const localPivot = localAnchor ?? part.pivot;
  if (localPivot) return vec(localPivot).applyMatrix4(partMatrix(part));
  if (!part.geometry.boundingBox) part.geometry.computeBoundingBox();
  return part.geometry.boundingBox!.getCenter(new Vector3()).applyMatrix4(partMatrix(part));
}

export function poseAtPivot(
  part: Part,
  patch: Pick<Partial<Part>, 'quaternion' | 'scale'>,
  localAnchor?: Vec3,
): Part {
  const pivot = partPivot(part, localAnchor);
  const localPivot = pivot.clone().applyMatrix4(partMatrix(part).invert());
  const next = { ...part, ...patch };
  next.position = pivot
    .sub(localPivot.multiply(vec(next.scale)).applyQuaternion(quat(next.quaternion)))
    .toArray();
  return next;
}

export function worldPoint(part: Part, surface: SurfacePoint): Vector3 {
  return vec(surface.point).applyMatrix4(partMatrix(part));
}

export function worldNormal(part: Part, surface: SurfacePoint): Vector3 {
  return vec(surface.normal)
    .applyMatrix3(new Matrix3().getNormalMatrix(partMatrix(part)))
    .normalize();
}

export function triangleCount(geometry: BufferGeometry) {
  return (geometry.index?.count ?? geometry.getAttribute('position').count) / 3;
}

export function sceneBounds(parts: Part[]): Box3 {
  const bounds = new Box3();
  for (const part of parts.filter((p) => p.visible)) {
    if (!part.geometry.boundingBox) part.geometry.computeBoundingBox();
    bounds.union(part.geometry.boundingBox!.clone().applyMatrix4(partMatrix(part)));
  }
  return bounds.isEmpty() ? new Box3(new Vector3(-30, 0, -30), new Vector3(30, 80, 30)) : bounds;
}

export function serializeGeometry(geometry: BufferGeometry): SerializedGeometry {
  const position = geometry.getAttribute('position');
  const color = geometry.getAttribute('color');
  const positions: number[] = [],
    colors: number[] = [];
  for (let i = 0; i < position.count; i++)
    positions.push(position.getX(i), position.getY(i), position.getZ(i));
  if (color)
    for (let i = 0; i < color.count; i++) colors.push(color.getX(i), color.getY(i), color.getZ(i));
  return {
    positions,
    indices: geometry.index ? Array.from(geometry.index.array) : undefined,
    colors: color ? colors : undefined,
  };
}

export function deserializeGeometry(data: SerializedGeometry): BufferGeometry {
  if (
    !Array.isArray(data.positions) ||
    data.positions.length < 9 ||
    data.positions.length % 3 !== 0 ||
    !data.positions.every(Number.isFinite)
  ) {
    throw new Error('The mesh has invalid vertex positions.');
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(data.positions), 3));
  if (data.indices) {
    if (
      data.indices.length % 3 ||
      data.indices.some((i) => !Number.isInteger(i) || i < 0 || i >= data.positions.length / 3)
    )
      throw new Error('The mesh has invalid triangle indices.');
    geometry.setIndex(data.indices);
  } else if (data.positions.length % 9) throw new Error('The mesh has incomplete triangles.');
  if (data.colors) {
    if (data.colors.length !== data.positions.length || !data.colors.every(Number.isFinite))
      throw new Error('The mesh has invalid vertex colors.');
    geometry.setAttribute('color', new BufferAttribute(new Float32Array(data.colors), 3));
  }
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Least-squares rigid registration (Kabsch); reflects neither shape nor scale. */
export function rigidAlignment(source: Vector3[], target: Vector3[]) {
  if (source.length !== target.length || source.length < 3)
    throw new Error('Pick at least three matching point pairs.');
  const centroid = (points: Vector3[]) =>
    points.reduce((sum, p) => sum.add(p), new Vector3()).multiplyScalar(1 / points.length);
  const aCenter = centroid(source),
    bCenter = centroid(target);
  const a = source.map((p) => p.clone().sub(aCenter)),
    b = target.map((p) => p.clone().sub(bCenter));
  const h = new Matrix(3, 3);
  for (let i = 0; i < a.length; i++)
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) {
        h.set(r, c, h.get(r, c) + a[i].getComponent(r) * b[i].getComponent(c));
      }
  const svd = new SingularValueDecomposition(h, { autoTranspose: true });
  if (svd.diagonal[1] < Math.max(svd.diagonal[0], 1) * 1e-8)
    throw new Error('Points are on one line or too close together. Pick a wider triangle.');
  const u = svd.leftSingularVectors,
    v = svd.rightSingularVectors;
  let rotation = v.mmul(u.transpose());
  const asMatrix4 = (m: Matrix) =>
    new Matrix4().set(
      m.get(0, 0),
      m.get(0, 1),
      m.get(0, 2),
      0,
      m.get(1, 0),
      m.get(1, 1),
      m.get(1, 2),
      0,
      m.get(2, 0),
      m.get(2, 1),
      m.get(2, 2),
      0,
      0,
      0,
      0,
      1,
    );
  if (asMatrix4(rotation).determinant() < 0) {
    for (let r = 0; r < 3; r++) v.set(r, 2, -v.get(r, 2));
    rotation = v.mmul(u.transpose());
  }
  const matrix = asMatrix4(rotation);
  matrix.setPosition(bCenter.clone().sub(aCenter.clone().applyMatrix4(matrix)));
  const rms = Math.sqrt(
    source.reduce(
      (sum, p, i) => sum + p.clone().applyMatrix4(matrix).distanceToSquared(target[i]),
      0,
    ) / source.length,
  );
  return { matrix, rms };
}

export function alignmentTransform(source: Part, target: Part, operation: AssemblyOperation) {
  const { pairs, mode } = operation;
  if (!pairs.length) throw new Error('Pick a point on each part first.');
  if (mode === 'multi') {
    return rigidAlignment(
      pairs.map((p) => worldPoint(source, p.source)),
      pairs.map((p) => worldPoint(target, p.target)),
    );
  }
  const pair = pairs[0];
  const from = worldPoint(source, pair.source),
    to = worldPoint(target, pair.target);
  const normal = worldNormal(target, pair.target);
  to.addScaledVector(normal, operation.offset);
  const matrix = new Matrix4();
  if (mode === 'plane') {
    const rotation = new Quaternion().setFromUnitVectors(
      worldNormal(source, pair.source),
      normal.clone().multiplyScalar(operation.flipNormal ? -1 : 1),
    );
    matrix.makeRotationFromQuaternion(rotation);
    matrix.setPosition(to.clone().sub(from.clone().applyMatrix4(matrix)));
  } else if (mode === 'point-plane') {
    matrix.makeTranslation(normal.multiplyScalar(to.clone().sub(from).dot(normal)));
  } else matrix.makeTranslation(to.sub(from));
  return { matrix, rms: 0 };
}

export function bakedPartGeometry(part: Part) {
  const geometry = (
    part.geometry.index ? part.geometry.toNonIndexed() : part.geometry.clone()
  ).applyMatrix4(partMatrix(part));
  if (part.scale[0] * part.scale[1] * part.scale[2] < 0) {
    // A baked reflection needs its triangle winding reversed as well.
    for (const attribute of Object.values(geometry.attributes)) {
      for (let i = 0; i < attribute.count; i += 3)
        for (let component = 0; component < attribute.itemSize; component++) {
          const a = attribute.getComponent(i + 1, component);
          attribute.setComponent(i + 1, component, attribute.getComponent(i + 2, component));
          attribute.setComponent(i + 2, component, a);
        }
    }
  }
  const tint = new Color(part.color),
    count = geometry.getAttribute('position').count,
    original = geometry.getAttribute('color'),
    colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = (original?.getX(i) ?? 1) * tint.r;
    colors[i * 3 + 1] = (original?.getY(i) ?? 1) * tint.g;
    colors[i * 3 + 2] = (original?.getZ(i) ?? 1) * tint.b;
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  for (const name of Object.keys(geometry.attributes))
    if (!['position', 'normal', 'color'].includes(name)) geometry.deleteAttribute(name);
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
  geometry.clearGroups();
  return geometry;
}

export function combineParts(parts: Part[]): BufferGeometry {
  const geometries = parts.map(bakedPartGeometry);
  const combined = mergeGeometries(geometries);
  geometries.forEach((g) => g.dispose());
  if (!combined) throw new Error('These mesh attributes could not be combined.');
  combined.computeVertexNormals();
  return combined;
}

export function rotationDegrees(part: Part): Vec3 {
  const rotation = new Euler().setFromQuaternion(quat(part.quaternion), 'XYZ');
  return [degrees(rotation.x), degrees(rotation.y), degrees(rotation.z)];
}
