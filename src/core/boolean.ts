import type { BufferGeometry } from 'three';
import { ADDITION, Evaluator, INTERSECTION, SUBTRACTION } from 'three-bvh-csg';
import { MeshBVH } from 'three-mesh-bvh';
import { binaryGeometry, deserializeGeometry } from './geometry';
import { PreparedBrush } from './boolean-topology';
import type { BinaryGeometry } from './types';

export type BooleanOperation = 'union' | 'subtract' | 'intersect';
const operations = { union: ADDITION, subtract: SUBTRACTION, intersect: INTERSECTION } as const;
const emptyResults = {
  union: 'The union produced an empty mesh. Check that the meshes are closed.',
  subtract: 'The subtraction removed the whole mesh.',
  intersect: 'The intersection is empty. These meshes do not overlap.',
};

export interface BooleanInput {
  /** Includes geometry revision, transform and material tint. */
  key?: string;
  create: () => BufferGeometry;
}

function brushBytes(brush: PreparedBrush) {
  const geometry = brush.geometry;
  const data = binaryGeometry(geometry);
  let bytes = Object.values(data).reduce((sum, a) => sum + (a?.byteLength ?? 0), 0);
  if (geometry.boundsTree) {
    const tree = MeshBVH.serialize(geometry.boundsTree as MeshBVH, { cloneBuffers: false });
    bytes += tree.roots.reduce((sum, root) => sum + root.byteLength, 0);
    bytes += tree.indirectBuffer?.byteLength ?? 0;
  }
  // Half-edge references and material-group ids, plus a small object allowance.
  return bytes + (geometry.index?.count ?? geometry.attributes.position.count) * 6 + 4096;
}

/** Owns prepared immutable inputs. Only inactive entries are evicted after an operation. */
export class BooleanProcessor {
  private cache = new Map<string, { brush: PreparedBrush; bytes: number }>();
  constructor(private readonly maxBytes = 96 * 1024 * 1024) {}

  get retainedBytes() {
    return [...this.cache.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  }
  dispose() {
    for (const { brush } of this.cache.values()) brush.geometry.dispose();
    this.cache.clear();
  }

  evaluate(
    inputs: BooleanInput[],
    operation: BooleanOperation,
    onProgress?: (completed: number, total: number) => void,
  ): BufferGeometry {
    if (inputs.length < 2) throw new Error('Select at least two parts for a Boolean operation.');
    const temporary = new Set<BufferGeometry>();
    const brushes: PreparedBrush[] = [];
    let result: PreparedBrush | undefined;
    try {
      for (const input of inputs) {
        let entry = input.key ? this.cache.get(input.key) : undefined;
        if (!entry) {
          const geometry = input.create();
          temporary.add(geometry);
          geometry.clearGroups();
          const brush = new PreparedBrush(geometry);
          brush.updateMatrixWorld(true);
          brush.prepareGeometry();
          entry = { brush, bytes: brushBytes(brush) };
          if (input.key && entry.bytes <= this.maxBytes) {
            this.cache.set(input.key, entry);
            temporary.delete(geometry);
          }
        } else {
          this.cache.delete(input.key!);
          this.cache.set(input.key!, entry);
        }
        brushes.push(entry.brush);
      }
      const evaluator = new Evaluator();
      evaluator.attributes = ['position', 'normal', 'color'];
      evaluator.useGroups = false;
      result = brushes[0];
      for (let i = 1; i < brushes.length; i++) {
        onProgress?.(i - 1, brushes.length - 1);
        const target = new PreparedBrush();
        temporary.add(target.geometry);
        const next = evaluator.evaluate(
          result,
          brushes[i],
          operations[operation],
          target,
        ) as PreparedBrush;
        if (!brushes.includes(result)) {
          result.geometry.dispose();
          temporary.delete(result.geometry);
        }
        result = next;
      }
      onProgress?.(brushes.length - 1, brushes.length - 1);
      if (!result.geometry.getAttribute('position')?.count)
        throw new Error(emptyResults[operation]);
      // The result owns new buffers; transferring it cannot detach any cached input.
      temporary.delete(result.geometry);
      return result.geometry;
    } finally {
      temporary.forEach((geometry) => geometry.dispose());
      let bytes = this.retainedBytes;
      for (const [key, entry] of this.cache) {
        if (bytes <= this.maxBytes) break;
        bytes -= entry.bytes;
        entry.brush.geometry.dispose();
        this.cache.delete(key);
      }
    }
  }
}

/** Applies the operation left to right: the first mesh is the base for a subtraction. */
export function evaluateBoolean(
  meshes: BinaryGeometry[],
  operation: BooleanOperation = 'union',
  onProgress?: (completed: number, total: number) => void,
) {
  const processor = new BooleanProcessor(0);
  let geometry: BufferGeometry | undefined;
  try {
    geometry = processor.evaluate(
      meshes.map((data) => ({ create: () => deserializeGeometry(data) })),
      operation,
      onProgress,
    );
    return binaryGeometry(geometry);
  } finally {
    geometry?.dispose();
    processor.dispose();
  }
}
