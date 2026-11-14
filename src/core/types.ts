import type { BufferGeometry } from 'three';
import type { InspectionSettings } from './inspection-types';

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
export type AxisLocks = [boolean, boolean, boolean];
export type Tool =
  | 'select'
  | 'translate'
  | 'rotate'
  | 'scale'
  | 'transform'
  | 'align'
  | 'joint'
  | 'measure'
  | 'pins'
  | 'anchors';
export type AlignmentMode = 'point' | 'point-plane' | 'plane' | 'multi' | 'surface';
export type AlignmentView = 'scene' | 'pair' | 'active' | 'ghost';

export interface FitAnchor {
  id: string;
  /** Attachment in mesh-local coordinates; never changes during fitting. */
  point: Vec3;
  /** Desired position in world millimeters. */
  target: Vec3;
}

export interface Pin {
  id: string;
  /** Fixed attachment in mesh-local coordinates. */
  point: Vec3;
  /** World-space resting position, in millimeters. Never follows a transform. */
  target: Vec3;
  kind: 'hard' | 'soft';
  /** Soft resistance, 0 (off) to 100 (strongest). */
  priority: number;
}

export interface Part {
  id: string;
  name: string;
  geometry: BufferGeometry;
  position: Vec3;
  quaternion: Quat;
  scale: Vec3;
  color: string;
  visible: boolean;
  locked: boolean;
  source: string;
  /** User-picked pivot in mesh-local coordinates. */
  pivot?: Vec3;
  anchors?: FitAnchor[];
  pins?: Pin[];
  /** Viewport-only color. Saved with the scene; exports and merges use `color`. */
  displayColor?: string;
}

/** What the viewport paints parts with: export colors, editor colors, or one color per part. */
export type PartColorMode = 'material' | 'editor' | 'distinct';

export type LightKind = 'directional' | 'point';

export interface SceneLight {
  id: string;
  name: string;
  kind: LightKind;
  color: string;
  intensity: number;
  /**
   * Directional: where it shines from, as an offset from the scene's center; only the
   * direction counts. Point: a world position in mm. With `camera`, in the camera's frame.
   */
  position: Vec3;
  /** Point lights fade out by this distance in mm. 0 reaches everything. */
  range: number;
  /** Directional lights only. */
  castShadow: boolean;
  enabled: boolean;
  /** Moves with the camera, like a headlight. */
  camera: boolean;
}

/** Editor lighting, saved with the scene and never exported. */
export interface SceneLighting {
  /** Overall brightness. */
  exposure: number;
  ambient: number;
  hemisphere: number;
  sky: string;
  ground: string;
  shadows: boolean;
  lights: SceneLight[];
}

export interface Joint {
  id: string;
  name: string;
  parentId: string;
  childId: string;
  parentAnchor: Vec3;
  childAnchor: Vec3;
  restRotation: Quat;
  rotationLocks: AxisLocks;
  keepConnected: boolean;
}

export type PlaneConstraintKind = 'mate' | 'parallel' | 'perpendicular' | 'angle';
export type SurfaceMethod = 'contact' | 'flush' | PlaneConstraintKind;
export interface PlaneFrame {
  point: Vec3;
  normal: Vec3;
}
export interface PlaneConstraint {
  id: string;
  name: string;
  sourceId: string;
  targetId: string;
  sourcePlane: PlaneFrame;
  targetPlane: PlaneFrame;
  kind: PlaneConstraintKind;
  angle: number;
  offset: number;
  opposed: boolean;
  enabled: boolean;
}

export interface ClipSettings {
  enabled: boolean;
  /** How far parts may sink into each other, in mm. */
  overlap: number;
}

export interface IsolationSettings {
  /** Also draw other parts where they come near the isolated ones. */
  nearby: boolean;
  /** How near, in mm. */
  distance: number;
}

/** Browser recovery only: never embedded in a portable .kitbash file. */
export interface DriveFileBinding {
  id: string;
  version: string | null;
  /** Drive content checksum; metadata-only version changes are not conflicts. */
  md5Checksum?: string;
  /** Identifies an upload whose response may have been lost. */
  pendingWriteId?: string;
}

export interface SceneDocument {
  name: string;
  parts: Part[];
  joints: Joint[];
  constraints?: PlaneConstraint[];
  /** Absent until the user changes it; the viewport then uses their default lighting. */
  lighting?: SceneLighting;
}

export interface SurfacePoint {
  partId: string;
  point: Vec3;
  normal: Vec3;
}

export interface PickPair {
  source: SurfacePoint;
  target: SurfacePoint;
}

export type SurfaceSide = 'source' | 'target';

export interface SurfacePatch {
  partId: string;
  faces: number[];
  /** Fixed first hit; painting must not walk its reference plane around a curve. */
  seed?: SurfacePoint & { face: number };
}

export interface BrushPlaneSettings {
  enabled: boolean;
  angle: number;
  distance: number;
}

export interface SurfacePair {
  id: string;
  source: SurfacePatch | null;
  target: SurfacePatch | null;
}

export interface AssemblyOperation {
  mode: AlignmentMode;
  /** Temporary viewport presentation; never changes the scene's part visibility. */
  view?: AlignmentView;
  sourceId: string | null;
  targetId: string | null;
  pairs: PickPair[];
  surfacePairs: SurfacePair[];
  activeSurface: { pairId: string; side: SurfaceSide } | null;
  pending: SurfacePoint | null;
  flipNormal: boolean;
  offset: number;
  rotationLocks: AxisLocks;
  keepConnected: boolean;
  surfaceMethod?: SurfaceMethod;
  planeAngle?: number;
  retainConstraint?: boolean;
}

/** Number lists, used by the JSON scene files of earlier versions and 3MF export. */
export interface SerializedGeometry {
  positions: number[];
  indices?: number[];
  colors?: number[];
  normals?: number[];
}

/** Typed-array form used by workers and binary scene files. */
export interface BinaryGeometry {
  positions: Float32Array;
  indices?: Uint16Array | Uint32Array;
  colors?: Float32Array;
  normals?: Float32Array;
}

export interface GeometrySection {
  offset: number;
  length: number;
}

export interface GeometryLayout {
  vertices: number;
  positions: GeometrySection;
  normals?: GeometrySection;
  colors?: GeometrySection;
  indices?: GeometrySection & { type: 'u16' | 'u32' };
}

/** One compressed run of values in a scene file: how many values, then how many bytes. */
export type PackedBlock = [count: number, bytes: number];

/** Values that repeat are stored once: for each vertex, each triangle, or the whole mesh. */
export interface PackedAttribute {
  per: 'vertex' | 'face' | 'mesh';
  blocks: PackedBlock[];
}

/** A mesh in a scene file. Its blocks follow each other in the order of these fields. */
export interface PackedLayout {
  /** Bytes from the start of the body. */
  offset: number;
  length: number;
  vertices: number;
  /** The distinct positions. With `map`, each vertex names the one it uses. */
  positions: { blocks: PackedBlock[]; map?: PackedBlock[] };
  /** Absent when the triangles alone give the same normals. */
  normals?: PackedAttribute;
  colors?: PackedAttribute;
  indices?: { type: 'u16' | 'u32'; blocks: PackedBlock[] };
}

interface SceneHeader<Version, Layout> {
  format: 'kitbasher';
  version: Version;
  units: 'mm';
  name: string;
  parts: (Omit<Part, 'geometry'> & { geometry: number })[];
  joints: Joint[];
  constraints: PlaneConstraint[];
  lighting?: SceneLighting;
  geometries: Layout[];
  bodyLength: number;
}

export type BinarySceneHeader = SceneHeader<3, PackedLayout>;
/** Version 2 files hold every mesh value uncompressed. They still open. */
export type RawSceneHeader = SceneHeader<2, GeometryLayout>;

/** The JSON scene document written by earlier versions. */
export interface SceneFile {
  format: 'kitbasher';
  version: 1;
  units: 'mm';
  name: string;
  parts: (Omit<Part, 'geometry'> & { geometry: SerializedGeometry })[];
  joints: Joint[];
  constraints?: PlaneConstraint[];
  lighting?: SceneLighting;
}

export interface ViewSettings {
  inspection: InspectionSettings;
  /** Keep moves and fits from pushing parts through each other. */
  clip: ClipSettings;
  isolation: IsolationSettings;
  orbitSelection: boolean;
  partColors: PartColorMode;
  grid: boolean;
  joints: boolean;
  wireframe: boolean;
  snap: boolean;
  snapStep: number;
  /** Rotation step in degrees, shared by handles and precise adjustments. */
  rotationSnapStep: number;
  projection: 'perspective' | 'orthographic';
  explode: number;
  space: 'world' | 'local';
  planes: string[];
}
