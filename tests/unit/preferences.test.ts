import { beforeEach, describe, expect, it } from 'vitest';
import {
  assignBinding,
  bindingFromEvent,
  formatBinding,
  formatBindings,
  matchKeyAction,
  parseBinding,
  removeBinding,
  sanitizeOverrides,
  serializeChord,
} from '../../src/core/keybindings';
import type { KeyInput } from '../../src/core/keybindings';
import { layoutCallouts } from '../../src/core/callouts';
import {
  defaultPreferences,
  sanitizePreferences,
  usePreferences,
} from '../../src/core/preferences';
import { shortcutCommand } from '../../src/core/commands';
import {
  maxPendingZoom,
  clampPendingZoom,
  wheelZoom,
  zoomGlideStep,
  zoomSettleThreshold,
} from '../../src/core/zoom';

const press = (key: string, extra: Partial<KeyInput> = {}): KeyInput => ({
  key,
  code: undefined,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...extra,
});

describe('key bindings', () => {
  it('parses and serializes chords, including the plus key itself', () => {
    expect(parseBinding('Mod+Shift+Z')).toEqual({ key: 'Z', mod: true, alt: false, shift: true });
    expect(parseBinding('Mod++')).toEqual({ key: '+', mod: true, alt: false, shift: false });
    expect(parseBinding('+').key).toBe('+');
    expect(serializeChord(parseBinding('Mod+Alt+Shift+K'))).toBe('Mod+Alt+Shift+K');
  });

  it('matches the default single-key and modified shortcuts', () => {
    expect(matchKeyAction(press('g'), {})).toBe('move');
    expect(matchKeyAction(press(' ', { code: 'Space' }), {})).toBe('holdOrbit');
    expect(matchKeyAction(press('.', { code: 'Period' }), {})).toBe('centerOrbit');
    expect(matchKeyAction(press('>', { code: 'Period', shiftKey: true }), {})).toBe(
      'orbitSelection',
    );
    expect(matchKeyAction(press('?', { code: 'Slash', shiftKey: true }), {})).toBe('help');
    expect(matchKeyAction(press('z', { metaKey: true }), {})).toBe('undo');
    expect(matchKeyAction(press('Z', { ctrlKey: true, shiftKey: true }), {})).toBe('redo');
    expect(matchKeyAction(press('Backspace'), {})).toBe('delete');
    expect(matchKeyAction(press(',', { metaKey: true, code: 'Comma' }), {})).toBe('preferences');
    // The keypad's decimal key centers the orbit even with Num Lock off.
    expect(matchKeyAction(press('Delete', { code: 'NumpadDecimal' }), {})).toBe('centerOrbit');
    expect(matchKeyAction(press('Delete', { code: 'Delete' }), {})).toBe('delete');
    expect(matchKeyAction(press('Home', { code: 'Numpad7' }), {})).toBe('viewTop');
  });

  it('keeps modifiers strict, so Shift and ⌘ variants never trigger plain tools', () => {
    expect(matchKeyAction(press('G', { shiftKey: true }), {})).toBeNull();
    expect(matchKeyAction(press('g', { metaKey: true }), {})).toBeNull();
    expect(matchKeyAction(press('g', { altKey: true }), {})).toBeNull();
  });

  it('falls back to the physical key when a layout or Alt changes the character', () => {
    expect(matchKeyAction(press('п', { code: 'KeyG' }), {})).toBe('move');
    expect(matchKeyAction(press('©', { code: 'KeyG', altKey: true }), { move: ['Alt+G'] })).toBe(
      'move',
    );
    // AZERTY's A key types Q, so it must not also count as A.
    expect(matchKeyAction(press('q', { code: 'KeyA' }), {})).toBeNull();
  });

  it('records presses as layout-independent bindings', () => {
    expect(bindingFromEvent(press('Shift'))).toBeNull();
    expect(bindingFromEvent(press('k'))).toBe('K');
    expect(bindingFromEvent(press('?', { code: 'Slash', shiftKey: true }))).toBe('Shift+/');
    expect(bindingFromEvent(press('©', { code: 'KeyG', altKey: true }))).toBe('Alt+G');
    expect(bindingFromEvent(press('k', { ctrlKey: true, shiftKey: true }))).toBe('Mod+Shift+K');
    expect(bindingFromEvent(press(' ', { code: 'Space' }))).toBe('Space');
    const recorded = bindingFromEvent(press('?', { code: 'Slash', shiftKey: true }))!;
    expect(
      matchKeyAction(press('?', { code: 'Slash', shiftKey: true }), { search: [recorded] }, [
        'search',
      ]),
    ).toBe('search');
  });

  it('formats bindings for each platform', () => {
    expect(formatBinding('Mod+Shift+Z', true)).toBe('⌘+Shift+Z');
    expect(formatBinding('Mod+Shift+Z', false)).toBe('Ctrl+Shift+Z');
    expect(formatBinding('Alt+G', true)).toBe('⌥+G');
    expect(formatBindings(['Delete', 'Backspace'])).toBe('Del / ⌫');
    expect(formatBinding('Escape')).toBe('Esc');
  });

  it('moves a reassigned key away from its old action', () => {
    const { overrides, displaced } = assignBinding({}, 'measure', 'G');
    expect(displaced).toEqual(['move']);
    expect(overrides.move).toEqual([]);
    expect(overrides.measure).toEqual(['D', 'G']);
    expect(matchKeyAction(press('g'), overrides)).toBe('measure');
    const replaced = assignBinding({}, 'measure', 'M', 'D');
    expect(replaced.overrides.measure).toEqual(['M']);
    expect(replaced.displaced).toEqual([]);
  });

  it('drops overrides that equal the defaults', () => {
    const removed = removeBinding({}, 'redo', 'Mod+Y');
    expect(removed.redo).toEqual(['Mod+Shift+Z']);
    expect(assignBinding(removed, 'redo', 'Mod+Y').overrides).toEqual({});
  });

  it('ignores unknown actions and malformed stored bindings', () => {
    expect(
      sanitizeOverrides({ move: ['M', 'M', 3], nope: ['X'], undo: 'Mod+Z', select: ['V'] }),
    ).toEqual({ move: ['M'] });
  });
});

describe('preferences', () => {
  beforeEach(() => usePreferences.setState({ ...defaultPreferences, panel: null }));

  it('clamps stored values and falls back for anything invalid', () => {
    const prefs = sanitizePreferences({
      zoom: { sensitivity: 99, curve: 'steep', smoothing: -5, invert: 'yes' },
      markers: { size: 1, style: 'balloon', placement: 'offset', leader: 80 },
    });
    expect(prefs.zoom).toEqual({ sensitivity: 4, curve: 0.5, smoothing: 0, invert: false });
    expect(prefs.markers).toMatchObject({ size: 4, style: 'inline', placement: 'offset' });
    expect(prefs.markers.leader).toBe(80);
    expect(sanitizePreferences(null)).toEqual(defaultPreferences);
  });

  it('command shortcuts follow rebinding', () => {
    expect(shortcutCommand(press('d', { metaKey: true }))).toBe('duplicate');
    usePreferences.getState().assignBinding('save', 'Mod+D');
    expect(shortcutCommand(press('d', { metaKey: true }))).toBe('save');
    usePreferences.getState().resetBindings();
    expect(shortcutCommand(press('d', { metaKey: true }))).toBe('duplicate');
  });

  it('reports the actions that lost a binding', () => {
    expect(usePreferences.getState().assignBinding('focus', 'Home')).toEqual(['frameAll']);
    expect(usePreferences.getState().keybindings.frameAll).toEqual([]);
  });
});

describe('scroll zoom', () => {
  const settings = defaultPreferences.zoom;

  it('zooms in on upward scroll and out on downward, with optional inversion', () => {
    expect(wheelZoom({ deltaY: -100, deltaMode: 0 }, settings)).toBeGreaterThan(0);
    expect(wheelZoom({ deltaY: 100, deltaMode: 0 }, settings)).toBeLessThan(0);
    expect(wheelZoom({ deltaY: -100, deltaMode: 0 }, { ...settings, invert: true })).toBeLessThan(
      0,
    );
    expect(wheelZoom({ deltaY: 0, deltaMode: 0 }, settings)).toBe(0);
  });

  it('treats Firefox line deltas like pixel notches', () => {
    expect(wheelZoom({ deltaY: 3, deltaMode: 1 }, settings)).toBeCloseTo(
      wheelZoom({ deltaY: 100, deltaMode: 0 }, settings),
    );
  });

  it('scales by sensitivity and shapes notch size by the curve', () => {
    const notch = (deltaY: number, curve: number) =>
      wheelZoom({ deltaY, deltaMode: 0 }, { ...settings, curve });
    expect(wheelZoom({ deltaY: 100, deltaMode: 0 }, { ...settings, sensitivity: 2 })).toBeCloseTo(
      2 * notch(100, settings.curve),
    );
    // Proportional: a quarter of the distance zooms a quarter as much.
    expect(notch(25, 1) / notch(100, 1)).toBeCloseTo(0.25);
    // A gentler curve lifts small steps such as a slow macOS wheel notch.
    expect(notch(4, 0.5) / notch(100, 0.5)).toBeCloseTo(0.2);
    expect(Math.abs(notch(4, 0.5))).toBeLessThan(Math.abs(notch(4, 0.2)));
  });

  it('follows a trackpad pinch directly and ignores inversion for it', () => {
    const pinch = wheelZoom({ deltaY: -100 * Math.log(2), deltaMode: 0 }, settings, true);
    expect(Math.exp(pinch)).toBeCloseTo(2);
    expect(
      wheelZoom({ deltaY: -10, deltaMode: 0 }, { ...settings, invert: true }, true),
    ).toBeGreaterThan(0);
  });

  it('glides toward the target and lands within a few time constants', () => {
    expect(zoomGlideStep(0.3, 0.016, 0)).toBe(0.3);
    let pending = 0.32,
      time = 0;
    while (pending) {
      const step = zoomGlideStep(pending, 1 / 60, settings.smoothing);
      expect(Math.abs(step)).toBeLessThanOrEqual(Math.abs(pending));
      pending -= step;
      time += 1 / 60;
      if (Math.abs(pending) < 1e-12) pending = 0;
    }
    expect(time).toBeLessThan(0.4);
    expect(zoomGlideStep(zoomSettleThreshold / 2, 0.001, 100)).toBe(zoomSettleThreshold / 2);
    expect(clampPendingZoom(99)).toBe(maxPendingZoom);
  });
});

describe('callout layout', () => {
  const viewport = { width: 800, height: 600 };
  const item = (x: number, y: number, modelTop: number | null = 300) => ({
    x,
    y,
    width: 30,
    height: 16,
    radius: 4,
    modelTop,
  });

  it('keeps every label vertically above its point, clear of the model', () => {
    const [a, b] = layoutCallouts(
      [item(200, 400), item(500, 450)],
      { placement: 'model', clearance: 20, leader: 50 },
      viewport,
    );
    expect(a.x).toBe(200);
    expect(b.x).toBe(500);
    expect(a.y + 8).toBeLessThanOrEqual(300 - 20);
    expect(b.y).toBe(a.y);
    expect(a.leader).toEqual([a.y + 8, 400 - 4]);
  });

  it('uses a fixed leader length when asked', () => {
    const [label] = layoutCallouts(
      [item(200, 400)],
      { placement: 'offset', clearance: 20, leader: 50 },
      viewport,
    );
    expect(label.leader).toEqual([400 - 4 - 50, 400 - 4]);
  });

  it('stacks overlapping labels away from the model without moving them sideways', () => {
    const placed = layoutCallouts(
      [item(200, 400), item(210, 420), item(400, 410)],
      { placement: 'model', clearance: 20, leader: 50 },
      viewport,
    );
    expect(placed.map((p) => p.x)).toEqual([200, 210, 400]);
    expect(Math.abs(placed[0].y - placed[1].y)).toBeGreaterThanOrEqual(16);
    expect(placed[2].y).toBe(Math.max(placed[0].y, placed[1].y));
  });

  it('hangs a label below a point at the top edge', () => {
    const [label] = layoutCallouts(
      [item(200, 20, 0)],
      { placement: 'model', clearance: 20, leader: 50 },
      viewport,
    );
    expect(label.y).toBeGreaterThan(20);
    expect(label.leader![0]).toBe(24);
  });
});
