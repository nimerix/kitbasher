import type { Vec3 } from './types';

export interface InspectionSettings {
  enabled: boolean;
  scope: 'all' | 'selected';
  distance: number;
  overlap: boolean;
  proximity: boolean;
  closestPoints: boolean;
  context: boolean;
}

export interface InspectionMesh {
  id: string;
  name: string;
  positions: Float32Array;
  indices?: Uint32Array;
  matrix: number[];
}

export interface InspectionRequest {
  meshes: InspectionMesh[];
  distance: number;
}

export interface InspectionPair {
  a: string;
  b: string;
  nameA: string;
  nameB: string;
  volume: number | null;
  distance: number;
  points: [Vec3, Vec3];
}

export interface InspectionResult {
  overlaps: { a: string; b: string; positions: Float32Array }[];
  surfaces: { id: string; positions: Float32Array }[];
  pairs: InspectionPair[];
  checkedPairs: number;
  solidPairs: number;
  resolution: number;
  warnings: string[];
}
