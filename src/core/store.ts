import { create } from 'zustand';
import { notify as recordNotification } from './activity';
import type { DriveFileBinding } from './types';
import { Quaternion } from 'three';
import type { BufferGeometry } from 'three';
import { quat, triangleCount, uid, worldPoint } from './geometry';
import { markInteraction } from './display-performance';
import {
  anchorError,
  connectedPartIds,
  constrainPart,
  isJointConnected,
  transformAssembly,
  validateJoint,
} from './constraints';
import { solveAlignment } from './alignment';
import { alignmentPartDisplay } from './alignment-visibility';
import { fitAnchors } from './anchor-fit';
import {
  clipNote,
  placeClear,
  readClipSettings,
  sanitizeClipSettings,
  saveClipSettings,
} from './clipping';
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
import {
  nextIsolation,
  readIsolationSettings,
  sanitizeIsolationSettings,
  saveIsolationSettings,
} from './isolation';
import { readOrbitPreference, saveOrbitPreference } from './navigation';
import { readPartColorMode, savePartColorMode } from './appearance';
import {
  presetLighting,
  readDefaultLighting,
  sanitizeLighting,
  saveDefaultLighting,
} from './lighting';
import { same } from './sync';
import { transformSelection } from './transform-selection';
import type { FreeTransformMode, TransformAxis, TransformPatch } from './free-transform';
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
  Pin,
  SceneDocument,
  SceneLighting,
  SurfacePoint,
  SurfacePair,
  SurfaceSide,
  Tool,
  ViewSettings,
  Vec3,
} from './types';

export type Modal = 'export' | 'import' | 'merge' | 'mesh' | 'help' | 'new' | 'rename' | null;
export interface EditorContextMenu {
  x: number;
  y: number;
  kind?: 'brush';
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
const liveParameter =
  typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('live');
/** Set when the page was opened by a live view, which shares its scene. */
export const liveSession = liveParameter !== null;
/** Who holds a shared scene: an agent's MCP server, or only the people editing it. */
export const liveHost = liveParameter === 'shared' ? 'people' : 'agent';
const initialScene: SceneDocument = liveSession
  ? {
      name: liveHost === 'people' ? 'Joining the shared scene' : 'Waiting for the agent',
      parts: [],
      joints: [],
      constraints: [],
    }
  : createSample();
const historyLimit = 40;
// Leaves a dragged frame time to draw. The part catches up over the next frames.
const gestureBudget = 12;

interface FreeTransform {
  mode: FreeTransformMode;
  axis: TransformAxis;
  baseline: SceneDocument;
  patches: TransformPatch[];
}

interface EditorState {
  scene: SceneDocument;
  selected: string[];
  /** Parts the viewport draws alone. A view state: never saved, shared, or undone. */
  isolated: string[] | null;
  /** Grid spacing in mm of the nearby-surface field in use, or null until one is ready. */
  nearbyDetail: number | null;
  /** The parts outside the isolated set that are near enough to be drawn in part. */
  nearbyParts: string[] | null;
  clipboard: ComponentClipboard | null;
  contextMenu: EditorContextMenu | null;
  tool: Tool;
  navigationMode: NavigationMode | null;
  temporaryOrbit: boolean;
  precision: boolean;
  /** A reversible placement preview. Only confirmation changes history or persistence. */
  freeTransform: FreeTransform | null;
  pivotRequest: number;
  pivotPicking: boolean;
  activeAnchor: string | null;
  anchorPicking: boolean;
  activePin: string | null;
  pinPicking: Pin['kind'] | null;
  painting: boolean;
  brushRadius: number;
  brushErase: boolean;
  brushPlane: BrushPlaneSettings;
  paintHistory: SurfacePair[][];
  operation: AssemblyOperation;
  view: ViewSettings;
  /** Lighting for scenes that have none of their own. Kept in this browser. */
  defaultLighting: SceneLighting;
  lightingPanel: boolean;
  /** The light being edited in the lighting panel and moved in the viewport. */
  activeLight: string | null;
  past: SceneDocument[];
  future: SceneDocument[];
  revision: number;
  savedRevision: number;
  driveFile: DriveFileBinding | null;
  recoveryStatus: 'saving' | 'saved' | 'error';
  liveStatus: 'connecting' | 'connected' | 'disconnected' | null;
  /** This tab's own steps in a shared scene. Null when undo uses the local history. */
  sharedHistory: { undo: number; redo: number } | null;
  /** Counts whole-scene replacements, such as opening a file. */
  sceneEpoch: number;
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
  isolate: (ids: string[] | null) => void;
  /** Isolates the selection, or shows everything when it is already isolated. */
  toggleIsolation: () => void;
  /** Turns nearby surfaces on or off, isolating the selection first if nothing is. */
  toggleNearby: () => void;
  hideOthers: () => void;
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
  addFitAnchor: (point: SurfacePoint) => void;
  moveFitAnchor: (
    partId: string,
    anchorId: string,
    target: Vec3,
    checkpoint?: boolean,
    baseline?: SceneDocument,
    /** Part of a drag, or the end of one, rather than a typed value. */
    gesture?: 'drag' | 'settle',
  ) => void;
  removeFitAnchor: (partId: string, anchorId: string) => void;
  rebaseFitAnchors: (partId: string) => void;
  addPin: (point: SurfacePoint) => void;
  updatePin: (
    partId: string,
    pinId: string,
    patch: Partial<Pick<Pin, 'kind' | 'priority'>>,
    checkpoint?: boolean,
  ) => void;
  removePin: (partId: string, pinId: string) => void;
  rebasePins: (partId: string) => void;
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
  beginFreeTransform: (mode: FreeTransformMode) => boolean;
  previewFreeTransform: (patches: TransformPatch[]) => void;
  finishFreeTransform: (confirm: boolean) => void;
  transformMany: (
    patches: { id: string; patch: Partial<Part> }[],
    checkpoint?: boolean,
    moveConnected?: boolean,
    /** The drag has ended, so finish avoiding other parts at full detail. */
    settle?: boolean,
    /** Milliseconds one step of a drag may spend avoiding other parts. */
    budget?: number,
    /** Original poses of this gesture, used for the full-detail release check. */
    baseline?: Part[],
    /** Update only the in-progress free-transform preview, without a document revision. */
    preview?: boolean,
  ) => void;
  patchParts: (ids: string[], patch: Partial<Part>, checkpoint?: boolean) => void;
  /** Sets or, with null, clears the viewport-only color of these parts. */
  setDisplayColor: (ids: string[], color: string | null, checkpoint?: boolean) => void;
  /** Gives the scene its own lighting, or with null returns it to the default. */
  setLighting: (lighting: SceneLighting | null, checkpoint?: boolean) => void;
  /** Saves lighting for scenes without their own, or with null restores the built-in one. */
  setDefaultLighting: (lighting: SceneLighting | null) => void;
  setLightingPanel: (open: boolean) => void;
  setActiveLight: (id: string | null) => void;
  addParts: (parts: Part[]) => void;
  deleteSelected: () => void;
  duplicateSelected: () => void;
  replaceWithMerged: (part: Part, ids: string[]) => void;
  applyProcessedMesh: (
    id: string,
    source: BufferGeometry,
    geometry: BufferGeometry,
    keepOriginal: boolean,
    epoch: number,
    label: string,
  ) => boolean;
  setScene: (
    scene: SceneDocument,
    recovered?: boolean,
    driveFile?: DriveFileBinding | null,
  ) => void;
  /** Takes the shared scene from a live view's server, leaving camera, selection, and tools. */
  receiveScene: (scene: SceneDocument) => void;
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
  ...(state.freeTransform ? { freeTransform: null } : {}),
  ...(checkpoint
    ? { past: [...state.past.slice(-(historyLimit - 1)), committedScene(state)], future: [] }
    : {}),
});

/** Picks on a removed part can never be completed, so restart the active tool. */
const withoutRemovedParts = (state: EditorState, ids: string[]) => {
  const op = state.operation;
  const stale = [
    op.sourceId,
    op.targetId,
    ...op.surfacePairs.flatMap((pair) => [pair.source?.partId, pair.target?.partId]),
  ].some((id) => id && ids.includes(id));
  return {
    measurement: state.measurement.filter((point) => !ids.includes(point.partId)),
    ...(stale ? { operation: blankOperation(op.mode), painting: false, paintHistory: [] } : {}),
  };
};

/** Parts made while isolating join the isolated view, so they do not appear to be missing. */
const alsoIsolated = (state: EditorState, parts: Part[]) =>
  state.isolated ? { isolated: [...state.isolated, ...parts.map((part) => part.id)] } : {};

/** The same for parts that undo or redo brings back. */
const restoredIsolated = (state: EditorState, scene: SceneDocument) =>
  alsoIsolated(
    state,
    scene.parts.filter((part) => !state.scene.parts.some((p) => p.id === part.id)),
  );

export const useEditor = create<EditorState>((set, get) => ({
  scene: initialScene,
  selected: liveSession ? [] : ['torso'],
  isolated: null,
  nearbyDetail: null,
  nearbyParts: null,
  clipboard: null,
  contextMenu: null,
  tool: 'select',
  navigationMode: null,
  temporaryOrbit: false,
  precision: false,
  freeTransform: null,
  pivotRequest: 0,
  pivotPicking: false,
  activeAnchor: null,
  anchorPicking: false,
  activePin: null,
  pinPicking: null,
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
    clip: readClipSettings(),
    isolation: readIsolationSettings(),
    orbitSelection: readOrbitPreference(),
    partColors: readPartColorMode(),
    grid: true,
    joints: false,
    wireframe: false,
    snap: false,
    snapStep: 1,
    rotationSnapStep: 15,
    projection: 'perspective',
    explode: 0,
    space: 'world',
    planes: [],
  },
  defaultLighting: readDefaultLighting(),
  lightingPanel: false,
  activeLight: null,
  past: [],
  future: [],
  revision: 0,
  savedRevision: 0,
  driveFile: null,
  recoveryStatus: 'saved',
  liveStatus: null,
  sharedHistory: null,
  sceneEpoch: 0,
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
  isolate: (ids) => set({ isolated: ids?.length ? ids : null }),
  toggleIsolation: () => {
    const state = get();
    const next = nextIsolation(state.scene.parts, state.selected, state.isolated);
    if (!next && !state.isolated) {
      state.notify('Select a visible part to isolate.', 'info');
      return;
    }
    // A new isolation starts plain. Moving it to another part keeps nearby surfaces as set.
    if (next && !state.isolated && state.view.isolation.nearby)
      state.setView({ isolation: { ...state.view.isolation, nearby: false } });
    set({ isolated: next });
  },
  toggleNearby: () => {
    const state = get();
    const { isolation } = state.view;
    if (state.isolated) {
      state.setView({ isolation: { ...isolation, nearby: !isolation.nearby } });
      return;
    }
    const next = nextIsolation(state.scene.parts, state.selected, null);
    if (!next) {
      state.notify('Select a visible part to isolate.', 'info');
      return;
    }
    state.setView({ isolation: { ...isolation, nearby: true } });
    set({ isolated: next });
  },
  hideOthers: () =>
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
      ...alsoIsolated(state, copies.parts),
      clipboard: { ...state.clipboard, nextOffset: state.clipboard.nextOffset + 1 },
      operation: blankOperation(),
      paintHistory: [],
    });
  },
  openContextMenu: (contextMenu) =>
    set((state) => ({
      contextMenu,
      selected:
        contextMenu.kind !== 'brush' &&
        contextMenu.partId &&
        !state.selected.includes(contextMenu.partId)
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
        pinPicking:
          tool === 'pins' &&
          !state.scene.parts.find((p) => p.id === state.selected[0])?.pins?.length
            ? 'hard'
            : null,
        anchorPicking:
          tool === 'anchors' &&
          !state.scene.parts.find((p) => p.id === state.selected[0])?.anchors?.length,
        navigationMode: null,
        pivotPicking: false,
        painting: false,
        paintHistory: [],
        measurement: [],
        operation: {
          ...blankOperation(mode),
          ...(tool === state.tool ? { view: state.operation.view } : {}),
          sourceId: state.selected[0] ?? null,
          targetId: state.selected[1] ?? null,
          surfacePairs: pair ? [pair] : [],
          activeSurface: pair ? { pairId: pair.id, side: 'source' as const } : null,
        },
        view: { ...state.view, explode: 0 },
      };
    }),
  addFitAnchor: (point) => {
    const state = get();
    const part = state.scene.parts.find((p) => p.id === point.partId);
    if (state.tool !== 'anchors' || !state.anchorPicking || state.view.explode || !part) return;
    if (part.locked || !part.visible) {
      state.notify('Choose a visible, unlocked part.', 'info');
      return;
    }
    if (state.selected.length && state.selected[0] !== part.id) {
      state.notify('Select the moving part in the Anchors panel before adding points.', 'info');
      return;
    }
    const anchor = {
      id: uid(),
      point: [...point.point] as Vec3,
      target: worldPoint(part, point).toArray(),
    };
    set({
      ...changed(state, {
        ...state.scene,
        parts: state.scene.parts.map((p) =>
          p.id === part.id ? { ...p, anchors: [...(p.anchors ?? []), anchor] } : p,
        ),
      }),
      selected: [part.id],
      activeAnchor: anchor.id,
    });
  },
  moveFitAnchor: (partId, anchorId, target, checkpoint = true, baseline, gesture) => {
    const state = get();
    const scene = baseline ?? state.scene;
    const part = scene.parts.find((p) => p.id === partId);
    const current = state.scene.parts.find((p) => p.id === partId);
    const anchor = current?.anchors?.find((a) => a.id === anchorId);
    if (
      !part ||
      !current ||
      current.locked ||
      !current.visible ||
      state.view.explode ||
      !anchor ||
      !target.every(Number.isFinite) ||
      (gesture !== 'settle' && target.every((v, i) => v === anchor.target[i]))
    )
      return;
    const anchors = part.anchors?.map((a) =>
      a.id === anchorId ? { ...a, target: [...target] as Vec3 } : a,
    );
    if (!anchors) return;
    try {
      const { clip } = state.view;
      let note = '';
      const parts = fitAnchors(
        scene,
        partId,
        anchors,
        clip.enabled
          ? {
              overlap: clip.overlap,
              mode: gesture ? 'drag' : 'adjust',
              current: state.scene.parts,
              budget: gesture === 'drag' ? gestureBudget : undefined,
              settle: gesture === 'settle',
              report: (report) => (note = clipNote(report, state.scene.parts)),
            }
          : undefined,
      );
      set(changed(state, { ...state.scene, parts }, checkpoint));
      if (note && !gesture) state.notify(`Anchor fit ${note}`, 'info');
    } catch (error) {
      const message = (error as Error).message;
      if (get().toast?.message !== message) state.notify(message, 'error');
    }
  },
  removeFitAnchor: (partId, anchorId) => {
    const state = get();
    const part = state.scene.parts.find((p) => p.id === partId);
    if (!part || part.locked || !part.anchors?.some((a) => a.id === anchorId)) return;
    const anchors = part.anchors.filter((a) => a.id !== anchorId);
    state.patchParts([partId], { anchors });
    if (state.activeAnchor === anchorId) set({ activeAnchor: anchors[0]?.id ?? null });
  },
  rebaseFitAnchors: (partId) => {
    const state = get();
    const part = state.scene.parts.find((p) => p.id === partId);
    if (!part || part.locked || !part.anchors?.length) return;
    state.patchParts([partId], {
      anchors: part.anchors.map((a) => ({
        ...a,
        target: worldPoint(part, { partId, point: a.point, normal: [0, 1, 0] }).toArray(),
      })),
    });
  },
  addPin: (point) => {
    const state = get();
    const part = state.scene.parts.find((p) => p.id === point.partId);
    if (
      state.tool !== 'pins' ||
      !state.pinPicking ||
      state.view.explode ||
      !part ||
      part.locked ||
      !part.visible ||
      !point.point.every(Number.isFinite)
    )
      return;
    if (state.selected.length && state.selected[0] !== part.id) {
      state.notify('Select this part in the Pins panel before placing pins.', 'info');
      return;
    }
    const pin: Pin = {
      id: uid(),
      point: [...point.point],
      target: worldPoint(part, point).toArray(),
      kind: state.pinPicking,
      priority: 50,
    };
    set({
      ...changed(state, {
        ...state.scene,
        parts: state.scene.parts.map((p) =>
          p.id === part.id ? { ...p, pins: [...(p.pins ?? []), pin] } : p,
        ),
      }),
      selected: [part.id],
      activePin: pin.id,
    });
  },
  updatePin: (partId, pinId, patch, checkpoint = true) => {
    const state = get(),
      part = state.scene.parts.find((p) => p.id === partId);
    if (
      !part ||
      part.locked ||
      !part.visible ||
      state.view.explode ||
      !part.pins?.some((pin) => pin.id === pinId) ||
      (patch.kind !== undefined && patch.kind !== 'hard' && patch.kind !== 'soft') ||
      (patch.priority !== undefined &&
        (!Number.isFinite(patch.priority) || patch.priority < 0 || patch.priority > 100))
    )
      return;
    let differs = false;
    const pins = part.pins.map((pin) => {
      if (
        pin.id !== pinId ||
        ((patch.kind === undefined || patch.kind === pin.kind) &&
          (patch.priority === undefined || patch.priority === pin.priority))
      )
        return pin;
      differs = true;
      return {
        ...pin,
        ...patch,
        // Promoting a stretched soft pin locks its current attachment without a jump.
        ...(patch.kind === 'hard' && pin.kind !== 'hard'
          ? {
              target: worldPoint(part, { partId, point: pin.point, normal: [0, 1, 0] }).toArray(),
            }
          : {}),
      };
    });
    if (differs) state.patchParts([partId], { pins }, checkpoint);
  },
  removePin: (partId, pinId) => {
    const state = get(),
      part = state.scene.parts.find((p) => p.id === partId);
    if (!part || part.locked || !part.pins?.some((pin) => pin.id === pinId)) return;
    const pins = part.pins.filter((pin) => pin.id !== pinId);
    state.patchParts([partId], { pins });
    if (state.activePin === pinId) set({ activePin: pins[0]?.id ?? null });
  },
  rebasePins: (partId) => {
    const state = get(),
      part = state.scene.parts.find((p) => p.id === partId);
    if (!part || part.locked || !part.visible || state.view.explode || !part.pins?.length) return;
    state.patchParts([partId], {
      pins: part.pins.map((pin) => ({
        ...pin,
        target: worldPoint(part, { partId, point: pin.point, normal: [0, 1, 0] }).toArray(),
      })),
    });
  },
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
      op = state.operation;
    const display = alignmentPartDisplay(state.tool, op, point.partId);
    if (display === 'hidden' || display === 'ghost') return false;
    let active = op.activeSurface;
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
    const flush = op.surfaceMethod === 'flush';
    if (flush)
      active = {
        pairId: active.pairId,
        side: op.sourceId
          ? point.partId === op.sourceId
            ? 'source'
            : 'target'
          : point.partId === op.targetId
            ? 'target'
            : 'source',
      };
    const pair = op.surfacePairs.find((pair) => pair.id === active.pairId);
    if (!pair) return false;
    const expected =
      active.side === 'source' ? op.sourceId : flush ? pair.target?.partId : op.targetId;
    let message = '';
    if (!flush && active.side === 'target' && !pair.source?.faces.length)
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
              activeSurface: active,
              sourceId: active.side === 'source' ? point.partId : op.sourceId,
              targetId:
                active.side === 'target'
                  ? flush
                    ? (op.targetId ?? point.partId)
                    : point.partId
                  : op.targetId,
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
        (patch.surfaceMethod !== undefined &&
          patch.surfaceMethod !== op.surfaceMethod &&
          (patch.surfaceMethod === 'flush' || op.surfaceMethod === 'flush')) ||
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
    const display = alignmentPartDisplay(state.tool, state.operation, point.partId);
    if (display === 'hidden' || display === 'ghost') return;
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
      const { parts, rms, constrained, anchored, addedConstraints, clip } = solveAlignment(
        state.scene,
        op,
        state.view.clip,
      );
      const note = clipNote(clip, state.scene.parts);
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
        (op.mode === 'surface' && op.surfaceMethod === 'flush'
          ? `Flush fit applied · ${completedSurfacePairs(op.surfacePairs).length} seams · ${rms.toFixed(3)} mm height RMS`
          : op.mode === 'surface' &&
              op.surfaceMethod &&
              op.surfaceMethod !== 'contact' &&
              op.surfaceMethod !== 'flush'
            ? `${planeKindLabels[op.surfaceMethod]} applied${addedConstraints?.length ? ` · ${addedConstraints.length} active plane ${addedConstraints.length === 1 ? 'constraint' : 'constraints'}` : ''}`
            : op.mode === 'surface'
              ? `Fitted ${completedSurfacePairs(op.surfacePairs).length} surface pairs · ${rms.toFixed(3)} mm contact RMS`
              : op.mode === 'multi'
                ? `Aligned ${op.pairs.length} pairs · ${rms.toFixed(3)} mm RMS`
                : anchored
                  ? `Parts aligned · ${rms.toFixed(3)} mm residual`
                  : 'Parts aligned') +
          (constrained
            ? op.surfaceMethod === 'flush'
              ? ' · imperfect fit: review seam residuals, locks, and connections'
              : ' · limited by joint constraints'
            : anchored
              ? ' · anchor connected'
              : '') +
          (note ? ` · ${note}` : ''),
        constrained || clip?.unresolved ? 'info' : 'success',
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
      let parts: Part[];
      try {
        parts = transformAssembly(state.scene.parts, joints, child.id, child);
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
  beginFreeTransform: (mode) => {
    const state = get();
    if (state.busy || state.modal || state.freeTransform) return false;
    const selection = transformSelection(
      { ...state, navigationMode: null, temporaryOrbit: false, pivotPicking: false },
      mode,
    );
    if (selection.blocked) {
      state.notify(selection.blocked, 'info');
      return false;
    }
    state.setTool(mode);
    set({
      freeTransform: { mode, axis: null, baseline: get().scene, patches: [] },
      contextMenu: null,
      temporaryOrbit: false,
    });
    return true;
  },
  previewFreeTransform: (patches) => {
    const session = get().freeTransform;
    if (!session) return;
    set({ freeTransform: { ...session, patches } });
    get().transformMany(
      patches,
      false,
      session.mode === 'translate',
      false,
      gestureBudget,
      undefined,
      true,
    );
  },
  finishFreeTransform: (confirm) => {
    const session = get().freeTransform;
    if (!session) return;
    if (confirm && session.patches.length)
      get().transformMany(
        session.patches,
        false,
        session.mode === 'translate',
        true,
        undefined,
        session.baseline.parts,
        true,
      );
    set((state) => {
      if (state.freeTransform?.baseline !== session.baseline) return {};
      const differs = state.scene.parts.some((part, i) => {
        const before = session.baseline.parts[i];
        return (
          !before ||
          part.id !== before.id ||
          (['position', 'quaternion', 'scale'] as const).some((key) =>
            part[key].some((value, j) => Math.abs(value - before[key][j]) > 1e-9),
          )
        );
      });
      return confirm && differs
        ? { ...changed(state, state.scene), freeTransform: null }
        : { scene: session.baseline, freeTransform: null };
    });
  },
  transform: (id, patch, checkpoint = true) =>
    set((state) => {
      const part = state.scene.parts.find((p) => p.id === id);
      if (!part || part.locked) return {};
      const place = (requested: Part) =>
        solvePlaneConstraints(
          state.scene,
          transformAssembly(state.scene.parts, state.scene.joints, id, requested, {
            moveConnected: !!patch.position && !patch.quaternion && !patch.scale,
          }),
        );
      const { clip } = state.view;
      let parts: Part[];
      let note = '';
      try {
        if (clip.enabled) {
          const result = placeClear({
            parts: state.scene.parts,
            joints: state.scene.joints,
            ids: [id],
            target: [{ ...part, ...patch }],
            place: ([pose]) => place(pose),
            overlap: clip.overlap,
            mode: 'adjust',
          });
          parts = result.parts;
          note = clipNote(result.report, state.scene.parts);
        } else parts = place({ ...part, ...patch });
      } catch (error) {
        const message = (error as Error).message;
        if (get().toast?.message !== message) get().notify(message, 'error');
        return {};
      }
      return {
        ...(parts === state.scene.parts
          ? {}
          : changed(state, { ...state.scene, parts }, checkpoint)),
        ...(note
          ? { toast: { id: uid(), message: `${part.name} ${note}`, kind: 'info' as const } }
          : {}),
      };
    }),
  transformMany: (
    patches,
    checkpoint = true,
    moveConnected = false,
    settle = false,
    budget = gestureBudget,
    baseline,
    preview = false,
  ) =>
    set((state) => {
      const ids = new Set(patches.map((p) => p.id));
      const driven = patches.filter(({ id }) => {
        let ancestor = id;
        const checked = new Set<string>();
        while (!checked.has(ancestor)) {
          checked.add(ancestor);
          const parent = state.scene.joints.find(
            (j) => j.childId === ancestor && isJointConnected(j),
          )?.parentId;
          if (!parent) break;
          if (ids.has(parent)) return false;
          ancestor = parent;
        }
        const part = state.scene.parts.find((p) => p.id === id);
        return !!part && !part.locked;
      });
      const place = (poses: Part[]) => {
        let parts = state.scene.parts;
        driven.forEach(({ id }, i) => {
          parts = transformAssembly(parts, state.scene.joints, id, poses[i], { moveConnected });
        });
        return solvePlaneConstraints(state.scene, parts);
      };
      const target = driven.map(({ id, patch }) => ({
        ...state.scene.parts.find((p) => p.id === id)!,
        ...patch,
      }));
      let releaseBaseline: Part[] | undefined;
      if (settle && baseline) {
        const original = new Map(baseline.map((part) => [part.id, part]));
        const related = new Set(
          driven.flatMap(({ id }) => [...connectedPartIds(state.scene.joints, id)]),
        );
        releaseBaseline = state.scene.parts.map((part) => {
          const start = original.get(part.id);
          return related.has(part.id) && start?.geometry === part.geometry && !part.locked
            ? {
                ...part,
                position: start.position,
                quaternion: start.quaternion,
                scale: start.scale,
              }
            : part;
        });
      }
      const { clip } = state.view;
      let parts: Part[];
      try {
        parts =
          clip.enabled && driven.length
            ? placeClear({
                parts: state.scene.parts,
                joints: state.scene.joints,
                ids: driven.map(({ id }) => id),
                target,
                place,
                overlap: clip.overlap,
                mode: 'drag',
                budget: settle ? undefined : budget,
                settle,
                baseline: releaseBaseline,
              }).parts
            : place(target);
      } catch (error) {
        const message = (error as Error).message;
        if (get().toast?.message !== message) get().notify(message, 'error');
        return {};
      }
      return parts === state.scene.parts
        ? {}
        : preview
          ? { scene: { ...state.scene, parts } }
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
  setDisplayColor: (ids, color, checkpoint = true) => {
    set((state) => {
      const targets = new Set(ids);
      if (
        !state.scene.parts.some((p) => targets.has(p.id) && p.displayColor !== (color || undefined))
      )
        return {};
      return changed(
        state,
        {
          ...state.scene,
          parts: state.scene.parts.map((p) => {
            if (!targets.has(p.id)) return p;
            const { displayColor: _, ...rest } = p;
            return color ? { ...rest, displayColor: color } : rest;
          }),
        },
        checkpoint,
      );
    });
    // Material mode would hide the color just picked.
    if (color && get().view.partColors === 'material') get().setView({ partColors: 'editor' });
  },
  setLighting: (lighting, checkpoint = true) =>
    set((state) => {
      const next = lighting ? sanitizeLighting(lighting, state.defaultLighting) : undefined;
      if (same(next, state.scene.lighting)) return {};
      const { lighting: _, ...rest } = state.scene;
      return changed(state, next ? { ...rest, lighting: next } : rest, checkpoint);
    }),
  setDefaultLighting: (lighting) => {
    // Not read back from storage, which may be unavailable; the default still applies this session.
    const next = lighting ? sanitizeLighting(lighting) : presetLighting('studio');
    saveDefaultLighting(lighting ? next : null);
    set({ defaultLighting: next });
  },
  setLightingPanel: (open) => set({ lightingPanel: open }),
  setActiveLight: (id) => set({ activeLight: id }),
  addParts: (parts) =>
    set((state) => ({
      ...changed(state, { ...state.scene, parts: [...state.scene.parts, ...parts] }),
      selected: parts.map((p) => p.id),
      ...alsoIsolated(state, parts),
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
        ...alsoIsolated(state, copies.parts),
      };
    }),
  applyProcessedMesh: (id, source, geometry, keepOriginal, epoch, label) => {
    const state = get();
    const part = state.scene.parts.find((p) => p.id === id);
    if (!part || part.locked || part.geometry !== source || state.sceneEpoch !== epoch)
      return false;
    const linked =
      part.pins?.length ||
      part.anchors?.length ||
      state.scene.joints.some((j) => j.childId === id || j.parentId === id) ||
      state.scene.constraints?.some((c) => c.sourceId === id || c.targetId === id);
    if (!keepOriginal && linked) return false;
    const processed: Part = {
      ...part,
      geometry,
      id: keepOriginal ? uid() : id,
      name: keepOriginal ? `${part.name} · ${label}` : part.name,
      source: `${label} · ${part.source}`,
      anchors: undefined,
      pins: undefined,
      visible: keepOriginal ? true : part.visible,
    };
    set({
      ...changed(state, {
        ...state.scene,
        parts: keepOriginal
          ? [
              ...state.scene.parts.map((p) => (p.id === id ? { ...p, visible: false } : p)),
              processed,
            ]
          : state.scene.parts.map((p) => (p.id === id ? processed : p)),
      }),
      ...withoutRemovedParts(state, [id]),
      selected: [processed.id],
      ...alsoIsolated(state, [processed]),
    });
    return true;
  },
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
      ...alsoIsolated(state, [part]),
    })),
  setScene: (scene, recovered = false, driveFile = null) =>
    set((state) => ({
      scene,
      freeTransform: null,
      driveFile,
      sceneEpoch: state.sceneEpoch + 1,
      selected: [],
      isolated: null,
      past: [],
      future: [],
      revision: state.revision + 1,
      savedRevision: recovered ? state.revision : state.revision + 1,
      tool: 'select',
      activeAnchor: null,
      activeLight: null,
      anchorPicking: false,
      activePin: null,
      pinPicking: null,
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
  receiveScene: (scene) =>
    set((state) => {
      if (scene === state.scene) return {};
      const ids = new Set(scene.parts.map((part) => part.id));
      const removed = state.scene.parts.map((part) => part.id).filter((id) => !ids.has(id));
      return {
        scene,
        freeTransform: null,
        selected: state.selected.filter((id) => ids.has(id)),
        revision: state.revision + 1,
        ...(removed.length ? withoutRemovedParts(state, removed) : {}),
      };
    }),
  renameScene: (name) =>
    set((state) => {
      const next = name.trim() || 'Untitled assembly';
      return next === state.scene.name ? {} : changed(state, { ...state.scene, name: next });
    }),
  undo: () =>
    sharedHandlers
      ? sharedHandlers.undo()
      : set((state) =>
          state.past.length
            ? {
                scene: state.past.at(-1)!,
                past: state.past.slice(0, -1),
                future: [state.scene, ...state.future],
                revision: state.revision + 1,
                selected: state.selected.filter((id) =>
                  state.past.at(-1)!.parts.some((p) => p.id === id),
                ),
                ...restoredIsolated(state, state.past.at(-1)!),
                operation: blankOperation(),
                // Keep placement tools ready for another adjustment after undo.
                tool: ['translate', 'rotate', 'scale', 'transform'].includes(state.tool)
                  ? state.tool
                  : 'select',
                navigationMode: null,
                pivotPicking: false,
                painting: false,
                paintHistory: [],
                measurement: [],
              }
            : {},
        ),
  redo: () =>
    sharedHandlers
      ? sharedHandlers.redo()
      : set((state) =>
          state.future.length
            ? {
                scene: state.future[0],
                past: [...state.past, state.scene],
                future: state.future.slice(1),
                revision: state.revision + 1,
                selected: state.selected.filter((id) =>
                  state.future[0].parts.some((p) => p.id === id),
                ),
                ...restoredIsolated(state, state.future[0]),
                operation: blankOperation(),
                tool: ['translate', 'rotate', 'scale', 'transform'].includes(state.tool)
                  ? state.tool
                  : 'select',
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
    if (patch.partColors !== undefined) savePartColorMode(patch.partColors);
    if (patch.clip) {
      patch = { ...patch, clip: sanitizeClipSettings(patch.clip, get().view.clip) };
      saveClipSettings(patch.clip!);
    }
    if (patch.isolation) {
      patch = {
        ...patch,
        isolation: sanitizeIsolationSettings(patch.isolation, get().view.isolation),
      };
      saveIsolationSettings(patch.isolation!);
    }
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

// Capture every editor alert, including messages emitted directly by constraint handling.
// The transient toast remains available to headset UI and existing duplicate suppression.
useEditor.subscribe((state, previous) => {
  if (state.toast && state.toast.id !== previous.toast?.id)
    recordNotification(state.toast.message, state.toast.kind);
});

let sharedHandlers: { undo: () => void; redo: () => void } | null = null;

/** In a shared scene, undo and redo step through this tab's own changes on the server. */
export function useSharedHistory(handlers: typeof sharedHandlers) {
  sharedHandlers = handlers;
}

/** The lighting the viewport draws: the scene's own, or the default. */
export const sceneLighting = (state: EditorState) => state.scene.lighting ?? state.defaultLighting;

export const canUndo = (state: EditorState) =>
  state.sharedHistory ? state.sharedHistory.undo > 0 : state.past.length > 0;
export const canRedo = (state: EditorState) =>
  state.sharedHistory ? state.sharedHistory.redo > 0 : state.future.length > 0;

/** Preview poses never reach recovery, Drive, or other shared-session participants. */
export const committedScene = (state: EditorState) => state.freeTransform?.baseline ?? state.scene;

function reachableGeometries(state: EditorState) {
  const geometries = new Set<BufferGeometry>();
  for (const parts of [
    state.scene.parts,
    state.freeTransform?.baseline.parts ?? [],
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
    state.scene.parts === previous.scene.parts ||
    state.scene.parts.length !== previous.scene.parts.length
  )
    return;
  if (
    state.scene.parts.some((part, i) => {
      const before = previous.scene.parts[i];
      return (
        part.id === before.id &&
        part.geometry === before.geometry &&
        (part.position !== before.position ||
          part.quaternion !== before.quaternion ||
          part.scale !== before.scale)
      );
    })
  )
    markInteraction();
});
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

// Parts can leave the scene by many routes, such as delete, undo, or another editor.
useEditor.subscribe((state, previous) => {
  if (!state.isolated || state.scene.parts === previous.scene.parts) return;
  const isolated = state.isolated.filter((id) => state.scene.parts.some((part) => part.id === id));
  if (isolated.length !== state.isolated.length)
    useEditor.setState({ isolated: isolated.length ? isolated : null });
});

export function measureDistance() {
  const state = useEditor.getState();
  if (state.measurement.length !== 2) return null;
  const [a, b] = state.measurement,
    partA = resolvePart(state.scene, a.partId),
    partB = resolvePart(state.scene, b.partId);
  return partA && partB ? worldPoint(partA, a).distanceTo(worldPoint(partB, b)) : null;
}
