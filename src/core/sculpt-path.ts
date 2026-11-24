/** A pointer sample and the pen properties that affect a sculpt dab. */
export type SculptSample = Pick<
  PointerEvent,
  | 'clientX'
  | 'clientY'
  | 'pressure'
  | 'pointerType'
  | 'tiltX'
  | 'tiltY'
  | 'twist'
  | 'shiftKey'
  | 'altKey'
>;

function interpolate(a: SculptSample, b: SculptSample, t: number): SculptSample {
  const lerp = (start: number, end: number) => start + (end - start) * t;
  return {
    pointerType: b.pointerType,
    shiftKey: b.shiftKey,
    altKey: b.altKey,
    clientX: lerp(a.clientX, b.clientX),
    clientY: lerp(a.clientY, b.clientY),
    pressure: lerp(a.pressure, b.pressure),
    tiltX: lerp(a.tiltX, b.tiltX),
    tiltY: lerp(a.tiltY, b.tiltY),
    twist: (a.twist + (((b.twist - a.twist + 540) % 360) - 180) * t + 360) % 360,
  };
}

const distance = (a: SculptSample, b: SculptSample) =>
  Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);

/** Keep input segments intact and produce only as many dabs as the caller has time to apply. */
export class SculptPath {
  private queue: { sample: SculptSample; final: boolean }[] = [];
  private head = 0;
  private cursor: SculptSample;
  private filtered: SculptSample;
  private lastDab: SculptSample;
  private first = true;
  private travelled = 0;

  constructor(
    start: SculptSample,
    private readonly spacing: (a: SculptSample, b: SculptSample) => number,
    private readonly stabilization: number,
  ) {
    this.cursor = this.filtered = this.lastDab = start;
  }

  get pending() {
    return this.first || this.head < this.queue.length;
  }

  push(incoming: SculptSample, final = false) {
    this.filtered = final
      ? incoming
      : interpolate(this.filtered, incoming, 1 - this.stabilization * 0.85);
    this.queue.push({ sample: this.filtered, final });
  }

  private consume() {
    if (++this.head === this.queue.length) {
      this.queue.length = 0;
      this.head = 0;
    } else if (this.head >= 256) {
      this.queue = this.queue.slice(this.head);
      this.head = 0;
    }
  }

  next(): SculptSample | undefined {
    if (this.first) {
      this.first = false;
      return this.cursor;
    }
    while (this.head < this.queue.length) {
      const { sample, final } = this.queue[this.head];
      const length = distance(this.cursor, sample);
      const remaining = Math.max(0.001, this.spacing(this.cursor, sample) - this.travelled);
      if (length >= remaining) {
        this.cursor = interpolate(this.cursor, sample, remaining / length);
        this.travelled = 0;
        this.lastDab = this.cursor;
        return this.cursor;
      }
      this.travelled += length;
      this.cursor = sample;
      this.consume();
      if (
        (final && this.travelled > 0.001) ||
        (this.travelled < 0.1 && Math.abs(sample.pressure - this.lastDab.pressure) > 0.015)
      ) {
        this.travelled = 0;
        this.lastDab = sample;
        return sample;
      }
    }
  }
}
