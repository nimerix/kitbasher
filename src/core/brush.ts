interface RadiusRange {
  min: number;
  max: number;
}

interface RadiusSlider extends RadiusRange {
  scale: 'linear' | 'log';
}

interface BrushOptions<State> {
  radius: (state: State) => number;
  write: (state: State, radius: number) => void;
  limits?: RadiusRange;
  step: number;
  slider: (state: State) => RadiusSlider;
}

/** Shared brush sizing with tool-supplied storage and slider range. */
export class Brush<State> {
  readonly limits: RadiusRange;
  readonly radius: BrushOptions<State>['radius'];
  readonly slider: BrushOptions<State>['slider'];
  readonly step: number;
  private readonly write: BrushOptions<State>['write'];

  constructor(options: BrushOptions<State>) {
    this.limits = options.limits ?? { min: 0.05, max: 100 };
    this.radius = options.radius;
    this.slider = options.slider;
    this.step = options.step;
    this.write = options.write;
  }

  setRadius(state: State, radius: number) {
    if (Number.isFinite(radius))
      this.write(state, Math.max(this.limits.min, Math.min(this.limits.max, radius)));
  }

  resize(state: State, factor: number) {
    const radius = this.radius(state) * factor;
    // Keep small brushes adjustable below the usual hundredth of a millimeter.
    this.setRadius(state, Number(radius.toFixed(radius < 0.05 ? 3 : 2)));
  }
}
