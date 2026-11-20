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
