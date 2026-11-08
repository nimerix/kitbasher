import {
  alignmentTransform,
  partMatrix,
  transformFromMatrix,
  worldNormal,
  worldPoint,
} from './geometry';
import { isJointConnected, transformAssembly } from './constraints';
import { surfaceAlignment, surfaceResidual } from './surface-fit';
import { resolvePart } from './references';
import type { AssemblyOperation, SceneDocument } from './types';

/** Preview and application share the same solver, including active anchors and fixed targets. */
export function solveAlignment(scene: SceneDocument, operation: AssemblyOperation) {
  const source = scene.parts.find((part) => part.id === operation.sourceId);
  const target = resolvePart(scene, operation.targetId);
  if (!source || !target) throw new Error('Choose a moving part and a target.');
  if (source.locked) throw new Error('Unlock the moving part first.');
  if (operation.pending)
    throw new Error('Finish the pending target pick before applying alignment.');
  const { matrix } =
    operation.mode === 'surface'
      ? surfaceAlignment(source, target, operation)
      : alignmentTransform(source, target, operation);
  const desired = matrix.multiply(partMatrix(source));
  const parts = transformAssembly(
    scene.parts,
    scene.joints,
    source.id,
    transformFromMatrix(source, desired),
    { moveConnected: true, stationaryIds: [target.id] },
  );
  const placed = parts.find((part) => part.id === source.id)!;
  const errors = operation.pairs.map((pair) => {
    const from = worldPoint(placed, pair.source);
    const to = worldPoint(target, pair.target);
    if (operation.mode !== 'multi')
      to.addScaledVector(worldNormal(target, pair.target), operation.offset);
    if (operation.mode === 'point-plane')
      return Math.pow(from.sub(to).dot(worldNormal(target, pair.target)), 2);
    return from.distanceToSquared(to);
  });
  const achieved = partMatrix(placed);
  const constrained = desired.elements.some(
    (value, i) => Math.abs(value - achieved.elements[i]) > 1e-7,
  );
  return {
    parts,
    rms:
      operation.mode === 'surface'
        ? surfaceResidual(placed, target, operation)
        : Math.sqrt(errors.reduce((sum, error) => sum + error, 0) / errors.length),
    constrained,
    anchored: scene.joints.some((joint) => joint.childId === source.id && isJointConnected(joint)),
  };
}
