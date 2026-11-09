import { Quaternion } from 'three';
import { partMatrix, quat, rigidAlignment, vec } from './geometry';
import { transformAssembly } from './constraints';
import { solvePlaneConstraints } from './plane-constraints';
import type { FitAnchor, Part, SceneDocument } from './types';

export function anchorGaps(part: Part) {
  const matrix = partMatrix(part);
  return (part.anchors ?? []).map((anchor) =>
    vec(anchor.point).applyMatrix4(matrix).distanceTo(vec(anchor.target)),
  );
}

/** Equal-weight rigid best fit. Targets are soft; existing joints/planes stay authoritative. */
export function fitAnchors(scene: SceneDocument, id: string, anchors: FitAnchor[]) {
  const part = scene.parts.find((p) => p.id === id);
  if (!part || part.locked || !part.visible) throw new Error('Choose a visible, unlocked part.');
  if (!anchors.length) throw new Error('Add an anchor on the part first.');
  if (anchors.some((a) => ![...a.point, ...a.target].every(Number.isFinite)))
    throw new Error('Anchor coordinates must be finite.');
  const matrix = partMatrix(part);
  const { matrix: delta } = rigidAlignment(
    anchors.map((a) => vec(a.point).applyMatrix4(matrix)),
    anchors.map((a) => vec(a.target)),
    true,
  );
  // Apply only a world rotation and translation. Avoid decomposing the part's
  // matrix, which can reassign the signs of a mirrored or non-uniform scale.
  const requested: Part = {
    ...part,
    position: vec(part.position).applyMatrix4(delta).toArray(),
    quaternion: new Quaternion()
      .setFromRotationMatrix(delta)
      .multiply(quat(part.quaternion))
      .normalize()
      .toArray(),
  };
  const placed = solvePlaneConstraints(
    scene,
    transformAssembly(scene.parts, scene.joints, id, requested),
  );
  return placed.map((p) => (p.id === id ? { ...p, anchors } : p));
}
