import { Quaternion } from 'three';
import { partMatrix, quat, rigidAlignment, vec } from './geometry';
import { transformAssembly } from './constraints';
import { solvePlaneConstraints } from './plane-constraints';
import { placeClear } from './clipping';
import type { ClipMode, ClipReport } from './clipping';
import type { FitAnchor, Part, SceneDocument } from './types';

export function anchorGaps(part: Part) {
  const matrix = partMatrix(part);
  return (part.anchors ?? []).map((anchor) =>
    vec(anchor.point).applyMatrix4(matrix).distanceTo(vec(anchor.target)),
  );
}

export interface AnchorClearance {
  overlap: number;
  mode: ClipMode;
  /** Where the parts are now, when a drag fits from the scene as it was at its start. */
  current?: Part[];
  budget?: number;
  settle?: boolean;
  /** Receives what staying clear of other parts did to the fit. */
  report?: (report: ClipReport | null) => void;
}

/**
 * Equal-weight rigid best fit. Targets are soft; existing joints/planes stay authoritative. With
 * `clear`, the fit also stays out of every other visible part.
 */
export function fitAnchors(
  scene: SceneDocument,
  id: string,
  anchors: FitAnchor[],
  clear?: AnchorClearance,
) {
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
  const place = (pose: Part) =>
    solvePlaneConstraints(scene, transformAssembly(scene.parts, scene.joints, id, pose));
  let placed = place(requested);
  if (clear) {
    const result = placeClear({
      parts: clear.current ?? scene.parts,
      joints: scene.joints,
      ids: [id],
      target: [requested],
      place: ([pose]) => place(pose),
      overlap: clear.overlap,
      mode: clear.mode,
      rotate: true,
      budget: clear.budget,
      settle: clear.settle,
    });
    placed = result.parts;
    clear.report?.(result.report);
  }
  return placed.map((p) => (p.id === id ? { ...p, anchors } : p));
}
