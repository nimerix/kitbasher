import { describe, expect, it } from 'vitest';
import {
  calloutLeader,
  layoutCallouts,
  type CalloutBounds,
  type CalloutItem,
  type CalloutOffset,
  type PlacedCallout,
} from '../../src/core/callouts';

const viewport = { width: 800, height: 600 };
const settings = { leader: 28 };
const item = (id: string, x: number, y: number): CalloutItem => ({
  id,
  x,
  y,
  width: 36,
  height: 26,
  radius: 4,
});
const bounds = (point: { x: number; y: number }, size: { width: number; height: number }) => ({
  left: point.x - size.width / 2,
  right: point.x + size.width / 2,
  top: point.y - size.height / 2,
  bottom: point.y + size.height / 2,
});
const overlaps = (a: CalloutBounds, b: CalloutBounds) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const remembered = (items: CalloutItem[], placed: PlacedCallout[]) =>
  new Map(items.map((point, index) => [point.id, placed[index].offset]));

function checkReadable(items: CalloutItem[], placed: PlacedCallout[], size = viewport) {
  expect(placed).toHaveLength(items.length);
  for (const [index, label] of placed.entries()) {
    const point = items[index];
    const box = bounds(label, point);
    expect(Number.isFinite(label.x) && Number.isFinite(label.y)).toBe(true);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(size.width);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(size.height);
    // Even a collision escape must stay local to the actual point.
    expect(Math.hypot(label.x - point.x, label.y - point.y)).toBeLessThanOrEqual(120);
    if (label.leader) {
      expect(label.leader).toHaveLength(2);
      const [start, end] = label.leader;
      const startDistance = Math.hypot(start.x - point.x, start.y - point.y);
      expect(startDistance).toBeGreaterThanOrEqual(point.radius);
      expect(startDistance).toBeLessThanOrEqual(point.radius + 2);
      expect(Math.hypot(end.x - start.x, end.y - start.y)).toBeLessThanOrEqual(80.001);
      // The connector must stop before entering its label's opaque face.
      expect(
        end.x <= box.left || end.x >= box.right || end.y <= box.top || end.y >= box.bottom,
      ).toBe(true);
    }
  }
}

function checkSeparate(items: CalloutItem[], placed: PlacedCallout[]) {
  checkReadable(items, placed);
  for (let i = 0; i < placed.length; i++)
    for (let j = i + 1; j < placed.length; j++)
      expect(overlaps(bounds(placed[i], items[i]), bounds(placed[j], items[j]))).toBe(false);
}

describe('local callout layout', () => {
  it('keeps a lone callout close to its point in a large viewport', () => {
    const points = [item('pin:1', 2000, 1600)];
    const placed = layoutCallouts(points, settings, { width: 4000, height: 3200 });
    checkReadable(points, placed, { width: 4000, height: 3200 });
    expect(placed[0].leader).not.toBeNull();
    expect(Math.hypot(placed[0].x - 2000, placed[0].y - 1600)).toBeLessThan(80);
  });

  it('follows 0.5px camera translations without changing label offsets', () => {
    let points = [item('a', 260, 300), item('b', 420, 340), item('c', 570, 270)];
    let placed = layoutCallouts(points, settings, viewport);
    const initial = remembered(points, placed);
    for (let frame = 0; frame < 60; frame++) {
      const previous = remembered(points, placed);
      points = points.map((point) => ({ ...point, x: point.x + 0.5, y: point.y - 0.5 }));
      placed = layoutCallouts(points, settings, viewport, previous);
      for (const [index, point] of points.entries()) {
        expect(placed[index].offset.x).toBeCloseTo(initial.get(point.id)!.x, 6);
        expect(placed[index].offset.y).toBeCloseTo(initial.get(point.id)!.y, 6);
        expect(placed[index].x - point.x).toBeCloseTo(initial.get(point.id)!.x, 6);
        expect(placed[index].y - point.y).toBeCloseTo(initial.get(point.id)!.y, 6);
      }
      checkSeparate(points, placed);
    }
  });

  it('retains each label by ID when visible points are reordered, added, or removed', () => {
    const points = [item('a', 220, 240), item('b', 400, 300), item('c', 580, 360)];
    const first = layoutCallouts(points, settings, viewport);
    const previous = remembered(points, first);
    const next = [item('d', 650, 170), points[2], points[0]];
    const placed = layoutCallouts(next, settings, viewport, previous);
    checkSeparate(next, placed);
    expect(placed[1].offset).toEqual(previous.get('c'));
    expect(placed[2].offset).toEqual(previous.get('a'));
    const restored = layoutCallouts(points, settings, viewport, previous);
    expect(remembered(points, restored)).toEqual(previous);
  });

  it('lets a new nearby label yield to an established readable label', () => {
    const point = item('a', 400, 300);
    const first = layoutCallouts([point], settings, viewport);
    const points = [point, item('b', 360, 270)];
    const placed = layoutCallouts(points, settings, viewport, remembered([point], first));
    checkSeparate(points, placed);
    expect(placed[0].offset).toEqual(first[0].offset);
  });

  it('keeps a separated cluster stable during subpixel camera movement', () => {
    let points = [
      item('a', 400, 300),
      item('b', 403, 302),
      item('c', 397, 301),
      item('d', 402, 297),
    ];
    let placed = layoutCallouts(points, settings, viewport);
    const initial = remembered(points, placed);
    for (let frame = 0; frame < 30; frame++) {
      const previous = remembered(points, placed);
      points = points.map((point) => ({ ...point, x: point.x + 0.5, y: point.y - 0.5 }));
      placed = layoutCallouts(points, settings, viewport, previous);
      checkSeparate(points, placed);
      for (const [index, point] of points.entries()) {
        expect(placed[index].offset.x).toBeCloseTo(initial.get(point.id)!.x, 6);
        expect(placed[index].offset.y).toBeCloseTo(initial.get(point.id)!.y, 6);
      }
    }
  });

  it('keeps a previously chosen nondefault free position instead of snapping back', () => {
    const point = item('a', 400, 300);
    const first = layoutCallouts([point], settings, viewport)[0];
    const opposite = { x: -first.offset.x, y: -first.offset.y };
    const previous = new Map<string, CalloutOffset>([['a', opposite]]);
    const [placed] = layoutCallouts([point], settings, viewport, previous);
    expect(placed.offset).toEqual(opposite);
    checkReadable([point], [placed]);
    expect(previous.get('a')).toEqual(opposite);
  });

  it.each([
    [
      'coincident points',
      [
        [400, 300],
        [400, 300],
        [400, 300],
        [400, 300],
      ],
    ],
    [
      'nearby points',
      [
        [400, 300],
        [403, 302],
        [397, 301],
        [402, 297],
      ],
    ],
    [
      'a horizontal row',
      [
        [360, 300],
        [380, 300],
        [400, 300],
        [420, 300],
        [440, 300],
      ],
    ],
  ] as const)('separates readable labels around %s', (_name, coordinates) => {
    const points = coordinates.map(([x, y], index) => item(`pin:${index}`, x, y));
    const placed = layoutCallouts(points, settings, viewport);
    checkSeparate(points, placed);
  });

  it('keeps labels inside all four viewport corners', () => {
    const points = [item('tl', 1, 1), item('tr', 799, 1), item('bl', 1, 599), item('br', 799, 599)];
    const placed = layoutCallouts(points, settings, viewport);
    checkSeparate(points, placed);
    expect(placed[0].x).toBeGreaterThan(points[0].x);
    expect(placed[0].y).toBeGreaterThan(points[0].y);
    expect(placed[3].x).toBeLessThan(points[3].x);
    expect(placed[3].y).toBeLessThan(points[3].y);
  });

  it('temporarily clamps a label on resize and restores its intended offset when space returns', () => {
    const point = item('a', 390, 200);
    const previous = new Map<string, CalloutOffset>([['a', { x: 48, y: -30 }]]);
    const small = { width: 400, height: 300 };
    const placed = layoutCallouts([point], settings, small, previous);
    checkReadable([point], placed, small);
    expect(placed[0].offset).toEqual(previous.get('a'));
    expect(placed[0].x).toBeLessThan(point.x + placed[0].offset.x);
    const [restored] = layoutCallouts([point], settings, viewport, remembered([point], placed));
    expect(restored.x).toBe(point.x + previous.get('a')!.x);
    expect(restored.y).toBe(point.y + previous.get('a')!.y);
  });

  it('recovers its original local position after repeatedly panning to the screen edge and back', () => {
    let point = item('a', 400, 300);
    let placed = layoutCallouts([point], { leader: 24 }, viewport);
    const original = placed[0];
    for (let cycle = 0; cycle < 3; cycle++) {
      for (const direction of [1, -1]) {
        for (let step = 0; step < 195; step++) {
          const previous = remembered([point], placed);
          point = { ...point, x: point.x + direction * 2 };
          placed = layoutCallouts([point], { leader: 24 }, viewport, previous);
          checkReadable([point], placed);
          expect(placed[0].offset).toEqual(original.offset);
        }
      }
      expect(placed[0]).toEqual(original);
    }
  });

  it('clears a nearby toolbar even when a remembered label would cover it', () => {
    const point = item('a', 400, 300);
    const first = layoutCallouts([point], settings, viewport);
    const old = bounds(first[0], point);
    const obstacle = {
      left: old.left - 5,
      right: old.right + 5,
      top: old.top - 5,
      bottom: old.bottom + 5,
    };
    const placed = layoutCallouts([point], settings, viewport, remembered([point], first), [
      obstacle,
    ]);
    checkReadable([point], placed);
    expect(overlaps(bounds(placed[0], point), obstacle)).toBe(false);
    expect(placed[0].offset).not.toEqual(first[0].offset);
  });

  it('bounds leader length even when an old saved preference requests 240px', () => {
    const points = [item('a', 300, 300), item('b', 500, 300)];
    const placed = layoutCallouts(points, { leader: 240 }, viewport);
    checkSeparate(points, placed);
    expect(placed.every((label) => label.leader !== null)).toBe(true);
  });

  it('uses finite local positions when obstacles leave no collision-free option', () => {
    const points = [item('a', 400, 300), item('b', 404, 304)];
    const placed = layoutCallouts(points, settings, viewport, new Map(), [
      { left: 0, right: 800, top: 0, bottom: 600 },
    ]);
    checkReadable(points, placed);
  });
});

describe('callout connector', () => {
  it('starts at the marker edge and stops outside a wide label', () => {
    const point = { ...item('a', 200, 300), width: 90 };
    const center = { x: 280, y: 280 };
    const leader = calloutLeader(point, center);
    expect(leader).not.toBeNull();
    const [start, end] = leader!;
    const startDistance = Math.hypot(start.x - point.x, start.y - point.y);
    expect(startDistance).toBeGreaterThanOrEqual(point.radius);
    expect(startDistance).toBeLessThanOrEqual(point.radius + 2);
    const box = bounds(center, point);
    expect(end.x <= box.left || end.x >= box.right || end.y <= box.top || end.y >= box.bottom).toBe(
      true,
    );
    // Both endpoints lie along the same ray from the marker to the label.
    for (const p of leader!)
      expect(
        (p.x - point.x) * (center.y - point.y) - (p.y - point.y) * (center.x - point.x),
      ).toBeCloseTo(0, 5);
  });

  it('omits a connector when the label already covers the marker', () => {
    const point = item('a', 200, 300);
    expect(calloutLeader(point, { x: point.x, y: point.y })).toBeNull();
  });
});
