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
import { layoutCallouts, type CalloutBounds, type PlacedCallout } from '../../src/core/callouts';
import { Line3, Vector3 } from 'three';
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
    expect(matchKeyAction(press('G', { shiftKey: true }), {})).toBe('freeMove');
    expect(matchKeyAction(press('R', { shiftKey: true }), {})).toBe('freeRotate');
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
    expect(matchKeyAction(press('S', { shiftKey: true }), {})).toBeNull();
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
  const model = { left: 180, right: 600, top: 160, bottom: 480 };
  const settings = { placement: 'model' as const, clearance: 20, leader: 50 };
  const item = (x: number, y: number, modelBounds: CalloutBounds | null = model) => ({
    x,
    y,
    width: 30,
    height: 16,
    radius: 4,
    modelBounds,
  });
  // Sample the rendered paths, independently of the router's collision predicates.
  const samples = (label: PlacedCallout) =>
    label.leader!.slice(0, -1).flatMap((from, index) => {
      const to = label.leader![index + 1];
      const count = Math.ceil(Math.hypot(to.x - from.x, to.y - from.y));
      return Array.from({ length: count + 1 }, (_, i) => ({
        x: from.x + ((to.x - from.x) * i) / count,
        y: from.y + ((to.y - from.y) * i) / count,
      }));
    });
  const checkSeparate = (placed: PlacedCallout[]) => {
    for (const [index, label] of placed.entries()) {
      expect(label.x - 15).toBeGreaterThanOrEqual(8);
      expect(label.x + 15).toBeLessThanOrEqual(viewport.width - 8);
      expect(label.y - 8).toBeGreaterThanOrEqual(8);
      expect(label.y + 8).toBeLessThanOrEqual(viewport.height - 8);
      const [start, elbow, end] = label.leader!;
      expect(Math.abs(start.x - elbow.x)).toBeGreaterThan(1);
      expect(Math.abs(start.y - elbow.y)).toBeGreaterThan(1);
      expect(end.y).toBe(elbow.y);
      expect(end.y).toBe(label.y);
      for (const [otherIndex, other] of placed.entries()) {
        if (otherIndex === index) continue;
        expect(Math.abs(label.x - other.x) >= 33 || Math.abs(label.y - other.y) >= 19).toBe(true);
        const lines = other
          .leader!.slice(0, -1)
          .map(
            (point, i) =>
              new Line3(
                new Vector3(point.x, point.y, 0),
                new Vector3(other.leader![i + 1].x, other.leader![i + 1].y, 0),
              ),
          );
        for (const p of samples(label)) {
          expect(Math.abs(p.x - other.x) > 17 || Math.abs(p.y - other.y) > 10).toBe(true);
          const point = new Vector3(p.x, p.y, 0);
          for (const line of lines)
            expect(
              line.closestPointToPoint(point, true, new Vector3()).distanceTo(point),
            ).toBeGreaterThanOrEqual(2.9);
        }
      }
    }
  };

  it('routes independently around the model with clear labels and horizontal landings', () => {
    const items = [item(240, 370), item(550, 210), item(380, 300)];
    const placed = layoutCallouts(items, settings, viewport);
    checkSeparate(placed);
    expect(new Set(placed.map((p) => Math.round(p.y))).size).toBe(3);
    for (const [index, label] of placed.entries()) {
      expect(
        label.x + 15 <= model.left - 20 ||
          label.x - 15 >= model.right + 20 ||
          label.y + 8 <= model.top - 20 ||
          label.y - 8 >= model.bottom + 20,
      ).toBe(true);
      const [start, elbow, end] = label.leader!;
      expect(Math.hypot(start.x - items[index].x, start.y - items[index].y)).toBeCloseTo(4);
      expect(
        Math.max(elbow.x, end.x) <= model.left - 20 ||
          Math.min(elbow.x, end.x) >= model.right + 20 ||
          elbow.y <= model.top - 20 ||
          elbow.y >= model.bottom + 20,
      ).toBe(true);
    }
  });

  it('uses the preferred arm length when there are no obstacles', () => {
    const [label] = layoutCallouts(
      [item(200, 400, null)],
      { ...settings, placement: 'offset' },
      viewport,
    );
    const [start, elbow] = label.leader!;
    expect(Math.hypot(elbow.x - start.x, elbow.y - start.y)).toBeCloseTo(50);
  });

  it('adjusts both arms to keep crowded leaders from crossing or running through labels', () => {
    const placed = layoutCallouts(
      [item(250, 330), item(280, 350), item(310, 320), item(340, 345), item(370, 310)],
      settings,
      viewport,
    );
    checkSeparate(placed);
    const armLengths = placed.map(({ leader }) =>
      Math.hypot(leader![1].x - leader![0].x, leader![1].y - leader![0].y),
    );
    const landings = placed.map(({ leader }) => Math.abs(leader![2].x - leader![1].x));
    expect(new Set(armLengths.map(Math.round)).size).toBeGreaterThan(1);
    expect(new Set(landings.map(Math.round)).size).toBeGreaterThan(1);
  });

  it('keeps collinear point rows from producing shared horizontal rails', () => {
    checkSeparate(
      layoutCallouts(
        [item(230, 320), item(280, 320), item(330, 320), item(380, 320)],
        settings,
        viewport,
      ),
    );
  });

  it('mirrors the elbow near the right edge', () => {
    const [label] = layoutCallouts(
      [item(780, 400, null)],
      { ...settings, placement: 'offset' },
      viewport,
    );
    const [start, elbow, end] = label.leader!;
    expect(label.x).toBeLessThan(780);
    expect(start.x).toBeLessThan(780);
    expect(elbow.x).toBeLessThan(start.x);
    expect(end.x).toBeLessThan(elbow.x);
    expect(end.x).toBeGreaterThan(label.x + 15);
    checkSeparate([label]);
  });

  it('routes around the sides of a model whose top is off screen', () => {
    const cropped = { ...model, top: -200, bottom: 700 };
    const placed = layoutCallouts(
      [item(240, 300, cropped), item(540, 340, cropped)],
      settings,
      viewport,
    );
    checkSeparate(placed);
    expect(placed[0].x + 15).toBeLessThanOrEqual(cropped.left - 20);
    expect(placed[1].x - 15).toBeGreaterThanOrEqual(cropped.right + 20);
    expect(placed[0].y).toBeGreaterThan(50);
    expect(placed[1].y).toBeGreaterThan(50);
  });

  it('uses bounded local routes when the zoomed model fills the viewport', () => {
    const cropped = { left: -200, right: 1000, top: -200, bottom: 800 };
    const placed = layoutCallouts(
      [item(200, 400, cropped), item(400, 300, cropped)],
      settings,
      viewport,
    );
    checkSeparate(placed);
    expect(Math.abs(placed[0].y - 400)).toBeLessThan(100);
    expect(Math.abs(placed[1].y - 300)).toBeLessThan(100);
  });

  it('hangs a label below a point at the top edge', () => {
    const [label] = layoutCallouts([item(200, 20, null)], settings, viewport);
    expect(label.y).toBeGreaterThan(20);
    const [start, elbow] = label.leader!;
    expect(start.y).toBeGreaterThan(20);
    expect(elbow.y).toBeGreaterThan(start.y);
    expect(Math.hypot(start.x - 200, start.y - 20)).toBeCloseTo(4);
  });
});
