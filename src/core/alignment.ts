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
import { solveFlushAlignment } from './flush-fit';
import {
  constraintsFromPatches,
  planeConstraintResidual,
  solvePlaneConstraints,
} from './plane-constraints';
import { placeClear } from './clipping';
import type { ClipReport } from './clipping';
import type { AssemblyOperation, ClipSettings, Part, SceneDocument } from './types';

/**
 * Preview and application share the same solver, including active anchors and fixed targets.
 * With `clip` enabled, the result is the nearest placement that keeps the moved parts out of
 * every other visible part, and `clip` in the result says what that took.
 */
export function solveAlignment(
  scene: SceneDocument,
  operation: AssemblyOperation,
  clip?: ClipSettings,
) {
  const source = scene.parts.find((part) => part.id === operation.sourceId);
  const target = resolvePart(scene, operation.targetId);
  if (!source || !target) throw new Error('Choose a moving part and a target.');
  if (source.locked) throw new Error('Unlock the moving part first.');
  if (operation.pending)
    throw new Error('Finish the pending target pick before applying alignment.');
  if (operation.mode === 'surface' && operation.surfaceMethod === 'flush')
    return solveFlushAlignment(scene, operation, clip);
  const clear = (
    desired: Part,
    place: (requested: Part) => Part[],
    rotate: boolean,
  ): { parts: Part[]; report: ClipReport | null } =>
    clip?.enabled
      ? placeClear({
          parts: scene.parts,
          joints: scene.joints,
          ids: [source.id],
          target: [desired],
          place: ([pose]) => place(pose),
          overlap: clip.overlap,
          mode: 'fit',
          rotate,
        })
      : { parts: place(desired), report: null };
  const planar =
    operation.mode === 'surface' &&
    operation.surfaceMethod &&
    operation.surfaceMethod !== 'contact';
  if (planar) {
    const created = constraintsFromPatches(scene, operation);
    const constrained = { ...scene, constraints: [...(scene.constraints ?? []), ...created] };
    const seated = solvePlaneConstraints(constrained, scene.parts, [target.id]);
    // A relationship that is kept stays exact. One applied once may give way to stay clear.
    const held = operation.retainConstraint ? constrained : scene;
    const { parts, report } = clear(
      seated.find((part) => part.id === source.id)!,
      (requested) =>
        solvePlaneConstraints(
          held,
          transformAssembly(scene.parts, scene.joints, source.id, requested, {
            stationaryIds: [target.id],
          }),
          [target.id],
        ),
      false,
    );
    const residuals = created.map((c) => planeConstraintResidual(parts, c));
    return {
      parts,
      rms: Math.sqrt(residuals.reduce((sum, r) => sum + r.distance ** 2, 0) / residuals.length),
      angleError: (Math.max(...residuals.map((r) => r.angle)) * 180) / Math.PI,
      constrained: false,
      anchored: scene.joints.some(
        (joint) => joint.childId === source.id && isJointConnected(joint),
      ),
      addedConstraints: operation.retainConstraint ? created : [],
      clip: report,
    };
  }
  const { matrix } =
    operation.mode === 'surface'
      ? surfaceAlignment(source, target, operation)
      : alignmentTransform(source, target, operation);
  const desired = matrix.multiply(partMatrix(source));
  const place = (requested: Part) =>
    solvePlaneConstraints(
      scene,
      transformAssembly(scene.parts, scene.joints, source.id, requested, {
        moveConnected: true,
        stationaryIds: [target.id],
      }),
      [target.id],
    );
  const request = transformFromMatrix(source, desired);
  const reached = partMatrix(place(request).find((part) => part.id === source.id)!);
  const { parts, report } = clear(
    request,
    place,
    operation.mode === 'multi' || operation.mode === 'surface',
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
  const constrained = desired.elements.some(
    (value, i) => Math.abs(value - reached.elements[i]) > 1e-7,
  );
  return {
    parts,
    rms:
      operation.mode === 'surface'
        ? surfaceResidual(placed, target, operation)
        : Math.sqrt(errors.reduce((sum, error) => sum + error, 0) / errors.length),
    constrained,
    anchored: scene.joints.some((joint) => joint.childId === source.id && isJointConnected(joint)),
    clip: report,
  };
}
