import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { partMatrix, quat, transformFromMatrix, vec } from './geometry';
import type { Joint, Part } from './types';
import { applyPinCorrection, hardPinsSatisfied, pinCorrection } from './pins';

export function validateJoint(joints: Joint[], parentId: string, childId: string) {
  if (parentId === childId) throw new Error('Choose two different parts.');
  if (joints.some((j) => j.childId === childId))
    throw new Error('This part already has a parent joint. Remove that joint first.');
  const descendants = new Set([childId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const joint of joints)
      if (descendants.has(joint.parentId) && !descendants.has(joint.childId)) {
        descendants.add(joint.childId);
        changed = true;
      }
  }
  if (descendants.has(parentId)) throw new Error('This joint would create a circular assembly.');
}

/** Missing flags in older in-memory documents retain the original anchored behavior. */
export const isJointConnected = (joint: Joint) => joint.keepConnected !== false;

export function connectedPartIds(joints: Joint[], id: string): Set<string> {
  const ids = new Set([id]);
  const queue = [id];
  const active = joints.filter(isJointConnected);
  while (queue.length) {
    const current = queue.shift()!;
    for (const joint of active) {
      const neighbor =
        joint.parentId === current
          ? joint.childId
          : joint.childId === current
            ? joint.parentId
            : null;
      if (neighbor && !ids.has(neighbor)) {
        ids.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  return ids;
}

export function translationIsPinned(parts: Part[], joints: Joint[], id: string) {
  const connected = connectedPartIds(joints, id);
  return parts.some((part) => part.locked && connected.has(part.id));
}

function sameTransform(a: Part, b: Part) {
  const bMatrix = partMatrix(b);
  return partMatrix(a).elements.every((value, i) => Math.abs(value - bMatrix.elements[i]) < 1e-9);
}

export function constrainPart(part: Part, parent: Part, joint: Joint): Part {
  if (!isJointConnected(joint)) return part;
  const parentRotation = quat(parent.quaternion);
  const rest = quat(joint.restRotation);
  const relative = parentRotation.clone().invert().multiply(quat(part.quaternion));
  const delta = rest.clone().invert().multiply(relative);
  const angles = new Euler().setFromQuaternion(delta, 'XYZ');
  if (joint.rotationLocks[0]) angles.x = 0;
  if (joint.rotationLocks[1]) angles.y = 0;
  if (joint.rotationLocks[2]) angles.z = 0;
  const rotation = parentRotation
    .multiply(rest)
    .multiply(new Quaternion().setFromEuler(angles))
    .normalize();
  const anchor = vec(joint.parentAnchor).applyMatrix4(partMatrix(parent));
  const childOffset = vec(joint.childAnchor).multiply(vec(part.scale)).applyQuaternion(rotation);
  return { ...part, quaternion: rotation.toArray(), position: anchor.sub(childOffset).toArray() };
}

/** Move active descendants with their parent; placement can carry a connected assembly. */
export function transformAssembly(
  parts: Part[],
  joints: Joint[],
  id: string,
  requested: Part,
  options: { moveConnected?: boolean; stationaryIds?: string[]; softPins?: boolean } = {},
): Part[] {
  const original = parts.find((p) => p.id === id);
  if (!original || original.locked) return parts;
  const active = joints.filter(isJointConnected);
  const parentJoint = active.find((j) => j.childId === id);
  let baseline = parts;
  if (parentJoint && options.moveConnected) {
    const connected = connectedPartIds(active, id);
    const pinned =
      parts.some((p) => connected.has(p.id) && p.locked) ||
      options.stationaryIds?.some((stationary) => connected.has(stationary));
    const parent = parts.find((p) => p.id === parentJoint.parentId);
    if (!pinned && parent) {
      const offset = vec(parentJoint.childAnchor)
        .applyMatrix4(partMatrix(requested))
        .sub(vec(parentJoint.parentAnchor).applyMatrix4(partMatrix(parent)));
      if (offset.lengthSq() > 1e-18) {
        baseline = parts.map((p) =>
          connected.has(p.id) ? { ...p, position: vec(p.position).add(offset).toArray() } : p,
        );
      }
    }
  }
  const results = new Map(baseline.map((p) => [p.id, p]));
  let next = requested;
  if (parentJoint) {
    const parent = results.get(parentJoint.parentId);
    if (parent) next = constrainPart(next, parent, parentJoint);
  }
  results.set(id, next);
  const queue = [id],
    visited = new Set<string>();
  while (queue.length) {
    const parentId = queue.shift()!;
    if (visited.has(parentId)) continue;
    visited.add(parentId);
    const oldParent = baseline.find((p) => p.id === parentId)!,
      newParent = results.get(parentId)!;
    const delta = new Matrix4().multiplyMatrices(
      partMatrix(newParent),
      partMatrix(oldParent).invert(),
    );
    for (const joint of active.filter((j) => j.parentId === parentId)) {
      const child = results.get(joint.childId);
      if (!child) continue;
      const moved = transformFromMatrix(child, delta.clone().multiply(partMatrix(child)));
      results.set(child.id, constrainPart(moved, newParent, joint));
      queue.push(child.id);
    }
  }
  if (
    parts.some((p) =>
      p.pins?.some(
        (pin) => pin.kind === 'hard' || (options.softPins !== false && pin.priority > 0),
      ),
    )
  ) {
    const affected = new Set(
      parts
        .filter((p) => visited.has(p.id) || !sameTransform(p, results.get(p.id)!))
        .map((p) => p.id),
    );
    const moving = [...affected].map((key) => results.get(key)!);
    if (
      moving.some((p) =>
        p.pins?.some(
          (pin) => pin.kind === 'hard' || (options.softPins !== false && pin.priority > 0),
        ),
      )
    ) {
      // A joint to a stationary parent is another exact point constraint. Move the
      // affected assembly with one rigid correction so its internal joints stay seated.
      const boundaries = active
        .filter((j) => affected.has(j.childId) && !affected.has(j.parentId))
        .flatMap((j) => {
          const parent = results.get(j.parentId)!;
          const source = vec(j.childAnchor).applyMatrix4(partMatrix(results.get(j.childId)!));
          const target = vec(j.parentAnchor).applyMatrix4(partMatrix(parent));
          const pairs = [{ source, target }];
          const locks = j.rotationLocks.filter(Boolean).length;
          // A hinge permits twist about its one free axis. Two extra directions
          // make a fully locked joint's orientation exact as well as its position.
          const axes = locks === 3 ? [0, 1] : locks === 2 ? [j.rotationLocks.indexOf(false)] : [];
          const frame = quat(parent.quaternion).multiply(quat(j.restRotation));
          for (const axis of axes) {
            const direction = new Vector3().setComponent(axis, 1).applyQuaternion(frame);
            pairs.push({
              source: source.clone().add(direction),
              target: target.clone().add(direction),
            });
          }
          return pairs;
        });
      const delta = pinCorrection(results.get(id)!, moving, boundaries, options.softPins !== false);
      for (const p of moving) results.set(p.id, applyPinCorrection(p, delta));
      if (moving.some((p) => !hardPinsSatisfied(results.get(p.id)!)))
        throw new Error(
          'A hard pin prevents this movement. Release the pin to move its attachment.',
        );
      if (
        active.some((joint) => {
          const child = results.get(joint.childId)!,
            parent = results.get(joint.parentId)!;
          return !sameTransform(child, constrainPart(child, parent, joint));
        })
      )
        return parts;
    }
  }
  // A fixed object or an alignment target must never be dragged by another part.
  if (
    parts.some(
      (p) =>
        (p.locked || options.stationaryIds?.includes(p.id)) &&
        !sameTransform(p, results.get(p.id)!),
    )
  )
    return parts;
  if (parts.every((p) => sameTransform(p, results.get(p.id)!))) return parts;
  return parts.map((p) => results.get(p.id)!);
}

export function anchorError(parts: Part[], joint: Joint) {
  const parent = parts.find((p) => p.id === joint.parentId),
    child = parts.find((p) => p.id === joint.childId);
  if (!parent || !child) return Infinity;
  return new Vector3(...joint.parentAnchor)
    .applyMatrix4(partMatrix(parent))
    .distanceTo(new Vector3(...joint.childAnchor).applyMatrix4(partMatrix(child)));
}
