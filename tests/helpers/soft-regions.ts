import { BufferAttribute, BufferGeometry } from 'three';
import { rivetedPlate, softBox } from './soft-edges';

/** rivetedPlate with each dome pressed into the top face as a dimple of the same size. */
export function dimpledPlate() {
  const { geometry, rivets } = rivetedPlate();
  const position = geometry.getAttribute('position');
  for (let i = 0; i < position.count; i++) {
    const y = position.getY(i);
    if (y < 0.3) continue;
    for (const rivet of rivets) {
      const u = Math.hypot(position.getX(i) - rivet.x, position.getZ(i) - rivet.z) / rivet.radius;
      if (u < 1) position.setY(i, y - 2 * rivet.height * (1 - u * u) ** 2);
    }
  }
  geometry.computeVertexNormals();
  return { geometry, dimples: rivets };
}

/**
 * The riveted plate's slab without rivets and with a quarter of the ripple, its top face lifted by
 * `peak` * exp(-(r / 1.2)^2) about the centre.
 */
export function warpedPlate(peak: number) {
  const geometry = softBox([3, 0.5, 2], 0.2, { ripple: 0.005 });
  const position = geometry.getAttribute('position');
  for (let i = 0; i < position.count; i++) {
    const y = position.getY(i);
    if (y < 0.3) continue;
    const r = Math.hypot(position.getX(i), position.getZ(i));
    position.setY(i, y + peak * Math.exp(-((r / 1.2) ** 2)));
  }
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * A sheet of (nx + 1) x (ny + 1) vertices `spacing` apart from (x0, y0), lifted along z by
 * `height(x, y)`.
 */
export function heightGrid(
  height: (x: number, y: number) => number,
  nx = 120,
  ny = 80,
  x0 = -3,
  y0 = -2,
  spacing = 0.05,
) {
  const points: number[] = [];
  const indices: number[] = [];
  for (let row = 0; row <= ny; row++)
    for (let col = 0; col <= nx; col++) {
      const x = x0 + col * spacing,
        y = y0 + row * spacing;
      points.push(x, y, height(x, y));
      const i = points.length / 3 - 1;
      if (row && col) indices.push(i - nx - 2, i - nx - 1, i, i - nx - 2, i, i - 1);
    }
  return sheet(points, indices);
}

/**
 * A strip folded back over itself: z = 0 from x = 0.8 to 0, up 0.12 mm at x = 0, then back out
 * along z = 0.12 to x = 0.8, the returning sheet rising by `rise` from x = 0.25 to 0.4.
 */
export function foldedSheet(rise: number) {
  const path = [
    ...Array.from({ length: 17 }, (_, i) => [0.8 - 0.05 * i, 0]),
    [0, 0.04],
    [0, 0.08],
    ...Array.from({ length: 16 }, (_, i) => {
      const x = 0.05 * (i + 1);
      return [x, 0.12 + rise * Math.min(1, Math.max(0, (x - 0.25) / 0.15))];
    }),
  ];
  const points: number[] = [];
  const indices: number[] = [];
  for (let row = 0; row <= 20; row++)
    for (let col = 0; col < path.length; col++) {
      points.push(path[col][0], -0.5 + row * 0.05, path[col][1]);
      const i = points.length / 3 - 1;
      if (row && col)
        indices.push(i - path.length - 1, i - path.length, i, i - path.length - 1, i, i - 1);
    }
  return sheet(points, indices);
}

function sheet(points: number[], indices: number[]) {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(points), 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}
