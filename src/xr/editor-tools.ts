import { Quaternion, Vector3 } from 'three';
import { isJointConnected } from '../core/constraints';
import { poseAtPivot, quat, worldPoint } from '../core/geometry';
import { hiddenByIsolation } from '../core/isolation';
import { resolvePart } from '../core/references';
import { useEditor } from '../core/store';
import { completedSurfacePairs } from '../core/surfaces';
import type { AlignmentMode, Part, SurfaceMethod, SurfacePoint, Tool, Vec3 } from '../core/types';

export const xrToolChoices: { tool: Tool; label: string }[] = [
  { tool: 'select', label: 'Grab / select' },
  { tool: 'translate', label: 'Move' },
  { tool: 'rotate', label: 'Rotate' },
  { tool: 'scale', label: 'Scale' },
  { tool: 'align', label: 'Align / paint' },
  { tool: 'joint', label: 'Joint' },
  { tool: 'measure', label: 'Measure' },
  { tool: 'anchors', label: 'Anchors' },
];

const alignModes: { mode: AlignmentMode; label: string }[] = [
  { mode: 'point', label: 'Point to point' },
  { mode: 'point-plane', label: 'Point to plane' },
  { mode: 'plane', label: 'Plane to plane' },
  { mode: 'multi', label: '3+ point fit' },
  { mode: 'surface', label: 'Paint surfaces' },
];
const surfaceMethods: { method: SurfaceMethod; label: string }[] = [
  { method: 'contact', label: 'Contact fit' },
  { method: 'flush', label: 'Flush seams' },
  { method: 'mate', label: 'Mate planes' },
  { method: 'parallel', label: 'Parallel' },
  { method: 'perpendicular', label: 'Perpendicular' },
  { method: 'angle', label: 'Angled planes' },
];

export type XRToolAction =
  | 'advance'
  | 'back'
  | 'apply'
  | 'resetPicks'
  | 'alignMode'
  | 'surfaceMethod'
  | 'erase'
  | 'paintUndo'
  | 'flip'
  | 'anchorAdd'
  | 'anchorNext'
  | 'anchorRemove'
  | 'anchorRebase'
  | 'duplicate'
  | 'isolate'
  | 'lock'
  | 'hide'
  | 'showAll'
  | 'jointLockX'
  | 'jointLockY'
  | 'jointLockZ'
  | 'keepConnected';

export interface XRToolButton {
  action: XRToolAction;
  label: string;
  enabled: boolean;
  on?: boolean;
}

export interface XRAdjustmentGesture {
  baseline: Part[];
  patches: { id: string; patch: Partial<Part> }[] | null;
}

/** Finish the budgeted collision pass against the original geometry on stick release. */
export function xrFinishAdjustment(gesture: XRAdjustmentGesture) {
  const state = useEditor.getState();
  if (!state.view.clip.enabled || !gesture.patches) return;
  const patches = gesture.patches.filter(({ id }) => {
    const current = state.scene.parts.find((part) => part.id === id);
    const start = gesture.baseline.find((part) => part.id === id);
    return current && start && current.geometry === start.geometry;
  });
  if (patches.length) state.transformMany(patches, false, true, true, undefined, gesture.baseline);
}

const activePart = () => {
  const state = useEditor.getState();
  return state.scene.parts.find((part) => part.id === state.selected[0]);
};
const activeAnchor = (part = activePart()) => {
  const anchors = part?.anchors ?? [];
  return anchors.find((anchor) => anchor.id === useEditor.getState().activeAnchor) ?? anchors[0];
};

/** Cheap availability checks; the editor's solver still validates geometry and constraints. */
export function xrCanApply(): boolean {
  const state = useEditor.getState(),
    op = state.operation;
  if (
    state.busy ||
    state.painting ||
    state.view.explode ||
    state.view.inspection.enabled ||
    (state.tool !== 'align' && state.tool !== 'joint') ||
    op.pending
  )
    return false;
  const source = state.scene.parts.find((part) => part.id === op.sourceId);
  if (!source?.visible || source.locked || !resolvePart(state.scene, op.targetId)) return false;
  if (state.tool === 'joint') return op.pairs.length > 0;
  if (op.mode !== 'surface') return op.pairs.length >= (op.mode === 'multi' ? 3 : 1);
  const complete = completedSurfacePairs(op.surfacePairs).length;
  return (
    complete >= ((op.surfaceMethod ?? 'contact') === 'contact' ? 3 : 1) &&
    complete === op.surfacePairs.length
  );
}

export function xrApply() {
  if (!xrCanApply()) return;
  const state = useEditor.getState();
  if (state.tool === 'joint') state.createJoint();
  else state.applyAlignment();
}

/** All points use the original mesh's local coordinates, just like desktop picks. */
export function xrPick(point: SurfacePoint, _face: number | null = null) {
  const state = useEditor.getState();
  if (state.busy || state.view.explode || state.view.inspection.enabled) return;
  const hit = resolvePart(state.scene, point.partId);
  if (!hit?.visible || hiddenByIsolation(state.isolated, state.nearbyParts, hit.id)) return;
  if (state.tool === 'anchors') {
    if (state.anchorPicking) state.addFitAnchor(point);
    else {
      const part = activePart(),
        anchor = activeAnchor(part);
      if (part && anchor) state.moveFitAnchor(part.id, anchor.id, worldPoint(hit, point).toArray());
    }
  } else if (
    state.tool === 'measure' ||
    state.tool === 'joint' ||
    (state.tool === 'align' && state.operation.mode !== 'surface')
  ) {
    if (state.tool !== 'measure' && !state.operation.pending && hit.locked) {
      state.notify('Unlock the moving part first.', 'info');
      return;
    }
    state.pick(point);
  } else if (state.tool !== 'align') state.select(point.partId);
}

/** Advance only the active tool. Painted pairs finish explicitly before another is added. */
export function xrAdvance(point?: SurfacePoint | null) {
  const state = useEditor.getState(),
    op = state.operation;
  if (state.busy || state.painting) return;
  if (state.tool === 'align' && op.mode === 'surface') {
    const active = op.activeSurface;
    if (!active) {
      state.addSurfacePair();
      return;
    }
    const pair = op.surfacePairs.find((pair) => pair.id === active.pairId);
    if (!pair?.[active.side]?.faces.length) {
      state.notify(
        `Paint the ${active.side === 'source' ? 'moving' : 'target'} patch first.`,
        'info',
      );
      return;
    }
    if (active.side === 'source') state.chooseSurface(pair.id, 'target');
    else state.setOperation({ activeSurface: null });
  } else if (state.tool === 'anchors' && state.anchorPicking && activePart()?.anchors?.length) {
    useEditor.setState({ anchorPicking: false });
  } else if (xrCanApply()) xrApply();
  else if (point) xrPick(point);
}

/** Back reverses a pick or a paint stage without undoing a completed scene edit. */
export function xrBack() {
  const state = useEditor.getState(),
    op = state.operation;
  if (state.painting) state.endPaintStroke();
  if (state.tool === 'measure') {
    useEditor.setState({ measurement: state.measurement.slice(0, -1) });
  } else if (state.tool === 'align' && op.mode === 'surface') {
    const index = op.surfacePairs.findIndex((pair) => pair.id === op.activeSurface?.pairId);
    if (!op.activeSurface) {
      const last = op.surfacePairs.at(-1);
      if (last) state.chooseSurface(last.id, last.target?.faces.length ? 'target' : 'source');
    } else if (op.activeSurface.side === 'target') {
      state.chooseSurface(op.activeSurface.pairId, 'source');
    } else if (index > 0) {
      const current = op.surfacePairs[index];
      // A newly added, unpainted pair is removed when stepping back into the previous one.
      state.setOperation({
        surfacePairs:
          !current.source?.faces.length && !current.target?.faces.length
            ? op.surfacePairs.filter((pair) => pair.id !== current.id)
            : op.surfacePairs,
        activeSurface: { pairId: op.surfacePairs[index - 1].id, side: 'target' },
      });
    }
  } else if (state.tool === 'align' || state.tool === 'joint') {
    if (op.pending) state.setOperation({ pending: null });
    else if (op.pairs.length)
      state.setOperation({
        pairs: op.pairs.slice(0, -1),
        pending: op.pairs.at(-1)!.source,
      });
  } else if (state.tool === 'anchors') useEditor.setState({ anchorPicking: false });
}

export function xrToolStatus(): string {
  const state = useEditor.getState(),
    op = state.operation;
  if (state.tool === 'measure') {
    const points = state.measurement.map((point) => {
      const part = resolvePart(state.scene, point.partId);
      return part ? worldPoint(part, point) : null;
    });
    return points[0] && points[1]
      ? `${points[0].distanceTo(points[1]).toFixed(3)} mm · pick to measure again`
      : `Measure · pick ${points.length ? 'end' : 'start'} point`;
  }
  if (state.tool === 'anchors') {
    const part = activePart(),
      anchor = activeAnchor(part),
      anchors = part?.anchors ?? [];
    return state.anchorPicking
      ? `Add anchors · ${anchors.length} placed · advance to finish`
      : anchor
        ? `Anchor ${anchors.indexOf(anchor) + 1}/${anchors.length} · pick target or nudge`
        : 'Choose a part and add anchors';
  }
  if (state.tool === 'align' && op.mode === 'surface') {
    const index = op.surfacePairs.findIndex((pair) => pair.id === op.activeSurface?.pairId);
    return op.activeSurface
      ? `Pair ${index + 1}: ${state.brushErase ? 'erase' : 'paint'} ${op.activeSurface.side === 'source' ? 'moving' : 'target'} · ${state.brushRadius.toFixed(2)} mm brush`
      : `${completedSurfacePairs(op.surfacePairs).length} pairs finished · add pair or apply`;
  }
  if (state.tool === 'align' || state.tool === 'joint') {
    const offset = state.tool === 'align' ? ` · offset ${op.offset.toFixed(2)} mm` : '';
    if (xrCanApply())
      return state.tool === 'joint'
        ? 'Anchors ready · create joint'
        : `${op.pairs.length} pairs ready · apply${op.mode === 'multi' ? ' or add pair' : ''}${offset}`;
    return `${state.tool === 'joint' ? 'Joint' : `Pair ${op.pairs.length + 1}`} · pick ${op.pending ? 'target' : 'moving'} point${offset}`;
  }
  return state.selected.length
    ? `${state.selected.length} selected · sticks adjust · grip moves world`
    : 'Trigger selects / grabs · grip moves world';
}

export function xrToolButtons(): XRToolButton[] {
  const state = useEditor.getState(),
    op = state.operation;
  const button = (
    action: XRToolAction,
    label: string,
    enabled = true,
    on?: boolean,
  ): XRToolButton => ({
    action,
    label,
    enabled: enabled && !state.busy,
    ...(on === undefined ? {} : { on }),
  });
  const apply = button(
    'apply',
    state.tool === 'joint' ? 'Create joint' : 'Apply fit',
    xrCanApply(),
  );
  const back = button('back', 'Back');
  const reset = button('resetPicks', 'Reset picks');
  if (state.tool === 'align') {
    const mode = button('alignMode', alignModes.find((entry) => entry.mode === op.mode)!.label);
    if (op.mode === 'surface') {
      const active = op.surfacePairs.find((pair) => pair.id === op.activeSurface?.pairId);
      return [
        mode,
        button(
          'surfaceMethod',
          surfaceMethods.find((entry) => entry.method === (op.surfaceMethod ?? 'contact'))!.label +
            (op.surfaceMethod === 'angle'
              ? ` ${(op.planeAngle ?? 0).toFixed(1)}°`
              : ` ${op.offset.toFixed(2)} mm`),
        ),
        button(
          'advance',
          op.activeSurface?.side === 'source'
            ? 'Next: target'
            : op.activeSurface
              ? 'Finish pair'
              : 'Add pair',
          !state.painting && (!op.activeSurface || !!active?.[op.activeSurface.side]?.faces.length),
        ),
        back,
        apply,
        button('erase', 'Erase', true, state.brushErase),
        button('paintUndo', 'Undo stroke', state.paintHistory.length > 0),
        reset,
      ];
    }
    return [
      mode,
      button(
        'advance',
        xrCanApply() ? 'Apply fit' : op.pending ? 'Aim at target' : 'Aim at moving part',
        xrCanApply(),
      ),
      back,
      apply,
      button('flip', 'Oppose normals', op.mode !== 'point', op.flipNormal),
      reset,
    ];
  }
  if (state.tool === 'joint')
    return [
      apply,
      back,
      reset,
      ...(['X', 'Y', 'Z'] as const).map((axis, i) =>
        button(`jointLock${axis}`, `Lock ${axis}`, true, op.rotationLocks[i]),
      ),
      button('keepConnected', 'Keep connected', true, op.keepConnected),
    ];
  if (state.tool === 'measure') return [back, reset];
  if (state.tool === 'anchors') {
    const part = activePart(),
      anchor = activeAnchor(part);
    const editable = !!part?.visible && !part.locked && !state.view.explode;
    return [
      button(
        'anchorAdd',
        state.anchorPicking ? 'Finish anchors' : 'Add anchors',
        editable,
        state.anchorPicking,
      ),
      button('anchorNext', 'Next anchor', !!anchor),
      button('anchorRemove', 'Remove anchor', editable && !!anchor),
      button('anchorRebase', 'Hold current pose', editable && !!anchor),
    ];
  }
  const selected = state.scene.parts.filter((part) => state.selected.includes(part.id));
  return [
    button('duplicate', 'Duplicate', selected.length > 0),
    button('isolate', 'Isolate', selected.length > 0 || !!state.isolated, !!state.isolated),
    button('lock', selected.every((part) => part.locked) ? 'Unlock' : 'Lock', selected.length > 0),
    button('hide', 'Hide', selected.length > 0),
    button('showAll', 'Show all'),
  ];
}

export function xrRunToolAction(action: XRToolAction) {
  const state = useEditor.getState(),
    op = state.operation;
  if (state.busy) return;
  switch (action) {
    case 'advance':
      xrAdvance();
      break;
    case 'back':
      xrBack();
      break;
    case 'apply':
      xrApply();
      break;
    case 'resetPicks':
      state.resetPicks();
      if (state.tool === 'align' && op.mode === 'surface') state.addSurfacePair();
      break;
    case 'alignMode':
      state.setOperation({
        mode: alignModes[
          (alignModes.findIndex((entry) => entry.mode === op.mode) + 1) % alignModes.length
        ].mode,
      });
      break;
    case 'surfaceMethod':
      state.setOperation({
        surfaceMethod:
          surfaceMethods[
            (surfaceMethods.findIndex((entry) => entry.method === (op.surfaceMethod ?? 'contact')) +
              1) %
              surfaceMethods.length
          ].method,
      });
      break;
    case 'erase':
      state.setBrush({ erase: !state.brushErase });
      break;
    case 'paintUndo':
      state.undoPaintStroke();
      break;
    case 'flip':
      state.setOperation({ flipNormal: !op.flipNormal });
      break;
    case 'anchorAdd':
      useEditor.setState({ anchorPicking: !state.anchorPicking });
      break;
    case 'anchorNext': {
      const anchors = activePart()?.anchors ?? [],
        anchor = activeAnchor();
      if (anchors.length)
        useEditor.setState({
          activeAnchor: anchors[(anchors.indexOf(anchor!) + 1) % anchors.length].id,
          anchorPicking: false,
        });
      break;
    }
    case 'anchorRemove': {
      const part = activePart(),
        anchor = activeAnchor(part);
      if (part && anchor) state.removeFitAnchor(part.id, anchor.id);
      break;
    }
    case 'anchorRebase': {
      const part = activePart();
      if (part) state.rebaseFitAnchors(part.id);
      break;
    }
    case 'duplicate':
      state.duplicateSelected();
      break;
    case 'isolate':
      state.toggleIsolation();
      break;
    case 'lock':
      state.patchParts(state.selected, {
        locked: !state.scene.parts
          .filter((part) => state.selected.includes(part.id))
          .every((part) => part.locked),
      });
      break;
    case 'hide':
      state.patchParts(state.selected, { visible: false });
      break;
    case 'showAll':
      state.patchParts(
        state.scene.parts.map((part) => part.id),
        { visible: true },
      );
      state.isolate(null);
      break;
    case 'jointLockX':
    case 'jointLockY':
    case 'jointLockZ': {
      const i = { jointLockX: 0, jointLockY: 1, jointLockZ: 2 }[action];
      const rotationLocks = [...op.rotationLocks] as typeof op.rotationLocks;
      rotationLocks[i] = !rotationLocks[i];
      state.setOperation({ rotationLocks });
      break;
    }
    case 'keepConnected':
      state.setOperation({ keepConnected: !op.keepConnected });
      break;
  }
}

/**
 * Amount is signed stick intensity × elapsed seconds. Translation is 10 mm/s, rotation
 * 45°/s; precision divides both by ten. Horizontal translates X, vertical the selected
 * axis. Rotation uses the selected axis horizontally, and a perpendicular axis vertically.
 * The runtime supplies one checkpoint per stick gesture, including both controllers.
 */
export function xrAdjust(
  axis: 'x' | 'y',
  amount: number,
  mode: 'translate' | 'rotate' | 'context',
  precision: boolean,
  checkpoint = true,
  selectedAxis: 'x' | 'y' | 'z' = 'y',
  gesture?: XRAdjustmentGesture,
): boolean {
  const state = useEditor.getState();
  if (
    !Number.isFinite(amount) ||
    !amount ||
    state.busy ||
    state.view.explode ||
    state.view.inspection.enabled
  )
    return false;
  const step = amount * (precision ? 0.1 : 1);
  if (mode === 'context' && state.tool === 'align') {
    if (state.operation.mode === 'surface') {
      if (axis === 'y') {
        state.setBrush({ radius: state.brushRadius * Math.exp(step) });
        return useEditor.getState().brushRadius !== state.brushRadius;
      }
      if (state.operation.surfaceMethod === 'angle') {
        state.setOperation({
          planeAngle: Math.max(0, Math.min(180, (state.operation.planeAngle ?? 0) + step * 45)),
        });
      } else state.setOperation({ offset: state.operation.offset + step });
      return true;
    }
    if (axis !== 'y') return false;
    state.setOperation({ offset: state.operation.offset + step });
    return true;
  }
  const parts = state.scene.parts.filter(
    (part) =>
      state.selected.includes(part.id) &&
      part.visible &&
      !part.locked &&
      !hiddenByIsolation(state.isolated, state.nearbyParts, part.id),
  );
  if (!parts.length || state.tool === 'measure') return false;
  const direction = new Vector3();
  const translationAxis = axis === 'x' ? 'x' : selectedAxis;
  if (state.tool === 'anchors') {
    const part = parts.find((part) => part.id === state.selected[0]),
      anchor = activeAnchor(part);
    if (!part || !anchor || state.anchorPicking) return false;
    const target: Vec3 = [...anchor.target];
    target[{ x: 0, y: 1, z: 2 }[translationAxis]] += step * 10;
    state.moveFitAnchor(part.id, anchor.id, target, checkpoint);
    return useEditor.getState().scene.parts !== state.scene.parts;
  }
  const scaling = mode === 'context' && state.tool === 'scale';
  const rotate =
    mode === 'rotate' || (mode === 'context' && state.tool !== 'translate' && !scaling);
  const rotationAxis = axis === 'x' ? selectedAxis : selectedAxis === 'x' ? 'z' : 'x';
  direction[rotate ? rotationAxis : translationAxis] = 1;
  const rotation = new Quaternion().setFromAxisAngle(direction, (step * Math.PI) / 4);
  const patches = parts.map((part): { id: string; patch: Partial<Part> } => {
    const joint = state.scene.joints.find(
      (joint) => joint.childId === part.id && isJointConnected(joint),
    );
    if (scaling) {
      const factor = Math.exp(step * 0.5);
      const scale = part.scale.map(
        (value) => Math.sign(value) * Math.min(1000, Math.max(0.001, Math.abs(value) * factor)),
      ) as Vec3;
      const next = poseAtPivot(part, { scale }, joint?.childAnchor);
      return { id: part.id, patch: { position: next.position, scale } };
    }
    if (rotate) {
      const next = poseAtPivot(
        part,
        { quaternion: rotation.clone().multiply(quat(part.quaternion)).toArray() },
        joint?.childAnchor,
      );
      return { id: part.id, patch: { position: next.position, quaternion: next.quaternion } };
    }
    return {
      id: part.id,
      patch: {
        position: new Vector3(...part.position).addScaledVector(direction, step * 10).toArray(),
      },
    };
  });
  if (gesture) gesture.patches = patches;
  state.transformMany(patches, checkpoint, true, false, 5);
  return useEditor.getState().scene.parts !== state.scene.parts;
}
