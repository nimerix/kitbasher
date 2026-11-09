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
  BinaryGeometry,
  Part,
  Quat,
  SerializedGeometry,
  SurfacePoint,
  Vec3,
} from './types';

/** randomUUID needs a secure context; plain-HTTP LAN hosts still offer getRandomValues. */
export const uid = () =>
  crypto.randomUUID?.() ??
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
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

// Chrome rejects a larger WebGL buffer with a console error, and the mesh silently does not draw.
export const maxBufferBytes = 2 ** 31 - 1;
export const drawLimit =
  'One mesh can use at most 2 GB per GPU buffer, about 59 million triangles in STL or OBJ.';

export function exceedsDrawLimit(geometry: BufferGeometry) {
  return [geometry.index, ...Object.values(geometry.attributes)].some(
    (attribute) => attribute && attribute.array.byteLength > maxBufferBytes,
  );
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

function vectorList(geometry: BufferGeometry, name: string, digits: number) {
  const attribute = geometry.getAttribute(name);
  if (!attribute) return undefined;
  const values: number[] = [];
  for (let i = 0; i < attribute.count; i++)
    values.push(
      Number(attribute.getX(i).toPrecision(digits)),
      Number(attribute.getY(i).toPrecision(digits)),
      Number(attribute.getZ(i).toPrecision(digits)),
    );
  return values;
}

export function serializeGeometry(geometry: BufferGeometry): SerializedGeometry {
  return {
    // Nine significant digits restore every Float32 value exactly and shrink scene files.
    positions: vectorList(geometry, 'position', 9)!,
    indices: geometry.index ? Array.from(geometry.index.array) : undefined,
    colors: vectorList(geometry, 'color', 9),
    // Normals only affect shading, and six digits are far below a visible difference.
    normals: vectorList(geometry, 'normal', 6),
  };
}

function vectorArray(geometry: BufferGeometry, name: string) {
  const attribute = geometry.getAttribute(name);
  if (!attribute) return undefined;
  if (
    attribute instanceof BufferAttribute &&
    attribute.itemSize === 3 &&
    attribute.array instanceof Float32Array
  )
    return attribute.array;
  const values = new Float32Array(attribute.count * 3);
  for (let i = 0; i < attribute.count; i++) {
    values[i * 3] = attribute.getX(i);
    values[i * 3 + 1] = attribute.getY(i);
    values[i * 3 + 2] = attribute.getZ(i);
  }
  return values;
}

/** Shares the live buffers, which never change once a mesh is in a scene. */
export function binaryGeometry(geometry: BufferGeometry): BinaryGeometry {
  return {
    positions: vectorArray(geometry, 'position')!,
    indices: geometry.index?.array as BinaryGeometry['indices'],
    colors: vectorArray(geometry, 'color'),
    normals: vectorArray(geometry, 'normal'),
  };
}

const isNumberList = (value: unknown): value is ArrayLike<number> =>
  Array.isArray(value) || (ArrayBuffer.isView(value) && !(value instanceof DataView));

function allFinite(values: ArrayLike<number>) {
  for (let i = 0; i < values.length; i++) if (!Number.isFinite(values[i])) return false;
  return true;
}

const floatAttribute = (values: ArrayLike<number>) =>
  new BufferAttribute(values instanceof Float32Array ? values : new Float32Array(values), 3);

export function deserializeGeometry(data: SerializedGeometry | BinaryGeometry): BufferGeometry {
  const positions = data?.positions as ArrayLike<number> | undefined;
  if (
    !isNumberList(positions) ||
    positions.length < 9 ||
    positions.length % 3 !== 0 ||
    !allFinite(positions)
  ) {
    throw new Error('The mesh has invalid vertex positions.');
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', floatAttribute(positions));
  const vertexCount = positions.length / 3;
  if (data.indices) {
    const indices: ArrayLike<number> = data.indices;
    let valid = isNumberList(indices) && indices.length % 3 === 0;
    for (let i = 0; valid && i < indices.length; i++)
      valid = Number.isInteger(indices[i]) && indices[i] >= 0 && indices[i] < vertexCount;
    if (!valid) throw new Error('The mesh has invalid triangle indices.');
    geometry.setIndex(
      new BufferAttribute(
        indices instanceof Uint16Array || indices instanceof Uint32Array
          ? indices
          : vertexCount > 65535
            ? new Uint32Array(indices)
            : new Uint16Array(indices),
        1,
      ),
    );
  } else if (positions.length % 9) throw new Error('The mesh has incomplete triangles.');
  for (const [name, values] of [
    ['color', data.colors],
    ['normal', data.normals],
  ] as const) {
    if (!values) continue;
    if (!isNumberList(values) || values.length !== positions.length || !allFinite(values))
      throw new Error(`The mesh has invalid vertex ${name}s.`);
    geometry.setAttribute(name, floatAttribute(values));
  }
  // Scenes saved before normals were stored fall back to computed shading.
  if (!data.normals) geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Least-squares rigid registration (Kabsch); reflects neither shape nor scale. */
export function rigidAlignment(source: Vector3[], target: Vector3[], stabilize = false) {
  if (source.length !== target.length || source.length < (stabilize ? 1 : 3))
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
  // A tiny preference for the current orientation resolves free twist for one,
  // two, or collinear anchors without introducing arbitrary SVD rotations.
  if (stabilize) {
    const bias = Math.max(...h.to1DArray().map(Math.abs), 1e-12) * 1e-10;
    for (let i = 0; i < 3; i++) h.set(i, i, h.get(i, i) + bias);
  }
  const svd = new SingularValueDecomposition(h, { autoTranspose: true });
  if (!stabilize && svd.diagonal[1] < Math.max(svd.diagonal[0], 1) * 1e-8)
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

export const isMirrored = (part: Part) => part.scale[0] * part.scale[1] * part.scale[2] < 0;

export function bakedPartGeometry(part: Part) {
  const geometry = (
    part.geometry.index ? part.geometry.toNonIndexed() : part.geometry.clone()
  ).applyMatrix4(partMatrix(part));
  if (isMirrored(part)) {
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
  return combined;
}

export function rotationDegrees(part: Part): Vec3 {
  const rotation = new Euler().setFromQuaternion(quat(part.quaternion), 'XYZ');
  return [degrees(rotation.x), degrees(rotation.y), degrees(rotation.z)];
}
