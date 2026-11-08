import { Quaternion, Vector3 } from 'three';
import { constrainPart, isJointConnected, transformAssembly } from './constraints';
import { partMatrix, quat, triangleCount, vec } from './geometry';
import { fitPatchPlane, worldPlane } from './planes';
import { completedSurfacePairs } from './surfaces';
import type { AssemblyOperation, Part, PlaneConstraint, SceneDocument } from './types';

export const planeKindLabels = {
  mate: 'Mate planes',
  parallel: 'Parallel',
  perpendicular: 'Perpendicular',
  angle: 'Angle',
} as const;
const angleTolerance = 1e-5; // radians
const distanceTolerance = 1e-4; // mm
const sameTransform = (a: Part, b: Part) => {
  const matrix = partMatrix(b);
  return partMatrix(a).elements.every((value, i) => Math.abs(value - matrix.elements[i]) < 1e-8);
};
export function constraintAngle(constraint: PlaneConstraint) {
  return (
    ((constraint.kind === 'perpendicular'
      ? 90
      : constraint.kind === 'angle'
        ? constraint.angle
        : constraint.opposed
          ? 180
          : 0) *
      Math.PI) /
    180
  );
}

export function planeConstraintResidual(parts: Part[], constraint: PlaneConstraint) {
  const source = parts.find((p) => p.id === constraint.sourceId),
    target = parts.find((p) => p.id === constraint.targetId);
  if (!source || !target) return { angle: Infinity, distance: Infinity, satisfied: false };
  const a = worldPlane(source, constraint.sourcePlane),
    b = worldPlane(target, constraint.targetPlane);
  const angle = Math.abs(a.normal.angleTo(b.normal) - constraintAngle(constraint));
  const distance =
    constraint.kind === 'mate'
      ? Math.abs(a.point.sub(b.point).dot(b.normal) - constraint.offset)
      : 0;
  return { angle, distance, satisfied: angle < angleTolerance && distance < distanceTolerance };
}

/** Directed plane dependencies share the joint hierarchy's target-to-moving direction. */
export function validatePlaneConstraints(scene: SceneDocument) {
  const ids = new Set(scene.parts.map((p) => p.id)),
    edges = new Map<string, Set<string>>();
  for (const id of ids) edges.set(id, new Set());
  for (const joint of scene.joints.filter(isJointConnected))
    edges.get(joint.parentId)?.add(joint.childId);
  for (const constraint of scene.constraints ?? []) {
    if (
      !ids.has(constraint.sourceId) ||
      !ids.has(constraint.targetId) ||
      constraint.sourceId === constraint.targetId
    )
      throw new Error('A plane constraint needs two different existing parts.');
    if (
      !Object.hasOwn(planeKindLabels, constraint.kind) ||
      !Number.isFinite(constraint.angle) ||
      constraint.angle < 0 ||
      constraint.angle > 180 ||
      !Number.isFinite(constraint.offset)
    )
      throw new Error('Use a finite plane offset and an angle between 0 and 180 degrees.');
    if (constraint.enabled) edges.get(constraint.targetId)!.add(constraint.sourceId);
  }
  const visited = new Set<string>(),
    visiting = new Set<string>(),
    order: string[] = [];
  const visit = (id: string) => {
    if (visiting.has(id))
      throw new Error(
        'This relationship would create a circular dependency. Choose the same moving/target direction as the existing joints and constraints.',
      );
    if (visited.has(id)) return;
    visiting.add(id);
    for (const child of edges.get(id) ?? []) visit(child);
    visiting.delete(id);
    visited.add(id);
    order.unshift(id);
  };
  for (const id of ids) visit(id);
  return order;
}

export function constraintsFromPatches(
  scene: SceneDocument,
  operation: AssemblyOperation,
): PlaneConstraint[] {
  const source = scene.parts.find((p) => p.id === operation.sourceId),
    target = scene.parts.find((p) => p.id === operation.targetId);
  if (!source || !target) throw new Error('Choose a moving part and a target part.');
  const pairs = completedSurfacePairs(operation.surfacePairs);
  if (!pairs.length || pairs.length !== operation.surfacePairs.length)
    throw new Error('Finish at least one painted plane pair, or remove incomplete pairs.');
  const kind = operation.surfaceMethod;
  if (!kind || kind === 'contact' || kind === 'flush')
    throw new Error('Choose a plane relationship.');
  return pairs.map((pair, i) => {
    if (pair.source!.partId !== source.id || pair.target!.partId !== target.id)
      throw new Error('Every plane pair must use the chosen moving and target parts.');
    // Prevent imported invalid triangle indices from reaching geometry reads.
    if (!triangleCount(source.geometry) || !triangleCount(target.geometry))
      throw new Error('Paint a surface on each part.');
    return {
      id: `plane-${pair.id}`,
      name: `${source.name} · ${planeKindLabels[kind]} ${i + 1}`,
      sourceId: source.id,
      targetId: target.id,
      sourcePlane: fitPatchPlane(source, pair.source!).plane,
      targetPlane: fitPatchPlane(target, pair.target!).plane,
      kind,
      angle: operation.planeAngle ?? 0,
      offset: operation.offset,
      opposed: operation.flipNormal,
      enabled: true,
    };
  });
}

function projectPlane(source: Part, target: Part, constraint: PlaneConstraint) {
  const a = worldPlane(source, constraint.sourcePlane),
    b = worldPlane(target, constraint.targetPlane);
  const difference = a.normal.angleTo(b.normal) - constraintAngle(constraint);
  let placed = source;
  if (Math.abs(difference) > 1e-10) {
    const axis = a.normal.clone().cross(b.normal);
    if (axis.lengthSq() < 1e-16) {
      const least = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)].sort(
        (x, y) => Math.abs(x.dot(a.normal)) - Math.abs(y.dot(a.normal)),
      )[0];
      axis.crossVectors(a.normal, least);
    }
    const rotation = new Quaternion().setFromAxisAngle(axis.normalize(), difference);
    placed = {
      ...source,
      position: vec(source.position).sub(a.point).applyQuaternion(rotation).add(a.point).toArray(),
      quaternion: rotation.multiply(quat(source.quaternion)).normalize().toArray(),
    };
  }
  if (constraint.kind === 'mate') {
    const separation = worldPlane(placed, constraint.sourcePlane).point.sub(b.point).dot(b.normal);
    if (Math.abs(separation - constraint.offset) > 1e-10)
      placed = {
        ...placed,
        position: vec(placed.position)
          .addScaledVector(b.normal, constraint.offset - separation)
          .toArray(),
      };
  }
  return placed;
}

/** Bounded projection, with each source's target fixed and every existing joint re-applied. */
export function solvePlaneConstraints(
  scene: SceneDocument,
  proposed: Part[],
  fixedIds: string[] = [],
) {
  const active = (scene.constraints ?? []).filter((c) => c.enabled);
  if (!active.length) return proposed;
  const order = validatePlaneConstraints(scene),
    byId = new Map(order.map((id, i) => [id, i]));
  const constraints = [...active].sort((a, b) => byId.get(a.sourceId)! - byId.get(b.sourceId)!);
  let parts = proposed;
  let failed = constraints[0];
  for (let iteration = 0; iteration < 80; iteration++) {
    for (const constraint of constraints) {
      if (planeConstraintResidual(parts, constraint).satisfied) continue;
      const source = parts.find((p) => p.id === constraint.sourceId)!,
        target = parts.find((p) => p.id === constraint.targetId)!;
      if (source.locked || fixedIds.includes(source.id)) continue;
      const requested = projectPlane(source, target, constraint);
      parts = transformAssembly(parts, scene.joints, source.id, requested, {
        stationaryIds: [...fixedIds, target.id],
      });
    }
    const unsatisfied = constraints.find((c) => !planeConstraintResidual(parts, c).satisfied);
    if (!unsatisfied) {
      // Existing joint constraints and every fixed transform remain authoritative.
      const validJoints = scene.joints.filter(isJointConnected).every((joint) => {
        const child = parts.find((p) => p.id === joint.childId)!,
          parent = parts.find((p) => p.id === joint.parentId)!;
        return sameTransform(child, constrainPart(child, parent, joint));
      });
      const validFixed = scene.parts.every(
        (part) =>
          !(part.locked || fixedIds.includes(part.id)) ||
          sameTransform(
            part,
            parts.find((p) => p.id === part.id)!,
          ),
      );
      if (
        validJoints &&
        validFixed &&
        parts.every((p) => [...p.position, ...p.quaternion, ...p.scale].every(Number.isFinite))
      )
        return scene.parts.every((p, i) => sameTransform(p, parts[i])) ? scene.parts : parts;
      break;
    }
    failed = unsatisfied;
  }
  throw new Error(
    `Cannot satisfy “${failed.name}” with the current locks, joints, or other plane constraints. Suppress a conflicting constraint or unlock the connected part.`,
  );
}
