import type { EdgeEnd } from '../core/refine-edge';
import type { RefineModel } from '../core/refine-model';
import type { RegionSolve } from '../core/refine-region';
import type { RefineFeature, RefineSession } from '../core/store';

const triangles = (n: number) => (n === 1 ? '1 triangle' : `${n} triangles`);

export const featureCounts = (features: readonly Pick<RefineFeature, 'state'>[]) => {
  const accepted = features.filter((f) => f.state === 'accepted').length;
  return `${accepted} accepted · ${features.length - accepted} proposed`;
};

export const foldWarning = (n: number) =>
  `${triangles(n)} ${n === 1 ? 'folds' : 'fold'} over. Undo the last step or reduce Width.`;

export const skippedWarning = (n: number) => `${triangles(n)} could not be cut cleanly.`;

/** Said where features are selected when too many are for the preview to show them. */
export const draftSkippedHint = (limit: number) =>
  `Preview is off while more than ${limit} are selected.`;

/** What a region's Auto shape fitted, or null when nothing was fitted. */
export const fittedLabel = (fitted: RegionSolve['fitted']) => (fitted ? `Fits a ${fitted}` : null);

export const endLabels = { auto: 'Auto', taper: 'Fade', hold: 'Hold' } as const;

/** The Auto choice of an end, naming what the solve chose once there is one. */
export const endOption = (chosen: EdgeEnd | undefined) =>
  chosen ? `Auto (${endLabels[chosen]})` : endLabels.auto;

/**
 * The rule the solver applies to a null setting, from the model's noise and median edge length:
 * where a setting taken off Auto starts when no solve says what it used.
 */
export function autoRule(
  setting: 'width' | 'scale' | 'detail' | 'blend',
  model: Pick<RefineModel, 'noise' | 'step'>,
) {
  switch (setting) {
    case 'width':
      return Math.min(1, 6 * model.step);
    case 'scale':
      return Math.max(0.9, 15 * model.step);
    case 'detail':
      return 4 * model.noise;
    case 'blend':
      return 4 * model.step;
  }
}

/** A setting's first manual value: `start` held to the control's range, and whether that moved it. */
export function manualStart(start: number, range: { min: number; max: number }) {
  const value = Math.min(range.max, Math.max(range.min, start));
  return { value, adjusted: value !== start };
}

/** Each target's first manual value from its own start, and whether any was held to the range. */
export function manualStarts(
  targets: readonly { id: string; start: number }[],
  range: { min: number; max: number },
) {
  const each: Record<string, number> = {};
  let adjusted = false;
  for (const { id, start } of targets) {
    const seeded = manualStart(start, range);
    each[id] = seeded.value;
    adjusted ||= seeded.adjusted;
  }
  return { each, adjusted };
}

/** An edge's pair of ends with one end changed and the other kept. */
export function withEnd(
  ends: readonly [EdgeEnd | null, EdgeEnd | null] | undefined,
  index: 0 | 1,
  end: EdgeEnd | null,
): [EdgeEnd | null, EdgeEnd | null] {
  const next: [EdgeEnd | null, EdgeEnd | null] = [ends?.[0] ?? null, ends?.[1] ?? null];
  next[index] = end;
  return next;
}

/**
 * What the mode's Dismiss, Accept, Delete and Enter act on: the selected pending features of the
 * mode's kind, any kind in Detect, and edges in Brush (where a crease stroke wider than the brush
 * leaves its guide waiting to be accepted).
 */
export function refineTargets(refine: Pick<RefineSession, 'mode' | 'features' | 'selected'>) {
  const { mode } = refine;
  if (!refine.selected.length) return [];
  const kind = mode === 'brush' ? 'edge' : mode;
  const selected = new Set(refine.selected);
  return refine.features.filter(
    (f) =>
      f.state === 'pending' && selected.has(f.id) && (kind === 'detect' || f.feature.type === kind),
  );
}

/** Names what the panel's settings write to, so an edit started on one target is never another's. */
export const targetKey = (
  mode: RefineSession['mode'],
  targets: readonly Pick<RefineFeature, 'id'>[],
) => `${mode}:${targets.length ? targets.map((f) => f.id).join(',') : 'defaults'}`;

/** The value several targets share, or the first one's when they differ (shown as mixed). */
export function shared<T>(values: readonly T[], fallback: T) {
  const value = values.length ? values[0] : fallback;
  return { value, mixed: values.some((v) => v !== value) };
}

/** Whether the next click extends a guide: Edge mode with one open pending edge selected. */
export function extendsGuide(refine: Pick<RefineSession, 'mode' | 'features' | 'selected'>) {
  if (refine.mode !== 'edge' || refine.selected.length !== 1) return false;
  const feature = refine.features.find((f) => f.id === refine.selected[0]);
  return (
    feature?.state === 'pending' && feature.feature.type === 'edge' && !feature.feature.input.closed
  );
}
