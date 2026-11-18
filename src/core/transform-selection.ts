import { Quaternion, Vector3 } from 'three';
import { isJointConnected, translationIsPinned } from './constraints';
import { partPivot, quat, radians, sceneBounds, vec } from './geometry';
import { hiddenByIsolation } from './isolation';
import type { TransformPatch } from './free-transform';
import type { useEditor } from './store';
import type { Part, Tool, Vec3 } from './types';
import { untouchedAuto, writtenCentre } from './warp-handles';

type EditorState = ReturnType<typeof useEditor.getState>;
type TransformState = Pick<
  EditorState,
  | 'scene'
  | 'selected'
  | 'view'
  | 'isolated'
  | 'nearbyParts'
  | 'pivotPicking'
  | 'navigationMode'
  | 'temporaryOrbit'
  | 'tool'
  | 'warp'
>;

/** What the transform tools move: a part, or a warp control point at its world position. */
export type TransformTarget = Pick<Part, 'id' | 'position' | 'quaternion' | 'scale'>;
export type WarpTransformSelection = Extract<
  ReturnType<typeof transformSelection>,
  { kind: 'warp' }
>;

/** While a grid is laid, the transform tools move the session's control points. */
export const warpingPoints = (state: Pick<EditorState, 'tool' | 'warp'>) =>
  state.tool === 'warp' && state.warp?.stage === 'warp';

/** The tool the transform handles and adjustments follow: the warp gizmo while warping. */
export function activeTransformTool(state: Pick<EditorState, 'tool' | 'warp'>): Tool {
  return warpingPoints(state) ? state.warp!.gizmo : state.tool;
}

function pointSelection(state: TransformState) {
  const warp = state.warp!;
  const parts: TransformTarget[] = warp.points
    .filter((point) => warp.selectedPoints.includes(point.id))
    .map((point) => ({
      id: point.id,
      // An untouched automatic point may have ridden with a bump: it is taken where it is now.
      position:
        point.target ??
        (untouchedAuto(point) && warp.model && warp.state
          ? writtenCentre(warp.model, warp.state, point)
          : point.pin),
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
    }));
  const pivot = new Vector3();
  for (const part of parts) pivot.add(vec(part.position));
  if (parts.length) pivot.divideScalar(parts.length);
  return {
    kind: 'warp' as const,
    parts,
    joint: undefined,
    axes: 'world' as const,
    orientation: new Quaternion(),
    pivot,
    pivotLabel: parts.length === 1 ? 'Control point' : 'Point center',
    locks: undefined,
    blocked: !parts.length
      ? 'Select a control point to move it.'
      : state.view.explode > 0
        ? 'Reset the exploded view to move control points.'
        : state.pivotPicking
          ? 'Pick a pivot on the model or press Escape to return.'
          : state.navigationMode || state.temporaryOrbit
            ? 'Finish camera navigation to move control points.'
            : null,
    skipped: 0,
  };
}

/** The same selection, pivot, and axes for handles and precise button adjustments. */
export function transformSelection(state: TransformState, tool: Tool) {
  if (warpingPoints(state)) return pointSelection(state);
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
  const locks = tool === 'rotate' || tool === 'transform' ? joint?.rotationLocks : undefined;
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
              : tool === 'rotate' && locks?.every(Boolean)
                ? 'All joint rotation axes are locked. Free an axis in Connections.'
                : null;
  return {
    kind: 'parts' as const,
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

/**
 * World targets for the control points a transform patched. A point has no orientation or
 * size of its own, so turning or scaling a single point about itself moves nothing.
 */
export function warpMovesFromPatches(
  selection: WarpTransformSelection,
  patches: TransformPatch[],
): { id: string; target: Vec3 }[] {
  const points = new Map(selection.parts.map((point) => [point.id, point]));
  const single = selection.parts.length === 1;
  return patches.flatMap(({ id, patch }) => {
    const point = points.get(id);
    if (!point) return [];
    const scales = !!patch.scale?.some((value) => Math.abs(value - 1) > 1e-9);
    const turns = !!patch.quaternion && quat(patch.quaternion).angleTo(new Quaternion()) > 1e-9;
    if (single && (scales || turns)) return [];
    if (patch.position) return [{ id, target: patch.position }];
    if (!patch.scale) return [];
    // Scale the point's offset from the pivot in the handle frame.
    const inverse = selection.orientation.clone().invert();
    const offset = vec(point.position).sub(selection.pivot).applyQuaternion(inverse);
    offset.multiply(vec(patch.scale).divide(vec(point.scale)));
    return [
      {
        id,
        target: offset.applyQuaternion(selection.orientation).add(selection.pivot).toArray(),
      },
    ];
  });
}
