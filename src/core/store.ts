import { create } from 'zustand';
import {
  cancelTask,
  completeTask,
  failTask,
  notify as recordNotification,
  startTask,
} from './activity';
import type { DriveFileBinding } from './types';
import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Quaternion,
  Sphere,
  Triangle,
  Vector3,
} from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import {
  binaryGeometry,
  partMatrix,
  partSize,
  quat,
  triangleCount,
  uid,
  worldPoint,
} from './geometry';
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
  clipLimits,
  clipNote,
  defaultClipSettings,
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
import {
  transformSelection,
  warpMovesFromPatches,
  type WarpTransformSelection,
} from './transform-selection';
import type { FreeTransformMode, TransformAxis, TransformPatch } from './free-transform';
import type { NavigationMode } from './navigation';
import { createSample } from './sample';
import { useXR } from './xr-session';
import { trimHistory } from './history-budget';
import { captureComponents, instantiateComponents } from './clipboard';
import type { ComponentClipboard } from './clipboard';
import { referencePlanes, resolvePart } from './references';
import { bindTrianglePoint } from './warp-bind';
import {
  createWarpOutput,
  deformPoint,
  evaluateWarp,
  warpUpdateRanges,
  type WarpOutput,
} from './warp-evaluate';
import { defaultWarpDensity, warpDensityNodes } from './warp-grid';
import {
  distributionNodes,
  handleConstraints,
  nodeSample,
  reachHandle,
  warpGuides,
  type WarpHandle,
  type WarpSample,
} from './warp-handles';
import { buildWarpModelJob } from './warp-job';
import { isPaintedFace, type WarpModel, type WarpModelInput } from './warp-model';
import {
  closeGapTargets,
  measureSeam,
  seamMeasurement,
  snapToNeighbour,
  warpNeighbourRange,
  warpNeighbours,
  type SeamReport,
} from './warp-neighbour';
import { regionTriangleOf } from './warp-region';
import {
  createWarpState,
  solveWarp,
  warpDragIterations,
  warpSettleIterations,
  warpSettleTolerance,
  type WarpConstraint,
  type WarpGuides,
  type WarpState,
} from './warp-solve';
import type {
  AssemblyOperation,
  BrushPlaneSettings,
  Joint,
  PlaneConstraint,
  Part,
  Pin,
  SceneDocument,
  SceneLighting,
  SurfacePatch,
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
  /** A free move of warp control points, and the points to restore if it is cancelled. */
  warp?: WarpBaseline;
}

/** The control points a drag began from, to put back if it is cancelled or ends where it began. */
export interface WarpBaseline {
  model: WarpModel;
  points: WarpPoint[];
  selection: WarpTransformSelection;
}

export type WarpGizmo = 'translate' | 'rotate' | 'scale' | 'transform';
/** A control point: a handle with one sample. */
export type WarpPoint = WarpHandle;
export interface WarpSession {
  id: string;
  partId: string;
  source: BufferGeometry;
  epoch: number;
  stage: 'region' | 'building' | 'warp';
  region: 'painted' | 'whole';
  faces: number[];
  /** The region the session began with. Painting since then is work that ending it would lose. */
  startFaces: number[];
  /** The first painted hit; like a contact patch's seed, it fixes the brush plane. */
  seed?: SurfacePatch['seed'];
  density: number;
  model: WarpModel | null;
  state: WarpState | null;
  output: WarpOutput | null;
  /** Never in the scene or history: it owns new position and normal attributes only. */
  preview: BufferGeometry | null;
  points: WarpPoint[];
  selectedPoints: string[];
  gapTargets: { node: number; target: Vec3 }[];
  snap: boolean;
  overlap: number;
  gizmo: WarpGizmo;
  /** Radius new points take, mm, or null for the default for this part and region. */
  pointRadius: number | null;
  /** Falloff new points take, 0 to 1. */
  pointFalloff: number;
  /** How many points Distribute points and automatic placement add. */
  distributeCount: number;
  /** Whether the first grid over effectively the whole part places points itself. */
  autoPoints: boolean;
  /** No grid has been laid in this session yet. */
  firstLay: boolean;
  folds: Uint32Array;
  seam: SeamReport | null;
  undo: WarpEdit[];
}
type WarpEdit = Pick<WarpSession, 'points' | 'gapTargets'>;

export interface WarpFeatherOption {
  enabled: boolean;
  /** mm; null until the switch is first turned on, which takes the brush radius. */
  width: number | null;
}

interface WarpRecovery {
  partId: string;
  source: BufferGeometry;
  session: WarpSession;
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
  /** Warp's own brush radius for each part it was set on. Align's brushRadius is separate. */
  warpBrush: Record<string, number>;
  /** The state before each stroke: contact patches, or the warp region while warping. */
  paintHistory: (SurfacePair[] | Pick<WarpSession, 'faces' | 'seed'>)[];
  operation: AssemblyOperation;
  warp: WarpSession | null;
  /** Feathered edge for painted warp regions, remembered for the page session and never saved. */
  warpFeather: WarpFeatherOption;
  /** First warp in the queued or submitted edit, available to reopen if that batch is refused. */
  warpPending: WarpRecovery | null;
  warpInFlight: WarpRecovery | null;
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
  historyTrimNotified: boolean;
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
  setWarpBrushRadius: (radius: number) => void;
  addSurfacePair: () => void;
  chooseSurface: (pairId: string, side: SurfaceSide) => void;
  paintSurface: (point: SurfacePoint, face: number, erase?: boolean, begin?: boolean) => boolean;
  endPaintStroke: () => void;
  undoPaintStroke: () => void;
  /** Starts a session on the one selected part, or says why it cannot. */
  startWarp: () => boolean;
  /** Also returns a laid grid to the region stage, keeping its points for the next build. */
  setWarpRegion: (mode: 'painted' | 'whole') => void;
  paintWarpRegion: (point: SurfacePoint, face: number, erase?: boolean, begin?: boolean) => boolean;
  layWarpGrid: () => Promise<void>;
  setWarpDensity: (density: number) => Promise<void>;
  setWarpFeather: (patch: { enabled?: boolean; width?: number }) => void;
  cancelWarp: (notice?: string) => void;
  /** Adds a control point where the warped surface was clicked, and selects it. */
  addWarpPoint: (point: SurfacePoint, face: number) => void;
  /** Removes these points, or the selected ones. */
  removeWarpPoints: (ids?: string[]) => void;
  selectWarpPoints: (ids: string[], additive?: boolean) => void;
  /** World targets for points. A drag solves briefly; its end settles and is one undo step. */
  moveWarpPoints: (moves: { id: string; target: Vec3 }[], gesture: 'drag' | 'end') => void;
  setWarpOptions: (
    patch: Partial<
      Pick<WarpSession, 'snap' | 'overlap' | 'gizmo' | 'autoPoints' | 'distributeCount'>
    >,
  ) => void;
  /**
   * Sets the radius and falloff of the selected points, or of new points when none is selected.
   * A slider's drag sends 'drag' per frame and 'end' on release, which records one step.
   */
  setWarpPointSettings: (
    patch: { radius?: number; falloff?: number },
    gesture: 'drag' | 'end',
  ) => void;
  /** Adds the session's number of unmoved points spread evenly over the grid. */
  distributeWarpPoints: () => void;
  /** Pulls the grid nodes that face a nearby part onto its surface, at the overlap depth. */
  closeWarpGap: () => void;
  undoWarpEdit: () => void;
  /** Bakes the warp into the part as one undo step, then starts again on the result. */
  applyWarp: () => boolean;
  /** The live server took the applied warp, or refused it. */
  submitWarp: () => void;
  retryWarp: () => void;
  settleWarp: (accepted: boolean, submittedOnly?: boolean) => void;
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

const toolChange = (state: EditorState, tool: Tool): Partial<EditorState> => {
  // Re-selecting the active tool must not discard picks or painted patches.
  if (tool === state.tool && hasOperationWork(state.operation))
    return { navigationMode: null, pivotPicking: false };
  const mode = tool === 'joint' ? 'point' : state.operation.mode;
  const pair = mode === 'surface' ? emptySurfacePair() : null;
  return {
    tool,
    pinPicking:
      tool === 'pins' && !state.scene.parts.find((p) => p.id === state.selected[0])?.pins?.length
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
};

const newWarpSession = (part: Part, epoch: number, faces: number[] = []): WarpSession => ({
  id: uid(),
  partId: part.id,
  source: part.geometry,
  epoch,
  stage: 'region',
  region: 'painted',
  faces,
  startFaces: faces,
  density: defaultWarpDensity,
  model: null,
  state: null,
  output: null,
  preview: null,
  points: [],
  selectedPoints: [],
  gapTargets: [],
  snap: false,
  overlap: defaultClipSettings.overlap,
  gizmo: 'translate',
  pointRadius: null,
  pointFalloff: 1,
  distributeCount: 8,
  autoPoints: true,
  firstLay: true,
  folds: new Uint32Array(0),
  seam: null,
  undo: [],
});

export const warpDistributeCounts = [4, 8, 16, 32] as const;

/** Whether the region is effectively the whole part, where no fixed border holds it. */
export const warpWholePart = (warp: Pick<WarpSession, 'region' | 'faces'>) =>
  warp.region === 'whole' || !warp.faces.length;

/** Largest axis of the region's world box, mm. */
function regionExtent(model: WarpModel) {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  const { restNodes } = model;
  for (let i = 0; i < restNodes.length; i++) {
    min[i % 3] = Math.min(min[i % 3], restNodes[i]);
    max[i % 3] = Math.max(max[i % 3], restNodes[i]);
  }
  return Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
}

/** The radius new points take: the last one set, or 6 % of the part within a quarter of the region. */
export function warpPointRadius(
  warp: Pick<WarpSession, 'pointRadius' | 'model'>,
  part: Pick<Part, 'geometry' | 'scale'> | undefined,
) {
  if (warp.pointRadius !== null) return warp.pointRadius;
  let radius = part ? 0.06 * partSize(part) : 0;
  if (warp.model) radius = Math.min(radius, regionExtent(warp.model) / 4);
  return radius > 0 ? Number(radius.toPrecision(2)) : 0;
}

type WarpSettled = { stage: 'region' | 'warp'; density: number };
// The grid build in flight, and the stage and density to return to if it is cancelled or fails.
let warpBuild: { controller: AbortController; from: WarpSettled } | null = null;

/** The session before this build, or before the build in flight that it replaces. */
const settledWarp = (warp: WarpSession): WarpSettled =>
  warp.stage === 'building'
    ? (warpBuild?.from ?? { stage: 'region', density: warp.density })
    : { stage: warp.stage, density: warp.density };

function abortWarpBuild() {
  const build = warpBuild;
  warpBuild = null;
  build?.controller.abort();
}

/** Reuse the source's indirect triangle order, with private bounds for the deformed mesh. */
export function refitWarpTree(source: BufferGeometry, geometry: BufferGeometry) {
  if (geometry.boundsTree) {
    geometry.boundsTree.refit();
  } else if (source.boundsTree) {
    const data = MeshBVH.serialize(source.boundsTree as MeshBVH, { cloneBuffers: false });
    const roots = data.roots.map((root) => root.slice(0));
    const tree = MeshBVH.deserialize({ ...data, roots }, geometry, { setIndex: false });
    tree.refit();
    geometry.boundsTree = tree;
  }
}

function warpPreview(source: BufferGeometry, output: WarpOutput) {
  const preview = new BufferGeometry();
  preview.setAttribute('position', new BufferAttribute(output.positions, 3));
  if (output.normals) preview.setAttribute('normal', new BufferAttribute(output.normals, 3));
  preview.setIndex(source.index);
  const color = source.getAttribute('color');
  if (color) preview.setAttribute('color', color);
  return preview;
}

/** Frees a warp preview's own buffers. Its index and color are the source's. */
function disposeWarpPreview(preview: BufferGeometry | null) {
  if (preview) releaseGeometries([preview], useEditor.getState());
}

/** Copies, because the build job transfers its input arrays to a worker. */
function warpModelInput(
  part: Part,
  faces: number[] | null,
  density: number,
  feather = 0,
): WarpModelInput {
  const mesh = binaryGeometry(part.geometry);
  return {
    positions: mesh.positions.slice(),
    index: mesh.indices ? new Uint32Array(mesh.indices) : null,
    normals: mesh.normals?.slice() ?? null,
    matrix: partMatrix(part).elements,
    faces,
    density,
    feather,
  };
}

/** The binding and rest world position of a point on one of the region's triangles. */
function warpBinding(model: WarpModel, triangle: number, barycentric: Vec3) {
  const restWorld: Vec3 = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const v = model.region.triangles[triangle * 3 + c];
    for (let a = 0; a < 3; a++) restWorld[a] += barycentric[c] * model.restWorld[v * 3 + a];
  }
  return {
    binding: bindTrianglePoint(model.region, model.binding, model.restWorld, triangle, barycentric),
    restWorld,
  };
}

/**
 * Binds a handle to a new model, dropping samples whose face is no longer painted in its region, or returns null when
 * none is left. Its guides start from `surface`, the settled surface at each new node, less the
 * share of the session's version of the handle that each node carries.
 */
function rebindHandle(
  model: WarpModel,
  handle: WarpPoint,
  surface: Float64Array,
  current: WarpPoint | null,
): WarpPoint | null {
  const samples = handle.samples.flatMap((sample) => {
    const triangle = isPaintedFace(model, sample.face)
      ? regionTriangleOf(model.region, sample.face)
      : -1;
    return triangle < 0
      ? []
      : [{ ...sample, binding: warpBinding(model, triangle, sample.barycentric).binding }];
  });
  if (!samples.length) return null;
  return reachHandle(model, { ...handle, samples, reach: null }, surface, current);
}

/** The settled surface at each node of `model`, world, from the session's current preview. */
function settledSurface(warp: WarpSession, model: WarpModel) {
  const surface = model.restNodes.slice();
  const { output, model: old } = warp;
  if (!output || !old) return surface;
  const { weldOf, weldedCount } = model.region;
  const first = new Int32Array(weldedCount).fill(-1);
  for (let g = 0; g < weldOf.length; g++)
    if (weldOf[g] !== 0xffffffff && first[weldOf[g]] < 0) first[weldOf[g]] = g;
  const m = old.matrix,
    p = output.positions;
  model.grid.nodes.forEach((v, n) => {
    const g = first[v] * 3;
    for (let a = 0; a < 3; a++)
      surface[n * 3 + a] = m[a] * p[g] + m[4 + a] * p[g + 1] + m[8 + a] * p[g + 2] + m[12 + a];
  });
  return surface;
}

/** Unmoved points on free nodes spread over the grid, away from the points there already. */
function distributedPoints(warp: WarpSession, count: number): WarpPoint[] {
  const model = warp.model!,
    { positions } = warp.state!;
  const guides = sessionGuides(warp);
  return distributionNodes(model, count, warp.points).map((node) => {
    const sample = nodeSample(model, node, positions);
    const point: WarpPoint = {
      id: uid(),
      kind: 'point',
      samples: [sample],
      pin: sample.pin,
      target: null,
      radius: 0,
      falloff: warp.pointFalloff,
      auto: true,
      reach: null,
    };
    return reachHandle(model, point, positions, null, guides);
  });
}

const warpUndoLimit = 100;
// Larger regions follow a drag on the grid alone, and the surface catches up when it ends. A drag
// frame at this size takes about 4 ms on a 3M-triangle unindexed scan.
const warpDragVertices = 50_000;

// The points before the drag in progress, which its end records as one undo step. A radius or
// falloff drag also keeps the points it began from and the surface their guides start from.
let warpDrag: {
  model: WarpModel;
  before: WarpEdit;
  settings?: { from: Map<string, WarpPoint>; surface: Float64Array };
} | null = null;
export const isWarpDragging = () =>
  warpDrag?.model === useEditor.getState().warp?.model && !!warpDrag;

const warpEdit = (warp: WarpSession): WarpEdit => ({
  points: warp.points,
  gapTargets: warp.gapTargets,
});
const withUndo = (warp: WarpSession, step = warpEdit(warp)) => [
  ...warp.undo.slice(-(warpUndoLimit - 1)),
  step,
];
const sameEdit = (a: WarpEdit, b: WarpEdit) =>
  a.gapTargets === b.gapTargets &&
  same(
    a.points.map((point) => [point.id, point.target, point.radius, point.falloff]),
    b.points.map((point) => [point.id, point.target, point.radius, point.falloff]),
  );

/** Whether a point holds the surface away from rest, so a new grid must be solved for it. */
const holdsWarp = (point: WarpPoint) =>
  point.target !== null ||
  point.samples.some(
    ({ pin, restWorld }) => Math.hypot(...pin.map((value, a) => value - restWorld[a])) > 1e-6,
  );

/** Whether Apply would change the mesh. */
export const warpChanges = (warp: WarpSession) =>
  warp.gapTargets.length > 0 || warp.points.some(holdsWarp);

/** Whether ending the session would lose work: a grid, points, gap targets, steps or painting. */
export const warpEdited = (warp: WarpSession) =>
  warp.stage !== 'region' ||
  warp.points.length > 0 ||
  warp.gapTargets.length > 0 ||
  warp.undo.length > 0 ||
  warp.faces !== warp.startFaces;

type WarpSolveInput = Pick<WarpSession, 'model' | 'points' | 'gapTargets'>;

function warpConstraints({ model, points, gapTargets }: WarpSolveInput): WarpConstraint[] {
  const rest = model!.restNodes;
  return [
    ...handleConstraints(points),
    ...gapTargets.map(({ node, target }) => ({
      node: [node],
      weight: [1],
      rest: [rest[node * 3], rest[node * 3 + 1], rest[node * 3 + 2]] as Vec3,
      target,
    })),
  ];
}

/** The points' guides. Gap targets are exact, so no guide pulls on their nodes. */
const sessionGuides = ({ model, points, gapTargets }: WarpSolveInput) =>
  warpGuides(
    model!,
    points,
    gapTargets.map(({ node }) => node),
  );

/** World box around the grid as it is now deformed. */
function warpBounds(state: WarpState) {
  const box = new Box3(),
    point = new Vector3();
  for (let i = 0; i < state.positions.length; i += 3)
    box.expandByPoint(point.fromArray(state.positions, i));
  return box;
}

let seamTimer: ReturnType<typeof setTimeout> | undefined;

function warpSeam(scene: SceneDocument, warp: WarpSession) {
  clearTimeout(seamTimer);
  const { neighbours, indexing } = warpNeighbours(scene, warp.partId, warpBounds(warp.state!));
  noticePreparing(warp, indexing);
  if (!neighbours.length) return null;
  const { model, output, preview } = warp;
  if (typeof window === 'undefined') return measureSeam(model!, output!, neighbours);

  // Neighbour complexity can make even a small region expensive. Budget browser measurements
  // by time and drop work when the preview changes.
  const position = preview!.getAttribute('position') as BufferAttribute;
  const version = position.version;
  const measurement = seamMeasurement(model!, output!, neighbours);
  const advance = () => {
    const current = useEditor.getState();
    if (
      current.warp?.stage !== 'warp' ||
      current.warp.preview !== preview ||
      position.version !== version
    )
      return;
    if (current.scene.parts !== scene.parts) {
      const seam = warpSeam(current.scene, current.warp);
      useEditor.setState({ warp: { ...current.warp, seam } });
      return;
    }
    const deadline = performance.now() + 8;
    do {
      const result = measurement.next();
      if (result.done) {
        useEditor.setState({ warp: { ...current.warp, seam: result.value } });
        return;
      }
    } while (performance.now() < deadline);
    seamTimer = setTimeout(advance, 0);
  };
  seamTimer = setTimeout(advance, 0);
  return null;
}

// The parts still being prepared that the session was told snap and the seam pass over.
let preparingNoticed: { session: string; names: Set<string> } | null = null;

/** Says once a session, for each set of parts, that parts still being prepared were skipped. */
function noticePreparing(warp: WarpSession, indexing: string[]) {
  if (!indexing.length) return;
  if (preparingNoticed?.session !== warp.id)
    preparingNoticed = { session: warp.id, names: new Set() };
  const names = indexing.join(', ');
  if (preparingNoticed.names.has(names)) return;
  preparingNoticed.names.add(names);
  useEditor.getState().notify(`Still preparing ${names}. Try again when it finishes.`, 'info');
}

/** Deforms the preview from the solved grid, and returns the region triangles that folded. */
function deformWarpPreview(
  { model, state, output, preview, source }: WarpSession,
  gesture: 'drag' | 'end',
) {
  // A drag frame leaves folds to the end of the gesture.
  const folds = evaluateWarp(model!, state!, output!, gesture === 'end');
  const ranges = warpUpdateRanges(model!);
  uploadRanges(preview!.getAttribute('position') as BufferAttribute, ranges.positions);
  const normal = preview!.getAttribute('normal') as BufferAttribute | undefined;
  if (normal) uploadRanges(normal, ranges.normals);
  // The source's box grown by the moved vertices holds the surface without a pass over the rest.
  // The sphere encloses the box rather than fitting the points.
  if (!source.boundingBox) source.computeBoundingBox();
  const box = (preview!.boundingBox ??= new Box3()).copy(source.boundingBox!);
  const moved = output!.moved;
  if (moved[0] <= moved[3])
    box.expandByPoint(movedCorner.fromArray(moved)).expandByPoint(movedCorner.fromArray(moved, 3));
  preview!.boundingSphere = box.getBoundingSphere(preview!.boundingSphere ?? new Sphere());
  return folds;
}
const movedCorner = new Vector3();

/** Sends only the given parts of an attribute to the GPU on its next upload. */
function uploadRanges(attribute: BufferAttribute, ranges: Uint32Array) {
  if (!ranges.length) return;
  attribute.clearUpdateRanges();
  for (let i = 0; i < ranges.length; i += 2) attribute.addUpdateRange(ranges[i], ranges[i + 1]);
  attribute.needsUpdate = true;
}

/** Solves `state` until it settles, warm-started from it. */
function settleGrid(
  model: WarpModel,
  constraints: WarpConstraint[],
  state: WarpState,
  guides?: WarpGuides,
) {
  for (let i = 0; i < warpSettleIterations; i++)
    if (solveWarp(model.grid, model.restNodes, constraints, state, 1, guides) < warpSettleTolerance)
      break;
}

/**
 * Solves the grid for the session's points and gap targets. A drag takes a few iterations and
 * deforms the surface only for regions small enough to follow the pointer. The end of an edit
 * settles fully and refreshes folds and, unless `measure` is false, the seam.
 */
function solveWarpSession(
  scene: SceneDocument,
  warp: WarpSession,
  gesture: 'drag' | 'end',
  measure = true,
): WarpSession {
  const model = warp.model!;
  const constraints = warpConstraints(warp);
  const guides = sessionGuides(warp);
  // With nothing holding it, the grid rests rather than staying where the last points left it.
  if (!constraints.length) warp = { ...warp, state: createWarpState(model.restNodes) };
  else if (gesture === 'drag')
    solveWarp(model.grid, model.restNodes, constraints, warp.state!, warpDragIterations, guides);
  else settleGrid(model, constraints, warp.state!, guides);
  if (gesture === 'end')
    return {
      ...warp,
      folds: deformWarpPreview(warp, 'end')!,
      seam: measure ? warpSeam(scene, warp) : warp.seam,
    };
  if (model.region.interiorCount <= warpDragVertices) deformWarpPreview(warp, 'drag');
  return warp;
}

/**
 * The start of a radius or falloff change to the selected points: the points as they were, and
 * the surface their guides start from. A moved point's new guides start from the surface as it
 * would be with that point unmoved, so a wider radius does not stack its bump on the old one.
 */
function beginSettings(warp: WarpSession, selected: Set<string>) {
  const model = warp.model!;
  const from = new Map(
    warp.points.filter((point) => selected.has(point.id)).map((point) => [point.id, point]),
  );
  const state = warp.state!;
  if (![...from.values()].some((point) => point.target)) return { from, surface: state.positions };
  const held = { positions: state.positions.slice(), rotations: state.rotations.slice() };
  const unmoved = {
    ...warp,
    points: warp.points.map((point) => (from.has(point.id) ? { ...point, target: null } : point)),
  };
  settleGrid(model, warpConstraints(unmoved), held, sessionGuides(unmoved));
  return { from, surface: held.positions };
}

/** Moves each target onto the nearest neighbouring surface in range, at the overlap depth. */
function snapWarpTargets(
  scene: SceneDocument,
  warp: WarpSession,
  moves: { id: string; target: Vec3 }[],
) {
  const bounds = warpBounds(warp.state!);
  for (const { target } of moves) bounds.expandByPoint(new Vector3(...target));
  const { neighbours, indexing } = warpNeighbours(scene, warp.partId, bounds);
  noticePreparing(warp, indexing);
  if (!neighbours.length) return moves;
  return moves.map(({ id, target }) => ({
    id,
    target:
      (snapToNeighbour(new Vector3(...target), neighbours, warp.overlap)?.toArray() as Vec3) ??
      target,
  }));
}

/** A new geometry with the session's surface and the source's index and color. */
function appliedWarpGeometry(source: BufferGeometry, output: WarpOutput) {
  const geometry = new BufferGeometry();
  // Copies, so later edits in the session never reach a committed mesh.
  geometry.setAttribute('position', new BufferAttribute(output.positions.slice(), 3));
  if (output.normals)
    geometry.setAttribute('normal', new BufferAttribute(output.normals.slice(), 3));
  geometry.setIndex(source.index);
  const color = source.getAttribute('color');
  if (color) geometry.setAttribute('color', color);
  refitWarpTree(source, geometry);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

const changed = (state: EditorState, scene: SceneDocument, checkpoint = true) => {
  const base = committedScene(state);
  let past = checkpoint ? [...state.past.slice(-(historyLimit - 1)), base] : state.past;
  let notice = {};
  if (checkpoint && (newGeometry(base, scene) || newGeometry(scene, base))) {
    const kept = trimHistory(
      past,
      [],
      [scene, ...(state.clipboard ? [{ name: '', parts: state.clipboard.parts, joints: [] }] : [])],
    );
    if (kept.trimmed) {
      past = kept.past;
      if (!state.historyTrimNotified)
        notice = {
          historyTrimNotified: true,
          toast: { id: uid(), message: 'Undo history was shortened to free memory.', kind: 'info' },
        };
    }
  }
  return {
    scene,
    revision: state.revision + 1,
    ...(state.freeTransform ? { freeTransform: null } : {}),
    ...(checkpoint ? { past, future: [] } : {}),
    ...notice,
  };
};

/** True when a part's geometry in `scene` is not in `base`. Costs one pass over the parts. */
function newGeometry(base: SceneDocument, scene: SceneDocument) {
  const known = new Set<BufferGeometry>();
  for (const part of base.parts) known.add(part.geometry);
  return scene.parts.some((part) => !known.has(part.geometry));
}

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
  warpBrush: {},
  paintHistory: [],
  operation: blankOperation(),
  warp: null,
  warpFeather: { enabled: false, width: null },
  warpPending: null,
  warpInFlight: null,
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
  historyTrimNotified: false,
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
            ...changed(
              { ...state, clipboard },
              {
                ...state.scene,
                parts: state.scene.parts.filter((part) => !ids.has(part.id)),
                joints: state.scene.joints.filter(
                  (joint) => !ids.has(joint.parentId) && !ids.has(joint.childId),
                ),
                constraints: state.scene.constraints?.filter(
                  (c) => !ids.has(c.sourceId) && !ids.has(c.targetId),
                ),
              },
            ),
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
  setTool: (tool) => {
    const state = get();
    if (tool === 'warp' && state.tool === 'warp' && state.warp)
      set({ navigationMode: null, pivotPicking: false });
    else if (tool === 'warp') state.startWarp();
    else set((state) => toolChange(state, tool));
  },
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
  setWarpBrushRadius: (radius) =>
    set((state) =>
      state.warp && Number.isFinite(radius)
        ? {
            warpBrush: {
              ...state.warpBrush,
              [state.warp.partId]: Math.max(0.05, Math.min(100, radius)),
            },
          }
        : {},
    ),
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
  undoPaintStroke: () => {
    const { warp, paintHistory } = get();
    // A grid being built from the region the stroke painted stops.
    const step = paintHistory.at(-1);
    const settled =
      warp?.stage === 'building' && step && !Array.isArray(step) ? settledWarp(warp) : null;
    if (settled) abortWarpBuild();
    set((state) => {
      const surfacePairs = state.paintHistory.at(-1);
      if (!surfacePairs) return {};
      if (!Array.isArray(surfacePairs))
        return {
          painting: false,
          paintHistory: state.paintHistory.slice(0, -1),
          ...(state.warp ? { warp: { ...state.warp, ...surfacePairs, ...settled } } : {}),
        };
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
    });
  },
  startWarp: () => {
    const state = get();
    if (useXR.getState().session) return false;
    const part =
      state.selected.length === 1
        ? state.scene.parts.find((p) => p.id === state.selected[0])
        : undefined;
    if (!part || part.locked || !part.visible) {
      state.notify('Select one visible, unlocked part to warp.', 'info');
      return false;
    }
    if (triangleCount(part.geometry) > maxPaintTriangles) {
      state.notify(`${part.name} has too many triangles to warp. The limit is 10 million.`, 'info');
      return false;
    }
    abortWarpBuild();
    disposeWarpPreview(state.warp?.preview ?? null);
    set((state) => ({
      ...toolChange(state, 'warp'),
      warp: newWarpSession(part, state.sceneEpoch),
    }));
    return true;
  },
  setWarpRegion: (mode) => {
    const { warp } = get();
    if (!warp) return;
    if (warp.stage === 'building') abortWarpBuild();
    set({ painting: false, warp: { ...warp, region: mode, stage: 'region' } });
  },
  paintWarpRegion: (point, face, erase = false, begin = false) => {
    const state = get(),
      warp = state.warp;
    if (
      !warp ||
      state.tool !== 'warp' ||
      warp.stage !== 'region' ||
      warp.region !== 'painted' ||
      point.partId !== warp.partId ||
      state.navigationMode ||
      state.temporaryOrbit ||
      state.pivotPicking ||
      (!begin && !state.painting)
    )
      return false;
    if (state.view.explode) {
      if (begin) state.notify('Reset the exploded view before painting surfaces.', 'info');
      return false;
    }
    const part = state.scene.parts.find((part) => part.id === warp.partId);
    if (!part?.visible || part.geometry !== warp.source) return false;
    const erasing = erase || state.brushErase;
    let faces: number[];
    try {
      faces = facesUnderBrush(part, point, warpBrushRadius(state), face, {
        plane: erasing ? undefined : state.brushPlane,
        patch: { partId: part.id, faces: warp.faces, seed: warp.seed },
      });
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      if (begin) state.notify(`${part.name} has too many edges to paint a warp region.`, 'error');
      return false;
    }
    if (!faces.length) return false;
    const previous = warp.faces;
    const touched = new Set(faces),
      result = erasing
        ? contiguousRemainder(
            part.geometry,
            previous.filter((face) => !touched.has(face)),
            warp.seed?.face,
          )
        : [...new Set([...previous, ...faces])].sort((a, b) => a - b);
    const same =
      previous.length === result.length && previous.every((face, i) => face === result[i]);
    set({
      ...(begin
        ? {
            painting: true,
            paintHistory: [
              ...state.paintHistory.slice(-29),
              { faces: warp.faces, seed: warp.seed },
            ],
          }
        : {}),
      ...(!same
        ? {
            warp: {
              ...warp,
              faces: result,
              seed: result.length
                ? ((previous.length ? warp.seed : undefined) ?? { ...point, face })
                : undefined,
            },
          }
        : {}),
    });
    return true;
  },
  layWarpGrid: async () => {
    const { warp } = get();
    if (warp) await layWarp(settledWarp(warp));
  },
  setWarpDensity: async (density) => {
    const { warp } = get();
    if (!warp || !Number.isFinite(density)) return;
    const level = Math.min(warpDensityNodes.length - 1, Math.max(0, Math.round(density)));
    if (level === warp.density) return;
    const from = settledWarp(warp);
    set({ warp: { ...warp, density: level } });
    if (warp.stage !== 'region') await layWarp(from);
  },
  setWarpFeather: (patch) =>
    set((state) => {
      const enabled = patch.enabled ?? state.warpFeather.enabled;
      const width =
        patch.width !== undefined && Number.isFinite(patch.width)
          ? Math.max(0, Math.min(100, patch.width))
          : (state.warpFeather.width ?? (enabled ? warpBrushRadius(state) : null));
      return { warpFeather: { enabled, width } };
    }),
  cancelWarp: (notice) => {
    const { warp } = get();
    if (!warp) return;
    abortWarpBuild();
    clearTimeout(seamTimer);
    warpDrag = null;
    disposeWarpPreview(warp.preview);
    set({ warp: null, painting: false, paintHistory: [] });
    if (notice) get().notify(notice, 'info');
  },
  addWarpPoint: (point, face) => {
    const state = get(),
      warp = state.warp,
      model = warp?.model;
    if (!warp || !model || state.tool !== 'warp' || warp.stage !== 'warp') return;
    const triangle =
      point.partId === warp.partId && isPaintedFace(model, face)
        ? regionTriangleOf(model.region, face)
        : -1;
    if (triangle < 0) {
      state.notify(
        model.painted ? 'Click on the painted area.' : 'Click inside the warp region.',
        'info',
      );
      return;
    }
    // The click lands on the surface as it is warped, so it is measured against that triangle.
    const { positions } = warp.output!;
    const corner = (c: number) =>
      new Vector3().fromArray(positions, (model.index?.[face * 3 + c] ?? face * 3 + c) * 3);
    // Clamped, since a click can land a hair outside its face.
    const weights = new Triangle(corner(0), corner(1), corner(2))
      .getBarycoord(new Vector3(...point.point), new Vector3())
      ?.toArray()
      .map((w) => Math.max(0, w)) ?? [1, 1, 1];
    const sum = weights[0] + weights[1] + weights[2];
    const barycentric = weights.map((w) => w / sum) as Vec3;
    const { binding, restWorld } = warpBinding(model, triangle, barycentric);
    if (binding.node.every((node) => model.grid.fixed[node])) {
      state.notify('This spot is fixed. Click farther inside the warp region.', 'info');
      return;
    }
    const sample: WarpSample = {
      face,
      barycentric,
      binding,
      restWorld,
      pin: deformPoint(model, warp.state!, binding, restWorld),
    };
    const part = state.scene.parts.find((p) => p.id === warp.partId);
    const added = reachHandle(
      model,
      {
        id: uid(),
        kind: 'point',
        samples: [sample],
        pin: sample.pin,
        target: null,
        radius: warpPointRadius(warp, part),
        falloff: warp.pointFalloff,
        auto: false,
        reach: null,
      },
      warp.state!.positions,
      null,
      sessionGuides(warp),
    );
    set({
      warp: {
        ...warp,
        points: [...warp.points, added],
        selectedPoints: [added.id],
        undo: withUndo(warp),
      },
    });
  },
  removeWarpPoints: (ids) => {
    const state = get(),
      warp = state.warp;
    if (!warp) return;
    const removed = new Set(ids ?? warp.selectedPoints);
    const points = warp.points.filter((point) => !removed.has(point.id));
    if (points.length === warp.points.length) return;
    const next: WarpSession = {
      ...warp,
      points,
      selectedPoints: warp.selectedPoints.filter((id) => !removed.has(id)),
      undo: withUndo(warp),
    };
    set({ warp: warp.stage === 'warp' ? solveWarpSession(state.scene, next, 'end') : next });
  },
  selectWarpPoints: (ids, additive = false) =>
    set(({ warp }) => {
      if (!warp) return {};
      const known = new Set(warp.points.map((point) => point.id));
      const picked = ids.filter((id) => known.has(id));
      const selectedPoints = additive
        ? [
            ...warp.selectedPoints.filter((id) => !picked.includes(id)),
            ...picked.filter((id) => !warp.selectedPoints.includes(id)),
          ]
        : picked;
      return { warp: { ...warp, selectedPoints } };
    }),
  moveWarpPoints: (moves, gesture) => {
    const state = get(),
      warp = state.warp,
      model = warp?.model;
    if (!warp || !model || warp.stage !== 'warp') return;
    const targets = new Map(
      (warp.snap && moves.length ? snapWarpTargets(state.scene, warp, moves) : moves).map(
        (move) => [move.id, move.target],
      ),
    );
    const points = warp.points.map((point) => {
      const target = targets.get(point.id);
      return target ? { ...point, target, auto: false } : point;
    });
    const before = warpDrag?.model === model ? warpDrag.before : warpEdit(warp);
    warpDrag = gesture === 'drag' ? { model, before } : null;
    const next = solveWarpSession(state.scene, { ...warp, points }, gesture);
    set({
      warp:
        gesture === 'end' && !sameEdit(before, next)
          ? { ...next, undo: withUndo(warp, before) }
          : next,
    });
  },
  setWarpOptions: ({ snap, overlap, gizmo, autoPoints, distributeCount }) =>
    set(({ warp }) =>
      warp
        ? {
            warp: {
              ...warp,
              ...(snap !== undefined ? { snap } : {}),
              ...(gizmo ? { gizmo } : {}),
              ...(autoPoints !== undefined ? { autoPoints } : {}),
              ...(distributeCount !== undefined &&
              Number.isInteger(distributeCount) &&
              distributeCount > 0
                ? { distributeCount }
                : {}),
              ...(overlap !== undefined && Number.isFinite(overlap)
                ? { overlap: Math.min(clipLimits.max, Math.max(clipLimits.min, overlap)) }
                : {}),
            },
          }
        : {},
    ),
  setWarpPointSettings: ({ radius, falloff }, gesture) => {
    const state = get(),
      warp = state.warp,
      model = warp?.model;
    if (!warp) return;
    const settings: Partial<WarpSession> = {};
    if (radius !== undefined && Number.isFinite(radius))
      settings.pointRadius = Math.min(100, Math.max(0, radius));
    if (falloff !== undefined && Number.isFinite(falloff))
      settings.pointFalloff = Math.min(1, Math.max(0, falloff));
    const selected = new Set(warp.selectedPoints);
    if (!model || warp.stage !== 'warp' || !warp.points.some((point) => selected.has(point.id))) {
      set({ warp: { ...warp, ...settings } });
      return;
    }
    const continuing = warpDrag?.model === model ? warpDrag : null;
    const start = continuing?.settings ?? beginSettings(warp, selected);
    const points = warp.points.map((point) => {
      const from = start.from.get(point.id);
      if (!from) return point;
      const next = {
        ...from,
        radius: settings.pointRadius ?? from.radius,
        falloff: settings.pointFalloff ?? from.falloff,
      };
      if (next.radius === from.radius && next.falloff === from.falloff) return from;
      return reachHandle(model, { ...next, auto: false }, start.surface, from);
    });
    const before = continuing?.before ?? warpEdit(warp);
    warpDrag = gesture === 'drag' ? { model, before, settings: start } : null;
    const next = solveWarpSession(state.scene, { ...warp, ...settings, points }, gesture);
    set({
      warp:
        gesture === 'end' && !sameEdit(before, next)
          ? { ...next, undo: withUndo(warp, before) }
          : next,
    });
  },
  distributeWarpPoints: () => {
    const state = get(),
      warp = state.warp;
    if (!warp?.model || warp.stage !== 'warp') return;
    const added = distributedPoints(warp, warp.distributeCount);
    if (!added.length) {
      state.notify('Every free grid node already has a point.', 'info');
      return;
    }
    set({ warp: { ...warp, points: [...warp.points, ...added], undo: withUndo(warp) } });
  },
  closeWarpGap: () => {
    const state = get(),
      warp = state.warp,
      model = warp?.model;
    if (!warp || !model || warp.stage !== 'warp') return;
    // Found on the surface the points alone hold, so pressing again or changing the overlap keeps
    // the nodes earlier targets pulled in.
    const held = createWarpState(model.restNodes);
    const constraints = warpConstraints({ ...warp, gapTargets: [] });
    if (constraints.length)
      settleGrid(model, constraints, held, sessionGuides({ ...warp, gapTargets: [] }));
    const { neighbours, indexing } = warpNeighbours(state.scene, warp.partId, warpBounds(held));
    if (indexing.length) {
      state.notify(
        `Still preparing ${indexing.join(', ')}. Try Close gap again when it finishes.`,
        'info',
      );
      return;
    }
    if (!neighbours.length) {
      state.notify(
        `No neighbouring part is within ${warpNeighbourRange} mm of this region.`,
        'info',
      );
      return;
    }
    const gapTargets = closeGapTargets(model, held, neighbours, warp.overlap);
    // Untouched automatic points near the nodes it pulls would hold the seam open: on them, or
    // within the neighbour range where the seam's own edge is not pulled.
    const pulled = gapTargets.map(({ node }) => held.positions.subarray(node * 3, node * 3 + 3));
    const nearSeam = ({ pin }: WarpPoint) =>
      pulled.some(
        (at) => Math.hypot(at[0] - pin[0], at[1] - pin[1], at[2] - pin[2]) <= warpNeighbourRange,
      );
    const points = warp.points.filter((point) => !point.auto || !nearSeam(point));
    if (same(gapTargets, warp.gapTargets) && points.length === warp.points.length) return;
    const kept = new Set(points.map((point) => point.id));
    set({
      warp: solveWarpSession(
        state.scene,
        {
          ...warp,
          points,
          selectedPoints: warp.selectedPoints.filter((id) => kept.has(id)),
          gapTargets,
          undo: withUndo(warp),
        },
        'end',
      ),
    });
  },
  undoWarpEdit: () => {
    const state = get(),
      warp = state.warp,
      step = warp?.undo.at(-1);
    if (!warp || !step) return;
    warpDrag = null;
    const kept = new Set(step.points.map((point) => point.id));
    const next: WarpSession = {
      ...warp,
      ...step,
      selectedPoints: warp.selectedPoints.filter((id) => kept.has(id)),
      undo: warp.undo.slice(0, -1),
    };
    set({ warp: warp.stage === 'warp' ? solveWarpSession(state.scene, next, 'end') : next });
  },
  applyWarp: () => {
    const state = get(),
      warp = state.warp;
    if (!warp?.model || warp.stage !== 'warp') return false;
    // Nothing to bake, so the mesh keeps its exact bits.
    if (!warpChanges(warp)) return false;
    const part = state.scene.parts.find((p) => p.id === warp.partId);
    if (!part || part.geometry !== warp.source || state.sceneEpoch !== warp.epoch) {
      state.notify('The part changed, so the warp could not be applied.', 'error');
      return false;
    }
    if (part.locked) {
      state.notify(`Unlock ${part.name} to apply the warp.`, 'info');
      return false;
    }
    warpDrag = null;
    // The session starts again on the result, keeping the region and options.
    const {
      region,
      faces,
      seed,
      density,
      snap,
      overlap,
      gizmo,
      pointRadius,
      pointFalloff,
      distributeCount,
      autoPoints,
    } = warp;
    // In a live session the server may still refuse it, so the session is kept to reopen.
    const keep =
      !state.warpPending &&
      (state.liveStatus === 'connected' || state.liveStatus === 'disconnected');
    const settled = solveWarpSession(state.scene, warp, 'end', false);
    const geometry = appliedWarpGeometry(warp.source, settled.output!);
    const warped: Part = { ...part, geometry, source: `Warp · ${part.source}` };
    if (!keep) disposeWarpPreview(settled.preview);
    set({
      ...changed(state, {
        ...state.scene,
        parts: state.scene.parts.map((p) => (p.id === part.id ? warped : p)),
      }),
      warp: {
        ...newWarpSession(warped, state.sceneEpoch, faces),
        region,
        seed,
        density,
        snap,
        overlap,
        gizmo,
        pointRadius,
        pointFalloff,
        distributeCount,
        autoPoints,
      },
      warpPending: keep
        ? { partId: part.id, source: warp.source, session: settled }
        : state.warpPending,
    });
    return true;
  },
  submitWarp: () => {
    const { warpPending } = get();
    if (warpPending) set({ warpPending: null, warpInFlight: warpPending });
  },
  retryWarp: () => {
    const { warpInFlight, warpPending } = get();
    if (!warpInFlight) return;
    disposeWarpPreview(warpPending?.session.preview ?? null);
    set({ warpPending: warpInFlight, warpInFlight: null });
  },
  settleWarp: (accepted, submittedOnly = false) => {
    const state = get();
    if (!state.warpPending && !state.warpInFlight) return;
    const retained = submittedOnly ? state.warpPending : null;
    const settled = [state.warpInFlight, submittedOnly ? null : state.warpPending];
    // A coalesced edit rolls the scene all the way back. Only a draft on the restored mesh can
    // reopen, which is usually the first warp applied in the submitted batch.
    const reopen =
      !accepted && !useXR.getState().session
        ? settled.find((pending) => {
            if (!pending) return false;
            const { session } = pending;
            const part = state.scene.parts.find((p) => p.id === pending.partId);
            return (
              part?.geometry === pending.source &&
              part.visible &&
              !part.locked &&
              state.sceneEpoch === session.epoch &&
              same(partMatrix(part).elements, session.model!.matrix)
            );
          })
        : null;
    const released = settled.flatMap((pending) =>
      pending !== reopen && pending?.session.preview ? [pending.session.preview] : [],
    );
    if (released.length) releaseGeometries(released, state);
    if (!reopen) {
      set({ warpPending: retained, warpInFlight: null });
      return;
    }
    const { session } = reopen;
    state.cancelWarp();
    set({
      ...(state.tool === 'warp' ? {} : toolChange(state, 'warp')),
      selected: [reopen.partId],
      warp: { ...session, seam: warpSeam(state.scene, session) },
      warpPending: retained,
      warpInFlight: null,
    });
    state.notify(
      'Your warp could not be combined with another edit. It is open again so you can apply it once more.',
      'info',
    );
  },
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
    // Control points move inside the warp session, which leaving the tool would end.
    const warp =
      selection.kind === 'warp'
        ? { model: state.warp!.model!, points: state.warp!.points, selection }
        : undefined;
    if (!warp) state.setTool(mode);
    set({
      freeTransform: { mode, axis: null, baseline: get().scene, patches: [], warp },
      contextMenu: null,
      temporaryOrbit: false,
    });
    return true;
  },
  previewFreeTransform: (patches) => {
    const session = get().freeTransform;
    if (!session) return;
    set({ freeTransform: { ...session, patches } });
    if (session.warp) {
      const moves = warpMovesFromPatches(session.warp.selection, patches);
      if (moves.length) get().moveWarpPoints(moves, 'drag');
      return;
    }
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
    if (session.warp) {
      const moves = confirm ? warpMovesFromPatches(session.warp.selection, session.patches) : [];
      finishWarpDrag(session.warp, moves);
      set({ freeTransform: null });
      return;
    }
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
      historyTrimNotified: false,
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

/** Whether the brush paints a warp region: the region stage of a painted warp. */
export const paintingWarpRegion = (state: Pick<EditorState, 'tool' | 'warp'>) =>
  state.tool === 'warp' && state.warp?.stage === 'region' && state.warp.region === 'painted';

/** Warp's starting brush radius: 3 % of the part's size. */
export const fittedWarpBrushRadius = (part: Pick<Part, 'geometry' | 'scale'>) =>
  Math.max(0.05, Math.min(100, Number((partSize(part) * 0.03).toPrecision(2))));

/** The brush radius everything uses while warping: what was set on this part, or its fitted start. */
export function warpBrushRadius(state: Pick<EditorState, 'scene' | 'warp' | 'warpBrush'>) {
  const { warp, warpBrush } = state;
  if (warp && warpBrush[warp.partId] !== undefined) return warpBrush[warp.partId];
  const part = warp && state.scene.parts.find((part) => part.id === warp.partId);
  return part ? fittedWarpBrushRadius(part) : 0;
}

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
  const dropped = [...trackedGeometries].filter((geometry) => !reachable.has(geometry));
  trackedGeometries = reachable;
  if (dropped.length) releaseGeometries(dropped, state, reachable);
});

/**
 * Frees the GPU buffers of geometries nothing will draw again. A warp shares its source's index
 * and color, and the renderer frees every buffer a disposed geometry holds, so the ones another
 * geometry still draws with are set aside during the disposal and put back after it.
 */
function releaseGeometries(
  geometries: BufferGeometry[],
  state: EditorState,
  reachable = reachableGeometries(state),
) {
  const released = new Set(geometries);
  const inUse = new Set<unknown>();
  for (const geometry of [
    ...reachable,
    state.warp?.preview,
    state.warpPending?.session.preview,
    state.warpInFlight?.session.preview,
  ]) {
    if (!geometry || released.has(geometry)) continue;
    if (geometry.index) inUse.add(geometry.index);
    for (const name in geometry.attributes) inUse.add(geometry.attributes[name]);
  }
  for (const geometry of released) {
    const index = geometry.index && inUse.has(geometry.index) ? geometry.index : null;
    const shared = Object.entries(geometry.attributes).filter(([, value]) => inUse.has(value));
    if (index) geometry.setIndex(null);
    for (const [name] of shared) geometry.deleteAttribute(name);
    geometry.dispose();
    if (index) geometry.setIndex(index);
    for (const [name, attribute] of shared) geometry.setAttribute(name, attribute);
  }
}

// Parts can leave the scene by many routes, such as delete, undo, or another editor.
useEditor.subscribe((state, previous) => {
  if (!state.isolated || state.scene.parts === previous.scene.parts) return;
  const isolated = state.isolated.filter((id) => state.scene.parts.some((part) => part.id === id));
  if (isolated.length !== state.isolated.length)
    useEditor.setState({ isolated: isolated.length ? isolated : null });
});

/** Ends a free move of control points by putting them back and settling the surface again. */
function restoreWarpPoints({ model, points }: WarpBaseline) {
  if (warpDrag?.model !== model) return;
  const { warp, moveWarpPoints } = useEditor.getState();
  if (warp?.model !== model) {
    warpDrag = null;
    return;
  }
  useEditor.setState({ warp: { ...warp, points } });
  moveWarpPoints([], 'end');
}

/**
 * Ends a drag of control points. A drag that moved them is one undo step. One that ends where it
 * began puts them back, so unmoved points stay pins and no empty step is recorded.
 */
export function finishWarpDrag(baseline: WarpBaseline, moves: { id: string; target: Vec3 }[]) {
  const moved = moves.some(({ id, target }) => {
    const start = baseline.selection.parts.find((point) => point.id === id)?.position;
    return !start || target.some((value, a) => Math.abs(value - start[a]) > 1e-9);
  });
  if (moved) useEditor.getState().moveWarpPoints(moves, 'end');
  else restoreWarpPoints(baseline);
}

// Another edit can end a free move of control points before it is confirmed. It is cancelled.
useEditor.subscribe((state, previous) => {
  const moving = previous.freeTransform?.warp;
  if (moving && !state.freeTransform) restoreWarpPoints(moving);
});

// A kept warp waits for one live server's answer about one scene.
useEditor.subscribe((state) => {
  const pending = state.warpInFlight ?? state.warpPending;
  if (pending && (state.liveStatus === null || state.sceneEpoch !== pending.session.epoch))
    state.settleWarp(true);
});

/** Lays the session's grid. A build that stops returns the session to `from`. */
async function layWarp(from: WarpSettled) {
  const state = useEditor.getState(),
    warp = state.warp;
  const part = warp && state.scene.parts.find((p) => p.id === warp.partId);
  if (!warp || part?.geometry !== warp.source) return;
  abortWarpBuild();
  const controller = new AbortController();
  const build = (warpBuild = { controller, from });
  // An empty painted region would leave the grid nothing to simplify, so it means the whole part.
  const faces = warp.region === 'painted' && warp.faces.length ? warp.faces : null;
  const feather =
    faces && state.warpFeather.enabled ? (state.warpFeather.width ?? warpBrushRadius(state)) : 0;
  const taskId = startTask({
    title: 'Preparing warp',
    detail: `${(faces?.length ?? triangleCount(part.geometry)).toLocaleString()} triangles`,
    progress: null,
    notify: false,
    cancel: () => controller.abort(),
  });
  controller.signal.addEventListener(
    'abort',
    () => cancelTask(taskId, 'Warp preparation cancelled.'),
    { once: true },
  );
  useEditor.setState({ painting: false, warp: { ...warp, stage: 'building' } });
  let model: WarpModel;
  try {
    model = await buildWarpModelJob(
      warpModelInput(part, faces, warp.density, feather),
      controller.signal,
    );
  } catch (error) {
    // A newer build or a cancelled session has already taken over.
    if (warpBuild !== build) return;
    warpBuild = null;
    if (!controller.signal.aborted)
      failTask(taskId, error instanceof Error ? error.message : String(error));
    const current = useEditor.getState().warp;
    if (current) useEditor.setState({ warp: { ...current, ...from } });
    return;
  }
  const current = useEditor.getState().warp;
  if (warpBuild !== build || !current) return;
  warpBuild = null;
  const surface = settledSurface(current, model);
  const versions = new Map(current.points.map((point) => [point.id, point]));
  const rebound = new Map<WarpPoint, WarpPoint | null>();
  const rebind = (points: WarpPoint[]) =>
    points.flatMap((point) => {
      if (!rebound.has(point))
        rebound.set(point, rebindHandle(model, point, surface, versions.get(point.id) ?? null));
      return rebound.get(point) ?? [];
    });
  const points = rebind(current.points);
  const kept = new Set(points.map((point) => point.id));
  const output = createWarpOutput(model);
  disposeWarpPreview(current.preview);
  let laid: WarpSession = {
    ...current,
    stage: 'warp',
    model,
    state: createWarpState(model.restNodes),
    output,
    preview: warpPreview(current.source, output),
    points,
    selectedPoints: current.selectedPoints.filter((id) => kept.has(id)),
    gapTargets: [],
    firstLay: false,
    folds: new Uint32Array(0),
    seam: null,
    // Snapshots must bind to the same grid as the session; gap targets name old nodes.
    undo: current.undo.map((step) => ({ points: rebind(step.points), gapTargets: [] })),
  };
  // Without a fixed border, unmoved points are what stop a drag moving the whole part.
  if (current.firstLay && current.autoPoints && !faces)
    laid = { ...laid, points: [...points, ...distributedPoints(laid, current.distributeCount)] };
  const { scene } = useEditor.getState();
  useEditor.setState({
    // Stroke undo stays available until a grid replaces the region it painted.
    paintHistory: [],
    warp: laid.points.some(holdsWarp)
      ? solveWarpSession(scene, laid, 'end')
      : { ...laid, seam: warpSeam(scene, laid) },
  });
  completeTask(taskId, `${model.grid.nodes.length.toLocaleString()} grid nodes`);
  const { notify } = useEditor.getState();
  if (current.gapTargets.length)
    notify('Close gap again to close the seam at this density.', 'info');
  if (points.length < current.points.length)
    notify('Some control points were outside the new region and were removed.', 'info');
}

// A warp is built from one geometry of one scene. Undo, another editor, opening a file
// or leaving the tool by any route ends the session.
useEditor.subscribe((state, previous) => {
  const { warp } = state;
  if (
    !warp ||
    (warp === previous.warp &&
      state.scene === previous.scene &&
      state.sceneEpoch === previous.sceneEpoch &&
      state.tool === previous.tool)
  )
    return;
  const part = state.scene.parts.find((p) => p.id === warp.partId);
  const before = previous.scene.parts.find((p) => p.id === warp.partId);
  // The grid is built in world space at the part's pose.
  const moved =
    part &&
    before &&
    (!same(part.position, before.position) ||
      !same(part.quaternion, before.quaternion) ||
      !same(part.scale, before.scale));
  // A session with nothing done in it, such as the one after Apply, ends without a word.
  const edited = warpEdited(warp);
  if (!part || part.geometry !== warp.source || state.sceneEpoch !== warp.epoch || moved)
    state.cancelWarp(edited ? 'The part changed, so the warp was cancelled.' : undefined);
  else if (state.tool !== 'warp')
    state.cancelWarp(edited ? 'Warp discarded. Use Apply to keep a warp.' : undefined);
});

export function measureDistance() {
  const state = useEditor.getState();
  if (state.measurement.length !== 2) return null;
  const [a, b] = state.measurement,
    partA = resolvePart(state.scene, a.partId),
    partB = resolvePart(state.scene, b.partId);
  return partA && partB ? worldPoint(partA, a).distanceTo(worldPoint(partB, b)) : null;
}
