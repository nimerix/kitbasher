import { Vector3 } from 'three';
import { partMatrix, uid, vec } from './geometry';
import { liveGroups } from './part-tree';
import type { Joint, Part, PartGroup, PlaneConstraint, SceneDocument } from './types';

export interface ComponentClipboard {
  parts: Part[];
  joints: Joint[];
  constraints: PlaneConstraint[];
  /**
   * The groups of the copied parts. One copied whole is pasted as a new group. Parts copied
   * from part of a group join it again, while it still has parts.
   */
  groups: (PartGroup & { whole: boolean })[];
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
  const groups = new Set(parts.flatMap((part) => (part.groupId ? [part.groupId] : [])));
  return {
    // Geometry is immutable in the editor; share the buffers, as scene history does.
    parts: parts.map(snapshotPart),
    joints: scene.joints
      .filter((joint) => captured.has(joint.parentId) && captured.has(joint.childId))
      .map(snapshotJoint),
    constraints: (scene.constraints ?? [])
      .filter((c) => captured.has(c.sourceId) && captured.has(c.targetId))
      .map(snapshotConstraint),
    groups: liveGroups(scene)
      .filter((group) => groups.has(group.id))
      .map((group) => ({
        ...group,
        whole: scene.parts.every((part) => part.groupId !== group.id || captured.has(part.id)),
      })),
    nextOffset: cut ? 0 : 1,
  };
}

/** Where copies of each clipboard group go: an existing group, or a new one named like parts. */
function pastedGroups(
  clipboard: ComponentClipboard,
  existing: Pick<SceneDocument, 'parts' | 'groups'>,
) {
  const live = liveGroups(existing);
  const names = new Set(live.map((group) => group.name));
  const target = new Map<string, string>();
  const created: PartGroup[] = [];
  for (const group of clipboard.groups ?? []) {
    if (!group.whole && live.some((known) => known.id === group.id)) {
      target.set(group.id, group.id);
      continue;
    }
    const base =
      clipboard.nextOffset === 0 && !names.has(group.name) ? group.name : `${group.name} copy`;
    let name = base;
    for (let index = 2; names.has(name); index++) name = `${base} ${index}`;
    names.add(name);
    const copy = { id: uid(), name };
    created.push(copy);
    target.set(group.id, copy.id);
  }
  return { target, created };
}

/** Copies of the clipboard's components, ready to add to the scene with their new groups. */
export function instantiateComponents(
  clipboard: ComponentClipboard,
  existing: Pick<SceneDocument, 'parts' | 'groups'>,
) {
  const ids = new Map(clipboard.parts.map((part) => [part.id, uid()]));
  const names = new Set(existing.parts.map((part) => part.name));
  const groups = pastedGroups(clipboard, existing);
  const parts = clipboard.parts.map((part): Part => {
    const base =
      clipboard.nextOffset === 0 && !names.has(part.name) ? part.name : `${part.name} copy`;
    let name = base;
    for (let index = 2; names.has(name); index++) name = `${base} ${index}`;
    names.add(name);
    const { groupId, ...copy } = snapshotPart(part);
    const group = groupId ? groups.target.get(groupId) : undefined;
    return {
      ...copy,
      ...(group ? { groupId: group } : {}),
      id: ids.get(part.id)!,
      name,
      pins: part.pins?.map((pin) => ({
        ...pin,
        id: uid(),
        point: [...pin.point] as typeof pin.point,
        target: vec(pin.target)
          .add(new Vector3(12 * clipboard.nextOffset, 0, 0))
          .toArray(),
      })),
      anchors: part.anchors?.map((a) => ({
        id: uid(),
        point: [...a.point] as typeof a.point,
        target:
          clipboard.nextOffset === 0
            ? ([...a.target] as typeof a.target)
            : vec(a.point)
                .applyMatrix4(partMatrix(part))
                .add(new Vector3(12 * clipboard.nextOffset, 0, 0))
                .toArray(),
      })),
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
  return { parts, joints, constraints, groups: groups.created };
}

/** A scene's group list with pasted groups added. */
export const addedGroups = (scene: Pick<SceneDocument, 'groups'>, groups: PartGroup[]) =>
  groups.length ? { groups: [...(scene.groups ?? []), ...groups] } : {};
