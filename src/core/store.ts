import { create } from 'zustand';
import { Quaternion } from 'three';
import type { BufferGeometry } from 'three';
import { quat, triangleCount, uid, worldPoint } from './geometry';
import {
  anchorError,
  constrainPart,
  isJointConnected,
  transformAssembly,
  validateJoint,
} from './constraints';
import { solveAlignment } from './alignment';
import {
  planeKindLabels,
  solvePlaneConstraints,
  validatePlaneConstraints,
} from './plane-constraints';
import {
  completedSurfacePairs,
  contiguousRemainder,
  facesUnderBrush,
  maxPaintTriangles,
} from './surfaces';
import { readOrbitPreference, saveOrbitPreference } from './navigation';
import type { NavigationMode } from './navigation';
import { createSample } from './sample';
import { captureComponents, instantiateComponents } from './clipboard';
import type { ComponentClipboard } from './clipboard';
import { referencePlanes, resolvePart } from './references';
import type {
  AssemblyOperation,
  BrushPlaneSettings,
  Joint,
  PlaneConstraint,
  Part,
  SceneDocument,
  SurfacePoint,
  SurfacePair,
  SurfaceSide,
  Tool,
  ViewSettings,
} from './types';

export type Modal = 'export' | 'import' | 'merge' | 'help' | 'new' | 'rename' | null;
export interface EditorContextMenu {
  x: number;
  y: number;
  partId?: string;
  point?: SurfacePoint;
}
type Toast = { id: string; message: string; kind: 'success' | 'error' | 'info' };
const emptySurfacePair = (): SurfacePair => ({ id: uid(), source: null, target: null });
const blankOperation = (mode: AssemblyOperation['mode'] = 'point'): AssemblyOperation => ({
  mode,
  sourceId: null,
  targetId: null,
  pairs: [],
  surfacePairs: [],
  activeSurface: null,
  pending: null,
  flipNormal: true,
  offset: 0,
  surfaceMethod: 'contact',
  planeAngle: 0,
  retainConstraint: false,
  rotationLocks: [true, false, true],
  keepConnected: true,
});
const hasOperationWork = (op: AssemblyOperation) =>
  op.pairs.length > 0 ||
  !!op.pending ||
  op.surfacePairs.some((pair) => pair.source?.faces.length || pair.target?.faces.length);
const initialScene = createSample();
const historyLimit = 40;

interface EditorState {
  scene: SceneDocument;
  selected: string[];
  clipboard: ComponentClipboard | null;
  contextMenu: EditorContextMenu | null;
  tool: Tool;
  navigationMode: NavigationMode | null;
  temporaryOrbit: boolean;
  precision: boolean;
  pivotRequest: number;
  pivotPicking: boolean;
  painting: boolean;
  brushRadius: number;
  brushErase: boolean;
  brushPlane: BrushPlaneSettings;
  paintHistory: SurfacePair[][];
  operation: AssemblyOperation;
  view: ViewSettings;
  past: SceneDocument[];
  future: SceneDocument[];
  revision: number;
  savedRevision: number;
  recoveryStatus: 'saving' | 'saved' | 'error';
  modal: Modal;
  toast: Toast | null;
  busy: string | null;
  indexingMeshes: number;
  focusRequest: {
    id: number;
    view?: 'front' | 'back' | 'right' | 'left' | 'top' | 'bottom' | 'iso';
    all?: boolean;
  };
  measurement: SurfacePoint[];
  select: (id: string | null, additive?: boolean) => void;
  selectAll: () => void;
  isolateSelected: () => void;
  copySelected: (cut?: boolean) => void;
  pasteClipboard: () => void;
  openContextMenu: (menu: EditorContextMenu) => void;
  closeContextMenu: () => void;
  setTool: (tool: Tool) => void;
  setNavigationMode: (mode: NavigationMode | null) => void;
  centerOrbit: () => void;
  setPivotPicking: (enabled: boolean) => void;
  setPartPivot: (point: SurfacePoint) => void;
  clearPartPivot: (id: string) => void;
  setBrush: (patch: {
    radius?: number;
    erase?: boolean;
    plane?: Partial<BrushPlaneSettings>;
  }) => void;
  addSurfacePair: () => void;
  chooseSurface: (pairId: string, side: SurfaceSide) => void;
  paintSurface: (point: SurfacePoint, face: number, erase?: boolean, begin?: boolean) => boolean;
  endPaintStroke: () => void;
  undoPaintStroke: () => void;
  setOperation: (patch: Partial<AssemblyOperation>) => void;
  resetPicks: () => void;
  pick: (point: SurfacePoint) => void;
  applyAlignment: () => void;
  createJoint: () => void;
  updateJoint: (id: string, patch: Partial<Joint>) => void;
  removeJoint: (id: string) => void;
  updateConstraint: (id: string, patch: Partial<PlaneConstraint>) => void;
  removeConstraint: (id: string) => void;
  transform: (id: string, patch: Partial<Part>, checkpoint?: boolean) => void;
  transformMany: (
    patches: { id: string; patch: Partial<Part> }[],
    checkpoint?: boolean,
    moveConnected?: boolean,
  ) => void;
  patchParts: (ids: string[], patch: Partial<Part>, checkpoint?: boolean) => void;
  addParts: (parts: Part[]) => void;
  deleteSelected: () => void;
  duplicateSelected: () => void;
  replaceWithMerged: (part: Part, ids: string[]) => void;
  setScene: (scene: SceneDocument, recovered?: boolean) => void;
  renameScene: (name: string) => void;
  undo: () => void;
  redo: () => void;
  setView: (patch: Partial<ViewSettings>) => void;
  setModal: (modal: Modal) => void;
  setBusy: (busy: string | null) => void;
  notify: (message: string, kind?: Toast['kind']) => void;
  focus: (view?: EditorState['focusRequest']['view'], all?: boolean) => void;
  markSaved: (revision: number) => void;
}

const changed = (state: EditorState, scene: SceneDocument, checkpoint = true) => ({
  scene,
  revision: state.revision + 1,
  ...(checkpoint
    ? { past: [...state.past.slice(-(historyLimit - 1)), state.scene], future: [] }
    : {}),
});

/** Picks on a removed part can never be completed, so restart the active tool. */
const withoutRemovedParts = (state: EditorState, ids: string[]) => {
  const op = state.operation;
  const stale = [op.sourceId, op.targetId].some((id) => id && ids.includes(id));
  return {
    measurement: state.measurement.filter((point) => !ids.includes(point.partId)),
    ...(stale ? { operation: blankOperation(op.mode), painting: false, paintHistory: [] } : {}),
  };
};

export const useEditor = create<EditorState>((set, get) => ({
  scene: initialScene,
  selected: ['torso'],
  clipboard: null,
  contextMenu: null,
  tool: 'select',
  navigationMode: null,
  temporaryOrbit: false,
  precision: false,
  pivotRequest: 0,
  pivotPicking: false,
  painting: false,
  brushRadius: 3,
  brushErase: false,
  brushPlane: { enabled: false, angle: 20, distance: 0.5 },
  paintHistory: [],
  operation: blankOperation(),
  view: {
    inspection: {
      enabled: false,
      scope: 'all',
      distance: 0.5,
      overlap: true,
      proximity: true,
      closestPoints: false,
      context: true,
    },
    orbitSelection: readOrbitPreference(),
    grid: true,
    joints: false,
    wireframe: false,
    snap: false,
    snapStep: 1,
    projection: 'perspective',
    explode: 0,
    space: 'world',
    planes: [],
  },
  past: [],
  future: [],
  revision: 0,
  savedRevision: 0,
  recoveryStatus: 'saved',
  modal: null,
  toast: null,
  busy: null,
  indexingMeshes: 0,
  focusRequest: { id: 0, all: true },
  measurement: [],
  select: (id, additive = false) =>
    set((state) => ({
      selected: id
        ? additive
          ? state.selected.includes(id)
            ? state.selected.filter((i) => i !== id)
            : [...state.selected, id]
          : [id]
        : [],
    })),
  selectAll: () => set((state) => ({ selected: state.scene.parts.map((part) => part.id) })),
  isolateSelected: () =>
    set((state) => {
      if (!state.selected.length) return {};
      const ids = new Set(state.selected);
      if (!state.scene.parts.some((part) => part.visible !== ids.has(part.id))) return {};
      return changed(state, {
        ...state.scene,
        parts: state.scene.parts.map((part) => ({ ...part, visible: ids.has(part.id) })),
      });
    }),
  copySelected: (cut = false) => {
    const state = get();
    const clipboard = captureComponents(state.scene, state.selected, cut);
    if (!clipboard.parts.length) return;
    const ids = new Set(clipboard.parts.map((part) => part.id));
    set({
      clipboard,
      ...(cut
        ? {
            ...changed(state, {
              ...state.scene,
              parts: state.scene.parts.filter((part) => !ids.has(part.id)),
              joints: state.scene.joints.filter(
                (joint) => !ids.has(joint.parentId) && !ids.has(joint.childId),
              ),
              constraints: state.scene.constraints?.filter(
                (c) => !ids.has(c.sourceId) && !ids.has(c.targetId),
              ),
            }),
            selected: state.selected.filter((id) => !ids.has(id)),
            operation: blankOperation(),
            paintHistory: [],
          }
        : {}),
    });
    const count = clipboard.parts.length;
    const skipped = cut && state.selected.length > count ? ' · locked parts kept' : '';
    state.notify(
      `${count} ${count === 1 ? 'component' : 'components'} ${cut ? 'cut' : 'copied'}${skipped}`,
    );
  },
  pasteClipboard: () => {
    const state = get();
    if (!state.clipboard?.parts.length) return;
    const copies = instantiateComponents(state.clipboard, state.scene.parts);
    set({
      ...changed(state, {
        ...state.scene,
        parts: [...state.scene.parts, ...copies.parts],
        joints: [...state.scene.joints, ...copies.joints],
        constraints: [...(state.scene.constraints ?? []), ...copies.constraints],
      }),
      selected: copies.parts.map((part) => part.id),
      clipboard: { ...state.clipboard, nextOffset: state.clipboard.nextOffset + 1 },
      operation: blankOperation(),
      paintHistory: [],
    });
  },
  openContextMenu: (contextMenu) =>
    set((state) => ({
      contextMenu,
      selected:
        contextMenu.partId && !state.selected.includes(contextMenu.partId)
          ? [contextMenu.partId]
          : state.selected,
    })),
  closeContextMenu: () => set({ contextMenu: null }),
  setTool: (tool) =>
    set((state) => {
      // Re-selecting the active tool must not discard picks or painted patches.
      if (tool === state.tool && hasOperationWork(state.operation))
        return { navigationMode: null, pivotPicking: false };
      const mode = tool === 'joint' ? 'point' : state.operation.mode;
      const pair = mode === 'surface' ? emptySurfacePair() : null;
      return {
        tool,
        navigationMode: null,
        pivotPicking: false,
        painting: false,
        paintHistory: [],
        measurement: [],
        operation: {
          ...blankOperation(mode),
          sourceId: state.selected[0] ?? null,
          targetId: state.selected[1] ?? null,
          surfacePairs: pair ? [pair] : [],
          activeSurface: pair ? { pairId: pair.id, side: 'source' as const } : null,
        },
        view: { ...state.view, explode: 0 },
      };
    }),
  setNavigationMode: (navigationMode) =>
    set(() => ({
      navigationMode,
      pivotPicking: false,
      painting: false,
    })),
  centerOrbit: () => {
    const state = get();
    if (!state.scene.parts.some((part) => part.visible && state.selected.includes(part.id))) {
      state.notify('Select a visible part to set the orbit center.', 'info');
      return;
    }
    set({ pivotRequest: state.pivotRequest + 1 });
  },
  setPivotPicking: (pivotPicking) =>
    set((state) => ({
      pivotPicking,
      navigationMode: null,
      painting: false,
      view: { ...state.view, explode: 0 },
    })),
  setPartPivot: (point) => {
    const state = get(),
      part = state.scene.parts.find((part) => part.id === point.partId);
    if (!part?.visible || !point.point.every(Number.isFinite)) return;
    set({
      ...changed(state, {
        ...state.scene,
        parts: state.scene.parts.map((part) =>
          part.id === point.partId ? { ...part, pivot: [...point.point] } : part,
        ),
      }),
      pivotPicking: false,
      selected: [part.id],
      pivotRequest: state.pivotRequest + 1,
    });
    state.notify(
      'Pivot set · orbit, rotate, and scale around this point. Joint anchors still apply.',
    );
  },
  clearPartPivot: (id) =>
    set((state) => {
      if (!state.scene.parts.some((part) => part.id === id && part.pivot)) return {};
      return {
        ...changed(state, {
          ...state.scene,
          parts: state.scene.parts.map((part) =>
            part.id === id ? { ...part, pivot: undefined } : part,
          ),
        }),
        pivotRequest: state.pivotRequest + 1,
      };
    }),
  setBrush: (patch) =>
    set((state) => ({
      brushRadius:
        patch.radius === undefined
          ? state.brushRadius
          : Math.max(0.05, Math.min(100, patch.radius)),
      brushErase: patch.erase ?? state.brushErase,
      brushPlane: {
        enabled: patch.plane?.enabled ?? state.brushPlane.enabled,
        angle: Number.isFinite(patch.plane?.angle)
          ? Math.max(0, Math.min(90, patch.plane!.angle!))
          : state.brushPlane.angle,
        distance: Number.isFinite(patch.plane?.distance)
          ? Math.max(0, Math.min(100, patch.plane!.distance!))
          : state.brushPlane.distance,
      },
    })),
  addSurfacePair: () =>
    set((state) => {
      const unfinished = state.operation.surfacePairs.find(
        (pair) => !pair.source?.faces.length || !pair.target?.faces.length,
      );
      const pair = unfinished ?? emptySurfacePair();
      return {
        painting: false,
        operation: {
          ...state.operation,
          surfacePairs: unfinished
            ? state.operation.surfacePairs
            : [...state.operation.surfacePairs, pair],
          activeSurface: { pairId: pair.id, side: pair.source?.faces.length ? 'target' : 'source' },
        },
      };
    }),
  chooseSurface: (pairId, side) =>
    set((state) => ({
      painting: false,
      operation: { ...state.operation, activeSurface: { pairId, side } },
    })),
  paintSurface: (point, face, erase = false, begin = false) => {
    const state = get(),
      op = state.operation,
      active = op.activeSurface;
    if (
      state.tool !== 'align' ||
      op.mode !== 'surface' ||
      state.navigationMode ||
      state.temporaryOrbit ||
      state.pivotPicking ||
      !active ||
      (!begin && !state.painting)
    )
      return false;
    if (state.view.explode) {
      // Patches are hidden in the exploded view, so painting there would be blind.
      if (begin) state.notify('Reset the exploded view before painting surfaces.', 'info');
      return false;
    }
    const pair = op.surfacePairs.find((pair) => pair.id === active.pairId);
    if (!pair) return false;
    const expected = active.side === 'source' ? op.sourceId : op.targetId;
    let message = '';
    if (active.side === 'target' && !pair.source?.faces.length)
      message = 'Paint the moving patch for this pair first.';
    else if (active.side === 'target' && point.partId === op.sourceId)
      message = 'Paint the matching patch on a different target part.';
    else if (active.side === 'source' && point.partId === op.targetId)
      message = 'Paint a patch on the moving part.';
    else if (expected && expected !== point.partId)
      message = `Paint the ${active.side === 'source' ? 'moving' : 'target'} part for this pair.`;
    const part = state.scene.parts.find((part) => part.id === point.partId);
    if (!part?.visible) return false;
    if (active.side === 'source' && part.locked)
      message = 'Unlock the moving part before painting its contact surfaces.';
    if (triangleCount(part.geometry) > maxPaintTriangles)
      message = `${part.name} has too many triangles for contact paint. The limit is 10 million.`;
    if (message) {
      if (begin) state.notify(message, 'info');
      return false;
    }
    const erasing = erase || state.brushErase;
    const previousPatch = pair[active.side];
    let faces: number[];
    try {
      faces = facesUnderBrush(part, point, state.brushRadius, face, {
        plane: erasing ? undefined : state.brushPlane,
        patch: previousPatch ?? undefined,
      });
    } catch (error) {
      // Unconnected triangles reach the browser's limit on map size sooner than a closed mesh.
      if (!(error instanceof RangeError)) throw error;
      if (begin) state.notify(`${part.name} has too many edges for contact paint.`, 'error');
      return false;
    }
    if (!faces.length) return false;
    const previous = previousPatch?.faces ?? [];
    const touched = new Set(faces),
      result = erasing
        ? contiguousRemainder(
            part.geometry,
            previous.filter((face) => !touched.has(face)),
            previousPatch?.seed?.face,
          )
        : [...new Set([...previous, ...faces])].sort((a, b) => a - b);
    const same =
      previous.length === result.length && previous.every((face, i) => face === result[i]);
    set({
      ...(begin
        ? { painting: true, paintHistory: [...state.paintHistory.slice(-29), op.surfacePairs] }
        : {}),
      ...(!same
        ? {
            operation: {
              ...op,
              sourceId: active.side === 'source' ? point.partId : op.sourceId,
              targetId: active.side === 'target' ? point.partId : op.targetId,
              surfacePairs: op.surfacePairs.map((entry) =>
                entry.id === pair.id
                  ? {
                      ...entry,
                      [active.side]: {
                        partId: point.partId,
                        faces: result,
                        seed: result.length
                          ? ((previous.length ? previousPatch?.seed : undefined) ?? {
                              ...point,
                              face,
                            })
                          : undefined,
                      },
                    }
                  : entry,
              ),
            },
          }
        : {}),
    });
    return true;
  },
  endPaintStroke: () => {
    if (get().painting) set({ painting: false });
  },
  undoPaintStroke: () =>
    set((state) => {
      const surfacePairs = state.paintHistory.at(-1);
      if (!surfacePairs) return {};
      const active = state.operation.activeSurface;
      return {
        painting: false,
        paintHistory: state.paintHistory.slice(0, -1),
        operation: {
          ...state.operation,
          surfacePairs,
          // Keep the brush on the same patch so painting can continue after an undo.
          activeSurface: surfacePairs.some((pair) => pair.id === active?.pairId) ? active : null,
        },
      };
    }),
  setOperation: (patch) =>
    set((state) => {
      const op = state.operation;
      const reset =
        (patch.mode !== undefined && patch.mode !== op.mode) ||
        ('sourceId' in patch && patch.sourceId !== op.sourceId) ||
        ('targetId' in patch && patch.targetId !== op.targetId);
      const mode = patch.mode ?? state.operation.mode;
      const target = patch.targetId === undefined ? state.operation.targetId : patch.targetId;
      const targetId =
        mode === 'surface' && target && !state.scene.parts.some((part) => part.id === target)
          ? null
          : target;
      const pair = reset && mode === 'surface' ? emptySurfacePair() : null;
      return {
        painting: false,
        ...(reset ? { paintHistory: [] } : {}),
        operation: {
          ...state.operation,
          ...patch,
          targetId,
          ...(reset
            ? {
                pairs: [],
                pending: null,
                surfacePairs: pair ? [pair] : [],
                activeSurface: pair ? { pairId: pair.id, side: 'source' as const } : null,
              }
            : {}),
        },
      };
    }),
  resetPicks: () =>
    set((state) => ({
      operation: {
        ...state.operation,
        pairs: [],
        pending: null,
        surfacePairs: [],
        activeSurface: null,
      },
      painting: false,
      paintHistory: [],
      measurement: [],
    })),
  pick: (point) => {
    const state = get();
    if (state.tool === 'measure') {
      set({
        measurement: state.measurement.length === 2 ? [point] : [...state.measurement, point],
      });
      return;
    }
    const operation = state.operation;
    const onReferencePlane = referencePlanes.some((plane) => plane.id === point.partId);
    if (!operation.pending) {
      if (onReferencePlane || (operation.sourceId && point.partId !== operation.sourceId)) {
        state.notify('Pick a surface on the moving part.', 'info');
        return;
      }
      if (operation.pairs.length && operation.mode !== 'multi') {
        state.notify('Reset points to choose a new pair.', 'info');
        return;
      }
      set({ operation: { ...operation, sourceId: point.partId, pending: point } });
    } else {
      if (point.partId === operation.sourceId) {
        state.notify('Now pick a surface on a different, target part.', 'info');
        return;
      }
      if (onReferencePlane && state.tool === 'joint') {
        state.notify('Joints connect two parts. Pick a surface on the target part.', 'info');
        return;
      }
      if (operation.targetId && point.partId !== operation.targetId) {
        state.notify('Pick a surface on the target part.', 'info');
        return;
      }
      set({
        operation: {
          ...operation,
          targetId: point.partId,
          pending: null,
          pairs: [...operation.pairs, { source: operation.pending, target: point }],
        },
      });
    }
  },
  applyAlignment: () => {
    const state = get(),
      op = state.operation;
    const source = state.scene.parts.find((p) => p.id === op.sourceId),
      target = resolvePart(state.scene, op.targetId);
    if (!source || !target) {
      state.notify('Choose a moving part and a target.', 'error');
      return;
    }
    if (source.locked) {
      state.notify('Unlock the moving part first.', 'error');
      return;
    }
    try {
      const { parts, rms, constrained, anchored, addedConstraints } = solveAlignment(
        state.scene,
        op,
      );
      set({
        ...changed(state, {
          ...state.scene,
          parts,
          ...(addedConstraints?.length
            ? { constraints: [...(state.scene.constraints ?? []), ...addedConstraints] }
            : {}),
        }),
        tool: 'select',
        navigationMode: null,
        selected: [source.id],
        operation: blankOperation(),
        painting: false,
        paintHistory: [],
      });
      state.notify(
        (op.mode === 'surface' && op.surfaceMethod && op.surfaceMethod !== 'contact'
          ? `${planeKindLabels[op.surfaceMethod]} applied${addedConstraints?.length ? ` · ${addedConstraints.length} active plane ${addedConstraints.length === 1 ? 'constraint' : 'constraints'}` : ''}`
          : op.mode === 'surface'
            ? `Fitted ${completedSurfacePairs(op.surfacePairs).length} surface pairs · ${rms.toFixed(3)} mm contact RMS`
            : op.mode === 'multi'
              ? `Aligned ${op.pairs.length} pairs · ${rms.toFixed(3)} mm RMS`
              : anchored
                ? `Parts aligned · ${rms.toFixed(3)} mm residual`
                : 'Parts aligned') +
          (constrained ? ' · limited by joint constraints' : anchored ? ' · anchor connected' : ''),
        constrained ? 'info' : 'success',
      );
    } catch (error) {
      state.notify((error as Error).message, 'error');
    }
  },
  createJoint: () => {
    const state = get(),
      op = state.operation,
      pair = op.pairs[0];
    const child = state.scene.parts.find((p) => p.id === op.sourceId),
      parent = state.scene.parts.find((p) => p.id === op.targetId);
    if (!child || !parent || !pair) {
      state.notify('Pick a moving anchor and a target anchor first.', 'error');
      return;
    }
    if (child.locked) {
      state.notify('Unlock the moving part first.', 'error');
      return;
    }
    try {
      validateJoint(state.scene.joints, parent.id, child.id);
      const rotation = new Quaternion().multiplyQuaternions(
        quat(parent.quaternion).invert(),
        quat(child.quaternion),
      );
      const joint: Joint = {
        id: uid(),
        name: `${child.name} joint`,
        parentId: parent.id,
        childId: child.id,
        parentAnchor: pair.target.point,
        childAnchor: pair.source.point,
        restRotation: rotation.toArray(),
        rotationLocks: op.rotationLocks,
        keepConnected: op.keepConnected,
      };
      // Seat the selected anchors once even when the persistent connection is off.
      const constrained = constrainPart(child, parent, { ...joint, keepConnected: true });
      const proposed = transformAssembly(
        state.scene.parts,
        state.scene.joints,
        child.id,
        constrained,
      );
      const parts = solvePlaneConstraints(
        { ...state.scene, joints: [...state.scene.joints, joint] },
        proposed,
      );
      if (anchorError(parts, joint) > 1e-5)
        throw new Error('A fixed connected part prevents seating this joint. Unlock it first.');
      set({
        ...changed(state, { ...state.scene, parts, joints: [...state.scene.joints, joint] }),
        tool: 'select',
        navigationMode: null,
        selected: [child.id],
        operation: blankOperation(),
        view: { ...state.view, joints: true },
      });
      state.notify(
        joint.keepConnected
          ? 'Joint created · keep connected on'
          : 'Joint created · keep connected off',
      );
    } catch (error) {
      state.notify((error as Error).message, 'error');
    }
  },
  updateJoint: (id, patch) =>
    set((state) => {
      const previous = state.scene.joints.find((j) => j.id === id);
      if (!previous) return {};
      const previousChild = state.scene.parts.find((p) => p.id === previous.childId)!;
      const parent = state.scene.parts.find((p) => p.id === previous.parentId)!;
      if (previousChild.locked && patch.keepConnected === true && !isJointConnected(previous)) {
        get().notify('Unlock the child part before reconnecting its anchor.', 'info');
        return {};
      }
      const newlyLocked = patch.rotationLocks?.some(
        (locked, i) => locked && !previous.rotationLocks[i],
      );
      const reconnecting = patch.keepConnected === true && !isJointConnected(previous);
      const restRotation =
        newlyLocked || reconnecting
          ? quat(parent.quaternion).invert().multiply(quat(previousChild.quaternion)).toArray()
          : previous.restRotation;
      const joints = state.scene.joints.map((j) =>
        j.id === id ? { ...j, ...patch, restRotation } : j,
      );
      const joint = joints.find((j) => j.id === id)!;
      const child = state.scene.parts.find((p) => p.id === joint.childId)!;
      let parts = transformAssembly(state.scene.parts, joints, child.id, child);
      try {
        parts = solvePlaneConstraints({ ...state.scene, joints }, parts);
      } catch (error) {
        get().notify((error as Error).message, 'error');
        return {};
      }
      if (isJointConnected(joint) && anchorError(parts, joint) > 1e-5) {
        get().notify(
          'A fixed connected part prevents reconnecting this anchor. Unlock it first.',
          'info',
        );
        return {};
      }
      return changed(state, { ...state.scene, joints, parts });
    }),
  removeJoint: (id) =>
    set((state) =>
      changed(state, { ...state.scene, joints: state.scene.joints.filter((j) => j.id !== id) }),
    ),
  updateConstraint: (id, patch) =>
    set((state) => {
      const previous = state.scene.constraints?.find((c) => c.id === id);
      if (!previous) return {};
      const next = {
        ...previous,
        ...patch,
        id: previous.id,
        sourceId: previous.sourceId,
        targetId: previous.targetId,
        sourcePlane: previous.sourcePlane,
        targetPlane: previous.targetPlane,
      };
      const scene = {
        ...state.scene,
        constraints: state.scene.constraints!.map((c) => (c.id === id ? next : c)),
      };
      try {
        validatePlaneConstraints(scene);
        const parts = solvePlaneConstraints(scene, scene.parts);
        return changed(state, { ...scene, parts });
      } catch (error) {
        get().notify((error as Error).message, 'error');
        return {};
      }
    }),
  removeConstraint: (id) =>
    set((state) =>
      changed(state, {
        ...state.scene,
        constraints: state.scene.constraints?.filter((c) => c.id !== id),
      }),
    ),
  transform: (id, patch, checkpoint = true) =>
    set((state) => {
      const part = state.scene.parts.find((p) => p.id === id);
      if (!part || part.locked) return {};
      let parts = transformAssembly(
        state.scene.parts,
        state.scene.joints,
        id,
        { ...part, ...patch },
        { moveConnected: !!patch.position && !patch.quaternion && !patch.scale },
      );
      try {
        parts = solvePlaneConstraints(state.scene, parts);
      } catch (error) {
        const message = (error as Error).message;
        if (get().toast?.message !== message) get().notify(message, 'error');
        return {};
      }
      return parts === state.scene.parts
        ? {}
        : changed(state, { ...state.scene, parts }, checkpoint);
    }),
  transformMany: (patches, checkpoint = true, moveConnected = false) =>
    set((state) => {
      let parts = state.scene.parts;
      const ids = new Set(patches.map((p) => p.id));
      for (const { id, patch } of patches) {
        let ancestor = id,
          hasSelectedAncestor = false;
        const checked = new Set<string>();
        while (!checked.has(ancestor)) {
          checked.add(ancestor);
          const parent = state.scene.joints.find(
            (j) => j.childId === ancestor && isJointConnected(j),
          )?.parentId;
          if (!parent) break;
          if (ids.has(parent)) {
            hasSelectedAncestor = true;
            break;
          }
          ancestor = parent;
        }
        if (hasSelectedAncestor) continue;
        const part = parts.find((p) => p.id === id);
        if (part && !part.locked)
          parts = transformAssembly(
            parts,
            state.scene.joints,
            id,
            { ...part, ...patch },
            { moveConnected },
          );
      }
      try {
        parts = solvePlaneConstraints(state.scene, parts);
      } catch (error) {
        const message = (error as Error).message;
        if (get().toast?.message !== message) get().notify(message, 'error');
        return {};
      }
      return parts === state.scene.parts
        ? {}
        : changed(state, { ...state.scene, parts }, checkpoint);
    }),
  patchParts: (ids, patch, checkpoint = true) =>
    set((state) => {
      const keys = Object.keys(patch) as (keyof Part)[];
      const differs = (part: Part) =>
        ids.includes(part.id) && keys.some((key) => part[key] !== patch[key]);
      if (!state.scene.parts.some(differs)) return {};
      return changed(
        state,
        {
          ...state.scene,
          parts: state.scene.parts.map((p) => (ids.includes(p.id) ? { ...p, ...patch } : p)),
        },
        checkpoint,
      );
    }),
  addParts: (parts) =>
    set((state) => ({
      ...changed(state, { ...state.scene, parts: [...state.scene.parts, ...parts] }),
      selected: parts.map((p) => p.id),
      focusRequest: { id: state.focusRequest.id + 1, all: false },
    })),
  deleteSelected: () =>
    set((state) => {
      const ids = state.selected.filter(
        (id) => !state.scene.parts.find((p) => p.id === id)?.locked,
      );
      if (!ids.length) return {};
      return {
        ...changed(state, {
          ...state.scene,
          parts: state.scene.parts.filter((p) => !ids.includes(p.id)),
          joints: state.scene.joints.filter(
            (j) => !ids.includes(j.parentId) && !ids.includes(j.childId),
          ),
          constraints: state.scene.constraints?.filter(
            (c) => !ids.includes(c.sourceId) && !ids.includes(c.targetId),
          ),
        }),
        ...withoutRemovedParts(state, ids),
        selected: [],
      };
    }),
  duplicateSelected: () =>
    set((state) => {
      const clipboard = captureComponents(state.scene, state.selected);
      if (!clipboard.parts.length) return {};
      const copies = instantiateComponents(clipboard, state.scene.parts);
      return {
        ...changed(state, {
          ...state.scene,
          parts: [...state.scene.parts, ...copies.parts],
          joints: [...state.scene.joints, ...copies.joints],
          constraints: [...(state.scene.constraints ?? []), ...copies.constraints],
        }),
        selected: copies.parts.map((part) => part.id),
      };
    }),
  replaceWithMerged: (part, ids) =>
    set((state) => ({
      ...changed(state, {
        ...state.scene,
        parts: [...state.scene.parts.filter((p) => !ids.includes(p.id)), part],
        joints: state.scene.joints.filter(
          (j) => !ids.includes(j.parentId) && !ids.includes(j.childId),
        ),
        constraints: state.scene.constraints?.filter(
          (c) => !ids.includes(c.sourceId) && !ids.includes(c.targetId),
        ),
      }),
      ...withoutRemovedParts(state, ids),
      selected: [part.id],
    })),
  setScene: (scene, recovered = false) =>
    set((state) => ({
      scene,
      selected: [],
      past: [],
      future: [],
      revision: state.revision + 1,
      savedRevision: recovered ? state.revision : state.revision + 1,
      tool: 'select',
      navigationMode: null,
      temporaryOrbit: false,
      precision: false,
      pivotPicking: false,
      painting: false,
      paintHistory: [],
      measurement: [],
      operation: blankOperation(),
      modal: null,
      contextMenu: null,
      view: { ...state.view, explode: 0 },
      focusRequest: { id: state.focusRequest.id + 1, all: true },
    })),
  renameScene: (name) =>
    set((state) => {
      const next = name.trim() || 'Untitled assembly';
      return next === state.scene.name ? {} : changed(state, { ...state.scene, name: next });
    }),
  undo: () =>
    set((state) =>
      state.past.length
        ? {
            scene: state.past.at(-1)!,
            past: state.past.slice(0, -1),
            future: [state.scene, ...state.future],
            revision: state.revision + 1,
            selected: state.selected.filter((id) =>
              state.past.at(-1)!.parts.some((p) => p.id === id),
            ),
            operation: blankOperation(),
            tool: 'select',
            navigationMode: null,
            pivotPicking: false,
            painting: false,
            paintHistory: [],
            measurement: [],
          }
        : {},
    ),
  redo: () =>
    set((state) =>
      state.future.length
        ? {
            scene: state.future[0],
            past: [...state.past, state.scene],
            future: state.future.slice(1),
            revision: state.revision + 1,
            selected: state.selected.filter((id) => state.future[0].parts.some((p) => p.id === id)),
            operation: blankOperation(),
            tool: 'select',
            navigationMode: null,
            pivotPicking: false,
            painting: false,
            paintHistory: [],
            measurement: [],
          }
        : {},
    ),
  setView: (patch) => {
    if (patch.orbitSelection !== undefined) saveOrbitPreference(patch.orbitSelection);
    set((state) => ({
      view: { ...state.view, ...patch },
    }));
  },
  setModal: (modal) => set({ modal, contextMenu: null }),
  setBusy: (busy) => set({ busy }),
  notify: (message, kind = 'success') => set({ toast: { id: uid(), message, kind } }),
  focus: (view, all = false) =>
    set((state) => ({ focusRequest: { id: state.focusRequest.id + 1, view, all } })),
  markSaved: (revision) => set({ savedRevision: revision }),
}));

function reachableGeometries(state: EditorState) {
  const geometries = new Set<BufferGeometry>();
  for (const parts of [
    state.scene.parts,
    ...state.past.map((scene) => scene.parts),
    ...state.future.map((scene) => scene.parts),
    state.clipboard?.parts ?? [],
  ])
    for (const part of parts) geometries.add(part.geometry);
  return geometries;
}

// The renderer keeps GPU buffers until a geometry is disposed. Undo history and the
// clipboard share geometry with the scene, so release it only when nothing can restore it.
let trackedGeometries = reachableGeometries(useEditor.getState());
useEditor.subscribe((state, previous) => {
  if (
    state.past === previous.past &&
    state.future === previous.future &&
    state.clipboard === previous.clipboard &&
    state.scene.parts.length === previous.scene.parts.length
  )
    return;
  const reachable = reachableGeometries(state);
  for (const geometry of trackedGeometries) if (!reachable.has(geometry)) geometry.dispose();
  trackedGeometries = reachable;
});

export function measureDistance() {
  const state = useEditor.getState();
  if (state.measurement.length !== 2) return null;
  const [a, b] = state.measurement,
    partA = resolvePart(state.scene, a.partId),
    partB = resolvePart(state.scene, b.partId);
  return partA && partB ? worldPoint(partA, a).distanceTo(worldPoint(partB, b)) : null;
}
