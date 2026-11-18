import { BoxGeometry, BufferAttribute, BufferGeometry, Vector3 } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** A seeded generator, so the fixture is the same on every run. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A closed, bumpy body on a latitude grid, each quad split along a random diagonal. */
function body(next: () => number) {
  const columns = 64,
    rows = 44;
  const positions: number[] = [];
  for (let r = 0; r <= rows; r++)
    for (let c = 0; c < columns; c++) {
      // Rows and columns land unevenly, as a scanner's samples do.
      const v = (r + (r > 0 && r < rows ? (next() - 0.5) * 0.6 : 0)) / rows;
      const u = (c + (next() - 0.5) * 0.6) / columns;
      const phi = v * Math.PI,
        theta = u * Math.PI * 2;
      // Small relief: ridges and a little noise, a few tenths of a millimetre.
      const relief =
        0.25 * Math.sin(theta * 9) * Math.sin(phi * 7) + 0.12 * Math.sin(phi * 23) + 0.06 * next();
      const radius = 10 + relief;
      positions.push(
        radius * Math.sin(phi) * Math.cos(theta) * 1.1,
        radius * Math.cos(phi) * 1.5,
        radius * Math.sin(phi) * Math.sin(theta) * 0.8,
      );
    }
  const index: number[] = [];
  const at = (r: number, c: number) => r * columns + (c % columns);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < columns; c++) {
      const a = at(r, c),
        b = at(r, c + 1),
        d = at(r + 1, c),
        e = at(r + 1, c + 1);
      if (next() < 0.5) index.push(a, d, b, b, d, e);
      else index.push(a, d, e, a, e, b);
    }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setIndex(index);
  return geometry;
}

/** Moves each vertex of a geometry by up to `amount` in each axis. */
function jitter(geometry: BufferGeometry, amount: number, next: () => number) {
  const position = geometry.getAttribute('position');
  const seen = new Map<string, Vector3>();
  for (let i = 0; i < position.count; i++) {
    const key = `${position.getX(i)},${position.getY(i)},${position.getZ(i)}`;
    let move = seen.get(key);
    if (!move) {
      move = new Vector3(next() - 0.5, next() - 0.5, next() - 0.5).multiplyScalar(2 * amount);
      seen.set(key, move);
    }
    position.setXYZ(
      i,
      position.getX(i) + move.x,
      position.getY(i) + move.y,
      position.getZ(i) + move.z,
    );
  }
  return geometry;
}

/**
 * About 33 mm tall, made the way scans are hard for the warp grid: a bumpy body with uneven
 * triangulation, a fin 0.3 mm thick passing through it, a block with sharp creases, faces with no
 * area, and unindexed triangles with flat normals, as an STL file holds them.
 */
export function scanLike() {
  const next = random(20261118);
  const fin = jitter(new BoxGeometry(18, 9, 0.3, 30, 15, 1), 0.02, next)
    .rotateY(0.5)
    .translate(9, 4, 0);
  const block = jitter(new BoxGeometry(7, 5, 6, 7, 5, 6), 0.08, next).translate(-6, -11, 3);
  const pieces = [body(next), fin, block].map((piece) => {
    piece.deleteAttribute('normal');
    piece.deleteAttribute('uv');
    return piece.index ? piece.toNonIndexed() : piece;
  });
  const merged = mergeGeometries(pieces)!;
  // Faces with no area: each a point repeated, or three points along one edge.
  const position = merged.getAttribute('position');
  const extra: number[] = [];
  for (let i = 0; i < 24; i++) {
    const f = Math.floor(next() * (position.count / 3)) * 3;
    const a = new Vector3().fromBufferAttribute(position, f),
      b = new Vector3().fromBufferAttribute(position, f + 1);
    const middle = a.clone().lerp(b, 0.5);
    if (i % 2) extra.push(...a.toArray(), ...a.toArray(), ...a.toArray());
    else extra.push(...a.toArray(), ...middle.toArray(), ...b.toArray());
  }
  const all = new Float32Array(position.count * 3 + extra.length);
  all.set(position.array as Float32Array);
  all.set(extra, position.count * 3);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(all, 3));
  geometry.computeVertexNormals();
  return geometry;
}
