import { expect, it, vi } from 'vitest';
import { BoxGeometry, TorusGeometry } from 'three';
import { clippingDepth, placeClear, treeOf } from '../../src/core/clipping';
import { binaryGeometry } from '../../src/core/geometry';
import type { Part } from '../../src/core/types';
import { useEditor } from '../../src/core/store';
import { displayTarget } from '../../src/core/display-performance';

it('reduces dense drag queries and settles on the original surface without changing its topology', () => {
  const geometry = new BoxGeometry(10, 10, 10, 92, 92, 92);
  const before = binaryGeometry(geometry).positions.slice();
  const tree = treeOf(geometry)!;
  const query = vi.spyOn(tree, 'closestPointToPoint');
  const part: Part = {
    id: 'a',
    name: 'Scan',
    geometry,
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    color: '#fff',
    visible: true,
    locked: false,
    source: 'test',
  };
  const parts: Part[] = [part, { ...part, id: 'b', position: [10.1, 0, 0] }];
  const move = (settle: boolean) =>
    placeClear({
      parts,
      joints: [],
      ids: ['b'],
      target: [{ ...parts[1], position: [9.95, 0.1, 0] }],
      place: ([pose]) => [part, pose],
      overlap: 0.1,
      mode: 'drag',
      settle,
    });
  move(false);
  const coarseQueries = query.mock.calls.length;
  query.mockClear();
  const result = move(true);
  const fullQueries = query.mock.calls.length;
  expect(coarseQueries).toBeGreaterThan(0);
  expect(fullQueries).toBeGreaterThan(coarseQueries * 3);
  expect(clippingDepth(result.parts, ['b'])).toBeLessThanOrEqual(0.105);
  expect(binaryGeometry(geometry).positions).toEqual(before);
  expect(result.parts[1].geometry).toBe(geometry);
  query.mockRestore();
});

const testPart = (
  id: string,
  geometry: Part['geometry'] = new BoxGeometry(10, 10, 10),
  x = 0,
): Part => ({
  id,
  name: id,
  geometry,
  position: [x, 0, 0],
  quaternion: [0, 0, 0, 1],
  scale: [1, 1, 1],
  color: '#fff',
  visible: true,
  locked: false,
  source: 'test',
});

it('does not build surface indexes for distant scans, even when another part is touching', () => {
  const moving = testPart('moving', undefined, 9.95),
    wall = testPart('wall');
  const distant = Array.from({ length: 4 }, (_, i) =>
    testPart(`far-${i}`, new BoxGeometry(10, 10, 10, 100, 100, 100), 100 + i * 30),
  );
  for (const fixed of [distant, [wall, ...distant]]) {
    const result = placeClear({
      parts: [moving, ...fixed],
      joints: [],
      ids: ['moving'],
      target: [{ ...moving, position: [9.95, 0.05, 0] }],
      place: ([pose]) => [pose, ...fixed],
      overlap: 0.1,
      mode: 'drag',
    });
    expect(result.parts[0].position[1]).toBeCloseTo(0.05, 5);
    for (const part of distant) expect(part.geometry.boundsTree).toBeUndefined();
  }
});

it('reuses exterior clearance without changing contact results as parts approach and turn', () => {
  const geometry = new TorusGeometry(10, 3, 64, 64);
  const fixed = testPart('warm-fixed', geometry),
    freshFixed = { ...fixed, id: 'fresh-fixed' };
  let warm = [fixed, testPart('warm-moving', geometry, 26.4)];
  let cold = [freshFixed, { ...warm[1], id: 'fresh-moving' }];
  for (let step = 0; step < 35; step++) {
    const position: Part['position'] = [26.4 - step * 0.04, step * 0.01, 0];
    const turn = step * 0.001;
    const quaternion: Part['quaternion'] = [0, 0, Math.sin(turn / 2), Math.cos(turn / 2)];
    const move = (parts: Part[], id: string) =>
      placeClear({
        parts,
        joints: [],
        ids: [id],
        target: [{ ...parts[1], position, quaternion }],
        place: ([pose]) => [parts[0], pose],
        overlap: 0.1,
        mode: 'drag',
      }).parts;
    warm = move(warm, 'warm-moving');
    // A new id forces an independent sample cache, with the same starting pose and geometry.
    cold = [freshFixed, { ...cold[1], id: `fresh-${step}` }];
    cold = move(cold, `fresh-${step}`);
    warm[1].position.forEach((value, i) => expect(value).toBeCloseTo(cold[1].position[i], 6));
  }
});

it('invalidates cached bounds when transforms or geometry change', () => {
  const wall = testPart('changing'),
    moving = testPart('mover', undefined, 30);
  const place = (x: number) =>
    placeClear({
      parts: [wall, moving],
      joints: [],
      ids: [moving.id],
      target: [{ ...moving, position: [x, 0, 0] }],
      place: ([pose]) => [wall, pose],
      overlap: 0.1,
      mode: 'fit',
    }).parts[1];
  expect(place(20).position[0]).toBe(20);
  wall.position[0] = 15;
  expect(place(20).position[0]).toBeCloseTo(24.9, 2);
  wall.geometry = new BoxGeometry(20, 10, 10);
  const actual = place(20);
  const freshWall = { ...wall, id: 'fresh-wall' };
  const expected = placeClear({
    parts: [freshWall, moving],
    joints: [],
    ids: [moving.id],
    target: [{ ...moving, position: [20, 0, 0] }],
    place: ([pose]) => [freshWall, pose],
    overlap: 0.1,
    mode: 'fit',
  }).parts[1];
  actual.position.forEach((value, i) => expect(value).toBeCloseTo(expected.position[i], 6));
});

it('shares the VR display budget across visible scans without affecting desktop detail', () => {
  const scan = new BoxGeometry(10, 10, 10, 100, 100, 100);
  const parts = Array.from({ length: 12 }, (_, i) => testPart(`${i}`, scan));
  expect(displayTarget(parts, true)).toBe(25_000);
  expect(displayTarget(parts, false)).toBe(50_000);
  expect(
    displayTarget(
      parts.map((part, i) => ({ ...part, visible: i < 2 })),
      true,
    ),
  ).toBe(50_000);
  expect(
    displayTarget([...parts, testPart('medium', new BoxGeometry(10, 10, 10, 64, 64, 64))], true),
  ).toBe(12_500);
});

it('rechecks an already-arrived gesture against its original clearance on release', () => {
  const original = useEditor.getState();
  try {
    const geometry = new BoxGeometry(10, 10, 10);
    const part: Part = {
      id: 'a',
      name: 'Scan',
      geometry,
      position: [0, 0, 0],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
      color: '#fff',
      visible: true,
      locked: false,
      source: 'test',
    };
    const baseline: Part[] = [part, { ...part, id: 'b', position: [12, 0, 0] }];
    // Reproduce overlap that a coarse sample set could miss, with the pointer already there.
    const arrived: Part = { ...baseline[1], position: [9, 0, 0] };
    useEditor.getState().setScene({ name: 'Release', parts: [part, arrived], joints: [] });
    useEditor.getState().setView({ clip: { enabled: true, overlap: 0.1 } });
    useEditor
      .getState()
      .transformMany(
        [{ id: 'b', patch: { position: arrived.position } }],
        false,
        true,
        true,
        undefined,
        baseline,
      );
    expect(clippingDepth(useEditor.getState().scene.parts, ['b'])).toBeLessThanOrEqual(0.105);
    expect(useEditor.getState().scene.parts[1].position[0]).toBeCloseTo(9.9, 2);
  } finally {
    useEditor.setState(original);
  }
});
