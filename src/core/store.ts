import { create } from 'zustand';
import {
  cancelTask,
  completeTask,
  failTask,
  notify as recordNotification,
  startTask,
  updateTask,
  useActivity,
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
import type { GuidePoint } from './refine-band';
import type { RefineBrush } from './refine-brush';
import type { EdgeCurve, GuideJoint, GuideKind } from './refine-curve';
import type { RefineProposal } from './refine-detect';
import type { EdgeEnd, EdgeInput, EdgeSegment, EdgeSolve } from './refine-edge';
import {
  type RefineMesh,
  cloneRefineMesh,
  foldedTriangles,
  trimRefineMesh,
  writeRefinedGeometry,
} from './refine-mesh';
import type { RefineModel } from './refine-model';
import { patchRefinedGeometry, patchRefinedVertices } from './refine-preview';
import type { RegionInput, RegionSolve } from './refine-region';
import type { NavigationMode } from './navigation';
import { createSample } from './sample';
import { useXR } from './xr-session';
import { geometryBytes, historyBudgetBytes, trimHistory } from './history-budget';
import {
  appendSculptStep,
  maskHistoryBytes,
  sculptDefaults,
  sculptHistoryBytes,
  stepSculptSession,
  type SculptSession,
  type SculptStrokeCommit,
} from './sculpt-session';
import { captureComponents, instantiateComponents } from './clipboard';
import type { ComponentClipboard } from './clipboard';
import { referencePlanes, resolvePart } from './references';
import { bindTrianglePoint } from './warp-bind';
import {
  createWarpOutput,
  evaluateWarp,
  warpUpdateRanges,
  writtenNodePositions,
  type WarpOutput,
} from './warp-evaluate';
import { defaultWarpDensity, warpDensityNodes, type WarpGrid } from './warp-grid';
import {
  distributionNodes,
  handleCarry,
  handleConstraints,
  handleGuides,
  heldWhereItIs,
  nodeSample,
  reachHandle,
  showDetail,
  shownDetail as shownOutputDetail,
  snapshotOf,
  spacingAt,
  transferSnapshot,
  uniqueSamples,
  untouchedAuto,
  warpDetail,
  warpEligibleNodes,
  warpGuides,
  warpPinHold,
  warpPriorityStrength,
  writeSnapshotDetail,
  writtenCentre,
  writtenSample,
  snapshotDetail,
  type WarpDetail,
  type WarpHandle,
  type WarpSample,
  type WarpSnapshot,
} from './warp-handles';
import { buildWarpModelJob } from './warp-job';
import { planarPointDetail } from './warp-point-surface';
import { isPaintedFace, type WarpModel, type WarpModelInput } from './warp-model';
import {
  areaSamples,
  lineSamples,
  survivingStroke,
  thinPath,
  type WarpStrokePoint,
} from './warp-strokes';
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
  SculptBrush,
  SculptureSettings,
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
export type WarpAddMode = 'point' | 'line' | 'area';
/** A line as its hits along the surface, or an area as the faces one stroke painted. */
export type WarpStroke =
  | { kind: 'line'; points: WarpStrokePoint[] }
  | { kind: 'area'; faces: number[]; first: WarpStrokePoint };
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
  /** Feather width in mm the grid was laid with, 0 or absent for none. Density changes keep it. */
  feather?: number;
  /** The feather switch and width Edit region shows and the next lay takes. */
  featherEdge: WarpFeatherOption;
  /** Whether the user chose the density. Otherwise it follows the region. */
  densityChosen: boolean;
  /** What the model was built from, so laying the same region again keeps it. */
  laid: WarpLaid | null;
  model: WarpModel | null;
  state: WarpState | null;
  /** The settled grid, shared by the handles and undo steps made on it. */
  surface: WarpSnapshot | null;
  output: WarpOutput | null;
  /** Never in the scene or history: it owns new position and normal attributes only. */
  preview: BufferGeometry | null;
  points: WarpPoint[];
  selectedPoints: string[];
  gapTargets: { node: number; target: Vec3 }[];
  /** How many targets the last Close gap withheld because points the user placed hold the surface. */
  gapHeld?: number;
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
  /** The last edit's solve has not converged yet. It goes on settling in idle frames. */
  settling: boolean;
  /** Apply was pressed while settling: it bakes once the surface settles, unless an edit comes. */
  applying?: boolean;
}
/**
 * A session step: the points and gap targets, the settled grid they held, and the settings new
 * points take.
 */
type WarpEdit = Pick<
  WarpSession,
  | 'points'
  | 'selectedPoints'
  | 'gapTargets'
  | 'gapHeld'
  | 'surface'
  | 'pointRadius'
  | 'pointFalloff'
> & {
  /** On the step a new grid records: the grid it undoes to, rebuilt when it is undone. */
  grid?: WarpGridStep;
  /** On the step laying the same grid records: the region as painted before, put back on undo. */
  painted?: WarpLaid['painted'];
};
type WarpLaid = {
  faces: number[] | null;
  density: number;
  feather: number;
  /** The region as painted when the grid was laid, which undoing a later grid paints again. */
  painted: Pick<WarpSession, 'region' | 'faces' | 'seed' | 'featherEdge'>;
};
/**
 * The grid a density change or a new region left. Its steps' snapshots name `token` instead of the
 * grid, so the old model can be let go; undoing rebuilds it from `laid` and puts them back on it.
 */
interface WarpGridStep {
  laid: WarpLaid;
  densityChosen: boolean;
  token: WarpGrid;
  /** Of the old model, to tell that the rebuild is the same grid. */
  fingerprint: number;
}

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

export type RefineMode = 'edge' | 'region' | 'brush' | 'detect';
export interface RefineFeature {
  id: string;
  state: 'pending' | 'accepted';
  origin: 'hand' | 'detected';
  feature: RefineProposal;
  /** The solved edge of an accepted or previewed edge feature, for drawing. */
  curve?: EdgeCurve;
  /** Pieces an accepted edge's cut came out in; more than 1 when it could not be cut whole. */
  pieces?: number;
  cutDisplay?: ReturnType<typeof import('./refine-edge').cutEdgeDisplay>;
  /** Whether the user changed it since it was made or proposed; a new Detect keeps it then. */
  edited?: boolean;
}
/** A session undo step. Its model shares every array that did not change with its neighbours. */
export interface RefineStep {
  model: RefineModel;
  features: RefineFeature[];
  selected: string[];
  triangles: number[];
  /** Whether the selected guide's last spline segment still took points. */
  drawing: boolean;
}
interface RefinePointSelection {
  feature: string;
  segment: number;
  index: number;
}
export interface RefineSession {
  id: string;
  partId: string;
  source: BufferGeometry;
  epoch: number;
  stage: 'building' | 'ready';
  /** The model the session started with. */
  start: RefineModel | null;
  /** The working surface: the scan with everything accepted. */
  model: RefineModel | null;
  /** The working surface with the selected pending features previewed, uncut. Null when nothing is selected. */
  draft: RefineMesh | null;
  /** Whether more than refineDraftLimit pending features are selected, so no draft is built. */
  draftSkipped: boolean;
  draftStatus: 'building' | 'presenting' | null;
  draggingHandle: boolean;
  /** Never in the scene or history. Face t is triangle t of the working surface. */
  preview: BufferGeometry | null;
  mode: RefineMode;
  features: RefineFeature[];
  selected: string[];
  chosenPoint: RefinePointSelection | null;
  /** Painted triangles of the working surface: the region being made, or where Detect looks. */
  triangles: number[];
  edge: {
    kind: GuideKind;
    width: number | null;
    joint: GuideJoint;
    strength: number;
    /** How the sharpness ends at each end of an open guide; null decides automatically. */
    ends: [EdgeEnd | null, EdgeEnd | null];
  };
  region: Omit<RegionInput, 'triangles'>;
  brush: { kind: RefineBrush; strength: number };
  detect: { where: 'part' | 'painted'; sensitivity: number; minLength: number; running: boolean };
  /** Triangles of the working surface that the last accept folded over. */
  folds: Uint32Array;
  /** Triangles of the working surface that the last accept's cuts left straddling an edge. */
  skipped: Uint32Array;
  /** Whether the selected guide's last spline segment still takes points. */
  drawing: boolean;
  undo: RefineStep[];
  redo: RefineStep[];
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
  /**
   * Warp's own brush radius for each part it was set on in this document, kept for a removed
   * part only while undo or redo can bring it back. Align's brushRadius is separate.
   */
  warpBrush: ReadonlyMap<string, number>;
  /** The state before each stroke: contact patches, or the warp region while warping. */
  paintHistory: (SurfacePair[] | Pick<WarpSession, 'faces' | 'seed'>)[];
  operation: AssemblyOperation;
  warp: WarpSession | null;
  /** Feathered edge for painted warp regions, remembered for the page session and never saved. */
  warpFeather: WarpFeatherOption;
  /** What a press on the surface makes in the Warp stage, remembered for the page session. */
  warpAdd: WarpAddMode;
  /** First warp in the queued or submitted edit, available to reopen if that batch is refused. */
  warpPending: WarpRecovery | null;
  warpInFlight: WarpRecovery | null;
  refine: RefineSession | null;
  sculpt: SculptSession | null;
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
  setWarpAdd: (mode: WarpAddMode) => void;
  /** Makes one line or area handle from a stroke on the warped surface, and selects it. */
  addWarpStroke: (stroke: WarpStroke) => boolean;
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
  /** Undoes a session step. Undoing a density change rebuilds the grid it left; this awaits it. */
  undoWarpEdit: () => Promise<void>;
  /**
   * Bakes the warp into the part as one undo step, then starts again on the result. A surface
   * still settling settles first: in the browser in idle steps, baking once it settles and
   * returning false meanwhile.
   */
  applyWarp: () => boolean;
  /** The live server took the applied warp, or refused it. */
  submitWarp: () => void;
  retryWarp: () => void;
  settleWarp: (accepted: boolean, submittedOnly?: boolean) => void;
  /** Starts a session on the one selected part, or says why it cannot. */
  startSculpt: () => boolean;
  setSculptBrush: (brush: SculptBrush) => void;
  setSculptSettings: (patch: Partial<Omit<SculptureSettings, 'brush'>>) => void;
  resetSculptBrush: () => void;
  cancelSculptStroke: () => void;
  commitSculpt: (stroke: SculptStrokeCommit) => boolean;
  changeSculptMask: (operation: 'invert' | 'clear') => void;
  startRefine: () => boolean;
  /** Ends the session without changing the part. It leaves the tool as it is. */
  cancelRefine: (notice?: string) => void;
  /** Writes the working surface to the part as one undo step, then starts again on the result. */
  applyRefine: () => boolean;
  undoRefine: () => void;
  redoRefine: () => void;
  setRefineMode: (mode: RefineMode) => void;
  /**
   * Kind and joint are always for the next segment. Width, strength and ends go to the selected
   * pending edges when there are any, each with its own entry of `each` on top, and otherwise to
   * the next edge's defaults.
   */
  setRefineEdge: (
    options: Partial<RefineSession['edge']>,
    each?: Record<string, Partial<Pick<EdgeInput, 'width' | 'strength' | 'ends'>>>,
  ) => void;
  /**
   * Goes to the selected pending regions when there are any, each with its own entry of `each` on
   * top, and otherwise to the next region's defaults.
   */
  /**
   * Puts pending features back as they were before an edit, each one's proposal and edited mark,
   * in one write: how a cancelled live edit undoes itself.
   */
  restoreRefineFeatures: (
    saved: readonly { id: string; feature: RefineProposal; edited?: boolean }[],
  ) => void;
  /** Puts back the session's Edge and Region defaults as saved; never touches a feature. */
  restoreRefineDefaults: (saved: {
    edge?: Partial<RefineSession['edge']>;
    region?: Partial<RefineSession['region']>;
  }) => void;
  setRefineRegion: (
    options: Partial<RefineSession['region']>,
    each?: Record<string, Partial<RefineSession['region']>>,
  ) => void;
  setRefineBrush: (options: Partial<RefineSession['brush']>) => void;
  setRefineDetect: (options: Partial<Omit<RefineSession['detect'], 'running'>>) => void;
  /** Adds a point to the guide being drawn, starting one if none is selected. `close` is set when the point is the path's first point. */
  addRefinePoint: (point: GuidePoint, close?: boolean) => void;
  /** `begin` starts a new undo step for a drag; moves without it extend the current drag. */
  moveRefinePoint: (
    feature: string,
    segment: number,
    index: number,
    point: GuidePoint,
    begin?: boolean,
  ) => void;
  removeRefinePoint: (feature: string, segment: number, index: number) => void;
  clickRefinePoint: (feature: string, segment: number, index: number) => void;
  clearChosenRefinePoint: () => void;
  removeChosenRefinePoint: () => void;
  /** Ends the spline segment being drawn. */
  finishRefineGuide: () => void;
  paintRefineRegion: (
    point: SurfacePoint,
    triangle: number,
    erase?: boolean,
    begin?: boolean,
  ) => boolean;
  /** Turns the painted triangles into a pending region with the current region settings, and selects it. */
  makeRefineRegion: () => void;
  selectRefine: (ids: string[]) => void;
  /** Accepts the given pending features, or the selected ones. */
  acceptRefine: (ids?: string[]) => void;
  presentRefineDraft: (presented: RefineSession) => void;
  dismissRefine: (ids?: string[]) => void;
  beginRefineStroke: (point: GuidePoint) => void;
  moveRefineStroke: (point: GuidePoint) => void;
  endRefineStroke: () => void;
  /** Ends the stroke under way without committing it: no step, and the preview shows the model. */
  cancelRefineStroke: () => void;
  beginRefineDrag: () => void;
  /** Puts the session back as it was when the handle drag under way began, its steps included. */
  cancelRefineDrag: () => void;
  /** The handle drag under way was released: its draft is built on the next frame. */
  endRefineDrag: () => void;
  detectRefine: () => Promise<void>;
  cancelRefineDetect: () => void;
  setRefineBrushRadius: (radius: number) => void;
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
    sculpt: tool === 'sculpt' ? state.sculpt : null,
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

const newWarpSession = (
  part: Part,
  epoch: number,
  featherEdge: WarpFeatherOption,
  faces: number[] = [],
): WarpSession => ({
  id: uid(),
  partId: part.id,
  source: part.geometry,
  epoch,
  stage: 'region',
  region: 'painted',
  faces,
  startFaces: faces,
  density: defaultWarpDensity,
  feather: 0,
  featherEdge,
  densityChosen: false,
  laid: null,
  model: null,
  state: null,
  surface: null,
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
  settling: false,
  applying: false,
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

/** Grid density for a region that is effectively the whole part, unless the user chose one. */
export const warpWholeDensity = 5;
/** A new point's default radius reaches at least this many node spacings, so it bends smoothly. */
export const warpRadiusSpacings = 4.5;

const typicalSpacings = new WeakMap<WarpModel, number>();

/** Median grid edge length over the nodes a handle can sit on, mm. */
function typicalSpacing(model: WarpModel) {
  let spacing = typicalSpacings.get(model);
  if (spacing === undefined) {
    const eligible = warpEligibleNodes(model);
    const lengths: number[] = [];
    for (let n = 0; n < eligible.length; n++) if (eligible[n]) lengths.push(spacingAt(model, [n]));
    lengths.sort((a, b) => a - b);
    spacing = lengths.length ? lengths[lengths.length >> 1] : 0;
    typicalSpacings.set(model, spacing);
  }
  return spacing;
}

/**
 * The radius new points take: the last one set, or else 6 % of the part or a few node spacings
 * where it is placed, whichever is larger, within a quarter of the region.
 */
export function warpPointRadius(
  warp: Pick<WarpSession, 'pointRadius' | 'model'>,
  part: Pick<Part, 'geometry' | 'scale'> | undefined,
  spacing = warp.model ? typicalSpacing(warp.model) : 0,
) {
  if (warp.pointRadius !== null) return warp.pointRadius;
  let radius = Math.max(part ? 0.06 * partSize(part) : 0, warpRadiusSpacings * spacing);
  if (warp.model) radius = Math.min(radius, regionExtent(warp.model) / 4);
  return radius > 0 ? Number(radius.toPrecision(2)) : 0;
}

type WarpSettled = Pick<WarpSession, 'feather' | 'densityChosen'> & {
  stage: 'region' | 'warp';
  density: number;
};
// The grid build in flight, and the stage, density and feather to return to if it is cancelled or
// fails.
let warpBuild: { controller: AbortController; from: WarpSettled } | null = null;

/** The session before this build, or before the build in flight that it replaces. */
const settledWarp = (warp: WarpSession): WarpSettled =>
  warp.stage === 'building'
    ? (warpBuild?.from ?? {
        stage: 'region',
        density: warp.density,
        feather: warp.feather,
        densityChosen: warp.densityChosen,
      })
    : {
        stage: warp.stage,
        density: warp.density,
        feather: warp.feather,
        densityChosen: warp.densityChosen,
      };

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
 * Why a new model would drop a handle: none of its samples is painted there, or every node they are
 * bound to is fixed, so it could not move the surface. Null when it stays.
 */
function droppedBy(model: WarpModel, handle: WarpPoint): 'unpainted' | 'fixed' | null {
  const left = survivingStroke(model, handle);
  if (!left) return 'unpainted';
  const painted = left.samples.filter(({ face }) => isPaintedFace(model, face));
  if (!painted.length) return 'unpainted';
  const { fixed } = model.grid;
  return painted.every(({ face, barycentric }) =>
    warpBinding(model, regionTriangleOf(model.region, face), barycentric).binding.node.every(
      (node) => fixed[node],
    ),
  )
    ? 'fixed'
    : null;
}

/**
 * Binds a handle to a new model, keeping what is left of a line or an area on its paint, and
 * dropping samples the new grid binds exactly as another. Null when no sample is left, when too
 * little of a line is, or when every node the samples are bound to is fixed, so it could not move
 * the surface.
 */
function rebindHandle(model: WarpModel, handle: WarpPoint): WarpPoint | null {
  const left = survivingStroke(model, handle);
  if (!left) return null;
  const samples = uniqueSamples(
    left.samples.flatMap((sample) => {
      const triangle = isPaintedFace(model, sample.face)
        ? regionTriangleOf(model.region, sample.face)
        : -1;
      return triangle < 0
        ? []
        : [{ ...sample, binding: warpBinding(model, triangle, sample.barycentric).binding }];
    }),
  );
  const { fixed } = model.grid;
  if (samples.every(({ binding }) => binding.node.every((node) => fixed[node]))) return null;
  const faces = left.faces?.filter((face) => isPaintedFace(model, face));
  return reachHandle(model, { ...left, samples, ...(faces ? { faces } : {}), reach: null });
}

/** The session's settled grid as a snapshot, or the grid as shown while it is still settling. */
function settledOf(warp: WarpSession) {
  if (warp.surface?.grid === warp.model!.grid && warp.surface.settled) return warp.surface;
  const snapshot = snapshotOf(warp.model!.grid, warp.state!, !warp.settling);
  // As shown: with the detail the points bend between nodes, which a handle made on it holds.
  writeSnapshotDetail(snapshot, shownDetail(warp));
  return snapshot;
}

/** Unmoved points on free nodes spread over the grid, away from the points there already. */
function distributedPoints(warp: WarpSession, count: number): WarpPoint[] {
  const model = warp.model!,
    { positions } = warp.state!;
  const baseline = settledOf(warp);
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
      baseline,
      reach: null,
    };
    return reachHandle(model, point);
  });
}

const warpUndoLimit = 100;
// Larger regions follow a drag on the grid alone, and the surface catches up when it ends. A drag
// frame at this size takes about 4 ms on a 3M-triangle unindexed scan.
const warpDragVertices = 50_000;

// The session before the drag in progress, which its end records as one undo step. A radius or
// falloff drag also keeps the points it began from.
let warpDrag: {
  model: WarpModel;
  before: WarpEdit;
  settings?: Map<string, WarpPoint>;
} | null = null;
export const isWarpDragging = () =>
  warpDrag?.model === useEditor.getState().warp?.model && !!warpDrag;

const warpEdit = (warp: WarpSession): WarpEdit => ({
  points: warp.points,
  selectedPoints: warp.selectedPoints,
  gapTargets: warp.gapTargets,
  gapHeld: warp.gapHeld ?? 0,
  surface: warp.model && warp.state ? settledOf(warp) : warp.surface,
  pointRadius: warp.pointRadius,
  pointFalloff: warp.pointFalloff,
});
const withUndo = (warp: WarpSession, step = warpEdit(warp)) => [
  ...warp.undo.slice(-(warpUndoLimit - 1)),
  step,
];
const sameEdit = (a: WarpEdit, b: WarpEdit) =>
  a.gapTargets === b.gapTargets &&
  a.pointRadius === b.pointRadius &&
  a.pointFalloff === b.pointFalloff &&
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

/**
 * How far the written surface stops from the targets of the selected handles that were moved,
 * at worst, mm; 0 when none is selected or moved.
 */
export function warpShortfall(warp: WarpSession) {
  const { model, state } = warp;
  if (!model || !state || warp.stage !== 'warp') return 0;
  let worst = 0;
  for (const point of warp.points)
    if (point.target && warp.selectedPoints.includes(point.id)) {
      const at = writtenCentre(model, state, point, shownDetail(warp));
      worst = Math.max(
        worst,
        Math.hypot(at[0] - point.target[0], at[1] - point.target[1], at[2] - point.target[2]),
      );
    }
  return worst;
}
/** A selected handle whose surface stops farther than this from its target says so, mm. */
export const warpShortfallShown = 0.02;

/**
 * How far the written surface has moved from the pins of the selected unmoved handles the user
 * placed, at worst, mm. Untouched automatic points ride with the surface, so they are left out.
 */
export function warpPinDrift(warp: WarpSession) {
  const { model, state } = warp;
  if (!model || !state || warp.stage !== 'warp') return 0;
  let worst = 0;
  for (const point of warp.points)
    if (point.target === null && !point.auto && warp.selectedPoints.includes(point.id)) {
      const at = writtenCentre(model, state, point, shownDetail(warp));
      worst = Math.max(
        worst,
        Math.hypot(at[0] - point.pin[0], at[1] - point.pin[1], at[2] - point.pin[2]),
      );
    }
  return worst;
}

/** The nodes a handle's samples are bound to and those beside them. */
function nodesAround(model: WarpModel, handle: WarpPoint) {
  const { edgeStart, edges } = model.grid;
  const near = new Set<number>();
  for (const { binding } of handle.samples)
    for (const n of binding.node) {
      near.add(n);
      for (let e = edgeStart[n]; e < edgeStart[n + 1]; e++) near.add(edges[e]);
    }
  return near;
}

/**
 * What holds back the selected moved handle that stops farthest short: a stationary point the user
 * placed on or beside its nodes, the fixed edge its samples are partly bound to, or Close gap's
 * targets beside it. Null when none of these is there.
 */
export function warpShortfallCause(warp: WarpSession): 'pin' | 'edge' | 'gap' | null {
  const { model, state } = warp;
  if (!model || !state) return null;
  let worst: WarpPoint | null = null,
    far = 0;
  for (const point of warp.points)
    if (point.target && warp.selectedPoints.includes(point.id)) {
      const at = writtenCentre(model, state, point, shownDetail(warp));
      const d = Math.hypot(...at.map((value, a) => value - point.target![a]));
      if (d > far) [worst, far] = [point, d];
    }
  if (!worst) return null;
  const near = nodesAround(model, worst);
  const { fixed } = model.grid;
  if (
    warp.points.some(
      (point) =>
        point.target === null &&
        !point.auto &&
        point.samples.some(({ binding }) => binding.node.some((n) => near.has(n))),
    )
  )
    return 'pin';
  // A binding's fixed corners carry the rest of its weight.
  const free = (binding: WarpPoint['samples'][number]['binding']) =>
    binding.node.reduce((sum, n, k) => sum + (fixed[n] ? 0 : binding.weight[k]), 0);
  if (worst.samples.some(({ binding }) => free(binding) < 1 - 1e-9)) return 'edge';
  if (warp.gapTargets.some(({ node }) => near.has(node))) return 'gap';
  return null;
}

/**
 * What moves the selected stationary point that has drifted farthest from its pin: Close gap's
 * targets or a moved handle, whichever the grid reaches first from its nodes.
 */
export function warpPinDriftCause(warp: WarpSession): 'gap' | 'moved' {
  const { model, state } = warp;
  if (!model || !state || !warp.gapTargets.length) return 'moved';
  let worst: WarpPoint | null = null,
    far = 0;
  for (const point of warp.points)
    if (point.target === null && !point.auto && warp.selectedPoints.includes(point.id)) {
      const at = writtenCentre(model, state, point, shownDetail(warp));
      const d = Math.hypot(...at.map((value, a) => value - point.pin[a]));
      if (d > far) [worst, far] = [point, d];
    }
  if (!worst) return 'moved';
  const gap = new Set(warp.gapTargets.map(({ node }) => node));
  const moved = new Set<number>();
  for (const point of warp.points)
    if (point.target !== null)
      for (const { binding } of point.samples) for (const n of binding.node) moved.add(n);
  const { edgeStart, edges } = model.grid;
  const seen = new Set<number>();
  const queue: number[] = [];
  for (const { binding } of worst.samples)
    for (const n of binding.node)
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
  for (let q = 0; q < queue.length; q++) {
    const n = queue[q];
    if (moved.has(n)) return 'moved';
    if (gap.has(n)) return 'gap';
    for (let e = edgeStart[n]; e < edgeStart[n + 1]; e++)
      if (!seen.has(edges[e])) {
        seen.add(edges[e]);
        queue.push(edges[e]);
      }
  }
  return 'moved';
}

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

function warpConstraints(
  { model, points, gapTargets }: WarpSolveInput,
  guides: WarpGuides | undefined,
  carry?: ReadonlyMap<WarpPoint, number>,
  detail?: WarpDetail,
): WarpConstraint[] {
  const rest = model!.restNodes;
  return [
    ...handleConstraints(
      points,
      model!,
      guides,
      gapTargets.map(({ node }) => node),
      carry,
      detail,
    ),
    // A seam closes as exactly as a point the user moved lands.
    ...gapTargets.map(({ node, target }) => ({
      node: [node],
      weight: [1],
      rest: [rest[node * 3], rest[node * 3 + 1], rest[node * 3 + 2]] as Vec3,
      target,
      strength: warpPriorityStrength,
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

/**
 * What the solve is given: guides and constraints, with each grab the fixed edge or a pin holds
 * back carrying only the share of its offset it can. A drag frame solves without priority.
 */
function warpSolveInput(warp: WarpSolveInput, drag = false) {
  const last = lastSolveInputs.get(warp.model!);
  if (
    last &&
    last.points === warp.points &&
    last.gapTargets === warp.gapTargets &&
    last.drag === drag
  )
    return last.input;
  const input = solveInputOf(warp, drag);
  lastSolveInputs.set(warp.model!, {
    points: warp.points,
    gapTargets: warp.gapTargets,
    drag,
    input,
  });
  return input;
}

// The last solve input, which the preview reads again for the same points.
const lastSolveInputs = new WeakMap<
  WarpModel,
  {
    points: WarpSolveInput['points'];
    gapTargets: WarpSolveInput['gapTargets'];
    drag: boolean;
    input: ReturnType<typeof solveInputOf>;
  }
>();

function solveInputOf(warp: WarpSolveInput, drag: boolean) {
  const exact = warp.gapTargets.map(({ node }) => node);
  const plain = (constraints: WarpConstraint[]) =>
    drag
      ? constraints.map(({ strength, ...constraint }) => (void strength, constraint))
      : constraints;
  let guides = sessionGuides(warp);
  let constraints = plain(warpConstraints(warp, guides));
  const carry = handleCarry(warp.model!, warp.points, constraints, guides, exact);
  if (carry.size) guides = warpGuides(warp.model!, warp.points, exact, carry);
  // What the moved handles bend between grid nodes, written over what the nodes carry.
  const samplesOnly = drag && warp.model!.region.interiorCount > warpDragVertices;
  const detail = warpDetail(warp.model!, warp.points, exact, carry, samplesOnly);
  if (carry.size || detail) constraints = plain(warpConstraints(warp, guides, carry, detail));
  return { guides, constraints, detail };
}

/** World box around the grid as it is now deformed. */
function warpBounds(positions: ArrayLike<number>) {
  const box = new Box3(),
    point = new Vector3();
  for (let i = 0; i < positions.length; i += 3) box.expandByPoint(point.fromArray(positions, i));
  return box;
}

let seamTimer: ReturnType<typeof setTimeout> | undefined;

function warpSeam(scene: SceneDocument, warp: WarpSession) {
  clearTimeout(seamTimer);
  const { neighbours, indexing } = warpNeighbours(
    scene,
    warp.partId,
    warpBounds(warp.state!.positions),
  );
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

/** The shoulder profile is written on a points-only surface. Exact seam targets take priority. */
function surfaceDetail(
  model: WarpModel,
  state: WarpState,
  points: WarpPoint[],
  guided: WarpDetail | undefined,
  closing: boolean,
) {
  return closing ? guided : (planarPointDetail(model, state, points, guided) ?? guided);
}

/** Deforms the preview from the solved grid, and returns the region triangles that folded. */
function deformWarpPreview(warp: WarpSession, gesture: 'drag' | 'end') {
  const { model, state, output, preview, source } = warp;
  const input = warpSolveInput(warp, gesture === 'drag');
  const detail = surfaceDetail(
    model!,
    state!,
    warp.points,
    input.detail,
    warp.gapTargets.length > 0,
  );
  showDetail(output!, detail);
  // A drag frame leaves folds to the end of the gesture.
  const folds = evaluateWarp(model!, state!, output!, gesture === 'end', detail);
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

/** The detail the session's surface is shown with: what a point made on it sits on. */
const shownDetail = (warp: Pick<WarpSession, 'output'>) => shownOutputDetail(warp.output);

/** Sends only the given parts of an attribute to the GPU on its next upload. */
function uploadRanges(attribute: BufferAttribute, ranges: Uint32Array) {
  if (!ranges.length) return;
  attribute.clearUpdateRanges();
  for (let i = 0; i < ranges.length; i += 2) attribute.addUpdateRange(ranges[i], ranges[i + 1]);
  attribute.needsUpdate = true;
}

/** Solves `state` until it settles, warm-started from it. Returns the last iteration's largest move. */
function settleGrid(
  model: WarpModel,
  constraints: WarpConstraint[],
  state: WarpState,
  guides?: WarpGuides,
) {
  let move = Infinity;
  for (let i = 0; i < warpSettleIterations; i++) {
    move = solveWarp(model.grid, model.restNodes, constraints, state, 1, guides);
    if (move < warpSettleTolerance) break;
  }
  return move;
}

// A solve has converged once an iteration moves no node by more than this, mm. Grids with few pins
// approach it slowly, so after the first settle the rest happens in idle frames.
const warpConvergedMove = 1e-6;
// The most iterations one edit settles for, after which it stops where it is.
const warpSettleLimit = 20_000;
// Time each idle step settles for, and how often it redraws the surface while settling, ms.
const warpSettleBudget = 8;
const warpSettleRedraw = 200;

/**
 * Solves the grid for the session's points and gap targets. A drag takes a few iterations and
 * deforms the surface only for regions small enough to follow the pointer. The end of an edit
 * settles, refreshes folds and, unless `measure` is false, the seam; when it has not converged it
 * goes on settling in idle frames.
 */
function solveWarpSession(
  scene: SceneDocument,
  warp: WarpSession,
  gesture: 'drag' | 'end',
  measure = true,
): WarpSession {
  const model = warp.model!;
  // A drag frame costs what it did before priority: the end of the gesture lands the handle.
  const { guides, constraints } = warpSolveInput(warp, gesture === 'drag');
  let move = 0;
  // With nothing holding it, the grid rests rather than staying where the last points left it.
  if (!constraints.length) warp = { ...warp, state: createWarpState(model.restNodes) };
  else if (gesture === 'drag')
    solveWarp(model.grid, model.restNodes, constraints, warp.state!, warpDragIterations, guides);
  else move = settleGrid(model, constraints, warp.state!, guides);
  if (gesture === 'end')
    return showWarp(
      scene,
      { ...warp, surface: null, settling: move >= warpConvergedMove },
      measure,
    );
  if (model.region.interiorCount <= warpDragVertices) deformWarpPreview(warp, 'drag');
  return warp.settling ? { ...warp, settling: false } : warp;
}

/**
 * Draws a settled grid: the preview, its folds and, unless `measure` is false, the seam. With
 * nothing holding the surface away from rest, the preview takes back the source's own bits. A grid
 * still settling has no settled surface yet and goes on settling.
 */
function showWarp(scene: SceneDocument, warp: WarpSession, measure = true): WarpSession {
  const resting = !warp.gapTargets.length && !warp.points.some(holdsWarp);
  if (warp.settling) scheduleWarpSettle();
  const surface = warp.settling
    ? null
    : (warp.surface ?? snapshotOf(warp.model!.grid, warp.state!));
  const folds = resting
    ? (restWarpPreview(warp), new Uint32Array(0))
    : deformWarpPreview(warp, 'end')!;
  // The surface keeps the detail it is shown with, which a new grid takes along with it.
  if (surface) writeSnapshotDetail(surface, shownDetail(warp));
  return {
    ...warp,
    surface,
    folds,
    seam: measure && warp.stage === 'warp' ? warpSeam(scene, warp) : warp.seam,
  };
}

// The session the idle steps are settling, the constraints they solve, and how far they are.
let warpSettled: {
  warp: WarpSession | null;
  guides?: WarpGuides;
  constraints?: WarpConstraint[];
  iterations: number;
  drawn: number;
} = { warp: null, iterations: 0, drawn: 0 };
let settleTimer: ReturnType<typeof setTimeout> | undefined;

/** Stops idle settling and lets go of the session it was settling. */
function forgetWarpSettle() {
  clearTimeout(settleTimer);
  settleTimer = undefined;
  warpSettled = { warp: null, iterations: 0, drawn: 0 };
}

function scheduleWarpSettle() {
  if (typeof window === 'undefined' || settleTimer !== undefined) return;
  settleTimer = setTimeout(() => {
    settleTimer = undefined;
    stepWarpSettle(warpSettleBudget);
  }, 0);
}

/**
 * Settles the session's grid further for about `budget` ms, or until it converges. It redraws
 * the surface now and then, and fully once it has converged. Returns whether there is more to do.
 */
function stepWarpSettle(budget: number) {
  const { warp, scene } = useEditor.getState();
  if (!warp?.settling || warp.stage !== 'warp' || !warp.model || isWarpDragging()) return false;
  const model = warp.model;
  // Any edit makes a new session object with new points, gap targets or state.
  const progress = warpSettled;
  if (
    !progress.warp ||
    progress.warp.points !== warp.points ||
    progress.warp.gapTargets !== warp.gapTargets ||
    progress.warp.state !== warp.state ||
    progress.warp.model !== model
  ) {
    progress.warp = warp;
    progress.iterations = 0;
    const input = warpSolveInput(warp);
    progress.guides = input.guides;
    progress.constraints = input.constraints;
  }
  const deadline = performance.now() + budget;
  let move = Infinity;
  do {
    move = solveWarp(
      model.grid,
      model.restNodes,
      progress.constraints!,
      warp.state!,
      1,
      progress.guides,
    );
    progress.iterations++;
  } while (
    move >= warpConvergedMove &&
    progress.iterations < warpSettleLimit &&
    performance.now() < deadline
  );
  if (move < warpConvergedMove || progress.iterations >= warpSettleLimit) {
    // An Apply waiting for this replaces the session, so the seam is not measured.
    const next = showWarp(scene, { ...warp, settling: false, surface: null }, !warp.applying);
    forgetWarpSettle();
    useEditor.setState({ warp: next });
    if (next.applying) useEditor.getState().applyWarp();
    return false;
  }
  const now = performance.now();
  let next = warp;
  if (now - progress.drawn >= warpSettleRedraw) {
    progress.drawn = now;
    // Folds are counted on the surface shown, so the panel never reports an older one.
    next = { ...warp, folds: deformWarpPreview(warp, 'end')! };
    progress.warp = next;
  }
  if (next !== warp) useEditor.setState({ warp: next });
  scheduleWarpSettle();
  return true;
}

/**
 * Where the session's surface is written at a sample, world: what its grid carries there, and
 * the detail the moved handles bend between nodes.
 */
export function writtenWarpSample(
  sample: Pick<WarpSample, 'face' | 'barycentric' | 'binding' | 'restWorld'>,
) {
  const { warp } = useEditor.getState();
  return writtenSample(warp!.model!, warp!.state!, sample, shownDetail(warp!));
}

/** Settles the session's grid until it converges, without waiting for idle frames. */
export function finishWarpSettling() {
  while (stepWarpSettle(Infinity));
}

/** Puts the source's positions and normals back into the preview. */
function restWarpPreview({ model, output, preview, source }: WarpSession) {
  showDetail(output!, undefined);
  output!.positions.set(model!.positions);
  if (output!.normals && model!.normals) output!.normals.set(model!.normals);
  output!.moved.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  for (const name of ['position', 'normal']) {
    const attribute = preview!.getAttribute(name) as BufferAttribute | undefined;
    if (!attribute) continue;
    attribute.clearUpdateRanges();
    attribute.needsUpdate = true;
  }
  if (!source.boundingBox) source.computeBoundingBox();
  (preview!.boundingBox ??= new Box3()).copy(source.boundingBox!);
  preview!.boundingSphere = preview!.boundingBox.getBoundingSphere(
    preview!.boundingSphere ?? new Sphere(),
  );
}

/**
 * The session as `step` left it. Its grid is restored exactly as it was shown when it was solved on
 * this grid, and settled again from it when it was carried over from another one.
 */
function restoreWarp(scene: SceneDocument, warp: WarpSession, step: WarpEdit): WarpSession {
  const kept = new Set(step.points.map((point) => point.id));
  const { painted, ...edit } = step;
  const next: WarpSession = {
    ...warp,
    ...edit,
    ...(painted && warp.laid ? { ...painted, laid: { ...warp.laid, painted } } : {}),
    surface: warp.surface,
    selectedPoints: step.selectedPoints.filter((id) => kept.has(id)),
  };
  const { model } = warp;
  const { surface } = step;
  if (!model || warp.stage === 'building') return next;
  if (surface?.grid !== model.grid) return solveWarpSession(scene, next, 'end');
  const state = { positions: surface.positions.slice(), rotations: surface.rotations.slice() };
  if (!surface.settled) return solveWarpSession(scene, { ...next, state }, 'end');
  // Shown as it was; one that was still settling goes on settling from there.
  return showWarp(scene, { ...next, state, surface, settling: !surface.converged });
}

/**
 * The surface a closing seam belongs to: the nodes Close gap pulls and those the grid joins them
 * to, never stepping onto a node that faces away from where its nearest pulled node goes. It never
 * reaches a piece the grid does not join, or the far side of a thin wall.
 */
function closingSurface(
  model: WarpModel,
  p: ArrayLike<number>,
  gapTargets: { node: number; target: Vec3 }[],
) {
  const { edgeStart, edges, triangles } = model.grid;
  const count = model.grid.nodes.length;
  const normals = new Float64Array(count * 3);
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t] * 3,
      b = triangles[t + 1] * 3,
      c = triangles[t + 2] * 3;
    const ux = p[b] - p[a],
      uy = p[b + 1] - p[a + 1],
      uz = p[b + 2] - p[a + 2],
      vx = p[c] - p[a],
      vy = p[c + 1] - p[a + 1],
      vz = p[c + 2] - p[a + 2];
    const x = uy * vz - uz * vy,
      y = uz * vx - ux * vz,
      z = ux * vy - uy * vx;
    for (const i of [a, b, c]) {
      normals[i] += x;
      normals[i + 1] += y;
      normals[i + 2] += z;
    }
  }
  const distance = new Float64Array(count).fill(Infinity);
  const direction = new Float64Array(count * 3);
  const queue: number[] = [];
  for (const { node, target } of gapTargets) {
    distance[node] = 0;
    const dx = target[0] - p[node * 3],
      dy = target[1] - p[node * 3 + 1],
      dz = target[2] - p[node * 3 + 2];
    const length = Math.hypot(dx, dy, dz) || 1;
    direction.set([dx / length, dy / length, dz / length], node * 3);
    queue.push(node);
  }
  // Breadth-first: each node takes the direction of the first pulled node to reach it.
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    for (let e = edgeStart[i]; e < edgeStart[i + 1]; e++) {
      const j = edges[e];
      if (model.grid.fixed[j]) continue;
      const step = Math.hypot(
        model.restNodes[i * 3] - model.restNodes[j * 3],
        model.restNodes[i * 3 + 1] - model.restNodes[j * 3 + 1],
        model.restNodes[i * 3 + 2] - model.restNodes[j * 3 + 2],
      );
      const d = distance[i] + step;
      if (d >= distance[j]) continue;
      const facing =
        normals[j * 3] * direction[i * 3] +
        normals[j * 3 + 1] * direction[i * 3 + 1] +
        normals[j * 3 + 2] * direction[i * 3 + 2];
      if (
        facing <
        -gapAwayCosine * Math.hypot(normals[j * 3], normals[j * 3 + 1], normals[j * 3 + 2])
      )
        continue;
      distance[j] = d;
      direction.copyWithin(j * 3, i * 3, i * 3 + 3);
      queue.push(j);
    }
  }
  const surface = new Uint8Array(count);
  for (let n = 0; n < count; n++) surface[n] = distance[n] < Infinity ? 1 : 0;
  return surface;
}
// A node whose normal points against its pull by more than this faces away from the neighbour.
const gapAwayCosine = 0.25;
// An automatic point the closing seam would move by more than this share of its largest pull
// holds the seam open.
const gapHoldShare = 0.05;

// Close gap settles a trial this many times at most, each time withholding more of its targets
// around the samples the user holds that it still moves.
const gapYieldRounds = 12;
// A trial settles until an iteration moves no node by more than this, or for this many iterations.
const gapTrialMove = 1e-5;
const gapTrialIterations = 4000;

/**
 * The gap targets without those that would move a sample of a stationary handle the user placed:
 * around each such sample, targets within a ring of grid edges are withheld, and the ring grows
 * until a settled trial keeps it within `warpPinHold` of where it is written now. Returns the
 * targets kept, how many were withheld, and the settled trial to start the solve from.
 */
function yieldingGapTargets(
  warp: WarpSession,
  points: WarpPoint[],
  gapTargets: { node: number; target: Vec3 }[],
) {
  const model = warp.model!,
    state = warp.state!;
  const samples = points.flatMap((point) =>
    point.target === null && !point.auto ? point.samples : [],
  );
  if (!samples.length || !gapTargets.length) return { gapTargets, held: 0, trial: null };
  const { edgeStart, edges, fixed } = model.grid;
  const count = model.grid.nodes.length;
  // Grid edges from each sample's nodes, out as far as any ring could grow.
  const hops = samples.map(({ binding }) => {
    const hop = new Uint16Array(count).fill(0xffff);
    const queue: number[] = [];
    for (const n of binding.node)
      if (!fixed[n] && hop[n]) {
        hop[n] = 0;
        queue.push(n);
      }
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q];
      if (hop[i] >= gapYieldRounds + 1) continue;
      for (let e = edgeStart[i]; e < edgeStart[i + 1]; e++)
        if (hop[edges[e]] === 0xffff) {
          hop[edges[e]] = hop[i] + 1;
          queue.push(edges[e]);
        }
    }
    return hop;
  });
  // Where each is written now and in each trial, detail included.
  const shown = shownDetail(warp);
  const now = samples.map((sample) => writtenSample(model, state, sample, shown));
  // A sample's own nodes and those beside them carry its skin map, so they are never pulled.
  const ring = samples.map(() => 1);
  const trial = { positions: state.positions.slice(), rotations: state.rotations.slice() };
  let kept = gapTargets;
  for (let round = 0; round < gapYieldRounds; round++) {
    kept = gapTargets.filter(({ node }) => hops.every((hop, s) => hop[node] > ring[s]));
    const { guides, constraints, detail } = warpSolveInput({ model, points, gapTargets: kept });
    if (constraints.length)
      for (let i = 0; i < gapTrialIterations; i++)
        if (solveWarp(model.grid, model.restNodes, constraints, trial, 1, guides) < gapTrialMove)
          break;
    const writtenDetail = surfaceDetail(model, trial, points, detail, kept.length > 0);
    let moved = false;
    samples.forEach((sample, s) => {
      const at = writtenSample(model, trial, sample, writtenDetail);
      if (Math.hypot(...at.map((value, a) => value - now[s][a])) > warpPinHold) {
        ring[s]++;
        moved = true;
      }
    });
    if (!moved) break;
  }
  return { gapTargets: kept, held: gapTargets.length - kept.length, trial };
}

const distanceTo = (positions: ArrayLike<number>, node: number, target: Vec3) =>
  Math.hypot(
    positions[node * 3] - target[0],
    positions[node * 3 + 1] - target[1],
    positions[node * 3 + 2] - target[2],
  );

/** Moves each target onto the nearest neighbouring surface in range, at the overlap depth. */
function snapWarpTargets(
  scene: SceneDocument,
  warp: WarpSession,
  moves: { id: string; target: Vec3 }[],
) {
  const bounds = warpBounds(warp.state!.positions);
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
      historyBudgetBytes,
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
  const warpBrush = checkpoint
    ? keptWarpBrush(
        { scene, past, future: [], sharedHistory: state.sharedHistory },
        state.warpBrush,
      )
    : state.warpBrush;
  return {
    scene,
    revision: state.revision + 1,
    ...(state.freeTransform ? { freeTransform: null } : {}),
    ...(checkpoint ? { past, future: [] } : {}),
    ...(warpBrush !== state.warpBrush ? { warpBrush } : {}),
    ...notice,
  };
};

/**
 * Warp brush radii for parts in the scene or in local undo history; the same map when nothing
 * is dropped. A shared scene's history is the server's, so there only the scene counts.
 */
function keptWarpBrush(
  state: Pick<EditorState, 'scene' | 'past' | 'future' | 'sharedHistory'>,
  brush: ReadonlyMap<string, number>,
) {
  if (!brush.size) return brush;
  const scenes = state.sharedHistory
    ? [state.scene]
    : [state.scene, ...state.past, ...state.future];
  const missing = [...brush.keys()].filter(
    (id) => !scenes.some((scene) => scene.parts.some((part) => part.id === id)),
  );
  if (!missing.length) return brush;
  const kept = new Map(brush);
  for (const id of missing) kept.delete(id);
  return kept;
}

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

let sculptRevision = 0;
const nextSculptRevision = () => ++sculptRevision;

type HistoryDirection = 'undo' | 'redo';

function historyScene(state: EditorState, direction: HistoryDirection) {
  return direction === 'undo' ? state.past.at(-1) : state.future[0];
}

function restoreHistoryScene(
  state: EditorState,
  direction: HistoryDirection,
  scene: SceneDocument,
  sculpt: SculptSession | null = null,
): Partial<EditorState> {
  const undo = direction === 'undo';
  return {
    scene,
    past: undo ? state.past.slice(0, -1) : [...state.past, state.scene],
    future: undo ? [state.scene, ...state.future] : state.future.slice(1),
    revision: state.revision + 1,
    selected: state.selected.filter((id) => scene.parts.some((part) => part.id === id)),
    ...restoredIsolated(state, scene),
    operation: blankOperation(),
    // Keep placement tools ready for another adjustment after undo.
    tool:
      sculpt || ['translate', 'rotate', 'scale', 'transform'].includes(state.tool)
        ? state.tool
        : 'select',
    sculpt,
    navigationMode: null,
    pivotPicking: false,
    painting: false,
    paintHistory: [],
    measurement: [],
  };
}

function sculptHistoryStep(state: EditorState, direction: HistoryDirection) {
  const { sculpt } = state;
  if (!sculpt || sculpt.pending) return;
  const undo = direction === 'undo';
  const step = undo ? sculpt.past.at(-1) : sculpt.future[0];
  if (!step || step.before.geometry === step.after.geometry || state.sharedHistory) return step;
  const destination = (undo ? step.before : step.after).geometry;
  const scene = historyScene(state, direction);
  if (scene?.parts.some((part) => part.id === sculpt.partId && part.geometry.uuid === destination))
    return step;
}

function moveHistory(direction: HistoryDirection) {
  const state = useEditor.getState();
  const { sculpt } = state;
  const step = sculptHistoryStep(state, direction);
  if (sculpt?.pending) return;
  if (sculpt && step) {
    const next = stepSculptSession(sculpt, direction, step);
    next.revision = nextSculptRevision();
    if (step.before.geometry === step.after.geometry) useEditor.setState({ sculpt: next });
    else if (sharedHandlers) {
      useEditor.setState({
        sculpt: {
          ...sculpt,
          pending: { id: next.revision, direction, step },
          revision: next.revision,
        },
      });
      sharedHandlers[direction]();
    } else {
      useEditor.setState(
        restoreHistoryScene(state, direction, historyScene(state, direction)!, next),
      );
    }
    return;
  }
  const scene = historyScene(state, direction);
  if (sharedHandlers) {
    if (sculpt) state.setTool('select');
    sharedHandlers[direction]();
  } else if (scene) useEditor.setState(restoreHistoryScene(state, direction, scene));
}

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
  warpBrush: new Map(),
  paintHistory: [],
  operation: blankOperation(),
  warp: null,
  warpFeather: { enabled: false, width: null },
  warpAdd: 'point',
  warpPending: null,
  warpInFlight: null,
  refine: null,
  sculpt: null,
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
    else if (tool === 'refine' && state.tool === 'refine' && state.refine)
      set({ navigationMode: null, pivotPicking: false });
    else if (tool === 'refine') state.startRefine();
    else if (tool === 'sculpt' && !state.sculpt) state.startSculpt();
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
            warpBrush: new Map(keptWarpBrush(state, state.warpBrush)).set(
              state.warp.partId,
              Math.max(0.05, Math.min(100, radius)),
            ),
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
      warp: newWarpSession(part, state.sceneEpoch, state.warpFeather),
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
    if (warp) await layWarp(settledWarp(warp), 'region');
  },
  setWarpDensity: async (density) => {
    const { warp } = get();
    if (!warp || !Number.isFinite(density)) return;
    const level = Math.min(warpDensityNodes.length - 1, Math.max(0, Math.round(density)));
    if (level === warp.density) {
      if (!warp.densityChosen) set({ warp: { ...warp, densityChosen: true } });
      return;
    }
    const from = settledWarp(warp);
    set({ warp: { ...warp, density: level, densityChosen: true } });
    if (warp.stage !== 'region') await layWarp(from, 'density');
  },
  setWarpFeather: (patch) =>
    set((state) => {
      const current = state.warp?.featherEdge ?? state.warpFeather;
      const enabled = patch.enabled ?? current.enabled;
      const width =
        patch.width !== undefined && Number.isFinite(patch.width)
          ? Math.max(0, Math.min(100, patch.width))
          : (current.width ?? (enabled ? warpBrushRadius(state) : null));
      const warpFeather = { enabled, width };
      return {
        warpFeather,
        ...(state.warp ? { warp: { ...state.warp, featherEdge: warpFeather } } : {}),
      };
    }),
  cancelWarp: (notice) => {
    const { warp } = get();
    if (!warp) return;
    abortWarpBuild();
    clearTimeout(seamTimer);
    warpDrag = null;
    forgetWarpSettle();
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
    // Where the surface is written, so holding it there changes nothing.
    const pin = writtenSample(
      model,
      warp.state!,
      { face, barycentric, binding, restWorld },
      shownDetail(warp),
    );
    const sample: WarpSample = { face, barycentric, binding, restWorld, pin };
    const part = state.scene.parts.find((p) => p.id === warp.partId);
    const eligible = warpEligibleNodes(model);
    const spacing = spacingAt(
      model,
      binding.node.filter((node) => eligible[node]),
    );
    // It holds the settled surface where it is, so adding it changes nothing.
    const added = reachHandle(model, {
      id: uid(),
      kind: 'point',
      samples: [sample],
      pin: sample.pin,
      target: null,
      radius: warpPointRadius(warp, part, spacing),
      falloff: warp.pointFalloff,
      auto: false,
      baseline: settledOf(warp),
      reach: null,
    });
    set({
      warp: {
        ...warp,
        points: [...warp.points, added],
        selectedPoints: [added.id],
        undo: withUndo(warp),
      },
    });
  },
  setWarpAdd: (warpAdd) => set({ warpAdd }),
  addWarpStroke: (stroke) => {
    const state = get(),
      warp = state.warp,
      model = warp?.model;
    if (!warp || !model || !warp.state || state.tool !== 'warp' || warp.stage !== 'warp')
      return false;
    const made =
      stroke.kind === 'line'
        ? lineSamples(model, warp.state, stroke.points, shownDetail(warp))
        : areaSamples(model, warp.state, stroke.faces, stroke.first, shownDetail(warp));
    if (!made || (stroke.kind === 'line' && made.samples.length < 2)) {
      state.notify(
        stroke.kind === 'line'
          ? 'Draw a longer line on the painted area.'
          : stroke.faces.some((face) => isPaintedFace(model, face))
            ? 'This spot is fixed. Paint farther inside the warp region.'
            : 'Paint on the painted area.',
        'info',
      );
      return false;
    }
    const eligible = warpEligibleNodes(model);
    const nodes = new Set<number>();
    for (const { binding } of made.samples)
      for (const node of binding.node) if (eligible[node]) nodes.add(node);
    const part = state.scene.parts.find((p) => p.id === warp.partId);
    const faces =
      stroke.kind === 'area'
        ? [...new Set(stroke.faces)].filter((f) => isPaintedFace(model, f))
        : [];
    // It holds the settled surface where it is, so adding it changes nothing.
    const added = reachHandle(model, {
      id: uid(),
      kind: stroke.kind,
      samples: made.samples,
      ...(stroke.kind === 'area'
        ? { faces: faces.sort((a, b) => a - b) }
        : { path: thinPath(stroke.points.filter(({ face }) => isPaintedFace(model, face))) }),
      pin: made.pin,
      target: null,
      radius: warpPointRadius(warp, part, spacingAt(model, nodes)),
      falloff: warp.pointFalloff,
      auto: false,
      baseline: settledOf(warp),
      reach: null,
    });
    set({
      warp: {
        ...warp,
        points: [...warp.points, added],
        selectedPoints: [added.id],
        undo: withUndo(warp),
      },
    });
    return true;
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
    const continuing = warpDrag?.model === model;
    const before = continuing ? warpDrag!.before : warpEdit(warp);
    const surface = before.surface!;
    // An untouched automatic point bound to a node a moved handle's samples are bound to would hold
    // the grab back, so it goes in the same step.
    const { fixed } = model.grid;
    const grabbed = new Set<number>();
    for (const point of warp.points)
      if (targets.has(point.id))
        for (const { binding } of point.samples)
          for (const node of binding.node) if (!fixed[node]) grabbed.add(node);
    const released = (point: WarpPoint) =>
      !targets.has(point.id) &&
      untouchedAuto(point) &&
      point.samples.some(({ binding }) => binding.node.some((node) => grabbed.has(node)));
    if (
      !continuing &&
      !warp.points.some(released) &&
      warp.points.every((point) => {
        const target = targets.get(point.id);
        return !target || (point.target !== null && same(point.target, target));
      })
    )
      return;
    const points = warp.points.flatMap((point) => {
      const target = targets.get(point.id);
      if (!target) return released(point) ? [] : [point];
      // An automatic point the guides have carried is taken where it is now. A point with no
      // guides of its own starts its first move from the surface as it is.
      const from = untouchedAuto(point)
        ? heldWhereItIs(model, surface, point, surface, shownDetail(warp))
        : point.target === null && !handleGuides(point)
          ? { ...point, baseline: surface }
          : point;
      return [{ ...from, target, auto: false }];
    });
    const kept = new Set(points.map((point) => point.id));
    warpDrag = gesture === 'drag' ? { model, before } : null;
    const next = solveWarpSession(
      state.scene,
      {
        ...warp,
        points,
        selectedPoints:
          points.length < warp.points.length
            ? warp.selectedPoints.filter((id) => kept.has(id))
            : warp.selectedPoints,
      },
      gesture,
    );
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
    if (!model || warp.stage !== 'warp') {
      set({ warp: { ...warp, ...settings } });
      return;
    }
    const continuing = warpDrag?.model === model && warpDrag.settings ? warpDrag : null;
    const before = continuing?.before ?? warpEdit(warp);
    const surface = before.surface!;
    const start =
      continuing?.settings ??
      new Map(warp.points.filter((point) => selected.has(point.id)).map((p) => [p.id, p]));
    // Only reach and weights change: the guides keep their baselines, so nothing settles here.
    const points = warp.points.map((point) => {
      const from = start.get(point.id);
      if (!from) return point;
      const radius = settings.pointRadius ?? from.radius,
        falloff = settings.pointFalloff ?? from.falloff;
      if (radius === from.radius && falloff === from.falloff) return from;
      // An automatic point the guides have carried is taken where it is written now.
      const held = untouchedAuto(from)
        ? heldWhereItIs(model, surface, from, surface, snapshotDetail(surface))
        : from;
      const next = reachHandle(model, { ...held, radius, falloff, auto: false });
      // An unmoved point first given a radius holds the surface as it is.
      return from.target === null && !handleGuides(from) && handleGuides(next)
        ? { ...next, baseline: surface }
        : next;
    });
    // Settings that leave every point as it was settle nothing. With none selected they are what
    // new points take, a step of their own.
    if ((!continuing || !start.size) && points.every((point, i) => point === warp.points[i])) {
      const next = { ...warp, ...settings };
      if (!start.size) warpDrag = gesture === 'drag' ? { model, before, settings: start } : null;
      set({
        warp:
          gesture === 'end' && !sameEdit(before, warpEdit(next))
            ? { ...next, undo: withUndo(warp, before) }
            : next,
      });
      return;
    }
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
    const {
      guides,
      constraints,
      detail: guidedDetail,
    } = warpSolveInput({ ...warp, gapTargets: [] });
    if (constraints.length) settleGrid(model, constraints, held, guides);
    const detail = surfaceDetail(model, held, warp.points, guidedDetail, false);
    const nodes = writtenNodePositions(
      model,
      held,
      new Float64Array(held.positions.length),
      detail,
    );
    const { neighbours, indexing } = warpNeighbours(state.scene, warp.partId, warpBounds(nodes));
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
    // Faced by the surface as it is written there, detail and all.
    const gapTargets = closeGapTargets(model, held, neighbours, warp.overlap, detail, nodes);
    // Untouched automatic points on the closing surface that the seam would move are holding it
    // open, so they go in the same step. Points the user placed or moved stay.
    const surface = closingSurface(model, nodes, gapTargets);
    const candidate = (point: WarpPoint) =>
      point.auto &&
      point.target === null &&
      point.samples.some(({ binding }) => binding.node.some((node) => surface[node]));
    const released = new Set<string>();
    if (gapTargets.length && warp.points.some(candidate)) {
      const free = {
        ...warp,
        points: warp.points.filter((point) => !candidate(point)),
        gapTargets,
      };
      const trial = {
        positions: warp.state!.positions.slice(),
        rotations: warp.state!.rotations.slice(),
      };
      const input = warpSolveInput(free);
      settleGrid(model, input.constraints, trial, input.guides);
      let pull = 0;
      for (const { node, target } of gapTargets)
        pull = Math.max(pull, distanceTo(nodes, node, target));
      // Measured from where each is written now, so a point that has ridden with a bump is
      // judged by what closing the seam would do to it. Both surfaces carry their detail.
      const shown = shownDetail(warp);
      for (const point of warp.points)
        if (
          candidate(point) &&
          point.samples.some((sample) => {
            const now = writtenSample(model, warp.state!, sample, shown);
            const then = writtenSample(model, trial, sample, input.detail);
            return Math.hypot(...then.map((value, a) => value - now[a])) > gapHoldShare * pull;
          })
        )
          released.add(point.id);
    }
    const points = warp.points.filter((point) => !released.has(point.id));
    // Samples the user holds still keep their place: the seam stays open around them.
    const yielded = yieldingGapTargets(warp, points, gapTargets);
    if (same(yielded.gapTargets, warp.gapTargets) && points.length === warp.points.length) {
      // Nothing moves, but the panel still says why the seam stays open.
      if (yielded.held !== (warp.gapHeld ?? 0)) set({ warp: { ...warp, gapHeld: yielded.held } });
      return;
    }
    const kept = new Set(points.map((point) => point.id));
    set({
      warp: solveWarpSession(
        state.scene,
        {
          ...warp,
          ...(yielded.trial ? { state: yielded.trial } : {}),
          points,
          selectedPoints: warp.selectedPoints.filter((id) => kept.has(id)),
          gapTargets: yielded.gapTargets,
          gapHeld: yielded.held,
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
    // A grid being built finishes or is cancelled first.
    if (!warp || !step || warp.stage === 'building') return Promise.resolve();
    warpDrag = null;
    if (step.grid) return layWarp(settledWarp(warp), step.grid);
    set({ warp: restoreWarp(state.scene, { ...warp, undo: warp.undo.slice(0, -1) }, step) });
    return Promise.resolve();
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
    // A surface still settling would bake a shape that is still changing: it settles first, in idle
    // steps, and bakes then. Without idle frames to settle in, it settles here.
    if (warp.settling) {
      if (!warp.applying) set({ warp: { ...warp, applying: true } });
      if (typeof window !== 'undefined') {
        scheduleWarpSettle();
        return false;
      }
      finishWarpSettling();
      return get().scene.parts.some((p) => p.id === part.id && p.geometry !== part.geometry);
    }
    warpDrag = null;
    forgetWarpSettle();
    // The session starts again on the result, keeping the region and options.
    const {
      region,
      faces,
      seed,
      density,
      densityChosen,
      featherEdge,
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
    // Exactly the surface shown, which has settled.
    const settled = { ...warp, applying: false };
    const geometry = appliedWarpGeometry(warp.source, settled.output!);
    const warped: Part = { ...part, geometry, source: `Warp · ${part.source}` };
    if (!keep) disposeWarpPreview(settled.preview);
    set({
      ...changed(state, {
        ...state.scene,
        parts: state.scene.parts.map((p) => (p.id === part.id ? warped : p)),
      }),
      warp: {
        ...newWarpSession(warped, state.sceneEpoch, featherEdge, faces),
        region,
        seed,
        density,
        densityChosen,
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
  startSculpt: () => {
    const state = get();
    if (useXR.getState().session) return false;
    const part =
      state.selected.length === 1
        ? state.scene.parts.find((candidate) => candidate.id === state.selected[0])
        : undefined;
    if (!part?.visible || part.locked) {
      state.notify('Select one visible, unlocked part to sculpt.', 'info');
      return false;
    }
    if (
      geometryBytes([part.geometry]) > sculptHistoryBytes ||
      part.geometry.getAttribute('position').count * Float32Array.BYTES_PER_ELEMENT >
        maskHistoryBytes
    ) {
      state.notify(`${part.name} is too large to sculpt with undo history.`, 'info');
      return false;
    }
    const defaultRadius = fittedWarpBrushRadius(part);
    set({
      ...toolChange(state, 'sculpt'),
      sculpt: {
        partId: part.id,
        settings: sculptDefaults('draw', defaultRadius),
        byBrush: {},
        defaultRadius,
        mask: null,
        revision: nextSculptRevision(),
        past: [],
        future: [],
        pending: null,
      },
    });
    return true;
  },
  setSculptBrush: (brush) =>
    set(({ sculpt }) => {
      if (!sculpt || brush === sculpt.settings.brush) return {};
      const { maskVisible } = sculpt.settings;
      const settings = sculpt.byBrush[brush] ?? sculptDefaults(brush, sculpt.defaultRadius);
      return {
        sculpt: {
          ...sculpt,
          settings: { ...settings, maskVisible },
          byBrush: { ...sculpt.byBrush, [sculpt.settings.brush]: sculpt.settings },
        },
      };
    }),
  setSculptSettings: (patch) =>
    set(({ sculpt }) =>
      sculpt ? { sculpt: { ...sculpt, settings: { ...sculpt.settings, ...patch } } } : {},
    ),
  resetSculptBrush: () =>
    set(({ sculpt }) =>
      sculpt
        ? {
            sculpt: {
              ...sculpt,
              settings: sculptDefaults(
                sculpt.settings.brush,
                sculpt.defaultRadius,
                sculpt.settings.maskVisible,
              ),
            },
          }
        : {},
    ),
  cancelSculptStroke: () =>
    set(({ sculpt }) => (sculpt ? { sculpt: { ...sculpt, revision: nextSculptRevision() } } : {})),
  commitSculpt: (stroke) => {
    const state = get();
    const { sculpt } = state;
    const part = state.scene.parts.find((candidate) => candidate.id === stroke.partId);
    if (
      state.tool !== 'sculpt' ||
      !sculpt ||
      sculpt.pending ||
      sculpt.partId !== stroke.partId ||
      (stroke.revision !== undefined && stroke.revision !== sculpt.revision) ||
      !part?.visible ||
      part.locked ||
      state.selected.length !== 1 ||
      state.selected[0] !== part.id ||
      part.geometry !== stroke.source ||
      state.sceneEpoch !== stroke.epoch ||
      !same(part.position, stroke.position) ||
      !same(part.quaternion, stroke.quaternion) ||
      !same(part.scale, stroke.scale)
    )
      return false;
    const geometry = stroke.geometry ?? part.geometry;
    if (stroke.mask && stroke.mask.length !== geometry.getAttribute('position').count) return false;
    const mask = stroke.mask;
    if (geometry === part.geometry && mask === sculpt.mask) return false;
    if (
      geometry !== part.geometry &&
      (geometryBytes([geometry]) > sculptHistoryBytes ||
        geometry.getAttribute('position').count * Float32Array.BYTES_PER_ELEMENT > maskHistoryBytes)
    ) {
      state.notify('This stroke exceeded the mesh size limit for Sculpt.', 'info');
      return false;
    }
    if (geometry !== part.geometry && sharedSculptQueueGuard && !sharedSculptQueueGuard(geometry)) {
      state.notify(
        state.liveStatus === 'disconnected'
          ? 'Reconnect to the shared scene to commit sculpt strokes.'
          : 'Wait for pending sculpt strokes to reach the shared scene.',
        'info',
      );
      return false;
    }
    const step = {
      before: { geometry: part.geometry.uuid, mask: sculpt.mask },
      after: { geometry: geometry.uuid, mask },
    };
    set({
      ...(geometry === part.geometry
        ? state.future.length
          ? { future: [] }
          : {}
        : changed(state, {
            ...state.scene,
            parts: state.scene.parts.map((candidate) =>
              candidate.id === part.id ? { ...part, geometry } : candidate,
            ),
          })),
      sculpt: {
        ...sculpt,
        revision: nextSculptRevision(),
        mask,
        past: appendSculptStep(sculpt.past, step),
        future: [],
      },
    });
    return true;
  },
  changeSculptMask: (operation) => {
    const state = get();
    const { sculpt } = state;
    const part = sculpt && state.scene.parts.find((candidate) => candidate.id === sculpt.partId);
    if (!sculpt || !part || (operation === 'clear' && !sculpt.mask)) return;
    const mask =
      operation === 'invert'
        ? new Float32Array(part.geometry.getAttribute('position').count)
        : null;
    if (mask) {
      const previous = sculpt.mask;
      if (previous) {
        for (let i = 0; i < mask.length; i++) mask[i] = 1 - previous[i];
      } else mask.fill(1);
    }
    state.commitSculpt({
      partId: part.id,
      source: part.geometry,
      epoch: state.sceneEpoch,
      revision: sculpt.revision,
      position: part.position,
      quaternion: part.quaternion,
      scale: part.scale,
      geometry: null,
      mask,
    });
  },
  startRefine: () => {
    const state = get();
    if (useXR.getState().session) return false;
    const part =
      state.selected.length === 1
        ? state.scene.parts.find((p) => p.id === state.selected[0])
        : undefined;
    if (!part || part.locked || !part.visible) {
      state.notify('Select one visible, unlocked part to refine.', 'info');
      return false;
    }
    if (triangleCount(part.geometry) > maxPaintTriangles) {
      state.notify(
        `${part.name} has too many triangles to refine. The limit is 10 million.`,
        'info',
      );
      return false;
    }
    state.cancelRefine();
    const refine = newRefineSession(part, state.sceneEpoch);
    // Registered before the session is published, so a cancel on publishing reaches the build.
    const build = refineBuild();
    set((state) => ({ ...toolChange(state, 'refine'), refine }));
    void buildRefine(refine, part, build);
    return true;
  },
  cancelRefine: (notice) => {
    abortRefineJobs();
    releaseRefineState();
    const { refine } = get();
    if (!refine) return;
    disposeRefinePreview(refine.preview);
    set({ refine: null });
    if (notice) get().notify(notice, 'info');
  },
  applyRefine: () => {
    const state = get(),
      refine = state.refine;
    if (!refine?.model || refine.stage !== 'ready' || !refineEdited(refine)) return false;
    const part = state.scene.parts.find((p) => p.id === refine.partId);
    if (!part || part.geometry !== refine.source || state.sceneEpoch !== refine.epoch) {
      state.notify('The part changed, so the refinement could not be applied.', 'error');
      return false;
    }
    if (part.locked) {
      state.notify(`Unlock ${part.name} to apply the refinement.`, 'info');
      return false;
    }
    abortRefineJobs();
    // A stroke under way was never accepted: it is dropped, not applied.
    releaseRefineState();
    const { mesh, topology } = refine.model;
    const geometry = writeRefinedGeometry(refine.source, partMatrix(part), mesh, topology);
    // Without a cut, triangle t is still the source's, so its tree only needs new bounds.
    if (mesh.corners === refine.start?.mesh.corners) refitWarpTree(refine.source, geometry);
    const refined: Part = { ...part, geometry, source: `Refine · ${part.source}` };
    const { mode, edge, region, brush, detect } = refine;
    const next: RefineSession = {
      ...newRefineSession(refined, state.sceneEpoch),
      mode,
      edge,
      region,
      brush,
      detect: { ...detect, running: false },
    };
    disposeRefinePreview(refine.preview);
    const build = refineBuild();
    set({
      ...changed(state, {
        ...state.scene,
        parts: state.scene.parts.map((p) => (p.id === part.id ? refined : p)),
      }),
      refine: next,
    });
    preparePicking(geometry);
    void buildRefine(next, refined, build);
    return true;
  },
  undoRefine: () => {
    const { refine } = get();
    const step = refine?.undo.at(-1);
    if (!refine?.model || !step) return;
    const kept = trimRefineSteps(step.model, refine.undo.slice(0, -1), [
      ...refine.redo,
      refineStep(refine),
    ]);
    discardRefineStroke();
    refineDrag = null;
    set({ refine: showRefine({ ...get().refine!, ...step, ...kept, ...unsteppedRefine }) });
    scheduleRefineDraft();
  },
  redoRefine: () => {
    const { refine } = get();
    const step = refine?.redo.at(-1);
    if (!refine?.model || !step) return;
    const kept = trimRefineSteps(
      step.model,
      [...refine.undo, refineStep(refine)],
      refine.redo.slice(0, -1),
    );
    discardRefineStroke();
    refineDrag = null;
    set({ refine: showRefine({ ...get().refine!, ...step, ...kept, ...unsteppedRefine }) });
    scheduleRefineDraft();
  },
  setRefineMode: (mode) => {
    const changed = get().refine?.mode !== mode;
    if (changed) {
      discardRefineStroke();
      cancelRefineDraft();
      clearRefineRest();
    }
    // A handle drag still under the pointer is left for the pointer code to cancel.
    const { refine } = get();
    if (refine)
      set({
        painting: false,
        refine: {
          ...refine,
          mode,
          drawing: false,
          chosenPoint: changed ? null : refine.chosenPoint,
        },
      });
    if (changed && refine && framesRefineDraft()) scheduleRefineDraft();
  },
  setRefineEdge: (options, each = {}) => {
    const { refine } = get();
    if (!refine) return;
    refineDrag = null;
    const { kind, joint, ...feature } = options;
    const next = { ...(kind ? { kind } : {}), ...(joint ? { joint } : {}) };
    const touched = Object.keys(feature).length > 0 || Object.keys(each).length > 0;
    const features = touched
      ? updateSelected(refine, (proposal, id) =>
          proposal.type === 'edge'
            ? { type: 'edge', input: { ...proposal.input, ...feature, ...each[id] } }
            : null,
        )
      : refine.features;
    const edited = features !== refine.features;
    const edge = { ...refine.edge, ...next, ...(edited ? {} : feature) };
    set({ refine: { ...refine, edge, features } });
    scheduleRefineDraft();
  },
  restoreRefineDefaults: ({ edge, region }) => {
    const { refine } = get();
    if (!refine) return;
    refineDrag = null;
    set({
      refine: {
        ...refine,
        edge: { ...refine.edge, ...edge },
        region: { ...refine.region, ...region },
      },
    });
  },
  restoreRefineFeatures: (saved) => {
    const { refine } = get();
    if (!refine) return;
    refineDrag = null;
    const byId = new Map(saved.map((s) => [s.id, s]));
    const features = refine.features.map((f) => {
      const prior = f.state === 'pending' ? byId.get(f.id) : undefined;
      if (!prior) return f;
      const { edited: _, ...rest } = f;
      return prior.edited
        ? { ...rest, feature: prior.feature, edited: true }
        : { ...rest, feature: prior.feature };
    });
    set({ refine: { ...refine, features } });
    scheduleRefineDraft();
  },
  setRefineRegion: (options, each = {}) => {
    const { refine } = get();
    if (!refine) return;
    refineDrag = null;
    const features = updateSelected(refine, (proposal, id) =>
      proposal.type === 'region'
        ? { type: 'region', input: { ...proposal.input, ...options, ...each[id] } }
        : null,
    );
    const region = features === refine.features ? { ...refine.region, ...options } : refine.region;
    set({ refine: { ...refine, region, features } });
    scheduleRefineDraft();
  },
  setRefineBrush: (options) => {
    const { refine } = get();
    if (refine) set({ refine: { ...refine, brush: { ...refine.brush, ...options } } });
  },
  setRefineDetect: (options) => {
    const { refine } = get();
    if (refine)
      set({
        refine: {
          ...refine,
          detect: { ...refine.detect, ...options, running: refine.detect.running },
        },
      });
  },
  addRefinePoint: (point, close = false) => {
    const refine = readyRefine();
    if (!refine || refine.mode !== 'edge') return;
    const { edge } = refine;
    const guide = drawnGuide(refine);
    if (!guide) {
      if (close) return;
      const feature: RefineFeature = {
        id: uid(),
        state: 'pending',
        origin: 'hand',
        feature: {
          type: 'edge',
          input: {
            segments: [{ kind: edge.kind, points: [point] }],
            joints: [],
            closed: false,
            width: edge.width,
            strength: edge.strength,
            ends: edge.ends,
          },
        },
      };
      commitRefine({
        features: [...refine.features, feature],
        selected: [feature.id],
        drawing: edge.kind === 'spline',
      });
      return;
    }
    const input = guide.feature.input;
    const segments = [...input.segments];
    const last = segments[segments.length - 1];
    const first = segments[0].points[0];
    const end = last.points[last.points.length - 1];
    const open = takesPoints(last, refine.drawing);
    let next: EdgeInput;
    let drawing = false;
    if (close) {
      if (segments.length === 1 && last.kind === 'arc' && last.points.length === 3)
        next = { ...input, closed: true, joints: [edge.joint] };
      else if (segments.length === 1 && last.kind === 'spline' && open && last.points.length > 2) {
        segments[0] = { ...last, points: [...last.points, first] };
        next = { ...input, segments, closed: true, joints: [edge.joint] };
      } else if (segments.length > 1 && open) {
        segments[segments.length - 1] = { ...last, points: [...last.points, first] };
        next = { ...input, segments, closed: true, joints: [...input.joints, edge.joint] };
      } else if (!open && edge.kind !== 'arc' && (segments.length > 1 || last.points.length > 2)) {
        // A closing segment adds two joints: where it starts, and where it meets the first point.
        segments.push({ kind: edge.kind, points: [end, first] });
        const joints = [...input.joints, edge.joint, edge.joint];
        next = { ...input, segments, closed: true, joints };
      } else return;
    } else if (open) {
      segments[segments.length - 1] = { ...last, points: [...last.points, point] };
      next = { ...input, segments };
      drawing = last.kind === 'spline' && refine.drawing;
    } else {
      segments.push({ kind: edge.kind, points: [end, point] });
      next = { ...input, segments, joints: [...input.joints, edge.joint] };
      drawing = edge.kind === 'spline';
    }
    commitRefine({
      features: withProposal(refine, guide.id, { type: 'edge', input: next }),
      drawing,
    });
  },
  moveRefinePoint: (id, segment, index, point, begin) => {
    const refine = readyRefine();
    const feature = refine?.features.find((f) => f.id === id);
    if (!refine || feature?.state !== 'pending' || feature.feature.type !== 'edge') return;
    const input = feature.feature.input;
    const old = input.segments[segment]?.points[index];
    if (!old) return;
    // A point two segments share, or the closing point, moves in both.
    const segments = input.segments.map((s) => ({
      ...s,
      points: s.points.map((p) => (samePoint(p, old) ? point : p)),
    }));
    const features = withProposal(refine, id, { type: 'edge', input: { ...input, segments } });
    const key = `${refine.id} ${id} ${segment} ${index}`;
    // One step per drag: further moves of the point just moved, with nothing between, extend it.
    if (!begin && refineDrag?.key === key && refineDrag.step === refine.undo.at(-1))
      set({ refine: { ...refine, features } });
    else {
      const { selected, undo, redo, mode, draft, draftSkipped, draftStatus } = refine;
      const before = {
        features: refine.features,
        selected,
        undo,
        redo,
        mode,
        draft,
        draftSkipped,
        draftStatus,
      };
      const built = builtDraft;
      commitRefine({ features });
      refineDrag = {
        id,
        feature,
        key,
        step: get().refine?.undo.at(-1),
        session: refine.id,
        before,
        built,
      };
    }
    restRefineDraft();
  },
  clickRefinePoint: (id, segment, index) => {
    const refine = readyRefine();
    const guide = refine && selectedEdge(refine, id);
    const point = guide?.segments[segment]?.points[index];
    if (!refine || !guide || !point) return;
    if (!guide.closed && segment === 0 && index === 0 && refine.mode === 'edge') {
      get().addRefinePoint(point, true);
      if (get().refine !== refine) return;
    }
    set({ refine: { ...refine, chosenPoint: { feature: id, segment, index } } });
  },
  clearChosenRefinePoint: () => {
    const { refine } = get();
    if (refine?.chosenPoint) set({ refine: { ...refine, chosenPoint: null } });
  },
  removeChosenRefinePoint: () => {
    const refine = readyRefine();
    if (!refine || !refinePointRemovable(refine)) return;
    const { feature, segment, index } = refine.chosenPoint!;
    get().removeRefinePoint(feature, segment, index);
  },
  removeRefinePoint: (id, segment, index) => {
    const refine = readyRefine();
    const feature = refine?.features.find((f) => f.id === id);
    if (!refine || feature?.state !== 'pending' || feature.feature.type !== 'edge') return;
    if (!feature.feature.input.segments[segment]?.points[index]) return;
    const input = withoutPoint(feature.feature.input, segment, index);
    commitRefine(
      input
        ? { features: withProposal(refine, id, { type: 'edge', input }) }
        : {
            features: refine.features.filter((f) => f.id !== id),
            selected: refine.selected.filter((s) => s !== id),
            drawing: false,
          },
    );
  },
  finishRefineGuide: () => {
    refineDrag = null;
    const { refine } = get();
    if (refine?.drawing) set({ refine: { ...refine, drawing: false } });
  },
  paintRefineRegion: (point, triangle, erase = false, begin = false) => {
    const state = get(),
      refine = readyRefine();
    if (
      !refine ||
      !paintingRefine(state) ||
      point.partId !== refine.partId ||
      state.navigationMode ||
      state.temporaryOrbit ||
      state.pivotPicking ||
      (!begin && !state.painting)
    )
      return false;
    const part = state.scene.parts.find((p) => p.id === refine.partId);
    const { mesh, topology } = refine.model!;
    if (!part?.visible || !(triangle >= 0 && triangle < mesh.triangleCount)) return false;
    const center = worldPoint(part, point).toArray() as Vec3;
    const under = refineCode!.paint.trianglesUnderBrush(
      mesh,
      topology,
      triangle,
      center,
      refineBrushRadius(state),
    );
    let triangles: number[];
    if (erase || state.brushErase) {
      const removed = new Set(under);
      triangles = refine.triangles.filter((t) => !removed.has(t));
    } else triangles = [...new Set([...refine.triangles, ...under])].sort((a, b) => a - b);
    const same =
      triangles.length === refine.triangles.length &&
      triangles.every((t, i) => t === refine.triangles[i]);
    if (begin) {
      set({ painting: true });
      commitRefine({ triangles: same ? refine.triangles : triangles });
    } else if (!same) set({ refine: { ...refine, triangles } });
    return true;
  },
  makeRefineRegion: () => {
    const refine = readyRefine();
    if (!refine || refine.mode !== 'region' || !refine.triangles.length) return;
    const feature: RefineFeature = {
      id: uid(),
      state: 'pending',
      origin: 'hand',
      feature: {
        type: 'region',
        input: { ...refine.region, triangles: Uint32Array.from(refine.triangles) },
      },
    };
    commitRefine({
      features: [...refine.features, feature],
      selected: [feature.id],
      triangles: [],
      drawing: false,
    });
  },
  selectRefine: (ids) => {
    const { refine } = get();
    if (!refine) return;
    refineDrag = null;
    clearRefineRest();
    cancelRefineDraft();
    const known = new Set(refine.features.map((f) => f.id));
    set({
      refine: {
        ...refine,
        selected: ids.filter((id) => known.has(id)),
        chosenPoint: null,
        drawing: false,
      },
    });
    scheduleRefineDraft();
  },
  acceptRefine: (ids) => {
    const refine = readyRefine();
    if (!refine || refine.draggingHandle || refine.draftStatus) return;
    const wanted = new Set(ids ?? drafted(refine).map((f) => f.id));
    const targets = refine.features.filter((f) => f.state === 'pending' && wanted.has(f.id));
    if (targets.length) acceptFeatures(refine, refine.features, targets);
  },
  presentRefineDraft: (presented) => {
    const { refine } = get();
    if (refine === presented && refine.draftStatus === 'presenting')
      set({ refine: { ...refine, draftStatus: null } });
  },
  dismissRefine: (ids) => {
    const refine = readyRefine();
    if (!refine) return;
    const wanted = new Set(ids ?? refine.selected);
    const features = refine.features.filter((f) => f.state !== 'pending' || !wanted.has(f.id));
    if (features.length === refine.features.length) return;
    const kept = new Set(features.map((f) => f.id));
    if (failures.session === refine.id)
      failures = {
        ...failures,
        known: new Map([...failures.known].filter(([id]) => kept.has(id))),
        banners: new Map([...failures.banners].filter(([id]) => kept.has(id))),
      };
    commitRefine({
      features,
      selected: refine.selected.filter((id) => kept.has(id)),
      drawing: false,
    });
  },
  beginRefineStroke: (point) => {
    discardRefineStroke();
    let refine = readyRefine();
    if (!refine || refine.mode !== 'brush') return;
    // The stroke owns the preview: a draft rebuild queued before it would overwrite its dabs.
    cancelRefineDraft();
    if (refine.selected.length || refine.draft || refine.draftStatus) {
      refine = showRefine({
        ...refine,
        selected: [],
        draft: null,
        draftStatus: null,
        drawing: false,
      });
      set({ refine });
    }
    const model = refine.model!;
    const { kind, strength } = refine.brush;
    const crease = kind === 'crease';
    refineStroke = {
      session: refine.id,
      model,
      kind,
      radius: refineBrushRadius(get()),
      strength,
      mesh: crease ? model.mesh : cloneRefineMesh(model.mesh, false),
      shownTouched: crease ? model.mesh.touched : model.mesh.touched.slice(),
      changed: new Set(),
      points: [point],
      last: point.position,
      moved: false,
    };
    if (!crease) dabRefine(refineStroke, point);
  },
  moveRefineStroke: (point) => {
    const stroke = liveStroke();
    if (!stroke) return;
    if (stroke.kind === 'crease') {
      stroke.points.push(point);
      return;
    }
    const [x, y, z] = stroke.last;
    const travel = Math.hypot(point.position[0] - x, point.position[1] - y, point.position[2] - z);
    if (travel >= stroke.radius / 4) dabRefine(stroke, point);
  },
  endRefineStroke: () => {
    const stroke = liveStroke();
    refineStroke = null;
    const refine = get().refine;
    if (!stroke || !refine?.model) return;
    if (stroke.kind !== 'crease') {
      if (!stroke.moved) return;
      commitRefine({ model: { ...stroke.model, mesh: stroke.mesh } });
      // Each dab only grew the bounds; they are measured afresh once the stroke ends.
      const { preview } = get().refine!;
      preview?.computeBoundingBox();
      preview?.computeBoundingSphere();
      return;
    }
    const input = refineCode!.brush.creaseInput(stroke.points, stroke.radius, stroke.strength);
    if (!input) {
      get().notify(noEdgeNotice, 'info');
      return;
    }
    // The brush is the guide's width. Where the rounding is wider, the solver's own width would
    // reach past the brush, so that guide waits, previewed, for the user to accept it.
    const { model } = refine;
    const feature = (guide: EdgeInput): RefineFeature => ({
      id: uid(),
      state: 'pending',
      origin: 'hand',
      feature: { type: 'edge', input: guide },
    });
    if (solveProposal(model, model.mesh, { type: 'edge', input })) {
      const drawn = feature(input);
      acceptFeatures(refine, [...refine.features, drawn], [drawn]);
      return;
    }
    const wide = feature({ ...input, width: null });
    if (!solveProposal(model, model.mesh, wide.feature)) {
      acceptFeatures(refine, [...refine.features, wide], [wide]);
      return;
    }
    commitRefine({ features: [...refine.features, wide], selected: [wide.id], drawing: false });
    get().notify(wideCreaseNotice, 'info');
  },
  cancelRefineStroke: () => discardRefineStroke(),
  beginRefineDrag: () => {
    const refine = readyRefine();
    if (refine && !refine.draggingHandle) set({ refine: { ...refine, draggingHandle: true } });
  },
  cancelRefineDrag: () => {
    const drag = refineDrag;
    refineDrag = null;
    clearRefineRest();
    const refine = readyRefine();
    // Only while nothing else has happened since the drag began.
    if (!drag || refine?.id !== drag.session || drag.step !== refine.undo.at(-1)) {
      if (refine?.draggingHandle) set({ refine: { ...refine, draggingHandle: false } });
      return;
    }
    cancelRefineDraft();
    const { before } = drag;
    const features = refine.features.map((f) => (f.id === drag.id ? drag.feature : f));
    const restored =
      features.length === before.features.length &&
      features.every((f, i) => f === before.features[i])
        ? before.features
        : features;
    const current = { ...refine, features: restored };
    const wasDrafted = drafted({ ...refine, ...before });
    const nowDrafted = drafted(current);
    const reuse =
      wasDrafted.length === nowDrafted.length &&
      nowDrafted.every((f, i) => f.feature === wasDrafted[i].feature);
    builtDraft = reuse ? drag.built : null;
    set({
      refine: showRefine({
        ...current,
        undo: before.undo,
        redo: before.redo,
        draft: reuse ? before.draft : null,
        draftSkipped: reuse && before.draftSkipped,
        draftStatus: reuse ? before.draftStatus : null,
        draggingHandle: false,
      }),
    });
    if (!reuse || before.draftStatus === 'building') scheduleRefineDraft();
  },
  endRefineDrag: () => {
    refineDrag = null;
    const { refine } = get();
    if (refine?.draggingHandle) set({ refine: { ...refine, draggingHandle: false } });
    if (!draftRest) return;
    clearRefineRest();
    scheduleRefineDraft();
  },
  detectRefine: async () => {
    const refine = readyRefine();
    if (!refine || refine.detect.running) return;
    const model = refine.model!;
    const { where, sensitivity, minLength } = refine.detect;
    const controller = new AbortController();
    refineJobs.add(controller);
    refineDetect = controller;
    const taskId = startTask({
      title: 'Finding edges and surfaces',
      progress: 0,
      notify: false,
      cancel: () => controller.abort(),
    });
    set({ refine: { ...refine, detect: { ...refine.detect, running: true } } });
    let proposals: RefineProposal[] | null = null;
    let failure: unknown = null;
    try {
      proposals = await refineCode!.job.detectRefineJob(
        model,
        {
          triangles: where === 'painted' ? Uint32Array.from(refine.triangles) : null,
          sensitivity,
          minLength,
        },
        controller.signal,
        (progress) => updateTask(taskId, { progress }),
      );
    } catch (error) {
      failure = error;
    }
    refineJobs.delete(controller);
    if (refineDetect === controller) refineDetect = null;
    // Checked here, just before publishing: a cancel may come after the job has replied.
    const current = get().refine;
    const live = current?.id === refine.id;
    const detect = live ? { ...current.detect, running: false } : null;
    if (failure !== null && !controller.signal.aborted) {
      failTask(taskId, failure instanceof Error ? failure.message : String(failure));
      if (detect) set({ refine: { ...current!, detect } });
      return;
    }
    if (!proposals || !detect || controller.signal.aborted) {
      cancelTask(taskId);
      if (detect) set({ refine: { ...current!, detect } });
      return;
    }
    if (current!.model !== model) {
      cancelTask(taskId);
      set({ refine: { ...current!, detect } });
      get().notify('The surface changed, so detection was stopped.', 'info');
      return;
    }
    completeTask(taskId);
    // A new run replaces the detected proposals still pending and untouched, and leaves out what
    // is accepted. One the user edited is their work, and stays.
    const kept = current!.features.filter(
      (f) => f.origin !== 'detected' || f.state !== 'pending' || f.edited,
    );
    // Nothing new along, or mostly inside, what the run keeps: accepted, edited or hand-made.
    const found: RefineFeature[] = proposals
      .filter((feature) => !repeatsKept(feature, kept, model.mesh))
      .map((feature) => ({ id: uid(), state: 'pending', origin: 'detected', feature }));
    // A selected proposal the run replaces passes its place in the selection to its counterpart:
    // an identical proposal first, then one that covers it and is covered by it.
    const ids = new Set(kept.map((f) => f.id));
    const byId = new Map(current!.features.map((f) => [f.id, f]));
    const taken = new Set<string>();
    const heir = new Map<string, string>();
    const replaced = current!.selected.filter((id) => !ids.has(id) && byId.has(id));
    for (const match of [identical, sameDetection])
      for (const id of replaced) {
        if (heir.has(id)) continue;
        const old = byId.get(id)!.feature;
        const next = found.find((f) => !taken.has(f.id) && match(old, f.feature, model.mesh));
        if (!next) continue;
        taken.add(next.id);
        heir.set(id, next.id);
      }
    const selected = current!.selected.flatMap((id) =>
      ids.has(id) ? [id] : heir.has(id) ? [heir.get(id)!] : [],
    );
    set({ refine: { ...current!, detect, features: [...kept, ...found], selected } });
    if (
      selected.some((id, i) => id !== current!.selected[i]) ||
      selected.length !== current!.selected.length
    )
      scheduleRefineDraft();
  },
  cancelRefineDetect: () => refineDetect?.abort(),
  setRefineBrushRadius: (radius) =>
    set((state) =>
      state.refine && Number.isFinite(radius)
        ? {
            warpBrush: new Map(keptWarpBrush(state, state.warpBrush)).set(
              state.refine.partId,
              Math.max(0.05, Math.min(100, radius)),
            ),
          }
        : {},
    ),
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
      warpBrush: new Map(),
      historyTrimNotified: false,
      revision: state.revision + 1,
      savedRevision: recovered ? state.revision : state.revision + 1,
      tool: 'select',
      sculpt: null,
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
        ...(removed.length
          ? {
              ...withoutRemovedParts(state, removed),
              warpBrush: keptWarpBrush({ ...state, scene }, state.warpBrush),
            }
          : {}),
      };
    }),
  renameScene: (name) =>
    set((state) => {
      const next = name.trim() || 'Untitled assembly';
      return next === state.scene.name ? {} : changed(state, { ...state.scene, name: next });
    }),
  undo: () => moveHistory('undo'),
  redo: () => moveHistory('redo'),
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

let sharedSculptQueueGuard: ((geometry: BufferGeometry) => boolean) | null = null;

export function useSharedSculptQueueGuard(guard: typeof sharedSculptQueueGuard) {
  sharedSculptQueueGuard = guard;
}

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

/** Whether a press on the warped surface draws a line or paints an area rather than adds a point. */
export const strokingWarp = (state: Pick<EditorState, 'tool' | 'warp' | 'warpAdd'>) =>
  state.tool === 'warp' && state.warp?.stage === 'warp' && state.warpAdd !== 'point';

/** Whether Warp's brush paints an area handle: the Area mode of the Warp stage. */
export const paintingWarpArea = (state: Pick<EditorState, 'tool' | 'warp' | 'warpAdd'>) =>
  strokingWarp(state) && state.warpAdd === 'area';

/** Warp's starting brush radius: 3 % of the part's size. */
export const fittedWarpBrushRadius = (part: Pick<Part, 'geometry' | 'scale'>) =>
  Math.max(0.05, Math.min(100, Number((partSize(part) * 0.03).toPrecision(2))));

/** The brush radius everything uses while warping: what was set on this part, or its fitted start. */
export function warpBrushRadius(state: Pick<EditorState, 'scene' | 'warp' | 'warpBrush'>) {
  const { warp, warpBrush } = state;
  const set = warp && warpBrush.get(warp.partId);
  if (typeof set === 'number') return set;
  const part = warp && state.scene.parts.find((part) => part.id === warp.partId);
  return part ? fittedWarpBrushRadius(part) : 0;
}

export const canUndo = (state: EditorState) =>
  !state.sculpt?.pending &&
  (!!sculptHistoryStep(state, 'undo') ||
    (state.sharedHistory ? state.sharedHistory.undo > 0 : state.past.length > 0));
export const canRedo = (state: EditorState) =>
  !state.sculpt?.pending &&
  (!!sculptHistoryStep(state, 'redo') ||
    (!state.sculpt?.past.length &&
      (state.sharedHistory ? state.sharedHistory.redo > 0 : state.future.length > 0)));

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
    state.refine?.preview,
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
function restoreWarpPoints({ model }: WarpBaseline) {
  const drag = warpDrag;
  if (drag?.model !== model) return;
  warpDrag = null;
  const { warp, scene } = useEditor.getState();
  if (warp?.model !== model) return;
  useEditor.setState({ warp: restoreWarp(scene, warp, drag.before) });
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

const samePainted = (a: WarpLaid['painted'], b: WarpLaid['painted']) =>
  a.region === b.region &&
  same(a.faces, b.faces) &&
  same(a.seed ?? null, b.seed ?? null) &&
  same(a.featherEdge, b.featherEdge);

const sameLaid = (a: WarpLaid, b: WarpLaid) =>
  a.density === b.density &&
  a.feather === b.feather &&
  (a.faces === b.faces ||
    (!!a.faces &&
      !!b.faces &&
      a.faces.length === b.faces.length &&
      a.faces.every((face, i) => face === b.faces![i])));

/** A hash of what a grid build makes, to tell that a rebuild made the same model. */
function warpFingerprint(model: WarpModel) {
  let hash = 0x811c9dc5;
  const { grid, binding } = model;
  for (const array of [
    grid.nodes,
    grid.fixed,
    grid.edgeStart,
    grid.edges,
    model.restNodes,
    binding.node,
    binding.weight,
    model.blend,
  ]) {
    if (!array) continue;
    const words =
      array.byteOffset % 4 === 0 && array.byteLength % 4 === 0
        ? new Uint32Array(array.buffer, array.byteOffset, array.byteLength / 4)
        : new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    hash = Math.imul(hash ^ words.length, 0x01000193);
    for (let i = 0; i < words.length; i++) hash = Math.imul(hash ^ words[i], 0x01000193);
  }
  return hash >>> 0;
}

/** A grid that stands for one no model holds any more, in the steps recorded on it. */
const detachedGrid = (): WarpGrid => ({
  nodes: new Uint32Array(0),
  nodeOf: new Uint32Array(0),
  fixed: new Uint8Array(0),
  triangles: new Uint32Array(0),
  edgeStart: new Uint32Array(1),
  edges: new Uint32Array(0),
});

/**
 * Steps with every snapshot on grid `from` moved to grid `to`, sharing what they shared. Points
 * moved off a model lose their reach and their bindings' caches; points moved onto `model` measure
 * their reach on it.
 */
function moveSteps(steps: WarpEdit[], from: WarpGrid, to: WarpGrid, model?: WarpModel) {
  const snapshots = new Map<WarpSnapshot, WarpSnapshot>();
  const snapshot = (value: WarpSnapshot) => {
    if (value.grid !== from) return value;
    let moved = snapshots.get(value);
    if (!moved) {
      snapshots.set(value, (moved = { ...value, grid: to }));
      writeSnapshotDetail(moved, snapshotDetail(value));
    }
    return moved;
  };
  const points = new Map<WarpPoint, WarpPoint>();
  const point = (value: WarpPoint) => {
    if (value.baseline.grid !== from) return value;
    let moved = points.get(value);
    if (!moved) {
      moved = model
        ? reachHandle(model, { ...value, baseline: snapshot(value.baseline), reach: null })
        : {
            ...value,
            baseline: snapshot(value.baseline),
            reach: null,
            // New arrays, so nothing cached for the old grid stays reachable through them.
            samples: value.samples.map((sample) => ({
              ...sample,
              binding: {
                ...sample.binding,
                node: [...sample.binding.node],
                weight: [...sample.binding.weight],
              },
            })),
          };
      points.set(value, moved);
    }
    return moved;
  };
  return steps.map((step) => ({
    ...step,
    points: step.points.map(point),
    surface: step.surface && snapshot(step.surface),
  }));
}

/**
 * Lays the session's grid. A build that stops returns the session to `from`. Laying from the region
 * stage takes the page's feather option; a rebuild keeps the feather the session was laid with. A
 * density change or a new region is one session undo step, and undoing it, given its grid step,
 * rebuilds the grid it left and restores that step on it exactly. A density change that would drop
 * a handle, or a new region that would leave a moved one on its fixed edge rather than outside the
 * paint, is not made.
 */
async function layWarp(from: WarpSettled, kind: 'region' | 'density' | WarpGridStep) {
  const state = useEditor.getState(),
    warp = state.warp;
  const part = warp && state.scene.parts.find((p) => p.id === warp.partId);
  if (!warp || part?.geometry !== warp.source) return;
  abortWarpBuild();
  const restore = typeof kind === 'object' ? kind : null;
  // An empty painted region would leave the grid nothing to simplify, so it means the whole part.
  const faces = restore
    ? restore.laid.faces
    : warp.region === 'painted' && warp.faces.length
      ? warp.faces
      : null;
  const feather = restore
    ? restore.laid.feather
    : !faces
      ? 0
      : kind === 'density'
        ? (warp.feather ?? 0)
        : warp.featherEdge.enabled
          ? (warp.featherEdge.width ?? warpBrushRadius(state))
          : 0;
  const density = restore
    ? restore.laid.density
    : warp.densityChosen
      ? warp.density
      : faces
        ? defaultWarpDensity
        : warpWholeDensity;
  const laid: WarpLaid = restore?.laid ?? {
    faces,
    density,
    feather,
    painted: {
      region: warp.region,
      faces: warp.faces,
      seed: warp.seed,
      // A density change keeps the feather the grid was laid with.
      featherEdge: (kind === 'density' && warp.laid?.painted.featherEdge) || warp.featherEdge,
    },
  };
  // The same region at the same density keeps its grid, so nothing moves. A region painted or set
  // differently since is a step of its own, which undo paints again without a rebuild.
  if (!restore && warp.model && warp.laid && sameLaid(warp.laid, laid)) {
    if (warp.settling) scheduleWarpSettle();
    const repainted = !samePainted(warp.laid.painted, laid.painted);
    useEditor.setState({
      painting: false,
      paintHistory: [],
      warp: {
        ...warp,
        stage: 'warp',
        density,
        feather,
        seam: warpSeam(state.scene, warp),
        ...(repainted
          ? {
              laid: { ...warp.laid, painted: laid.painted },
              undo: withUndo(warp, { ...warpEdit(warp), painted: warp.laid.painted }),
            }
          : {}),
      },
    });
    return;
  }
  const controller = new AbortController();
  const build = (warpBuild = { controller, from });
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
  useEditor.setState({
    painting: false,
    warp: { ...warp, stage: 'building', feather, density },
  });
  let model: WarpModel;
  try {
    model = await buildWarpModelJob(
      warpModelInput(part, faces, density, feather),
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
    if (current?.settling) scheduleWarpSettle();
    return;
  }
  const current = useEditor.getState().warp;
  if (warpBuild !== build || !current) return;
  warpBuild = null;
  const { scene, notify } = useEditor.getState();
  const old = current.model;

  if (restore) {
    forgetWarpSettle();
    const output = createWarpOutput(model);
    disposeWarpPreview(current.preview);
    const same = warpFingerprint(model) === restore.fingerprint;
    const rest = { ...snapshotOf(model.grid, createWarpState(model.restNodes)), settled: false };
    // Rebuilt the same, every step recorded on that grid goes back on it as it was. Otherwise
    // each settles again from rest on the new one.
    const recorded = current.undo.map((step) => step.surface?.grid === restore.token);
    const steps = moveSteps(current.undo, restore.token, model.grid, model).map((step, i) =>
      same || !recorded[i]
        ? step
        : {
            ...step,
            points: step.points.flatMap((point) => {
              const handle = rebindHandle(model, point);
              return handle ? [{ ...handle, baseline: rest }] : [];
            }),
            gapTargets: [],
            gapHeld: 0,
            surface: rest,
          },
    );
    const { grid: _, ...edit } = steps.at(-1)!;
    void _;
    const next: WarpSession = {
      ...current,
      stage: 'warp',
      ...restore.laid.painted,
      density,
      densityChosen: restore.densityChosen,
      feather,
      laid,
      model,
      state: createWarpState(model.restNodes),
      surface: null,
      output,
      preview: warpPreview(current.source, output),
      folds: new Uint32Array(0),
      seam: null,
      settling: false,
      undo: steps.slice(0, -1),
    };
    useEditor.setState({ paintHistory: [], warp: restoreWarp(scene, next, edit) });
    completeTask(taskId, `${model.grid.nodes.length.toLocaleString()} grid nodes`);
    if (!same)
      notify('The earlier grid came out different, so its surface was solved again.', 'info');
    return;
  }

  // A density change keeps every handle, and a new region every moved handle it still paints.
  const dropped = current.points.map((point) => droppedBy(model, point));
  const refused =
    kind === 'density'
      ? dropped.some((reason) => reason)
      : dropped.some((reason, i) => reason === 'fixed' && current.points[i].target !== null);
  if (refused) {
    cancelTask(taskId, 'Grid not changed.');
    useEditor.setState({ warp: { ...current, ...from } });
    if (current.settling) scheduleWarpSettle();
    notify(
      kind === 'density'
        ? 'That grid is too coarse for the points on this region, so the density stays as it was.'
        : 'Points you moved would be held by the edge of the new region, so the grid was not laid. Paint farther around them, or delete them first.',
      'info',
    );
    return;
  }

  // Each settled grid the session keeps is carried to the new grid once, so every version of a
  // handle and every undo step goes on sharing it. Each goes with the detail it was written with,
  // so a handle made on an earlier surface still holds it as it was shown.
  const carried = new Map<WarpSnapshot, WarpSnapshot>();
  const carry = (snapshot: WarpSnapshot) => {
    let next = carried.get(snapshot);
    if (!next) {
      next =
        old && snapshot.grid === old.grid
          ? transferSnapshot(old, snapshot, model)
          : { ...snapshotOf(model.grid, createWarpState(model.restNodes)), settled: false };
      carried.set(snapshot, next);
    }
    return next;
  };
  const rebound = new Map<WarpPoint, WarpPoint | null>();
  const rebind = (points: WarpPoint[]) =>
    points.flatMap((point) => {
      if (!rebound.has(point)) {
        const handle = rebindHandle(model, point);
        rebound.set(point, handle && { ...handle, baseline: carry(point.baseline) });
      }
      return rebound.get(point) ?? [];
    });
  const points = rebind(current.points);
  const kept = new Set(points.map((point) => point.id));
  const start = current.surface ? carry(current.surface) : null;
  // A density change or a new region is a step of its own. The steps before it stay on the grid
  // they were recorded on, which undoing it rebuilds.
  let undo: WarpEdit[];
  if (old && current.laid) {
    const token = detachedGrid();
    const [step, ...earlier] = moveSteps(
      [warpEdit(current), ...current.undo.slice(-(warpUndoLimit - 1))],
      old.grid,
      token,
    );
    undo = [
      ...earlier,
      {
        ...step,
        grid: {
          laid: current.laid,
          densityChosen: from.densityChosen,
          token,
          fingerprint: warpFingerprint(old),
        },
      },
    ];
  } else
    // Steps must bind to the same grid as the session; gap targets name old nodes.
    undo = current.undo.map(({ grid, ...step }) => {
      void grid;
      return {
        ...step,
        points: rebind(step.points),
        gapTargets: [],
        gapHeld: 0,
        surface: step.surface && carry(step.surface),
      };
    });
  // The idle steps would otherwise go on holding the session on the old grid.
  forgetWarpSettle();
  const output = createWarpOutput(model);
  disposeWarpPreview(current.preview);
  let next: WarpSession = {
    ...current,
    stage: 'warp',
    density,
    laid,
    model,
    state: start
      ? { positions: start.positions.slice(), rotations: start.rotations.slice() }
      : createWarpState(model.restNodes),
    surface: null,
    output,
    preview: warpPreview(current.source, output),
    points,
    selectedPoints: current.selectedPoints.filter((id) => kept.has(id)),
    gapTargets: [],
    gapHeld: 0,
    firstLay: false,
    folds: new Uint32Array(0),
    seam: null,
    settling: false,
    undo,
  };
  // A grid nothing holds rests, and its preview keeps the source's bits.
  const resting = !next.points.some(holdsWarp);
  if (resting) {
    const state = createWarpState(model.restNodes);
    next = { ...next, state, surface: snapshotOf(model.grid, state) };
  }
  // Without a fixed border, unmoved points are what stop a drag moving the whole part.
  if (current.firstLay && current.autoPoints && !faces)
    next = { ...next, points: [...points, ...distributedPoints(next, current.distributeCount)] };
  useEditor.setState({
    // Stroke undo stays available until a grid replaces the region it painted.
    paintHistory: [],
    warp: resting ? { ...next, seam: warpSeam(scene, next) } : solveWarpSession(scene, next, 'end'),
  });
  completeTask(taskId, `${model.grid.nodes.length.toLocaleString()} grid nodes`);
  if (current.gapTargets.length)
    notify('Close gap again to close the seam at this density.', 'info');
  if (dropped.includes('unpainted'))
    notify('Some control points were outside the new region and were removed.', 'info');
  if (dropped.includes('fixed'))
    notify(
      'Some unmoved control points were on the edge of the new region and were removed.',
      'info',
    );
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

// An Apply waiting for the surface to settle is dropped by any edit before it: another drag,
// undo, a new grid, or leaving the warp stage.
useEditor.subscribe((state, previous) => {
  const { warp } = state,
    before = previous.warp;
  if (
    warp?.applying &&
    before &&
    (warp.points !== before.points ||
      warp.gapTargets !== before.gapTargets ||
      warp.model !== before.model ||
      warp.stage !== 'warp')
  )
    useEditor.setState({ warp: { ...warp, applying: false } });
});

export const refineUndoLimit = 50;
/** The most pending features a draft previews; with more selected none is built. */
export const refineDraftLimit = 8;
/** The most memory session undo and redo may hold beyond the working surface, in bytes. */
export const refineUndoBytes = 512 * 1024 * 1024;
const noFolds: Uint32Array = new Uint32Array(0);

/** Whether the session holds work that ending it would lose. */
export const refineEdited = (refine: RefineSession) => refine.model !== refine.start;

/**
 * Whether ending the session loses work the user made, so it says so: anything accepted, a pending
 * guide or crease drawn by hand, a detected proposal the user edited, or painted triangles. Untouched
 * detected proposals are not the user's work.
 */
export const refineHoldsWork = (
  refine: Pick<RefineSession, 'model' | 'start' | 'features' | 'triangles'>,
) =>
  refine.model !== refine.start ||
  refine.triangles.length > 0 ||
  refine.features.some((f) => f.state === 'pending' && (f.origin === 'hand' || !!f.edited));

/** The geometry drawn in place of the part while a session on it has one. */
export const shownRefinePreview = (refine: RefineSession | null, partId: string) =>
  refine?.partId === partId ? refine.preview : null;

const newRefineSession = (part: Part, epoch: number): RefineSession => ({
  id: uid(),
  partId: part.id,
  source: part.geometry,
  epoch,
  stage: 'building',
  start: null,
  model: null,
  draft: null,
  draftSkipped: false,
  draftStatus: null,
  draggingHandle: false,
  preview: null,
  mode: 'edge',
  features: [],
  selected: [],
  chosenPoint: null,
  triangles: [],
  edge: { kind: 'line', width: null, joint: 'sharp', strength: 1, ends: [null, null] },
  region: {
    treatment: 'smooth',
    shape: 'auto',
    strength: 1,
    keepDetail: true,
    detail: null,
    blend: null,
    scale: null,
  },
  brush: { kind: 'smooth', strength: 0.5 },
  // detectDefaults, written out so the store does not load detection before a session needs it.
  detect: { where: 'part', sensitivity: 0.5, minLength: 1.5, running: false },
  folds: noFolds,
  skipped: noFolds,
  drawing: false,
  undo: [],
  redo: [],
});

const importRefineCode = () =>
  Promise.all([
    import('./refine-edge'),
    import('./refine-region'),
    import('./refine-brush'),
    import('./refine-paint'),
    import('./refine-cut'),
    import('./refine-model'),
    import('./refine-job'),
    import('./refine-curve'),
  ]).then(([edge, region, brush, paint, cut, model, job, curve]) => ({
    edge,
    region,
    brush,
    paint,
    cut,
    model,
    job,
    curve,
  }));
/** The Refine modules, loaded with the first session so the app does not load them until used. */
let refineCode: Awaited<ReturnType<typeof importRefineCode>> | null = null;
let refineCodeLoad: ReturnType<typeof importRefineCode> | null = null;
const loadRefineCode = () =>
  (refineCodeLoad ??= importRefineCode().then(
    (code) => (refineCode = code),
    (error) => {
      refineCodeLoad = null;
      throw error;
    },
  ));

/** Every running build or detection of the session, aborted when it ends. */
const refineJobs = new Set<AbortController>();

function abortRefineJobs() {
  const jobs = [...refineJobs];
  refineJobs.clear();
  for (const job of jobs) job.abort();
}

/** Frees a preview's buffers. It owns all of them. */
function disposeRefinePreview(preview: BufferGeometry | null) {
  if (preview) releaseGeometries([preview], useEditor.getState());
}

/** The mesh each preview holds, so a refresh writes only what differs from it. */
const previewMeshes = new WeakMap<BufferGeometry, RefineMesh>();

/** A build's abort, registered with the session's jobs so ending the session reaches it. */
function refineBuild() {
  const controller = new AbortController();
  refineJobs.add(controller);
  return controller;
}

const refineCancelled = () => new DOMException('Refine cancelled', 'AbortError');

async function buildRefine(refine: RefineSession, part: Part, controller: AbortController) {
  if (controller.signal.aborted) {
    refineJobs.delete(controller);
    return;
  }
  const taskId = startTask({
    title: 'Preparing to refine',
    detail: `${triangleCount(part.geometry).toLocaleString()} triangles`,
    progress: null,
    notify: false,
    cancel: () => controller.abort(),
  });
  controller.signal.addEventListener(
    'abort',
    () => cancelTask(taskId, 'Refine preparation cancelled.'),
    { once: true },
  );
  const failed = (error: unknown) => {
    failTask(taskId, error instanceof Error ? error.message : String(error));
    useEditor.getState().cancelRefine(`${part.name} could not be prepared for refining.`);
  };
  const matrix = partMatrix(part);
  let model: RefineModel;
  try {
    const { job, model: build } = await loadRefineCode();
    if (controller.signal.aborted) throw refineCancelled();
    model = await job.buildRefineModelJob(
      build.refineModelInput(part.geometry, matrix),
      controller.signal,
    );
    if (controller.signal.aborted) throw refineCancelled();
  } catch (error) {
    // Ending the session has already cleared its jobs; a cancel from the activity centre has not.
    if (!refineJobs.delete(controller) || useEditor.getState().refine?.id !== refine.id) return;
    if (controller.signal.aborted) useEditor.getState().cancelRefine();
    else failed(error);
    return;
  }
  const current = useEditor.getState().refine;
  if (!refineJobs.delete(controller) || current?.id !== refine.id) return;
  let preview: BufferGeometry;
  try {
    preview = writeRefinedGeometry(refine.source, matrix, model.mesh, model.topology);
  } catch (error) {
    failed(error);
    return;
  }
  previewMeshes.set(preview, model.mesh);
  givePickingTree(preview, model.mesh.corners, refine.source, model.mesh.corners, null);
  useEditor.setState({ refine: { ...current, stage: 'ready', start: model, model, preview } });
  completeTask(taskId, `${model.mesh.weldedCount.toLocaleString()} vertices`);
}

/** The corners array whose triangle order each preview's triangles follow. */
const previewLayouts = new WeakMap<BufferGeometry, Uint32Array>();

/**
 * Gives a newly written preview a picking tree: a copy of one built over the same triangle layout,
 * the previous preview's or the source's (whose layout is `sourceCorners`), or else its own index.
 */
function givePickingTree(
  preview: BufferGeometry,
  corners: Uint32Array,
  source: BufferGeometry,
  sourceCorners: Uint32Array | undefined,
  previous: BufferGeometry | null,
) {
  previewLayouts.set(preview, corners);
  if (previous?.boundsTree && previewLayouts.get(previous) === corners)
    refitWarpTree(previous, preview);
  else if (source.boundsTree && corners === sourceCorners) refitWarpTree(source, preview);
  // Brush dabs move the preview while its index builds; the index follows them when it arrives.
  else
    void import('./bvh').then(({ prepareEditedForPicking }) => {
      if (useEditor.getState().refine?.preview === preview) prepareEditedForPicking(preview);
    });
}

// A source whose index arrives after its session's preview was written lends the preview its tree.
useEditor.subscribe(({ refine }) => {
  const preview = refine?.preview;
  if (
    preview &&
    !preview.boundsTree &&
    refine.source.boundsTree &&
    previewLayouts.get(preview) === refine.start?.mesh.corners
  )
    refitWarpTree(refine.source, preview);
});

/** The model's topology when `mesh` has its weld map and corners, for writeRefinedGeometry. */
const sameLayout = (model: RefineModel, mesh: RefineMesh) =>
  mesh.corners === model.mesh.corners &&
  mesh.weldOf === model.mesh.weldOf &&
  mesh.triangleCount === model.mesh.triangleCount &&
  mesh.weldedCount === model.mesh.weldedCount
    ? model.topology
    : undefined;

/**
 * Brings the preview to the draft, or to the model without one. A change of positions only is
 * written into the preview's attributes; any other change writes a new preview in its place.
 */
function showRefine(refine: RefineSession): RefineSession {
  const { preview, model, source } = refine;
  const mesh = refine.draft ?? model?.mesh;
  const part = useEditor.getState().scene.parts.find((p) => p.id === refine.partId);
  const shown = preview && previewMeshes.get(preview);
  if (!preview || !model || !mesh || !part || shown === mesh) return refine;
  const matrix = partMatrix(part);
  if (
    shown &&
    mesh.corners === model.mesh.corners &&
    patchRefinedGeometry(preview, source, matrix, shown, mesh, model.topology)
  ) {
    previewMeshes.set(preview, mesh);
    return refine;
  }
  const next = writeRefinedGeometry(source, matrix, mesh, sameLayout(model, mesh));
  previewMeshes.set(next, mesh);
  givePickingTree(next, mesh.corners, source, refine.start?.mesh.corners, preview);
  disposeRefinePreview(preview);
  return { ...refine, preview: next };
}

/** Indexes a geometry for picking once the index code loads. */
const preparePicking = (geometry: BufferGeometry) =>
  void import('./bvh').then(({ prepareForPicking }) => prepareForPicking(geometry));

/** The buffers behind a model's arrays. */
const modelBuffers = ({ mesh, topology }: RefineModel) =>
  [...Object.values(mesh), ...Object.values(topology)].flatMap((value) =>
    ArrayBuffer.isView(value) ? [value.buffer] : [],
  );

const refineStep = ({
  model,
  features,
  selected,
  triangles,
  drawing,
}: RefineSession): RefineStep => ({
  model: model!,
  features,
  selected,
  triangles,
  drawing,
});

/**
 * Drops the oldest undo steps, then the furthest redo steps, until the arrays the steps hold
 * beyond those of `model` fit in `budget` bytes. An array shared by several is counted once.
 */
export function trimRefineSteps(
  model: RefineModel,
  undo: RefineStep[],
  redo: RefineStep[],
  budget = refineUndoBytes,
) {
  const held = () => {
    const counted = new Set(modelBuffers(model));
    let bytes = 0;
    for (const step of [...undo, ...redo])
      for (const buffer of modelBuffers(step.model))
        if (!counted.has(buffer)) {
          counted.add(buffer);
          bytes += buffer.byteLength;
        }
    return bytes;
  };
  // The newest undo step, or with none the nearest redo step, stays whatever it costs.
  while (held() > budget)
    if (undo.length > 1) undo = undo.slice(1);
    else if (redo.length > (undo.length ? 0 : 1)) redo = redo.slice(1);
    else break;
  return { undo, redo };
}

/**
 * Records the session as it is as one undo step, clears redo, then takes `next` and brings the
 * preview to it. Every change to the working surface goes through here.
 */
export function commitRefine(next: Partial<RefineSession>) {
  const { refine } = useEditor.getState();
  if (!refine?.model || refine.stage !== 'ready') return;
  refineDrag = null;
  if (next.model) shareCrease(next.model.mesh, refine.model.mesh);
  const updated = {
    ...refine,
    ...(next.features || next.selected ? { chosenPoint: null } : {}),
    ...next,
  };
  const kept = trimRefineSteps(
    updated.model!,
    [...refine.undo, refineStep(refine)].slice(-refineUndoLimit),
    [],
  );
  useEditor.setState({ refine: showRefine({ ...updated, ...kept }) });
  scheduleRefineDraft();
}

/** The detection running in the session, which Cancel aborts. */
let refineDetect: AbortController | null = null;

/** The point last dragged and the step its drag recorded, so a drag is one step. */
let refineDrag: {
  id: string;
  feature: RefineFeature;
  key: string;
  step: RefineStep | undefined;
  session: string;
  /** The session as the drag found it, and the draft record then, which a cancel puts back. */
  before: Pick<
    RefineSession,
    'features' | 'selected' | 'undo' | 'redo' | 'mode' | 'draft' | 'draftSkipped' | 'draftStatus'
  >;
  built: typeof builtDraft;
} | null = null;

interface RefineStroke {
  session: string;
  model: RefineModel;
  /** The brush settings when the stroke began, which it keeps to its end. */
  kind: RefineBrush;
  radius: number;
  strength: number;
  /** Smooth and Flatten: the stroke's own copy of the surface, sharing all but positions. */
  mesh: RefineMesh;
  /** The touched flags the preview was last written with. */
  shownTouched: Uint8Array;
  /** Every welded vertex a dab moved. */
  changed: Set<number>;
  points: GuidePoint[];
  /** Where the last dab was made. */
  last: Vec3;
  moved: boolean;
}
let refineStroke: RefineStroke | null = null;

/** The stroke under way, if the session it began on still holds the surface it began from. */
function liveStroke() {
  const refine = readyRefine();
  if (refineStroke && (refine?.id !== refineStroke.session || refine.model !== refineStroke.model))
    refineStroke = null;
  return refineStroke;
}

/**
 * Ends the stroke under way without committing it, and brings the preview back to the model the
 * stroke began from.
 */
function discardRefineStroke() {
  const stroke = refineStroke;
  if (!stroke) return;
  refineStroke = null;
  const state = useEditor.getState(),
    refine = state.refine;
  const preview = refine?.preview;
  if (refine?.id === stroke.session && preview && previewMeshes.get(preview) === stroke.mesh) {
    const model = refine.model!;
    const part = state.scene.parts.find((p) => p.id === refine.partId);
    const shown = { touched: stroke.shownTouched, crease: stroke.mesh.crease };
    if (
      part &&
      model === stroke.model &&
      patchRefinedVertices(
        preview,
        refine.source,
        partMatrix(part),
        shown,
        model.mesh,
        model.topology,
        stroke.changed,
      )
    ) {
      previewMeshes.set(preview, model.mesh);
      preview.computeBoundingBox();
      preview.computeBoundingSphere();
    } else {
      previewMeshes.delete(preview);
      useEditor.setState({ refine: showRefine(refine) });
    }
  }
  scheduleRefineDraft();
}

/** Lets go of everything the store keeps for a session outside it, when the session ends. */
function releaseRefineState() {
  refineStroke = null;
  refineDrag = null;
  refineDetect = null;
  builtDraft = null;
  cancelRefineDraft();
  clearRefineRest();
}

/** What the store keeps for Refine outside the session object; nothing once a session has ended. */
export const heldRefineState = () =>
  [
    builtDraft && 'draft',
    refineStroke && 'stroke',
    refineDrag && 'drag',
    refineDetect && 'detection',
    draftFrame && 'frame',
    draftRest && 'rest',
  ].filter(Boolean);

/** One brush dab on the stroke's surface, written into the preview. */
function dabRefine(stroke: RefineStroke, point: GuidePoint) {
  const state = useEditor.getState(),
    refine = state.refine!;
  const { topology, noise } = stroke.model;
  const dab = {
    triangle: point.triangle,
    center: point.position,
    radius: stroke.radius,
    strength: stroke.strength,
    noise,
  };
  const { smoothDab, flattenDab } = refineCode!.brush;
  const moved = (stroke.kind === 'flatten' ? flattenDab : smoothDab)(stroke.mesh, topology, dab);
  stroke.last = point.position;
  if (!moved.length) return;
  stroke.moved = true;
  for (const v of moved) stroke.changed.add(v);
  const part = state.scene.parts.find((p) => p.id === refine.partId);
  const { preview, source } = refine;
  if (!preview || !part) return;
  const shown = { touched: stroke.shownTouched, crease: stroke.mesh.crease };
  if (
    previewMeshes.get(preview) === stroke.mesh ||
    previewMeshes.get(preview) === stroke.model.mesh
  ) {
    if (
      patchRefinedVertices(preview, source, partMatrix(part), shown, stroke.mesh, topology, moved)
    ) {
      for (const v of moved) stroke.shownTouched[v] = stroke.mesh.touched[v];
      previewMeshes.set(preview, stroke.mesh);
      return;
    }
  }
  // The preview cannot be patched in place: write it afresh from the stroke's surface.
  previewMeshes.delete(preview);
  const shownRefine = showRefine({ ...refine, draft: stroke.mesh });
  stroke.shownTouched.set(stroke.mesh.touched.subarray(0, stroke.shownTouched.length));
  useEditor.setState({ refine: { ...shownRefine, draft: refine.draft } });
}

/**
 * Solves already made against a model's surface: by a region's proposal, and by an edge's segments
 * with the other inputs that change its solve, so a new Strength reuses it.
 */
interface SolveAttempt {
  input: unknown;
  solve: EdgeSolve | RegionSolve | null;
  tooLong: boolean;
}
const refineSolves = new WeakMap<object, SolveAttempt & { mesh: RefineMesh }>();

/**
 * The latest solve of each proposal (same keys) and the model it was made over, on the model's
 * own surface or on a draft built from it: what the preview last showed, for display.
 */
const latestSolves = new WeakMap<object, SolveAttempt & { model: RefineMesh }>();

const sameSolveInput = (a: unknown, b: unknown) => {
  if (a === b) return true;
  const [x, y] = [a as EdgeInput, b as EdgeInput];
  return (
    x.segments === y.segments &&
    x.closed === y.closed &&
    x.width === y.width &&
    x.joints.length === y.joints.length &&
    x.joints.every((joint, i) => joint === y.joints[i]) &&
    (x.ends?.[0] ?? null) === (y.ends?.[0] ?? null) &&
    (x.ends?.[1] ?? null) === (y.ends?.[1] ?? null)
  );
};

/** Solves `proposal` on `mesh` with the model's topology, reusing a solve on the same surface. */
function solveProposal<P extends RefineProposal>(
  model: RefineModel,
  mesh: RefineMesh,
  proposal: P,
): (P extends { type: 'edge' } ? EdgeSolve : RegionSolve) | null {
  type Solve = (P extends { type: 'edge' } ? EdgeSolve : RegionSolve) | null;
  const key = proposal.type === 'edge' ? proposal.input.segments : proposal;
  const cached = refineSolves.get(key);
  if (cached?.mesh === mesh && sameSolveInput(cached.input, proposal.input)) {
    latestSolves.set(key, { ...cached, model: model.mesh });
    return cached.solve as Solve;
  }
  const { edge, region, curve } = refineCode!;
  let solve: EdgeSolve | RegionSolve | null = null;
  let tooLong = false;
  try {
    solve =
      proposal.type === 'edge'
        ? edge.solveEdge(mesh, model.topology, solvedForm(proposal.input), model.noise)
        : region.solveRegion(mesh, model.topology, proposal.input, model.noise);
  } catch (error) {
    if (proposal.type !== 'edge' || !(error instanceof curve.GuideLengthError)) throw error;
    tooLong = true;
  }
  const attempt = { input: proposal.input, solve, tooLong };
  if (mesh === model.mesh) refineSolves.set(key, { ...attempt, mesh });
  latestSolves.set(key, { ...attempt, model: model.mesh });
  return solve as Solve;
}

const edgeFailure = (input: EdgeInput) =>
  latestSolves.get(input.segments)?.tooLong ? longGuideNotice : noEdgeNotice;

/**
 * Folds one solve pass into the failures already reported, one record per feature id: a feature
 * that solved is dropped; one failing for a reason not on its record is news. A feature not in the
 * pass keeps its record whatever the others do.
 */
export function reportFailures(
  known: ReadonlyMap<string, string>,
  pass: readonly { id: string; notice: string | null }[],
) {
  const next = new Map(known);
  const news: string[] = [];
  for (const { id, notice } of pass)
    if (notice === null) next.delete(id);
    else {
      if (known.get(id) !== notice) news.push(notice);
      next.set(id, notice);
    }
  return { known: next, news };
}

/**
 * The failures reported in a session: each feature's reason, and the banner that said it, so Accept
 * can tell whether that banner is still on screen.
 */
let failures: {
  session: string;
  known: ReadonlyMap<string, string>;
  banners: ReadonlyMap<string, string>;
  lengthReported: Set<string>;
} = { session: '', known: new Map(), banners: new Map(), lengthReported: new Set() };

/** Whether the notification banner `id` is on screen: not dismissed, and among those shown. */
const bannerShown = (id: string | undefined) =>
  !!id &&
  useActivity
    .getState()
    .notifications.filter((n) => !n.dismissed)
    .slice(0, 3)
    .some((n) => n.id === id);

/** Raises `notice` and records its banner for the failing features of `pass` it speaks for. */
function raiseFailure(
  notice: string,
  pass: readonly { id: string; notice: string | null }[],
  banners: Map<string, string>,
) {
  useEditor.getState().notify(notice, 'info');
  const banner = useActivity.getState().notifications.find((n) => n.message === notice)?.id;
  if (banner) for (const p of pass) if (p.notice === notice) banners.set(p.id, banner);
}

/**
 * Records a solve pass of the session and raises its notices. The preview says each new failure
 * once. Accept (`press`) says at most one thing: a new failure, or a known one whose banner is no
 * longer on screen.
 */
function solvePass(session: string, pass: { id: string; notice: string | null }[], press = false) {
  const same = failures.session === session;
  const before = same ? failures.known : new Map<string, string>();
  const { known } = reportFailures(before, pass);
  const banners = new Map(same ? failures.banners : []);
  for (const id of banners.keys()) if (!known.has(id)) banners.delete(id);
  const lengthReported = same ? failures.lengthReported : new Set<string>();
  failures = { session, known, banners, lengthReported };
  const due = pass.filter(({ id, notice }) =>
    notice === longGuideNotice
      ? !lengthReported.has(id)
      : notice !== null && (before.get(id) !== notice || (press && !bannerShown(banners.get(id)))),
  );
  const notices = [...new Set(due.map((p) => p.notice!))];
  for (const notice of press ? notices.slice(0, 1) : notices) {
    raiseFailure(notice, pass, banners);
    if (notice === longGuideNotice)
      for (const entry of due) if (entry.notice === notice) lengthReported.add(entry.id);
  }
}

/** A solver can report a touched vertex even when its position bits stayed the same. */
function wrotePositions(before: RefineMesh, after: RefineMesh, changed: Uint32Array) {
  return changed.some((v) => {
    const i = v * 3;
    return (
      !Object.is(before.position[i], after.position[i]) ||
      !Object.is(before.position[i + 1], after.position[i + 1]) ||
      !Object.is(before.position[i + 2], after.position[i + 2])
    );
  });
}

/**
 * Bakes `targets`, pending features of `features`, into the working surface in list order as one
 * step. A feature that does not solve stays as it was and is reported. Changes nothing when none
 * solves.
 */
function acceptFeatures(
  refine: RefineSession,
  features: RefineFeature[],
  targets: RefineFeature[],
) {
  const { cut, edge, region } = refineCode!;
  let model = refine.model!;
  let triangles: Uint32Array = Uint32Array.from(refine.triangles);
  let folds = noFolds,
    skipped = noFolds;
  const byId = new Map(features.map((f) => [f.id, f]));
  const pass: { id: string; notice: string | null }[] = [];
  const unchanged = new Set<string>();
  let accepted = false;
  let brokenPieces = 0;
  for (const target of targets) {
    const feature = byId.get(target.id)!;
    const proposal = feature.feature;
    const noChange = (notice: string) => {
      unchanged.add(feature.id);
      pass.push({ id: feature.id, notice });
    };
    if (proposal.input.strength === 0) {
      noChange(zeroStrengthNotice);
      continue;
    }
    if (proposal.type === 'edge') {
      const solve = solvable(proposal.input) ? solveProposal(model, model.mesh, proposal) : null;
      if (!solve) {
        pass.push({ id: feature.id, notice: edgeFailure(proposal.input) });
        continue;
      }
      const mesh = cloneRefineMesh(model.mesh, true);
      const result = edge.applyEdge(mesh, model.topology, solve, proposal.input.strength, true);
      const children = result.cut?.children;
      const base = model.mesh;
      const topologyChanged =
        mesh.weldedCount !== base.weldedCount ||
        mesh.vertexCount !== base.vertexCount ||
        mesh.triangleCount !== base.triangleCount ||
        (children &&
          [...children.keys()].some((t) => {
            const i = t * 3;
            return (
              mesh.corners[i] !== base.corners[i] ||
              mesh.corners[i + 1] !== base.corners[i + 1] ||
              mesh.corners[i + 2] !== base.corners[i + 2]
            );
          }));
      if (!topologyChanged && !wrotePositions(base, mesh, result.changed)) {
        noChange(noChangeNotice);
        continue;
      }
      const cutDisplay = result.cut
        ? edge.cutEdgeDisplay(mesh.position, result.cut.edges, solve, model.step)
        : undefined;
      if (result.pieces > 1 && !brokenPieces) brokenPieces = result.pieces;
      // A cut leaves its arrays room to grow: the model kept, and each undo step, holds what is used.
      model = result.cut
        ? refineCode!.model.modelFromMesh(trimRefineMesh(mesh), model)
        : { ...model, mesh };
      if (children?.size) {
        const remap = (t: Uint32Array) => cut.remapTriangles(t, children);
        triangles = remap(triangles);
        folds = remap(folds);
        skipped = remap(skipped);
        // Accepted regions follow too, so a later Detect can tell what they already cover.
        for (const [id, f] of byId)
          if (f.feature.type === 'region')
            byId.set(id, {
              ...f,
              feature: {
                type: 'region',
                input: { ...f.feature.input, triangles: remap(f.feature.input.triangles) },
              },
            });
      }
      folds = union(folds, result.folded);
      skipped = union(skipped, result.skipped);
      byId.set(feature.id, {
        ...feature,
        state: 'accepted',
        curve: solve.curve,
        ...(cutDisplay ? { pieces: result.pieces, cutDisplay } : {}),
      });
    } else {
      const solve = solveProposal(model, model.mesh, proposal);
      if (!solve) {
        pass.push({ id: feature.id, notice: smallRegionNotice });
        continue;
      }
      const mesh = cloneRefineMesh(model.mesh, false);
      const changed = region.applyRegion(mesh, solve);
      if (!wrotePositions(model.mesh, mesh, changed)) {
        noChange(noChangeNotice);
        continue;
      }
      folds = union(folds, foldedTriangles(mesh, model.topology, model.mesh.position, changed));
      model = { ...model, mesh };
      byId.set(feature.id, { ...feature, state: 'accepted' });
    }
    pass.push({ id: feature.id, notice: null });
    accepted = true;
  }
  const { notify } = useEditor.getState();
  // One notice per press, with failures ahead of pieces and pieces ahead of skipped or folded triangles.
  solvePass(refine.id, pass, true);
  const failed = pass.some((p) => p.notice !== null);
  if (!accepted) {
    if (features !== refine.features && unchanged.size)
      commitRefine({ features, selected: [...unchanged], drawing: false });
    return;
  }
  commitRefine({
    model,
    features: features.map((f) => byId.get(f.id)!),
    selected: refine.selected.filter((id) => unchanged.has(id)),
    draft: null,
    triangles: [...triangles],
    folds,
    skipped,
    drawing: false,
  });
  if (failed) return;
  if (brokenPieces) notify(piecesWarning(brokenPieces), 'info');
  else if (skipped.length || folds.length) notify(cutNotice, 'info');
}

/** solveEdge takes a closed path of one spline as two splines joined smoothly. */
function solvedForm(input: EdgeInput): EdgeInput {
  const [only] = input.segments;
  if (!input.closed || input.segments.length !== 1 || only.kind !== 'spline') return input;
  const half = Math.ceil((only.points.length - 1) / 2);
  return {
    ...input,
    segments: [
      { kind: 'spline', points: only.points.slice(0, half + 1) },
      { kind: 'spline', points: only.points.slice(half) },
    ],
    joints: ['smooth', input.joints[0]],
  };
}

/** How near an accepted edge's curve a detected edge runs to repeat it, mm. */
const repeatedEdge = 0.15;
/** Spacing of the samples along a detected edge, mm, and the fewest samples taken. */
const repeatStep = 0.2,
  repeatSamples = 5;
/** The share of a detected edge's samples, or of a region's area, that makes it a repeat. */
const repeatedEdgeShare = 0.8,
  repeatedRegionShare = 0.5;

/**
 * Whether a detected proposal repeats a feature the session keeps: an edge that runs along the
 * other's solved curve (or, for a pending one not solved yet, its drawn guide) over most of its
 * length, or a region mostly inside another by area.
 */
function repeatsKept(proposal: RefineProposal, kept: RefineFeature[], mesh: RefineMesh) {
  if (proposal.type === 'region')
    return kept.some(
      (f) =>
        f.feature.type === 'region' &&
        insideShare(proposal.input.triangles, f.feature.input.triangles, mesh) >
          repeatedRegionShare,
    );
  const samples = drawnSamples(proposal.input);
  return kept.some((f) => {
    const drawn = drawnCurve(f);
    if (drawn && mostlyNear(samples, drawn)) return true;
    // An accepted edge is on the surface now, so a guide drawn there lies on its solved curve.
    return f.state === 'accepted' && !!f.curve && mostlyNear(samples, f.curve);
  });
}

/** Whether a new detection is the very proposal it replaces. */
const identical = (old: RefineProposal, next: RefineProposal) =>
  JSON.stringify(old) === JSON.stringify(next);

/**
 * Whether a new detection repeats one it replaces, each covering the other: edges whose guides
 * run along each other, or regions each more than half inside the other by area. A fragment of
 * the old one does not stand in for it.
 */
function sameDetection(old: RefineProposal, next: RefineProposal, mesh: RefineMesh) {
  if (old.type === 'region' || next.type === 'region')
    return (
      old.type === 'region' &&
      next.type === 'region' &&
      insideShare(next.input.triangles, old.input.triangles, mesh) > repeatedRegionShare &&
      insideShare(old.input.triangles, next.input.triangles, mesh) > repeatedRegionShare
    );
  if (!solvable(old.input) || !solvable(next.input)) return false;
  const [a, b] = [drawnSamples(old.input), drawnSamples(next.input)];
  const line = (samples: Vec3[]) => ({ points: Float64Array.from(samples.flat()), closed: false });
  return mostlyNear(b, line(a)) && mostlyNear(a, line(b));
}

/** Whether at least repeatedEdgeShare of `samples` lie within repeatedEdge of `curve`. */
function mostlyNear(samples: Vec3[], curve: Pick<EdgeCurve, 'points' | 'closed'>) {
  let near = 0;
  for (const p of samples) if (distanceToCurve(curve, p) <= repeatedEdge) near++;
  return near >= samples.length * repeatedEdgeShare;
}

/** The share of the area of `triangles` that lies in `other`. */
function insideShare(triangles: Uint32Array, other: Uint32Array, mesh: RefineMesh) {
  const covered = new Set(other);
  let total = 0,
    inside = 0;
  for (const t of triangles) {
    const area = triangleArea(mesh, t);
    total += area;
    if (covered.has(t)) inside += area;
  }
  return total > 0 ? inside / total : 0;
}

/** The line an edge feature's guide points draw; null for a region or an unfinished guide. */
function drawnCurve({ feature }: RefineFeature): Pick<EdgeCurve, 'points' | 'closed'> | null {
  if (feature.type !== 'edge' || !solvable(feature.input)) return null;
  return { points: Float64Array.from(drawnSamples(feature.input).flat()), closed: false };
}

/** Points along the curves a guide's segments draw, every repeatStep and at least repeatSamples. */
function drawnSamples(input: EdgeInput): Vec3[] {
  const polylines = input.segments.map(
    ({ kind, points }) =>
      refineCode!.curve.fitCurve(
        kind,
        points.flatMap((p) => p.position),
        points.length,
        repeatStep / 4,
      ).points,
  );
  const spans: [Vec3, Vec3, number][] = [];
  let length = 0;
  for (const line of polylines)
    for (let i = 3; i < line.length; i += 3) {
      const a: Vec3 = [line[i - 3], line[i - 2], line[i - 1]],
        b: Vec3 = [line[i], line[i + 1], line[i + 2]];
      const span = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      spans.push([a, b, span]);
      length += span;
    }
  if (!spans.length) return input.segments.flatMap((s) => s.points.map((p) => p.position));
  const count = Math.max(repeatSamples, Math.ceil(length / repeatStep) + 1);
  const samples: Vec3[] = [];
  let k = 0,
    start = 0;
  for (let i = 0; i < count; i++) {
    const s = (i * length) / (count - 1);
    while (k < spans.length - 1 && start + spans[k][2] < s) start += spans[k++][2];
    const [a, b, span] = spans[k];
    const t = span > 0 ? Math.min(1, Math.max(0, (s - start) / span)) : 0;
    samples.push([0, 1, 2].map((j) => a[j] + t * (b[j] - a[j])) as Vec3);
  }
  return samples;
}

/** Area of triangle `t` of `mesh`. */
function triangleArea(mesh: RefineMesh, t: number) {
  const { position, weldOf, corners } = mesh;
  const [a, b, c] = [0, 1, 2].map((k) => weldOf[corners[t * 3 + k]] * 3);
  const u = [0, 1, 2].map((k) => position[b + k] - position[a + k]),
    w = [0, 1, 2].map((k) => position[c + k] - position[a + k]);
  return (
    Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) / 2
  );
}

/** Distance from `p` to the polyline of `curve`, its closing span included when closed. */
function distanceToCurve({ points, closed }: Pick<EdgeCurve, 'points' | 'closed'>, p: Vec3) {
  const count = points.length / 3;
  let nearest = Infinity;
  for (let i = 0; i < (closed ? count : count - 1); i++) {
    const a = i * 3,
      b = ((i + 1) % count) * 3;
    const d = [0, 1, 2].map((k) => points[b + k] - points[a + k]);
    const q = [0, 1, 2].map((k) => p[k] - points[a + k]);
    const length = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    const t =
      length > 0 ? Math.max(0, Math.min(1, (q[0] * d[0] + q[1] * d[1] + q[2] * d[2]) / length)) : 0;
    nearest = Math.min(nearest, Math.hypot(q[0] - t * d[0], q[1] - t * d[1], q[2] - t * d[2]));
  }
  return count === 1 ? Math.hypot(p[0] - points[0], p[1] - points[1], p[2] - points[2]) : nearest;
}

/** The sorted union of two sorted triangle sets. */
const union = (a: Uint32Array, b: Uint32Array) =>
  b.length ? Uint32Array.from(new Set([...a, ...b])).sort() : a;

/** The selected pending features, in list order: what the draft previews. */
const drafted = (refine: RefineSession) => {
  const selected = new Set(refine.selected);
  const kind = refine.mode === 'brush' ? 'edge' : refine.mode;
  const all = !framesRefineDraft() || kind === 'detect';
  return refine.features.filter(
    (f) => f.state === 'pending' && selected.has(f.id) && (all || f.feature.type === kind),
  );
};

/** What the draft was last built from. */
let builtDraft: { session: string; model: RefineModel; proposals: RefineProposal[] } | null = null;
/** Per draft, the welded vertices it moved off its model's surface. */
const draftMoves = new WeakMap<RefineMesh, { base: RefineMesh; moved: Uint32Array }>();
let draftFrame = 0;
const framesRefineDraft = () =>
  typeof window !== 'undefined' && typeof requestAnimationFrame === 'function';

/**
 * Rebuilds the draft once per frame in a browser, at once without one. A brush stroke owns the
 * preview, so none is built or queued while one is under way.
 */
function scheduleRefineDraft() {
  if (refineStroke) return;
  clearRefineRest();
  if (!framesRefineDraft()) rebuildRefineDraft();
  else if (!draftFrame) {
    const refine = readyRefine();
    if (!refine) return;
    if (refine.draftStatus !== 'building')
      useEditor.setState({ refine: { ...refine, draftStatus: 'building' } });
    const frame = requestAnimationFrame(() => {
      if (draftFrame !== frame) return;
      draftFrame = 0;
      rebuildRefineDraft('presenting');
    });
    draftFrame = frame;
  }
}

/** Drops a draft rebuild queued for the next frame. */
function cancelRefineDraft() {
  if (draftFrame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(draftFrame);
  draftFrame = 0;
}

/** How long a dragged handle rests, in ms, before its draft is rebuilt. */
export const refineDragRest = 120;
let draftRest: ReturnType<typeof setTimeout> | null = null;

/**
 * During a handle drag in a browser, rebuilds the draft once the pointer has rested for
 * `refineDragRest` or the drag ends, not every frame: one rebuild can take longer than a frame.
 */
function restRefineDraft() {
  if (!framesRefineDraft()) return scheduleRefineDraft();
  const refine = readyRefine();
  if (refine && (refine.draftStatus !== 'building' || !refine.draggingHandle))
    useEditor.setState({ refine: { ...refine, draftStatus: 'building', draggingHandle: true } });
  cancelRefineDraft();
  clearRefineRest();
  draftRest = setTimeout(() => {
    draftRest = null;
    scheduleRefineDraft();
  }, refineDragRest);
}

function clearRefineRest() {
  if (draftRest) clearTimeout(draftRest);
  draftRest = null;
}

function rebuildRefineDraft(draftStatus: RefineSession['draftStatus'] = null) {
  const refine = readyRefine();
  if (!refine || refineStroke) return;
  const model = refine.model!;
  const selected = drafted(refine);
  // Solving and applying a large selection on the main thread would stall the editor.
  const skipped = selected.length > refineDraftLimit;
  const features = skipped ? [] : selected;
  const proposals = features.map((f) => f.feature);
  if (
    builtDraft?.session === refine.id &&
    builtDraft.model === model &&
    refine.draftSkipped === skipped &&
    (refine.draft !== null) === proposals.length > 0 &&
    builtDraft.proposals.length === proposals.length &&
    builtDraft.proposals.every((p, i) => p === proposals[i])
  ) {
    if (refine.draftStatus !== draftStatus)
      useEditor.setState({ refine: { ...refine, draftStatus } });
    return;
  }
  builtDraft = { session: refine.id, model, proposals };
  if (!proposals.length) {
    useEditor.setState({
      refine: showDraft({ ...refine, draftSkipped: skipped, draftStatus }, null, noFolds),
    });
    return;
  }
  const { edge, region } = refineCode!;
  const mesh = {
    ...model.mesh,
    position: model.mesh.position.slice(),
    touched: model.mesh.touched.slice(),
  };
  const moved: Uint32Array[] = [];
  const curves = new Map<string, EdgeCurve | undefined>();
  const pass: { id: string; notice: string | null }[] = [];
  for (const { id, feature: proposal } of features) {
    // Until something moves, the draft's surface is the model's, whose solves are kept.
    const on = moved.some((m) => m.length) ? mesh : model.mesh;
    if (proposal.type === 'edge') {
      if (!solvable(proposal.input)) {
        curves.set(id, undefined);
        continue;
      }
      const solve = solveProposal(model, on, proposal);
      curves.set(id, solve?.curve);
      if (solve)
        moved.push(
          edge.applyEdge(mesh, model.topology, solve, proposal.input.strength, false).changed,
        );
      pass.push({ id, notice: solve ? null : edgeFailure(proposal.input) });
    } else {
      const solve = solveProposal(model, on, proposal);
      if (solve) moved.push(region.applyRegion(mesh, solve));
      pass.push({ id, notice: solve ? null : smallRegionNotice });
    }
  }
  const curved = refine.features.map((f) => {
    if (!curves.has(f.id) || f.curve === curves.get(f.id)) return f;
    const { curve: _, ...rest } = f;
    const curve = curves.get(f.id);
    return curve ? { ...rest, curve } : rest;
  });
  const changed = Uint32Array.from(new Set(moved.flatMap((m) => [...m])));
  draftMoves.set(mesh, { base: model.mesh, moved: changed });
  useEditor.setState({
    refine: showDraft(
      { ...refine, features: curved, draftSkipped: false, draftStatus },
      mesh,
      changed,
    ),
  });
  solvePass(refine.id, pass);
}

/**
 * Brings the preview to `draft`, or to the model without one, writing only the vertices the shown
 * draft and the new one moved off the model; showRefine when the preview shows anything else.
 */
function showDraft(refine: RefineSession, draft: RefineMesh | null, changed: Uint32Array) {
  const { preview, source } = refine;
  const model = refine.model!;
  const next = { ...refine, draft };
  const shown = preview && previewMeshes.get(preview);
  const part = useEditor.getState().scene.parts.find((p) => p.id === refine.partId);
  const before = shown === model.mesh ? null : shown && draftMoves.get(shown);
  if (!preview || !shown || !part || (shown !== model.mesh && before?.base !== model.mesh))
    return showRefine(next);
  const mesh = draft ?? model.mesh;
  const candidates = before ? [...before.moved, ...changed] : changed;
  if (
    !patchRefinedVertices(
      preview,
      source,
      partMatrix(part),
      shown,
      mesh,
      model.topology,
      candidates,
    )
  )
    return showRefine(next);
  previewMeshes.set(preview, mesh);
  return next;
}

/**
 * Gives `mesh` the crease array of `before` when they hold the same flags, so a position-only
 * edit shares it as it shares corners, weld map and topology. Neither is written once committed.
 */
function shareCrease(mesh: RefineMesh, before: RefineMesh) {
  const count = mesh.weldedCount;
  if (mesh.crease === before.crease || before.weldedCount !== count) return;
  for (let v = 0; v < count; v++) if (mesh.crease[v] !== before.crease[v]) return;
  mesh.crease = before.crease;
}

/** What undo and redo reset: none of it is recorded in a step. */
const unsteppedRefine = { draft: null, folds: noFolds, skipped: noFolds, chosenPoint: null };

const noEdgeNotice =
  'No edge found under this guide. Move it onto the rounded edge or change Width.';
const longGuideNotice = 'This guide is too long for this mesh. Try a shorter guide.';
const smallRegionNotice = 'This area is too small to fit a surface. Paint more of it.';
const zeroStrengthNotice = 'This changes nothing at 0 % strength.';
const noChangeNotice =
  'This feature did not change the surface. Adjust its settings and try again.';
const wideCreaseNotice = 'The edge is wider than the brush. Check the preview, then accept it.';
export const piecesWarning = (pieces: number) =>
  `The edge was cut in ${pieces} pieces. Undo to adjust the guide, or keep it.`;
const cutNotice = 'Some triangles along this edge could not be cut cleanly. Check the marked area.';

/** The session, when it is ready for work. */
function readyRefine() {
  const { refine } = useEditor.getState();
  return refine?.stage === 'ready' && refine.model && refineCode ? refine : null;
}

/** The brush radius on the session's part: what was set on it, or Warp's fitted start. */
export function refineBrushRadius(state: Pick<EditorState, 'scene' | 'refine' | 'warpBrush'>) {
  const { refine, warpBrush } = state;
  const set = refine && warpBrush.get(refine.partId);
  if (typeof set === 'number') return set;
  const part = refine && state.scene.parts.find((part) => part.id === refine.partId);
  return part ? fittedWarpBrushRadius(part) : 0;
}

/** Whether a press on the part paints triangles: Region, or Detect in a painted area. */
export const paintingRefine = (state: Pick<EditorState, 'tool' | 'refine'>) =>
  state.tool === 'refine' &&
  (state.refine?.mode === 'region' ||
    (state.refine?.mode === 'detect' && state.refine.detect.where === 'painted'));

/** Whether a press on the part makes a brush stroke. */
export const brushingRefine = (state: Pick<EditorState, 'tool' | 'refine'>) =>
  state.tool === 'refine' && state.refine?.mode === 'brush';

/** The guide still being drawn: the one selected open pending edge while a segment takes points. */
export function drawingRefineGuide(refine: RefineSession) {
  const guide = drawnGuide(refine);
  return guide && (refine.drawing || !solvable(guide.feature.input)) ? guide.id : null;
}

/**
 * The latest solve of a pending feature's current input over the working surface, as the preview
 * last made it (on a draft when features before it moved the surface), or null; for display.
 */
export function refineSolved(refine: RefineSession, feature: RefineFeature) {
  const proposal = feature.feature;
  const key = proposal.type === 'edge' ? proposal.input.segments : proposal;
  const latest = latestSolves.get(key);
  if (latest && latest.model === refine.model?.mesh && sameSolveInput(latest.input, proposal.input))
    return latest.solve;
  const cached = refineSolves.get(key);
  return cached &&
    cached.mesh === refine.model?.mesh &&
    sameSolveInput(cached.input, proposal.input)
    ? cached.solve
    : null;
}

const pointsNeeded = { line: 2, arc: 3, spline: 2 } as const;

/** Whether a segment takes another point: a line until 2, an arc until 3, a spline until finished. */
const takesPoints = (segment: EdgeSegment, drawing: boolean) =>
  segment.points.length < pointsNeeded[segment.kind] || (segment.kind === 'spline' && drawing);

/** Whether every segment of a guide has the points its kind needs. */
const solvable = (input: EdgeInput) =>
  input.segments.every((s) => s.points.length >= pointsNeeded[s.kind]);

const samePoint = (a: GuidePoint, b: GuidePoint) =>
  a.triangle === b.triangle && a.position.every((x, k) => x === b.position[k]);

/** The guide new points extend: the one selected feature when it is an open pending edge. */
function drawnGuide(refine: RefineSession) {
  if (refine.selected.length !== 1) return null;
  const feature = refine.features.find((f) => f.id === refine.selected[0]);
  return feature?.state === 'pending' &&
    feature.feature.type === 'edge' &&
    !feature.feature.input.closed
    ? (feature as RefineFeature & { feature: { type: 'edge' } })
    : null;
}

/** Whether a setting change left a proposal's input as it was, value for value. */
const sameInput = (a: RefineProposal, b: RefineProposal) => {
  const [x, y] = [
    a.input as unknown as Record<string, unknown>,
    b.input as unknown as Record<string, unknown>,
  ];
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  return [...keys].every((key) => x[key] === y[key]);
};

const withProposal = (refine: RefineSession, id: string, feature: RefineProposal) =>
  refine.features.map((f) => (f.id === id ? { ...f, feature, edited: true } : f));

/**
 * The features with each selected pending one's proposal replaced by `change`'s, unless null; the
 * same array when `change` replaced none.
 */
function updateSelected(
  refine: RefineSession,
  change: (proposal: RefineProposal, id: string) => RefineProposal | null,
) {
  const selected = new Set(refine.selected);
  let changed = false;
  const features = refine.features.map((f) => {
    const feature = f.state === 'pending' && selected.has(f.id) ? change(f.feature, f.id) : null;
    if (!feature) return f;
    changed = true;
    return sameInput(feature, f.feature) ? { ...f, feature } : { ...f, feature, edited: true };
  });
  return changed ? features : refine.features;
}

type PointSelectionState = Pick<RefineSession, 'selected' | 'features' | 'chosenPoint'>;

function selectedEdge(refine: PointSelectionState, id: string) {
  if (!refine.selected.includes(id)) return null;
  const feature = refine.features.find((f) => f.id === id);
  return feature?.state === 'pending' && feature.feature.type === 'edge'
    ? feature.feature.input
    : null;
}

export function chosenRefinePoint(refine: PointSelectionState) {
  const point = refine.chosenPoint;
  if (!point) return null;
  return selectedEdge(refine, point.feature)?.segments[point.segment]?.points[point.index]
    ? point
    : null;
}

export function refinePointRemovable(refine: PointSelectionState) {
  const point = chosenRefinePoint(refine);
  if (!point) return false;
  const guide = selectedEdge(refine, point.feature)!;
  const next = withoutPoint(guide, point.segment, point.index);
  return next !== null && solvable(next);
}

/**
 * The guide without point `index` of `segment`, or null when no point is left. A point two
 * segments share leaves the earlier one, which the later then starts from; the closing point opens
 * the path. A segment left with fewer than 2 points is dropped with its joint. A closed path left
 * in a form solveEdge cannot close is opened where it closed.
 */
function withoutPoint(input: EdgeInput, segment: number, index: number): EdgeInput | null {
  const segments = input.segments.map((s) => ({ kind: s.kind, points: [...s.points] }));
  const joints = [...input.joints];
  let closed = input.closed;
  if (index === 0 && segment > 0) {
    segment -= 1;
    index = segments[segment].points.length - 1;
  }
  const n = segments.length;
  const loops = () =>
    samePoint(segments[0].points[0], segments[segments.length - 1].points.at(-1)!);
  const closing =
    closed &&
    ((segment === 0 && index === 0) ||
      (segment === n - 1 && index === segments[n - 1].points.length - 1));
  if (closing && n > 1) {
    // Started one segment on, the closing point is shared like any other and is removed as one.
    segments.push(segments.shift()!);
    joints.push(joints.shift()!);
    segment = n - 2;
    index = segments[segment].points.length - 1;
  }
  const points = segments[segment].points;
  const lastPoint = index === points.length - 1;
  if (closing && n === 1) {
    if (loops()) {
      // A spline back on its first point starts again from its second.
      points.shift();
      points.pop();
      if (points.length) points.push(points[0]);
    } else points.splice(index, 1);
  } else if (lastPoint && segment < segments.length - 1) {
    points.pop();
    if (points.length) segments[segment + 1].points[0] = points[points.length - 1];
    else segments[segment + 1].points.shift();
  } else points.splice(index, 1);
  // Joint k joins segments k and k + 1; a dropped segment takes the joint at its emptied end.
  const dropShort = () => {
    for (let k; (k = segments.findIndex((s) => s.points.length < 2)) >= 0 && segments.length > 1;) {
      joints.splice(k < segments.length - 1 ? k : k - 1, 1);
      segments.splice(k, 1);
    }
  };
  dropShort();
  if (closed && !closesAs(segments)) {
    closed = false;
    joints.pop();
    if (loops()) segments[segments.length - 1].points.pop();
    dropShort();
  }
  return segments[0].points.length ? { ...input, segments, joints, closed } : null;
}

/**
 * Whether closed segments are a form solveEdge closes: each segment complete, and one arc of 3
 * points, one spline back on its first point, or several segments back on the first point,
 * through at least 3 points.
 */
function closesAs(segments: EdgeSegment[]) {
  const [first] = segments;
  const end = segments[segments.length - 1].points.at(-1)!;
  if (!segments.every((s) => s.points.length >= pointsNeeded[s.kind])) return false;
  const distinct: GuidePoint[] = [];
  for (const { points } of segments)
    for (const p of points) if (!distinct.some((q) => samePoint(p, q))) distinct.push(p);
  if (distinct.length < 3) return false;
  if (segments.length > 1) return samePoint(first.points[0], end);
  return first.kind === 'arc'
    ? first.points.length === 3
    : first.kind === 'spline' && samePoint(first.points[0], end);
}

// A refused shared edit restores the mask that belonged to the server's geometry.
export function restoreSculptAfterRefusal(scene: SceneDocument, sculpt: SculptSession | null) {
  if (!sculpt || useEditor.getState().sculpt?.partId !== sculpt.partId) return;
  const geometry = scene.parts.find((part) => part.id === sculpt.partId)?.geometry.uuid;
  const start = sculpt.past.findIndex(
    (step) => step.before.geometry === geometry && step.after.geometry !== geometry,
  );
  if (start < 0) return;
  useEditor.setState({
    sculpt: {
      ...sculpt,
      mask: sculpt.past[start].before.mask,
      past: sculpt.past.slice(0, start),
      future: [],
      pending: null,
      revision: nextSculptRevision(),
    },
  });
}

export function stopSharedSculptHistory(applied = false, pendingId?: number | null) {
  const { sculpt } = useEditor.getState();
  if (!sculpt?.pending || (pendingId !== undefined && pendingId !== sculpt.pending.id)) return;
  useEditor.setState({
    sculpt: {
      ...sculpt,
      ...(!applied ? { past: [], future: [] } : {}),
      pending: null,
      revision: nextSculptRevision(),
    },
  });
}

useEditor.subscribe((state, previous) => {
  const { sculpt } = state;
  if (!sculpt) return;
  if (
    state.tool !== 'sculpt' ||
    state.sceneEpoch !== previous.sceneEpoch ||
    state.selected.length !== 1 ||
    state.selected[0] !== sculpt.partId
  ) {
    useEditor.setState({ sculpt: null, ...(state.tool === 'sculpt' ? { tool: 'select' } : {}) });
    return;
  }
  if (state.scene === previous.scene) return;
  const part = state.scene.parts.find((candidate) => candidate.id === sculpt.partId);
  if (!part?.visible || part.locked) {
    useEditor.setState({ sculpt: null, tool: 'select' });
    return;
  }
  const before = previous.scene.parts.find((candidate) => candidate.id === sculpt.partId);
  if (!before) return;
  const moved =
    !same(part.position, before.position) ||
    !same(part.quaternion, before.quaternion) ||
    !same(part.scale, before.scale);
  if (sculpt.pending) {
    const { direction, step } = sculpt.pending;
    if (part.geometry.uuid === (direction === 'undo' ? step.before : step.after).geometry) {
      useEditor.setState({
        sculpt: { ...stepSculptSession(sculpt, direction, step), revision: nextSculptRevision() },
      });
      return;
    }
  }
  const replaced = part.geometry.uuid !== before.geometry.uuid;
  if (replaced && sculpt.revision === previous.sculpt?.revision) {
    useEditor.setState({
      sculpt: {
        ...sculpt,
        mask: null,
        past: [],
        future: [],
        pending: null,
        revision: nextSculptRevision(),
      },
    });
  } else if (moved) state.cancelSculptStroke();
});

// A refinement is built from one geometry of one scene at one pose. Undo, another editor,
// opening a file or leaving the tool by any route ends the session.
useEditor.subscribe((state, previous) => {
  const { refine } = state;
  if (
    !refine ||
    (refine === previous.refine &&
      state.scene === previous.scene &&
      state.sceneEpoch === previous.sceneEpoch &&
      state.tool === previous.tool)
  )
    return;
  const part = state.scene.parts.find((p) => p.id === refine.partId);
  const before = previous.scene.parts.find((p) => p.id === refine.partId);
  const moved =
    part &&
    before &&
    (!same(part.position, before.position) ||
      !same(part.quaternion, before.quaternion) ||
      !same(part.scale, before.scale));
  const work = refineHoldsWork(refine);
  if (!part || part.geometry !== refine.source || state.sceneEpoch !== refine.epoch || moved)
    state.cancelRefine(work ? 'The part changed, so the refinement was cancelled.' : undefined);
  else if (state.tool !== 'refine')
    state.cancelRefine(work ? 'Refinement discarded. Use Apply to keep it.' : undefined);
});

export function measureDistance() {
  const state = useEditor.getState();
  if (state.measurement.length !== 2) return null;
  const [a, b] = state.measurement,
    partA = resolvePart(state.scene, a.partId),
    partB = resolvePart(state.scene, b.partId);
  return partA && partB ? worldPoint(partA, a).distanceTo(worldPoint(partB, b)) : null;
}
