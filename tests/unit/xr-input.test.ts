import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defaultXRInputSettings,
  readXRButtons,
  readXRInputSettings,
  readXRStick,
  sanitizeXRInputSettings,
  useXRInput,
} from '../../src/core/xr-input';
import type { XRGamepadInput } from '../../src/core/xr-input';

const pad = (pressed: number[] = [], axes = [0, 0, 0, 0]): XRGamepadInput => ({
  mapping: 'xr-standard',
  buttons: Array.from({ length: 6 }, (_, index) => ({ pressed: pressed.includes(index) })),
  axes,
});

describe('Quest controller inputs', () => {
  it('maps each hand to its own face buttons and stick click', () => {
    expect(readXRButtons('left', pad([3, 4, 5])).down).toEqual(['x', 'y', 'leftStick']);
    expect(readXRButtons('right', pad([3, 4, 5])).down).toEqual(['a', 'b', 'rightStick']);
    expect(readXRButtons('none', pad([3, 4, 5])).down).toEqual([]);
    // Trigger and grip remain WebXR select/squeeze events, never duplicate button actions.
    expect(readXRButtons('right', pad([0, 1, 2])).down).toEqual([]);
  });

  it('runs a button only once until released, including a live gamepad updated in place', () => {
    const controller = pad([4]);
    const first = readXRButtons('right', controller);
    expect(first.down).toEqual(['a']);
    expect(readXRButtons('right', controller, first.pressed).down).toEqual([]);
    controller.buttons[4].pressed = false;
    const released = readXRButtons('right', controller, first.pressed);
    expect(released.pressed.size).toBe(0);
    // Earlier snapshots are values, not aliases to the live gamepad state.
    expect(first.pressed.has('a')).toBe(true);
    controller.buttons[4].pressed = true;
    expect(readXRButtons('right', controller, released.pressed).down).toEqual(['a']);
  });

  it('does not mistake an unrelated gamepad mapping or missing controls for Quest controls', () => {
    for (const controller of [null, undefined, { ...pad([4]), mapping: 'standard' }]) {
      expect(readXRButtons('right', controller).down).toEqual([]);
      expect(readXRStick(controller, 0.18)).toEqual([0, 0]);
    }
    expect(readXRButtons('right', { ...pad(), buttons: [{ pressed: true }] }).down).toEqual([]);
    expect(readXRStick({ ...pad(), axes: [1, 1] }, 0.18)).toEqual([0, 0]);
  });

  it('reads the thumbstick slots and ignores the touchpad slots', () => {
    expect(readXRStick(pad([], [1, 1, 0, 0]), 0.18)).toEqual([0, 0]);
    expect(readXRStick(pad([], [0, 0, 1, 0]), 0.18)).toEqual([1, 0]);
    expect(readXRStick(pad([], [0, 0, 0, -1]), 0.18)).toEqual([0, -1]);
  });

  it('filters drift and rescales the remaining stick travel smoothly', () => {
    expect(readXRStick(pad([], [0, 0, 0.1, 0.1]), 0.2)).toEqual([0, 0]);
    expect(readXRStick(pad([], [0, 0, 0.2, 0]), 0.2)).toEqual([0, 0]);
    const [x, y] = readXRStick(pad([], [0, 0, 0.6, 0]), 0.2);
    expect(x).toBeCloseTo(0.5);
    expect(y).toBe(0);
  });

  it('caps diagonal speed without changing direction', () => {
    const [x, y] = readXRStick(pad([], [0, 0, 1, -1]), 0.18);
    expect(Math.hypot(x, y)).toBeCloseTo(1);
    expect(x).toBeCloseTo(-y);
  });

  it('returns finite values for malformed axes and deadzones', () => {
    expect(readXRStick(pad([], [0, 0, NaN, 1]), 0.18)).toEqual([0, 0]);
    expect(readXRStick(pad([], [0, 0, Infinity, 1]), 0.18)).toEqual([0, 0]);
    expect(readXRStick(pad([], [0, 0, 1, 0]), NaN)).toEqual([1, 0]);
    expect(readXRStick(pad([], [0, 0, 1, 0]), 1)).toEqual([1, 0]);
  });
});

describe('headset binding preferences', () => {
  let storage: Map<string, string>;
  beforeEach(() => {
    storage = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    useXRInput.setState({ settings: sanitizeXRInputSettings(null) });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('supplies complete fresh defaults for missing or invalid stored settings', () => {
    for (const value of [null, undefined, 5, 'oops', [], { buttons: null, axes: false }]) {
      expect(sanitizeXRInputSettings(value)).toEqual(defaultXRInputSettings);
    }
    const settings = sanitizeXRInputSettings(null);
    settings.buttons.a = 'none';
    expect(defaultXRInputSettings.buttons.a).toBe('advance');
  });

  it('keeps valid custom bindings while rejecting unknown actions and clamping deadzone', () => {
    const settings = sanitizeXRInputSettings({
      buttons: { a: 'redo', b: 'none', x: 'unknown', bogus: 'undo' },
      axes: { left: 'rotate', right: 'invalid' },
      dominantHand: 'left',
      deadzone: 7,
    });
    expect(settings.buttons).toEqual({ ...defaultXRInputSettings.buttons, a: 'redo', b: 'none' });
    expect(settings.axes).toEqual({ left: 'rotate', right: 'context' });
    expect(settings.dominantHand).toBe('left');
    expect(settings.deadzone).toBe(0.5);
    expect(sanitizeXRInputSettings({ deadzone: -2 }).deadzone).toBe(0.05);
    expect(sanitizeXRInputSettings({ deadzone: NaN }).deadzone).toBe(0.18);
  });

  it('adds deliberate world navigation defaults to older saved bindings without replacing them', () => {
    storage.set(
      'kitbasher.xr-input',
      JSON.stringify({
        version: 1,
        buttons: { a: 'redo', y: 'panel' },
        axes: { left: 'rotate', right: 'context' },
        dominantHand: 'left',
        deadzone: 0.25,
      }),
    );
    expect(readXRInputSettings()).toMatchObject({
      buttons: { a: 'redo', y: 'panel' },
      axes: { left: 'rotate', right: 'context' },
      dominantHand: 'left',
      deadzone: 0.25,
      zoomSpeed: 1,
      turnAngle: 30,
      triggerWorld: false,
    });
  });

  it('bounds zoom speed and accepts only supported snap steps and explicit trigger opt-in', () => {
    expect(sanitizeXRInputSettings({ zoomSpeed: -1 }).zoomSpeed).toBe(0.25);
    expect(sanitizeXRInputSettings({ zoomSpeed: 8 }).zoomSpeed).toBe(2);
    expect(sanitizeXRInputSettings({ zoomSpeed: 0.75 }).zoomSpeed).toBe(0.75);
    for (const invalid of [NaN, Infinity, '2', null])
      expect(sanitizeXRInputSettings({ zoomSpeed: invalid }).zoomSpeed).toBe(1);
    for (const turnAngle of [15, 30, 45])
      expect(sanitizeXRInputSettings({ turnAngle }).turnAngle).toBe(turnAngle);
    for (const invalid of [0, 90, NaN, '15', null])
      expect(sanitizeXRInputSettings({ turnAngle: invalid }).turnAngle).toBe(30);
    for (const invalid of ['true', 1, null])
      expect(sanitizeXRInputSettings({ triggerWorld: invalid }).triggerWorld).toBe(false);
    expect(sanitizeXRInputSettings({ triggerWorld: true }).triggerWorld).toBe(true);
  });

  it('saves world navigation controls and restores safe defaults on reset', () => {
    useXRInput.getState().setSettings({
      buttons: { ...defaultXRInputSettings.buttons, a: 'frame', b: 'previousView' },
      axes: { left: 'world', right: 'context' },
      zoomSpeed: 0.6,
      turnAngle: 15,
      triggerWorld: true,
    });
    const saved = readXRInputSettings();
    expect(saved).toEqual(useXRInput.getState().settings);
    expect(saved).toMatchObject({
      buttons: { a: 'frame', b: 'previousView' },
      axes: { left: 'world', right: 'context' },
      zoomSpeed: 0.6,
      turnAngle: 15,
      triggerWorld: true,
    });
    useXRInput.getState().reset();
    expect(readXRInputSettings()).toEqual(defaultXRInputSettings);
  });

  it('persists updates and resets all bindings without losing unrelated settings', () => {
    useXRInput.getState().setSettings({
      buttons: { ...defaultXRInputSettings.buttons, a: 'redo' },
      dominantHand: 'left',
    });
    useXRInput.getState().setSettings({ deadzone: 0.3 });
    expect(readXRInputSettings()).toEqual(useXRInput.getState().settings);
    expect(readXRInputSettings().buttons.a).toBe('redo');
    expect(readXRInputSettings().dominantHand).toBe('left');
    useXRInput.getState().reset();
    expect(readXRInputSettings()).toEqual(defaultXRInputSettings);
  });

  it('recovers from corrupted storage and still changes bindings when writes are blocked', () => {
    storage.set('kitbasher.xr-input', '{broken');
    expect(readXRInputSettings()).toEqual(defaultXRInputSettings);
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('Unavailable');
      },
      setItem: () => {
        throw new Error('Quota exceeded');
      },
    });
    expect(readXRInputSettings()).toEqual(defaultXRInputSettings);
    useXRInput.getState().setSettings({ dominantHand: 'left' });
    expect(useXRInput.getState().settings.dominantHand).toBe('left');
  });
});
