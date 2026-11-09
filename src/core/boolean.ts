import { ADDITION, Brush, Evaluator, INTERSECTION, SUBTRACTION } from 'three-bvh-csg';
import { binaryGeometry, deserializeGeometry } from './geometry';
import type { BinaryGeometry } from './types';

export type BooleanOperation = 'union' | 'subtract' | 'intersect';

const operations = { union: ADDITION, subtract: SUBTRACTION, intersect: INTERSECTION } as const;
const emptyResults = {
  union: 'The union produced an empty mesh. Check that the meshes are closed.',
  subtract: 'The subtraction removed the whole mesh.',
  intersect: 'The intersection is empty. These meshes do not overlap.',
};

/** Applies the operation left to right: the first mesh is the base for a subtraction. */
export function evaluateBoolean(meshes: BinaryGeometry[], operation: BooleanOperation = 'union') {
  const brushes: Brush[] = [];
  try {
    const evaluator = new Evaluator();
    evaluator.attributes = ['position', 'normal', 'color'];
    evaluator.useGroups = false;
    for (const data of meshes) {
      const geometry = deserializeGeometry(data);
      geometry.clearGroups();
      const brush = new Brush(geometry);
      brush.updateMatrixWorld(true);
      brushes.push(brush);
    }
    let result = brushes[0];
    for (let i = 1; i < brushes.length; i++) {
      const next = evaluator.evaluate(result, brushes[i], operations[operation]);
      if (!brushes.includes(result)) result.geometry.dispose();
      result = next;
    }
    if (!result.geometry.getAttribute('position')?.count) throw new Error(emptyResults[operation]);
    return binaryGeometry(result.geometry);
  } finally {
    brushes.forEach((brush) => brush.geometry.dispose());
  }
}
