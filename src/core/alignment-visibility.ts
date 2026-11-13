import { hiddenByIsolation } from './isolation';
import { referencePlanes } from './references';
import type { AssemblyOperation, Tool } from './types';

export type PartDisplay = 'solid' | 'ghost' | 'hidden';

/** Flush seams may each have a different target; follow the seam being edited. */
export function alignmentPartIds(op: AssemblyOperation) {
  const active = op.surfacePairs.find((pair) => pair.id === op.activeSurface?.pairId);
  const source = op.sourceId;
  const target =
    op.mode === 'surface' && op.surfaceMethod === 'flush'
      ? (active?.target?.partId ?? op.targetId)
      : op.targetId;
  if (
    !source ||
    !target ||
    source === target ||
    referencePlanes.some((plane) => plane.id === source || plane.id === target)
  )
    return null;
  return [source, target] as const;
}

export const hasAlignmentView = (tool: Tool, op: AssemblyOperation) =>
  tool === 'align' && !!op.view && op.view !== 'scene' && !!alignmentPartIds(op);

/** Null means use the ordinary scene/isolation view. */
export function alignmentPartDisplay(
  tool: Tool,
  op: AssemblyOperation,
  id: string,
): PartDisplay | null {
  if (!hasAlignmentView(tool, op)) return null;
  const [source, target] = alignmentPartIds(op)!;
  if (id !== source && id !== target) return 'hidden';
  if (op.view === 'pair') return 'solid';
  const active =
    op.mode === 'surface'
      ? op.activeSurface?.side
      : op.pending
        ? 'target'
        : op.mode === 'multi' || !op.pairs.length
          ? 'source'
          : null;
  // When no pick/patch is pending, show both parts to review the completed pair.
  if (!active || id === (active === 'source' ? source : target)) return 'solid';
  return op.view === 'ghost' ? 'ghost' : 'hidden';
}

/** Alignment temporarily overrides isolation without changing it. */
export function partDisplay(
  state: {
    tool: Tool;
    operation: AssemblyOperation;
    isolated: string[] | null;
    nearbyParts: string[] | null;
  },
  id: string,
): PartDisplay {
  return (
    alignmentPartDisplay(state.tool, state.operation, id) ??
    (hiddenByIsolation(state.isolated, state.nearbyParts, id) ? 'hidden' : 'solid')
  );
}
