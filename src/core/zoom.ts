export interface ZoomSettings {
  /** Multiplies every zoom step. */
  sensitivity: number;
  /** Exponent on the wheel distance of one event. 1 is proportional, lower evens out notches. */
  curve: number;
  /** 0–100. How long the view glides toward the requested zoom. */
  smoothing: number;
  invert: boolean;
}

/** Pixels in one standard wheel notch, as Chromium reports it on Windows and Linux. */
export const notchPixels = 100;
/** Natural-log zoom for one notch at sensitivity 1, about 16%. */
const notchZoom = 0.15;
const maxNotches = 10;
/** The furthest a burst of wheel events can queue, about 55×. */
export const maxPendingZoom = 4;
/** Below this the rest of a glide is imperceptible, so it lands at once. */
export const zoomSettleThreshold = 0.004;
/** The glide's time constant at 100% smoothing, in seconds. */
const maxTimeConstant = 0.2;

export function wheelPixels(deltaY: number, deltaMode: number) {
  // Firefox reports three lines per notch; page mode is rare but possible.
  return deltaY * (deltaMode === 1 ? notchPixels / 3 : deltaMode === 2 ? notchPixels * 8 : 1);
}

/** The step of a wheel distance in notches, before sensitivity and direction. */
export function zoomResponse(notches: number, curve: number) {
  return notchZoom * Math.min(Math.abs(notches), maxNotches) ** curve;
}

/** The natural log of the zoom factor for one wheel event. Positive values zoom in. */
export function wheelZoom(
  event: { deltaY: number; deltaMode: number },
  settings: ZoomSettings,
  pinch = false,
) {
  const pixels = wheelPixels(event.deltaY, event.deltaMode);
  if (!pixels) return 0;
  // Chromium reports a trackpad pinch as Ctrl + wheel with deltaY = -100 × ln(scale),
  // so the zoom follows the fingers directly.
  if (pinch) return (-pixels / 100) * settings.sensitivity;
  const amount = zoomResponse(pixels / notchPixels, settings.curve) * settings.sensitivity;
  return (pixels < 0 ? amount : -amount) * (settings.invert ? -1 : 1);
}

export function zoomTimeConstant(smoothing: number) {
  return (Math.max(0, Math.min(100, smoothing)) / 100) * maxTimeConstant;
}

/** The part of a pending zoom to apply after `dt` seconds of an exponential glide. */
export function zoomGlideStep(pending: number, dt: number, smoothing: number) {
  const tau = zoomTimeConstant(smoothing);
  if (tau <= 0 || Math.abs(pending) <= zoomSettleThreshold) return pending;
  const step = pending * (1 - Math.exp(-Math.max(0, dt) / tau));
  return Math.abs(pending - step) <= zoomSettleThreshold ? pending : step;
}

export const clampPendingZoom = (pending: number) =>
  Math.max(-maxPendingZoom, Math.min(maxPendingZoom, pending));
