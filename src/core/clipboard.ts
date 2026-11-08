import { Vector3 } from 'three';
import { uid } from './geometry';
import type { Joint, Part, PlaneConstraint, SceneDocument } from './types';

export interface ComponentClipboard {
  parts: Part[];
  joints: Joint[];
  constraints: PlaneConstraint[];
  /** A cut is restored in place on its first paste. Copies start one step away. */
  nextOffset: number;
}

function snapshotPart(part: Part): Part {
  return {
    ...part,
    position: [...part.position],
    quaternion: [...part.quaternion],
    scale: [...part.scale],
    ...(part.pivot ? { pivot: [...part.pivot] } : {}),
  };
}

function snapshotJoint(joint: Joint): Joint {
  return {
    ...joint,
    parentAnchor: [...joint.parentAnchor],
    childAnchor: [...joint.childAnchor],
    restRotation: [...joint.restRotation],
    rotationLocks: [...joint.rotationLocks],
  };
}

function snapshotConstraint(constraint: PlaneConstraint): PlaneConstraint {
  return {
    ...constraint,
    sourcePlane: {
      point: [...constraint.sourcePlane.point],
      normal: [...constraint.sourcePlane.normal],
    },
    targetPlane: {
      point: [...constraint.targetPlane.point],
      normal: [...constraint.targetPlane.normal],
    },
  };
}

export function captureComponents(
  scene: SceneDocument,
  ids: string[],
  cut = false,
): ComponentClipboard {
  const selected = new Set(ids);
  const parts = scene.parts.filter((part) => selected.has(part.id) && (!cut || !part.locked));
  const captured = new Set(parts.map((part) => part.id));
  return {
    // Geometry is immutable in the editor; share the buffers, as scene history does.
    parts: parts.map(snapshotPart),
    joints: scene.joints
      .filter((joint) => captured.has(joint.parentId) && captured.has(joint.childId))
      .map(snapshotJoint),
    constraints: (scene.constraints ?? [])
      .filter((c) => captured.has(c.sourceId) && captured.has(c.targetId))
      .map(snapshotConstraint),
    nextOffset: cut ? 0 : 1,
  };
}

export function instantiateComponents(clipboard: ComponentClipboard, existing: Part[]) {
  const ids = new Map(clipboard.parts.map((part) => [part.id, uid()]));
  const names = new Set(existing.map((part) => part.name));
  const parts = clipboard.parts.map((part) => {
    const base =
      clipboard.nextOffset === 0 && !names.has(part.name) ? part.name : `${part.name} copy`;
    let name = base;
    for (let index = 2; names.has(name); index++) name = `${base} ${index}`;
    names.add(name);
    return {
      ...snapshotPart(part),
      id: ids.get(part.id)!,
      name,
      position: new Vector3(...part.position)
        .add(new Vector3(12 * clipboard.nextOffset, 0, 0))
        .toArray(),
      locked: false,
      visible: true,
    };
  });
  const joints = clipboard.joints.map((joint) => ({
    ...snapshotJoint(joint),
    id: uid(),
    name: `${joint.name} copy`,
    parentId: ids.get(joint.parentId)!,
    childId: ids.get(joint.childId)!,
  }));
  const constraints = clipboard.constraints.map((c) => ({
    ...snapshotConstraint(c),
    id: uid(),
    name: `${c.name} copy`,
    sourceId: ids.get(c.sourceId)!,
    targetId: ids.get(c.targetId)!,
  }));
  return { parts, joints, constraints };
}
