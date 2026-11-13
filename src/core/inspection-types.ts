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
  /** False skips the near-surface overlay meshes, for callers that only need the pairs. */
  surfaces?: boolean;
}

/** Progress is for the named stage, not an estimate of the total remaining time. */
export interface InspectionProgress {
  stage: 'preparing' | 'indexing' | 'validating' | 'pairs' | 'overlap' | 'surfaces' | 'finishing';
  detail: string;
  fraction: number | null;
}

export type InspectionResponse =
  { progress: InspectionProgress } | { result: InspectionResult } | { error: string };

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
