import type { EdgeEnd } from '../core/refine-edge';
import type { RefineModel } from '../core/refine-model';
import type { RegionSolve } from '../core/refine-region';
import type { RefineFeature } from '../core/store';

const triangles = (n: number) => (n === 1 ? '1 triangle' : `${n} triangles`);

export const featureCounts = (features: readonly Pick<RefineFeature, 'state'>[]) => {
  const accepted = features.filter((f) => f.state === 'accepted').length;
  return `${accepted} accepted · ${features.length - accepted} proposed`;
};

export const foldWarning = (n: number) =>
  `${triangles(n)} ${n === 1 ? 'folds' : 'fold'} over. Undo the last step or reduce Width.`;

export const skippedWarning = (n: number) => `${triangles(n)} could not be cut cleanly.`;

/** What a region's Auto shape fitted, or null when nothing was fitted. */
export const fittedLabel = (fitted: RegionSolve['fitted']) => (fitted ? `Fits a ${fitted}` : null);

export const endLabels = { auto: 'Auto', taper: 'Fade', hold: 'Hold' } as const;

/** The Auto choice of an end, naming what the solve chose once there is one. */
export const endOption = (chosen: EdgeEnd | undefined) =>
  chosen ? `Auto (${endLabels[chosen]})` : endLabels.auto;

/**
 * Where a setting taken off Auto starts: what the solve used when known, otherwise the rule the
 * solver applies to a null value, from the model's noise and median edge length.
 */
export function autoStart(
  setting: 'width' | 'scale' | 'detail' | 'blend',
  model: Pick<RefineModel, 'noise' | 'step'>,
  solved?: number,
) {
  if (solved !== undefined) return solved;
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
