import type { MergeWorkerRequest } from '../src/core/merge';
import type { BooleanOperation } from '../src/core/boolean';
import type { MeshProcessOptions } from '../src/core/mesh-processing';
import type { BinaryGeometry, Part } from '../src/core/types';
import type { GeometrySnapshot } from '../src/core/geometry-transfer';
import type { InspectionRequest, InspectionResult } from '../src/core/inspection-types';

export type ComputeRequest =
  | { kind: 'process'; mesh: BinaryGeometry; options: MeshProcessOptions }
  | {
      kind: 'merge';
      parts: MergeWorkerRequest['parts'];
      mode: 'combine' | BooleanOperation;
      name?: string;
    }
  | { kind: 'inspect'; request: InspectionRequest };
export interface ComputeResults {
  process: { geometry: GeometrySnapshot; error: number | null; backend: 'wasm' | 'native' };
  merge: { geometry: GeometrySnapshot; part: Omit<Part, 'geometry'> };
  inspect: InspectionResult;
}
