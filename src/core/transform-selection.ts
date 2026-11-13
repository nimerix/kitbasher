import { Quaternion, Vector3 } from 'three';
import { isJointConnected, translationIsPinned } from './constraints';
import { partPivot, quat, radians, sceneBounds, vec } from './geometry';
import { hiddenByIsolation } from './isolation';
import type { useEditor } from './store';
import type { Part, Tool } from './types';

type TransformState = Pick<
  ReturnType<typeof useEditor.getState>,
  | 'scene'
  | 'selected'
  | 'view'
  | 'isolated'
  | 'nearbyParts'
  | 'pivotPicking'
  | 'navigationMode'
  | 'temporaryOrbit'
>;

/** The same selection, pivot, and axes for handles and precise button adjustments. */
export function transformSelection(state: TransformState, tool: Tool) {
  const { scene, selected, view } = state;
  const parts = scene.parts.filter(
    (part) =>
      selected.includes(part.id) &&
      part.visible &&
      !part.locked &&
      !hiddenByIsolation(state.isolated, state.nearbyParts, part.id),
  );
  const joint =
    parts.length === 1
      ? scene.joints.find((joint) => joint.childId === parts[0].id && isJointConnected(joint))
      : undefined;
  const primary = parts.find((part) => part.id === selected[0]);
  const parent = joint ? scene.parts.find((part) => part.id === joint.parentId) : undefined;
  const axes =
    joint && parent ? 'joint' : view.space === 'local' && parts.length === 1 ? 'local' : 'world';
  const orientation =
    joint && parent
      ? quat(parent.quaternion).multiply(quat(joint.restRotation))
      : axes === 'local'
        ? quat(parts[0].quaternion)
        : new Quaternion();
  const pivot =
    joint && tool !== 'translate'
      ? partPivot(parts[0], joint.childAnchor)
      : primary?.pivot
        ? partPivot(primary)
        : sceneBounds(parts).getCenter(new Vector3());
  const pivotLabel =
    joint && tool !== 'translate'
      ? 'Joint anchor'
      : primary?.pivot
        ? 'Custom pivot'
        : parts.length > 1
          ? 'Selection center'
          : 'Mesh center';
  const locks = tool === 'rotate' ? joint?.rotationLocks : undefined;
  const blocked = !selected.length
    ? 'Select a part in the viewport or parts list.'
    : view.explode > 0
      ? 'Reset the exploded view to adjust parts.'
      : !parts.length
        ? 'Select a visible, unlocked part to adjust it.'
        : state.pivotPicking
          ? 'Pick a pivot on the model or press Escape to return.'
          : state.navigationMode || state.temporaryOrbit
            ? 'Finish camera navigation to adjust parts.'
            : tool === 'translate' &&
                parts.some((part) => translationIsPinned(scene.parts, scene.joints, part.id))
              ? 'A locked connected part prevents movement. Unlock it or turn Keep connected off.'
              : locks?.every(Boolean)
                ? 'All joint rotation axes are locked. Free an axis in Connections.'
                : null;
  return {
    parts,
    joint,
    axes,
    orientation,
    pivot,
    pivotLabel,
    locks,
    blocked,
    skipped: selected.length - parts.length,
  };
}

/** A rigid incremental edit: preserve geometry and scale, including mirrored parts. */
export function stepTransform(
  selection: ReturnType<typeof transformSelection>,
  mode: 'translate' | 'rotate',
  axis: 0 | 1 | 2,
  amount: number,
): { id: string; patch: Partial<Part> }[] {
  if (selection.blocked || selection.locks?.[axis] || !Number.isFinite(amount) || amount === 0)
    return [];
  const direction = new Vector3().setComponent(axis, 1).applyQuaternion(selection.orientation);
  const rotation = new Quaternion().setFromAxisAngle(direction, radians(amount));
  return selection.parts.map((part) => ({
    id: part.id,
    patch:
      mode === 'translate'
        ? { position: vec(part.position).addScaledVector(direction, amount).toArray() }
        : {
            position: vec(part.position)
              .sub(selection.pivot)
              .applyQuaternion(rotation)
              .add(selection.pivot)
              .toArray(),
            quaternion: rotation.clone().multiply(quat(part.quaternion)).normalize().toArray(),
          },
  }));
}
