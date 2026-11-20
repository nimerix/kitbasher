import { rivetedPlate } from './soft-edges';

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
