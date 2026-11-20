import type { BufferGeometry } from 'three';
import { weldedPositionIndex } from '../../src/core/mesh-topology';
import type { Vec3 } from '../../src/core/types';

function corner(geometry: BufferGeometry, triangle: number, k: number) {
  const vertex = geometry.index ? geometry.index.getX(triangle * 3 + k) : triangle * 3 + k;
  const position = geometry.getAttribute('position');
  return [position.getX(vertex), position.getY(vertex), position.getZ(vertex)];
}

/** Median length of every triangle edge. */
export function medianEdge(geometry: BufferGeometry) {
  const triangles = (geometry.index?.count ?? geometry.getAttribute('position').count) / 3;
  const lengths = new Float64Array(triangles * 3);
  for (let t = 0; t < triangles; t++)
    for (let k = 0; k < 3; k++) {
      const a = corner(geometry, t, k),
        b = corner(geometry, t, (k + 1) % 3);
      lengths[t * 3 + k] = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    }
  lengths.sort();
  return lengths[Math.floor(lengths.length / 2)];
}

/** Farthest any vertex lies from the surface of the box centred on the origin with `half`. */
export function maxBoxDistance(geometry: BufferGeometry, half: Vec3) {
  const position = geometry.getAttribute('position');
  let farthest = 0;
  for (let i = 0; i < position.count; i++) {
    const d = [position.getX(i), position.getY(i), position.getZ(i)].map(
      (value, axis) => Math.abs(value) - half[axis],
    );
    const outside = Math.hypot(...d.map((value) => Math.max(value, 0)));
    const distance = outside > 0 ? outside : -Math.max(...d);
    farthest = Math.max(farthest, distance);
  }
  return farthest;
}

/** Distance from the origin of each welded vertex. */
export function radii(geometry: BufferGeometry) {
  const position = geometry.getAttribute('position');
  const { indices, vertices } = weldedPositionIndex(geometry);
  const result = new Array<number>(vertices);
  for (let i = 0; i < indices.length; i++) {
    const vertex = geometry.index ? geometry.index.getX(i) : i;
    result[indices[i]] ??= Math.hypot(
      position.getX(vertex),
      position.getY(vertex),
      position.getZ(vertex),
    );
  }
  return result;
}
