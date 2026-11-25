import { fittedSizeRange, partSize } from './geometry';
import { Brush } from './brush';
import {
  brushingRefine,
  paintingRefine,
  paintingWarpArea,
  paintingWarpRegion,
  refineBrushRadius,
  useEditor,
  warpBrushRadius,
} from './store';

type State = ReturnType<typeof useEditor.getState>;
export type EditorBrush = Brush<State>;

function partSlider(state: State, id: string | undefined) {
  const part = state.scene.parts.find((part) => part.id === id);
  return { scale: 'log' as const, ...fittedSizeRange(part ? partSize(part) : 0) };
}

export const contactBrush = new Brush<State>({
  radius: (state) => state.brushRadius,
  write: (state, radius) => state.setBrush({ radius }),
  step: 0.5,
  slider: () => ({ scale: 'linear', min: 0.1, max: 20 }),
});
const warpBrush = new Brush<State>({
  radius: warpBrushRadius,
  write: (state, radius) => state.setWarpBrushRadius(radius),
  step: 0.1,
  slider: (state) => partSlider(state, state.warp?.partId),
});
export const refineBrush = new Brush<State>({
  radius: refineBrushRadius,
  write: (state, radius) => state.setRefineBrushRadius(radius),
  step: 0.1,
  slider: (state) => partSlider(state, state.refine?.partId),
});
const sculptLimits = { min: 0.01, max: 1000 };
const sculptBrush = new Brush<State>({
  radius: (state) => state.sculpt?.settings.radius ?? 0,
  write: (state, radius) => state.setSculptSettings({ radius }),
  step: 0.1,
  limits: sculptLimits,
  slider: () => ({ scale: 'log', ...sculptLimits }),
});

export function activeBrush(state: State): EditorBrush | null {
  if (state.tool === 'align' && state.operation.mode === 'surface') return contactBrush;
  if (paintingWarpRegion(state) || paintingWarpArea(state)) return warpBrush;
  if (paintingRefine(state) || brushingRefine(state)) return refineBrush;
  if (state.tool === 'sculpt' && state.sculpt) return sculptBrush;
  return null;
}
