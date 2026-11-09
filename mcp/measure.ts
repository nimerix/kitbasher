import { Box3, BufferGeometry, Triangle, Vector3 } from 'three';
import { computeBoundsTree } from 'three-mesh-bvh';
import type { MeshBVH } from 'three-mesh-bvh';
import { binaryGeometry, partMatrix } from '../src/core/geometry';
import { readFace } from '../src/core/surfaces';
import type { Part, Vec3 } from '../src/core/types';

/** Exact world bounds. Transforming a local box would overstate a rotated part. */
export function worldBounds(part: Part): Box3 {
  const values = binaryGeometry(part.geometry).positions;
  const e = partMatrix(part).elements;
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < values.length; i += 3) {
    const x = values[i],
      y = values[i + 1],
      z = values[i + 2];
    const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
    const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
    const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
    if (wx < minX) minX = wx;
    if (wx > maxX) maxX = wx;
    if (wy < minY) minY = wy;
    if (wy > maxY) maxY = wy;
    if (wz < minZ) minZ = wz;
    if (wz > maxZ) maxZ = wz;
  }
  return new Box3(new Vector3(minX, minY, minZ), new Vector3(maxX, maxY, maxZ));
}

export function unionBounds(parts: Part[]) {
  const bounds = new Box3();
  for (const part of parts) bounds.union(worldBounds(part));
  return bounds;
}

export function ensureBvh(geometry: BufferGeometry) {
  if (!geometry.boundsTree)
    computeBoundsTree.call(geometry, { indirect: true, targetLeafSize: 10 });
  return geometry.boundsTree as MeshBVH;
}

/** The surface nearest a local point, with its face and outward normal. */
export function closestSurface(part: Part, local: Vec3) {
  const hit = { point: new Vector3(), distance: 0, faceIndex: 0 };
  ensureBvh(part.geometry).closestPointToPoint(new Vector3(...local), hit);
  const normal = readFace(part.geometry, hit.faceIndex, new Triangle()).getNormal(new Vector3());
  return { point: hit.point.toArray(), normal: normal.toArray(), face: hit.faceIndex };
}
