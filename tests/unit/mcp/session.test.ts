import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { openAsBlob } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Euler, Quaternion, Vector3 } from 'three';
import { unzipSync } from 'fflate';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Session, requirePart, surfacePoint } from '../../../mcp/session';
import { worldBounds } from '../../../mcp/measure';
import { readSceneFile } from '../../../src/core/scene-file';
import { useEditor } from '../../../src/core/store';
import { partMatrix } from '../../../src/core/geometry';
import { solidVolume } from '../../../src/core/inspection';
import type { Part } from '../../../src/core/types';

let folder: string;
let session: Session;

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), 'kitbasher-mcp-'));
});
afterAll(() => rm(folder, { recursive: true, force: true }));
beforeEach(() => {
  session = new Session();
});

const box = (id: string, size = [10, 10, 10], position = [0, 0, 0]) => ({
  id,
  name: id,
  position,
  shapes: [{ type: 'box' as const, size }],
});
const part = (id: string) => requirePart(id);
const pos = (id: string) => part(id).position;
const min = (id: string) => worldBounds(part(id)).min.toArray();
const max = (id: string) => worldBounds(part(id)).max.toArray();
const expectVector = (actual: number[], expected: number[], digits = 5) =>
  expected.forEach((value, i) => expect(actual[i]).toBeCloseTo(value, digits));
const worldVolume = (p: Part) => {
  const geometry = p.geometry.clone().applyMatrix4(partMatrix(p));
  return solidVolume(geometry);
};

describe('building', () => {
  it('starts empty, without the sample', () => {
    expect(session.summary().part_count).toBe(0);
    expect(session.summary().unsaved).toBe(false);
  });

  it('makes readable, unique ids from names', () => {
    const { added } = session.addParts([
      { name: 'Left Arm!', shapes: [{ type: 'box', size: [1, 1, 1] }] },
      { name: 'Left Arm!', shapes: [{ type: 'box', size: [1, 1, 1] }] },
      { name: '日本語', shapes: [{ type: 'box', size: [1, 1, 1] }] },
      { name: 'plane xz', shapes: [{ type: 'box', size: [1, 1, 1] }] },
    ]);
    expect(added.map((p) => p.id)).toEqual(['left-arm', 'left-arm-2', 'part', 'plane-xz-2']);
  });

  it('refuses a requested id that is taken, changing nothing', () => {
    session.addParts([box('a')]);
    expect(() => session.addParts([box('b'), box('a')])).toThrow(/already in use/);
    expect(session.summary().part_count).toBe(1);
  });

  it('names the part whose shape was invalid', () => {
    expect(() => session.addParts([{ name: 'Wheel', shapes: [{ type: 'cylinder' }] }])).toThrow(
      /Part "Wheel": cylinder/,
    );
  });

  it('reports exact bounds for a rotated part, not a loose box', () => {
    const [added] = session.addParts([
      {
        name: 'r',
        shapes: [{ type: 'box', size: [10, 10, 10] }],
        rotation: [0, 0, 45],
      },
    ]).added;
    const half = Math.SQRT2 * 5;
    expect(added.bounds.max[0]).toBeCloseTo(half, 3);
    expect(added.bounds.max[2]).toBeCloseTo(5, 3);
    expect(added.rotation![2]).toBeCloseTo(45, 3);
  });
});

describe('history and atomic calls', () => {
  it('makes one undo step of a whole call', () => {
    session.addParts([box('a'), box('b')]);
    session.updateParts([
      { id: 'a', translate: [1, 0, 0] },
      { id: 'b', translate: [2, 0, 0] },
    ]);
    expect(session.summary().can_undo).toBe(2);
    session.undo();
    expect(pos('a')).toEqual([0, 0, 0]);
    expect(pos('b')).toEqual([0, 0, 0]);
    session.redo();
    expect(pos('a')).toEqual([1, 0, 0]);
    expect(pos('b')).toEqual([2, 0, 0]);
  });

  it('applies nothing when any part of a call fails', () => {
    session.addParts([box('a')]);
    const before = session.summary().can_undo;
    expect(() =>
      session.updateParts([
        { id: 'a', translate: [5, 0, 0] },
        { id: 'missing', translate: [1, 0, 0] },
      ]),
    ).toThrow(/no part "missing"/);
    expect(pos('a')).toEqual([0, 0, 0]);
    expect(session.summary().can_undo).toBe(before);
  });

  it('lists known parts when one is not found', () => {
    session.addParts([box('a'), box('b')]);
    expect(() => requirePart('c')).toThrow(/Parts: a, b/);
  });

  it('finds a part by a unique name as well as its id', () => {
    session.addParts([{ id: 'x', name: 'Named', shapes: [{ type: 'box', size: [1, 1, 1] }] }]);
    expect(requirePart('Named').id).toBe('x');
  });

  it('reports when there is nothing to undo or redo', () => {
    expect(() => session.undo()).toThrow(/nothing to undo/);
    expect(() => session.redo()).toThrow(/nothing to redo/);
  });

  it('keeps redo after a failed call', () => {
    session.addParts([box('a')]);
    session.updateParts([{ id: 'a', translate: [1, 0, 0] }]);
    session.undo();
    expect(() => session.updateParts([{ id: 'nope', translate: [1, 0, 0] }])).toThrow();
    expect(session.summary().can_redo).toBe(1);
  });
});

describe('transforms', () => {
  it('sets absolute position, rotation, and scale', () => {
    session.addParts([box('a')]);
    session.updateParts([{ id: 'a', position: [1, 2, 3] }]);
    expect(pos('a')).toEqual([1, 2, 3]);
    session.updateParts([{ id: 'a', scale: [2, 1, 1] }]);
    expectVector(max('a'), [11, 7, 8]);
  });

  it('rotates around the visual center of an off-center mesh', () => {
    session.addParts([
      { name: 'off', shapes: [{ type: 'box', size: [10, 10, 10], position: [100, 0, 0] }] },
    ]);
    const before = worldBounds(part('off')).getCenter(new Vector3());
    session.updateParts([{ id: 'off', rotation: [0, 90, 0] }]);
    expectVector(worldBounds(part('off')).getCenter(new Vector3()).toArray(), before.toArray(), 3);
  });

  it('turns around a given world point', () => {
    session.addParts([box('a', [2, 2, 2], [10, 0, 0])]);
    session.updateParts([
      { id: 'a', rotate_by: { axis: [0, 1, 0], degrees: 90, about: [0, 0, 0] } },
    ]);
    expectVector(pos('a'), [0, 0, -10]);
  });

  it('refuses a move of a locked part, but unlocks and moves in one call', () => {
    session.addParts([{ ...box('a'), locked: true }]);
    expect(() => session.updateParts([{ id: 'a', translate: [1, 0, 0] }])).toThrow(/locked/);
    session.updateParts([{ id: 'a', locked: false, translate: [1, 0, 0] }]);
    expect(pos('a')).toEqual([1, 0, 0]);
  });

  it('moves and then locks in one call', () => {
    session.addParts([box('a')]);
    const [result] = session.updateParts([{ id: 'a', translate: [1, 0, 0], locked: true }]).updated;
    expect(pos('a')).toEqual([1, 0, 0]);
    expect(part('a').locked).toBe(true);
    expect(result.locked).toBe(true);
  });

  it('refuses a collapsed scale, which could never be reopened', () => {
    session.addParts([box('a')]);
    expect(() => session.updateParts([{ id: 'a', scale: [1, 0, 1] }])).toThrow(/zero/);
  });

  it('refuses contradictory requests', () => {
    session.addParts([box('a')]);
    expect(() =>
      session.updateParts([{ id: 'a', position: [0, 0, 0], translate: [1, 0, 0] }]),
    ).toThrow(/not both/);
    expect(() =>
      session.updateParts([{ id: 'a', rotation: [0, 0, 0], quaternion: [0, 0, 0, 1] }]),
    ).toThrow(/not both/);
  });

  it('renames, recolors, and hides', () => {
    session.addParts([box('a')]);
    session.updateParts([{ id: 'a', name: 'Renamed', color: 'red', visible: false }]);
    const p = part('a');
    expect([p.name, p.color, p.visible]).toEqual(['Renamed', '#ff0000', false]);
  });

  it('sets and clears a pivot', () => {
    session.addParts([box('a')]);
    session.updateParts([{ id: 'a', pivot: [5, 5, 5] }]);
    expect(part('a').pivot).toEqual([5, 5, 5]);
    session.updateParts([{ id: 'a', pivot: null }]);
    expect(part('a').pivot).toBeUndefined();
  });
});

describe('placing by bounds', () => {
  it('rests a part on another, centered on the other axes', () => {
    session.addParts([
      box('base', [100, 10, 100], [5, 5, 7]),
      box('top', [10, 20, 10], [50, 90, 50]),
    ]);
    session.placeParts([{ id: 'top', target: 'base', side: '+y' }]);
    expectVector(min('top'), [0, 10, 2]);
    expectVector(max('top'), [10, 30, 12]);
  });

  it('honors gap, side, flush alignment, and a final offset', () => {
    session.addParts([box('base', [100, 10, 100]), box('p', [10, 10, 10], [3, 3, 3])]);
    session.placeParts([
      {
        id: 'p',
        target: 'base',
        side: '+x',
        gap: 2,
        align: { y: 'min', z: 'max' },
        offset: [0, 1, 0],
      },
    ]);
    expectVector(min('p'), [52, -4, 40]);
  });

  it('can embed with a negative gap, and hang below a part', () => {
    session.addParts([box('base'), box('p')]);
    session.placeParts([{ id: 'p', target: 'base', side: '-y', gap: -1 }]);
    expectVector(max('p'), [5, -4, 5]);
  });

  it('rests on the ground by default and keeps x and z', () => {
    session.addParts([box('p', [10, 10, 10], [33, 77, 44])]);
    session.placeParts([{ id: 'p' }]);
    expectVector(min('p'), [28, 0, 39]);
  });

  it('uses the exact bounds of a rotated part', () => {
    session.addParts([{ ...box('p'), rotation: [0, 0, 45] }]);
    session.placeParts([{ id: 'p' }]);
    expect(worldBounds(part('p')).min.y).toBeCloseTo(0, 4);
    expect(pos('p')[1]).toBeCloseTo(Math.SQRT2 * 5, 4);
  });

  it('later placements see earlier ones in the same call', () => {
    session.addParts([box('a'), box('b'), box('c')]);
    session.placeParts([
      { id: 'b', target: 'a', side: '+y' },
      { id: 'c', target: 'b', side: '+y' },
    ]);
    expectVector(min('c'), [-5, 15, -5]);
  });
});

describe('duplicating', () => {
  it('makes linear arrays that share one mesh', () => {
    session.addParts([box('a')]);
    const { added } = session.duplicateParts({ ids: ['a'], count: 3, translate: [20, 0, 0] });
    expect(added.map((p) => p.position[0])).toEqual([20, 40, 60]);
    expect(part(added[2].id).geometry).toBe(part('a').geometry);
  });

  it('makes radial arrays', () => {
    session.addParts([box('a', [2, 2, 2], [10, 0, 0])]);
    const { added } = session.duplicateParts({
      ids: ['a'],
      count: 3,
      rotate: { axis: [0, 1, 0], degrees: 90 },
    });
    expectVector(added[0].position, [0, 0, -10], 3);
    expectVector(added[1].position, [-10, 0, 0], 3);
    expectVector(added[2].position, [0, 0, 10], 3);
  });

  it('mirrors geometry exactly across a world plane', () => {
    session.addParts([
      {
        name: 'wing',
        position: [30, 5, 2],
        rotation: [10, 20, 30],
        scale: [1, 2, 1],
        shapes: [{ type: 'box', size: [40, 4, 10], position: [20, 0, 0] }],
      },
    ]);
    const [copy] = session.duplicateParts({
      ids: ['wing'],
      mirror: { axis: 'x', at: 5 },
      names: ['Wing mirrored'],
    }).added;
    expect(copy.id).toBe('wing-mirrored');
    const source = part('wing');
    const mirrored = part(copy.id);
    const position = source.geometry.getAttribute('position');
    for (let i = 0; i < position.count; i += 17) {
      const local = new Vector3().fromBufferAttribute(position, i);
      const a = local.clone().applyMatrix4(partMatrix(source));
      const b = local.clone().applyMatrix4(partMatrix(mirrored));
      expectVector(b.toArray(), [10 - a.x, a.y, a.z], 3);
    }
    expect(mirrored.scale[0] * mirrored.scale[1] * mirrored.scale[2]).toBeLessThan(0);
  });

  it('copies joints among the copied parts, still connected', () => {
    session.addParts([box('body'), box('head', [4, 4, 4], [0, 20, 0])]);
    session.createJoint({
      child: 'head',
      parent: 'body',
      child_anchor: { face: '-y' },
      parent_anchor: { face: '+y' },
    });
    const { added } = session.duplicateParts({
      ids: ['body', 'head'],
      mirror: { axis: 'x', at: 50 },
    });
    const { joints } = session.summary();
    expect(joints).toHaveLength(2);
    const copyJoint = joints[1];
    expect(added.map((p) => p.id)).toContain(copyJoint.child);
    expect(copyJoint.anchor_gap).toBeCloseTo(0, 5);
    // The copy keeps working: moving its parent carries it.
    const child = pos(copyJoint.child);
    session.updateParts([{ id: copyJoint.parent, translate: [0, 7, 0] }]);
    expect(pos(copyJoint.child)[1]).toBeCloseTo(child[1] + 7, 4);
  });

  it('leaves out joints to parts that were not copied', () => {
    session.addParts([box('body'), box('head', [4, 4, 4], [0, 20, 0])]);
    session.createJoint({
      child: 'head',
      parent: 'body',
      child_anchor: { face: '-y' },
      parent_anchor: { face: '+y' },
    });
    session.duplicateParts({ ids: ['head'], translate: [50, 0, 0] });
    expect(session.summary().joints).toHaveLength(1);
  });

  it('moves anchor targets with their copies', () => {
    session.addParts([box('a')]);
    session.fitAnchors('a', [{ point: { local: [0, 0, 0] }, target: [1, 2, 3] }]);
    const [copy] = session.duplicateParts({ ids: ['a'], translate: [10, 0, 0] }).added;
    expectVector(part(copy.id).anchors![0].target, [11, 2, 3]);
  });

  it('checks its options', () => {
    session.addParts([box('a')]);
    expect(() => session.duplicateParts({ ids: [] })).toThrow(/at least one/);
    expect(() => session.duplicateParts({ ids: ['a'], count: 0 })).toThrow(/count/);
    expect(() => session.duplicateParts({ ids: ['a'], count: 2, mirror: { axis: 'x' } })).toThrow(
      /mirror/,
    );
  });
});

describe('deleting', () => {
  it('removes joints that used the part, and undoes', () => {
    session.addParts([box('a'), box('b', [2, 2, 2], [0, 20, 0])]);
    session.createJoint({
      child: 'b',
      parent: 'a',
      child_anchor: { face: '-y' },
      parent_anchor: { face: '+y' },
    });
    const result = session.deleteParts(['a']);
    expect(result.removed_joints).toBe(1);
    expect(session.summary().part_count).toBe(1);
    session.undo();
    expect(session.summary().part_count).toBe(2);
    expect(session.summary().joints).toHaveLength(1);
  });

  it('refuses a locked part', () => {
    session.addParts([{ ...box('a'), locked: true }]);
    expect(() => session.deleteParts(['a'])).toThrow(/locked/);
  });
});

describe('merging', () => {
  it('combines every triangle, at the same world position', () => {
    session.addParts([box('a'), box('b', [10, 10, 10], [50, 0, 0])]);
    const { part: merged, removed } = session.mergeParts(['a', 'b'], 'combine', 'Both');
    expect(removed).toEqual(['a', 'b']);
    expect(merged.triangles).toBe(24);
    expectVector(merged.bounds.min, [-5, -5, -5]);
    expectVector(merged.bounds.max, [55, 5, 5]);
    expect(session.summary().part_count).toBe(1);
  });

  it('unions overlapping solids to the true volume', () => {
    session.addParts([box('a'), box('b', [10, 10, 10], [5, 0, 0])]);
    const { part: merged } = session.mergeParts(['a', 'b'], 'union', 'U');
    expect(worldVolume(requirePart(merged.id))).toBeCloseTo(1500, 2);
  });

  it('subtracts the rest from the first part', () => {
    session.addParts([
      box('plate', [40, 10, 40]),
      { name: 'cut', shapes: [{ type: 'cylinder', radius: 5, height: 30, segments: 64 }] },
    ]);
    const { part: merged } = session.mergeParts(['plate', 'cut'], 'subtract', 'Drilled plate');
    const hole = (64 / 2) * 25 * Math.sin((2 * Math.PI) / 64) * 10;
    expect(worldVolume(requirePart(merged.id))).toBeCloseTo(16000 - hole, 1);
    expect(merged.id).toBe('drilled-plate');
  });

  it('intersects, and explains an empty result without losing anything', () => {
    session.addParts([
      box('a'),
      box('b', [10, 10, 10], [5, 0, 0]),
      box('far', [1, 1, 1], [99, 0, 0]),
    ]);
    expect(() => session.mergeParts(['a', 'far'], 'intersect')).toThrow(/do not overlap/);
    expect(session.summary().part_count).toBe(3);
    const { part: merged } = session.mergeParts(['a', 'b'], 'intersect', 'I');
    expect(worldVolume(requirePart(merged.id))).toBeCloseTo(500, 2);
  });

  it('keeps the inputs when asked, even locked ones', () => {
    session.addParts([{ ...box('a'), locked: true }, box('b', [10, 10, 10], [5, 0, 0])]);
    session.mergeParts(['a', 'b'], 'union', 'U', true);
    expect(session.summary().part_count).toBe(3);
  });

  it('keeps colors through a Boolean', () => {
    session.addParts([{ ...box('a'), color: '#ff0000' }, box('b', [10, 10, 10], [5, 0, 0])]);
    const { part: merged } = session.mergeParts(['a', 'b'], 'union', 'U');
    expect(requirePart(merged.id).geometry.getAttribute('color')).toBeDefined();
    expect(requirePart(merged.id).color).toBe('#ffffff');
  });

  it('applies part transforms, including mirrors, in a Boolean', () => {
    session.addParts([box('a'), { ...box('b'), position: [5, 0, 0], scale: [-1, 1, 1] }]);
    const { part: merged } = session.mergeParts(['a', 'b'], 'union', 'U');
    expect(worldVolume(requirePart(merged.id))).toBeCloseTo(1500, 2);
  });

  it('refuses an open mesh for a Boolean and locked inputs for a replacement', () => {
    session.addParts([
      {
        name: 'open',
        shapes: [{ type: 'mesh', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0] }],
      },
      box('b'),
      { ...box('c'), locked: true },
    ]);
    expect(() => session.mergeParts(['open', 'b'], 'union')).toThrow(/open or non-manifold/);
    expect(() => session.mergeParts(['b', 'c'], 'combine')).toThrow(/locked/);
    expect(() => session.mergeParts(['b'], 'combine')).toThrow(/at least two/);
  });
});

describe('alignment', () => {
  it('moves a point onto a point', () => {
    session.addParts([box('a'), box('b', [10, 10, 10], [40, 3, 2])]);
    const result = session.alignParts({
      source: 'b',
      target: 'a',
      method: 'point',
      pairs: [{ source: { face: '-x' }, target: { face: '+x' } }],
    });
    expectVector(pos('b'), [10, 0, 0]);
    expect(result.rms_mm).toBe(0);
  });

  it('seats opposing faces with an offset along the target normal', () => {
    session.addParts([box('a'), { ...box('b'), position: [40, 3, 2], rotation: [0, 90, 0] }]);
    session.alignParts({
      source: 'b',
      target: 'a',
      method: 'plane',
      pairs: [{ source: { world: [40, -2, 2], normal: [0, -1, 0] }, target: { face: '+y' } }],
      offset: 1,
    });
    const placed = worldBounds(part('b'));
    expect(placed.min.y).toBeCloseTo(6, 4);
  });

  it('slides only along the target normal for point to plane', () => {
    session.addParts([box('a'), box('b', [2, 2, 2], [40, 30, 2])]);
    session.alignParts({
      source: 'b',
      target: 'a',
      method: 'point_to_plane',
      pairs: [{ source: { face: '-y' }, target: { face: '+y' } }],
    });
    expectVector(pos('b'), [40, 6, 2]);
  });

  it('registers three or more point pairs, and reports the residual', () => {
    const rotation = new Quaternion().setFromEuler(new Euler(0.2, 0.5, -0.3));
    const worldOf = (local: number[]) =>
      new Vector3(...(local as [number, number, number]))
        .applyQuaternion(rotation)
        .add(new Vector3(30, 4, -2))
        .toArray();
    session.addParts([
      box('fixed'),
      {
        id: 'moving',
        name: 'moving',
        position: [30, 4, -2],
        shapes: [{ type: 'box', size: [10, 10, 10] }],
      },
    ]);
    session.updateParts([{ id: 'moving', quaternion: rotation.toArray() }]);
    const locals = [
      [5, 5, 5],
      [-5, 5, 5],
      [5, -5, 5],
      [5, 5, -5],
    ];
    const result = session.alignParts({
      source: 'moving',
      target: 'fixed',
      method: 'points',
      pairs: locals.map((local) => ({
        source: { world: worldOf(local) },
        target: { local },
      })),
    });
    expectVector(pos('moving'), [0, 0, 0], 4);
    expect(result.rms_mm).toBeCloseTo(0, 3);
  });

  it('aligns to a reference plane', () => {
    session.addParts([box('a', [10, 10, 10], [3, 50, 4])]);
    session.alignParts({
      source: 'a',
      target: 'plane-xz',
      method: 'point_to_plane',
      pairs: [{ source: { face: '-y' }, target: { world: [0, 0, 0], normal: [0, 1, 0] } }],
    });
    expect(min('a')[1]).toBeCloseTo(0, 5);
  });

  it('holds the anchor of a joint, and says it was constrained', () => {
    session.addParts([
      box('parent'),
      box('child', [4, 4, 4], [0, 10, 0]),
      box('goal', [2, 2, 2], [40, 0, 0]),
    ]);
    session.createJoint({
      child: 'child',
      parent: 'parent',
      child_anchor: { face: '-y' },
      parent_anchor: { face: '+y' },
    });
    session.updateParts([{ id: 'parent', locked: true }]);
    const result = session.alignParts({
      source: 'child',
      target: 'goal',
      method: 'point',
      pairs: [{ source: { face: 'center' }, target: { face: 'center' } }],
    });
    expect(result.constrained).toBe(true);
    expect(session.summary().joints[0].anchor_gap).toBeCloseTo(0, 5);
  });

  it('needs a single pair for single-pair methods, and points to be spread', () => {
    session.addParts([box('a'), box('b')]);
    const pair = { source: { face: '+x' as const }, target: { face: '-x' as const } };
    expect(() =>
      session.alignParts({ source: 'a', target: 'b', method: 'point', pairs: [pair, pair] }),
    ).toThrow(/exactly one/);
    expect(() =>
      session.alignParts({ source: 'a', target: 'b', method: 'points', pairs: [pair] }),
    ).toThrow(/three/);
  });

  it('checks a point reference has one location', () => {
    session.addParts([box('a')]);
    expect(() => surfacePoint(part('a'), {})).toThrow(/exactly one/);
    expect(() => surfacePoint(part('a'), { face: '+x', local: [0, 0, 0] })).toThrow(/exactly one/);
  });

  it('turns a world point and normal into local ones on a transformed part', () => {
    session.addParts([{ ...box('a'), position: [10, 0, 0], rotation: [0, 90, 0] }]);
    const point = surfacePoint(part('a'), { world: [15, 0, 0], normal: [1, 0, 0] });
    expectVector(point.point, [0, 0, 5]);
    expectVector(point.normal, [0, 0, 1]);
  });

  it('reads the normal from the nearest surface when none is given', () => {
    session.addParts([box('a')]);
    expectVector(surfacePoint(part('a'), { local: [5, 1, 1] }).normal, [1, 0, 0]);
  });
});

describe('surface fitting', () => {
  const plate = (id: string, y: number, x = 0, z = 0) => ({
    id,
    name: id,
    position: [x, y, z],
    shapes: [{ type: 'box' as const, size: [40, 4, 40] }],
  });

  it('fits contact patches onto matching surfaces in different directions', () => {
    const scan = (id: string, position: number[]) => ({
      id,
      name: id,
      position,
      shapes: [{ type: 'box' as const, size: [40, 40, 40], segments: 2 }],
    });
    session.addParts([
      scan('fixed', [0, 0, 0]),
      { ...scan('moving', [0.4, -0.3, 0.2]), rotation: [1, -1, 0.5] },
    ]);
    const patch = (point: number[]) => ({ point, radius: 15 });
    const result = session.fitSurfaces({
      source: 'moving',
      target: 'fixed',
      method: 'contact',
      opposed: false,
      pairs: [
        { source: patch([20, 0, 0]), target: patch([20, 0, 0]) },
        { source: patch([0, 20, 0]), target: patch([0, 20, 0]) },
        { source: patch([0, 0, 20]), target: patch([0, 0, 20]) },
      ],
    });
    expect(result.rms_mm).toBeLessThan(0.05);
    expectVector(pos('moving'), [0, 0, 0], 1);
    expect(result.patch_triangles[0][0]).toBeGreaterThan(0);
  });

  it('applies and retains a mate from patches', () => {
    session.addParts([plate('fixed', 0), plate('moving', 30, 5, 5)]);
    const result = session.fitSurfaces({
      source: 'moving',
      target: 'fixed',
      method: 'mate',
      offset: 1,
      keep_constraint: true,
      pairs: [
        { source: { point: [5, 28, 5], radius: 10 }, target: { point: [0, 2, 0], radius: 10 } },
      ],
    });
    expect(result.plane_constraints_added).toHaveLength(1);
    expect(min('moving')[1]).toBeCloseTo(3, 4);
    // It stays in force through later moves of the target.
    session.updateParts([{ id: 'fixed', translate: [0, 10, 0] }]);
    expect(min('moving')[1]).toBeCloseTo(13, 3);
  });

  it('gives each retained constraint its own id', () => {
    session.addParts([plate('fixed', 0), plate('moving', 30)]);
    const target = { point: [0, 2, 0], radius: 10 };
    const args = { source: 'moving', target: 'fixed', keep_constraint: true };
    const first = session.fitSurfaces({
      ...args,
      method: 'mate',
      pairs: [{ source: { point: [0, 28, 0], radius: 10 }, target }],
    });
    // The first fit seated the moving part's lower face on the target.
    const second = session.fitSurfaces({
      ...args,
      method: 'parallel',
      pairs: [{ source: { point: [0, 2, 0], radius: 10 }, target }],
    });
    expect(first.plane_constraints_added![0]).not.toBe(second.plane_constraints_added![0]);
    expect(session.summary().plane_constraints).toHaveLength(2);
  });

  it('levels a part flush with its neighbors across a seam', () => {
    session.addParts([plate('left', 0, -21), plate('moving', 0.6, 21)]);
    const result = session.fitSurfaces({
      source: 'moving',
      target: 'left',
      method: 'flush',
      pairs: [
        {
          source: { point: [4, 2.6, 0], radius: 3 },
          target: { point: [-4, 2, 0], radius: 3 },
        },
      ],
    });
    expect(result.rms_mm).toBeLessThan(0.05);
    expect(max('moving')[1]).toBeCloseTo(2, 2);
    // Only its height changed: free sideways spacing is preserved.
    expect(pos('moving')[0]).toBeCloseTo(21, 2);
  });

  it('explains an unusable request', () => {
    session.addParts([plate('fixed', 0), plate('moving', 30)]);
    const patch = { point: [0, 2, 0], radius: 5 };
    expect(() =>
      session.fitSurfaces({
        source: 'moving',
        target: 'fixed',
        method: 'contact',
        pairs: [{ source: patch, target: patch }],
      }),
    ).toThrow(/three/);
    expect(() =>
      session.fitSurfaces({
        source: 'moving',
        method: 'mate',
        pairs: [{ source: patch, target: patch }],
      }),
    ).toThrow(/needs a part/);
  });
});

describe('anchors', () => {
  it('fits by best match and keeps the anchors with the part', () => {
    session.addParts([box('a')]);
    const { gaps_mm } = session.fitAnchors('a', [
      { point: { local: [5, 0, 0] }, target: [25, 0, 0] },
      { point: { local: [-5, 0, 0] }, target: [15, 0, 0] },
    ]);
    expectVector(pos('a'), [20, 0, 0]);
    expect(gaps_mm).toEqual([0, 0]);
    expect(part('a').anchors).toHaveLength(2);
  });

  it('leaves a gap rather than stretching when targets conflict', () => {
    session.addParts([box('a')]);
    const { gaps_mm } = session.fitAnchors('a', [
      { point: { local: [5, 0, 0] }, target: [20, 0, 0] },
      { point: { local: [-5, 0, 0] }, target: [-20, 0, 0] },
    ]);
    expect(gaps_mm[0]).toBeCloseTo(15, 3);
    expect(part('a').scale).toEqual([1, 1, 1]);
  });
});

describe('joints', () => {
  const pair = () => {
    session.addParts([box('body'), box('arm', [4, 20, 4], [30, 0, 0])]);
    return session.createJoint({
      child: 'arm',
      parent: 'body',
      child_anchor: { face: '+y' },
      parent_anchor: { face: '+x' },
      rotation_locks: [true, true, false],
      name: 'Shoulder',
    });
  };

  it('seats the child at the anchor with a readable id', () => {
    const { joint } = pair();
    expect(joint.id).toBe('shoulder');
    expectVector(pos('arm'), [5, -10, 0]);
    expect(session.summary().joints[0].anchor_gap).toBeCloseTo(0, 6);
  });

  it('rotates around the anchor on a free axis, and ignores a locked one', () => {
    pair();
    session.updateParts([{ id: 'arm', rotate_by: { axis: [0, 0, 1], degrees: 90 } }]);
    expect(session.summary().joints[0].anchor_gap).toBeCloseTo(0, 5);
    expectVector(pos('arm'), [15, 0, 0], 4);
    const [result] = session.updateParts([
      { id: 'arm', rotate_by: { axis: [1, 0, 0], degrees: 40 } },
    ]).updated;
    expect(result.constrained).toBe(true);
    expect(session.summary().joints[0].anchor_gap).toBeCloseTo(0, 5);
  });

  it('carries the child when the parent moves', () => {
    pair();
    session.updateParts([{ id: 'body', translate: [0, 50, 0] }]);
    expectVector(pos('arm'), [5, 40, 0]);
  });

  it('frees the child when keep_connected is off, and reseats it when back on', () => {
    pair();
    session.updateJoint('shoulder', { keep_connected: false });
    session.updateParts([{ id: 'arm', position: [80, 0, 0] }]);
    expectVector(pos('arm'), [80, 0, 0]);
    session.updateJoint('shoulder', { keep_connected: true });
    expect(session.summary().joints[0].anchor_gap).toBeCloseTo(0, 5);
  });

  it('refuses a second parent and a cycle, without changing the scene', () => {
    pair();
    session.addParts([box('other', [2, 2, 2], [0, 40, 0])]);
    const args = {
      child_anchor: { face: 'center' as const },
      parent_anchor: { face: 'center' as const },
    };
    expect(() => session.createJoint({ ...args, child: 'arm', parent: 'other' })).toThrow(
      /already has a parent/,
    );
    expect(() => session.createJoint({ ...args, child: 'body', parent: 'arm' })).toThrow(
      /circular/,
    );
    expect(session.summary().joints).toHaveLength(1);
  });

  it('reports a child held by a locked parent chain', () => {
    pair();
    session.updateParts([{ id: 'body', locked: true }]);
    session.updateJoint('shoulder', { keep_connected: false });
    session.updateParts([{ id: 'arm', position: [90, 0, 0] }]);
    session.updateParts([{ id: 'arm', locked: true }]);
    expect(() => session.updateJoint('shoulder', { keep_connected: true })).toThrow(/Unlock/);
  });

  it('removes a joint without moving anything', () => {
    pair();
    const before = pos('arm');
    session.removeRelationships(['shoulder']);
    expect(session.summary().joints).toHaveLength(0);
    expect(pos('arm')).toEqual(before);
    expect(() => session.removeRelationships(['shoulder'])).toThrow(/no joint/);
    expect(() => session.updateJoint('shoulder', {})).toThrow(/no joint/);
  });
});

describe('plane constraints', () => {
  const setup = () => {
    session.addParts([box('base', [40, 4, 40]), box('block', [10, 10, 10], [3, 40, 3])]);
    return session.createPlaneConstraint({
      source: 'block',
      target: 'base',
      kind: 'mate',
      source_plane: { face: '-y' },
      target_plane: { face: '+y' },
      offset: 2,
      name: 'Seat',
    });
  };

  it('seats at the offset and reports no residual', () => {
    const result = setup();
    expect(result.constraint).toBe('seat');
    expect(min('block')[1]).toBeCloseTo(4, 4);
    expect(result.residual_mm).toBe(0);
    expect(result.residual_degrees).toBe(0);
  });

  it('holds through later moves, while sliding stays free', () => {
    setup();
    session.updateParts([{ id: 'base', translate: [0, 20, 0] }]);
    expect(min('block')[1]).toBeCloseTo(24, 4);
    const [moved] = session.updateParts([{ id: 'block', translate: [5, 50, 0] }]).updated;
    expect(moved.constrained).toBe(true);
    expect(min('block')[1]).toBeCloseTo(24, 4);
    expect(pos('block')[0]).toBeCloseTo(8, 4);
  });

  it('can be edited, suppressed, and removed', () => {
    setup();
    session.updatePlaneConstraint('seat', { offset: 5 });
    expect(min('block')[1]).toBeCloseTo(7, 4);
    session.updatePlaneConstraint('seat', { enabled: false });
    session.updateParts([{ id: 'block', translate: [0, 40, 0] }]);
    expect(min('block')[1]).toBeCloseTo(47, 4);
    session.removeRelationships([], ['seat']);
    expect(session.summary().plane_constraints).toHaveLength(0);
  });

  it('refuses a circular dependency, without changing the scene', () => {
    setup();
    expect(() =>
      session.createPlaneConstraint({
        source: 'base',
        target: 'block',
        kind: 'parallel',
        source_plane: { face: '+y' },
        target_plane: { face: '-y' },
      }),
    ).toThrow(/circular/);
    expect(session.summary().plane_constraints).toHaveLength(1);
  });

  it('sets angles between planes', () => {
    session.addParts([box('a'), box('b', [10, 10, 10], [40, 0, 0])]);
    session.createPlaneConstraint({
      source: 'b',
      target: 'a',
      kind: 'perpendicular',
      source_plane: { face: '+y' },
      target_plane: { face: '+y' },
    });
    expect(session.summary().plane_constraints[0].residual_degrees).toBeCloseTo(0, 3);
  });

  it('reports an update to something missing', () => {
    expect(() => session.updatePlaneConstraint('nope', {})).toThrow(/no plane constraint/);
  });
});

describe('analysis', () => {
  it('measures overlap volume, touching, gaps, and isolated parts', () => {
    session.addParts([
      box('a'),
      box('overlapping', [10, 10, 10], [5, 0, 0]),
      box('touching', [10, 10, 10], [0, 10, 0]),
      box('near', [10, 10, 10], [0, 0, 10.3]),
      box('alone', [10, 10, 10], [500, 0, 0]),
    ]);
    const { pairs, isolated, checked_pairs, solid_pairs } = session.inspect(undefined, 0.5);
    expect(checked_pairs).toBe(10);
    expect(solid_pairs).toBe(10);
    const find = (a: string, b: string) => pairs.find((p) => p.a === a && p.b === b)!;
    expect(find('a', 'overlapping')).toMatchObject({ status: 'overlap', overlap_mm3: 500 });
    expect(find('a', 'touching').status).toBe('touching');
    expect(find('a', 'near').status).toBe('near');
    expect(find('a', 'near').gap_mm).toBeCloseTo(0.3, 4);
    expect(find('a', 'near').closest_points).toHaveLength(2);
    expect(find('a', 'touching').closest_points).toBeUndefined();
    expect(isolated).toEqual(['alone']);
  });

  it('warns about open meshes and limits parts', () => {
    session.addParts([
      { name: 'open', shapes: [{ type: 'mesh', positions: [0, 0, 0, 9, 0, 0, 0, 9, 0] }] },
      box('b'),
    ]);
    const { warnings, pairs } = session.inspect(['open', 'b'], 1);
    expect(warnings[0]).toMatch(/open or non-manifold/);
    expect(pairs[0].overlap_mm3).toBeNull();
    expect(() => session.inspect(['b'], 1)).toThrow(/at least two/);
  });

  it('skips hidden parts unless named', () => {
    session.addParts([
      box('a'),
      box('b', [10, 10, 10], [5, 0, 0]),
      { ...box('c'), visible: false },
    ]);
    expect(session.inspect(undefined, 1).checked_pairs).toBe(1);
    expect(session.inspect(['a', 'c'], 1).checked_pairs).toBe(1);
  });

  it('raycasts to exact world and local hits, nearest first', () => {
    session.addParts([box('near', [10, 10, 10], [0, 0, 20]), box('far')]);
    const { hits } = session.raycast([0, 0, 100], [0, 0, -2]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      part: 'near',
      world: [0, 0, 25],
      local: [0, 0, 5],
      distance: 75,
    });
    expect(hits[0].normal).toEqual([0, 0, 1]);
    const all = session.raycast([0, 0, 100], [0, 0, -1], undefined, true).hits;
    expect(all.map((hit) => hit.part)).toEqual(['near', 'near', 'far', 'far']);
    expect(session.raycast([0, 0, 100], [0, 1, 0]).hits).toEqual([]);
  });

  it('raycasts through scale and rotation', () => {
    session.addParts([{ ...box('a'), scale: [2, 1, 1], rotation: [0, 90, 0] }]);
    const [hit] = session.raycast([0, 0, 100], [0, 0, -1]).hits;
    expect(hit.world[2]).toBeCloseTo(10, 4);
    expect(hit.distance).toBeCloseTo(90, 4);
    expect(hit.normal[2]).toBeCloseTo(1, 4);
  });

  it('checks ray directions', () => {
    expect(() => session.raycast([0, 0, 0], [0, 0, 0])).toThrow(/zero/);
  });
});

describe('files', () => {
  it('saves a scene the app can read back, with everything intact', async () => {
    session.addParts([
      box('a'),
      {
        name: 'Mixed',
        position: [20, 0, 0],
        shapes: [
          { type: 'sphere', radius: 3, color: '#ff0000' },
          { type: 'cone', radius: 3, height: 6, position: [0, 6, 0], color: '#0000ff' },
        ],
      },
    ]);
    session.createJoint({
      child: 'mixed',
      parent: 'a',
      child_anchor: { local: [0, -3, 0] },
      parent_anchor: { face: '+x' },
    });
    session.createPlaneConstraint({
      source: 'mixed',
      target: 'a',
      kind: 'parallel',
      source_plane: { local: [0, 0, 0], normal: [0, 1, 0] },
      target_plane: { face: '+y' },
      opposed: false,
    });
    session.duplicateParts({ ids: ['a'], translate: [0, 30, 0] });
    const file = join(folder, 'full.kitbash');
    const saved = await session.saveScene(file);
    expect(saved.path).toBe(file);
    expect(session.summary().unsaved).toBe(false);
    const expected = useEditor.getState().scene;
    const scene = await readSceneFile(await openAsBlob(file));
    expect(scene.parts.map((p) => p.id)).toEqual(expected.parts.map((p) => p.id));
    expect(scene.parts.map((p) => p.position)).toEqual(expected.parts.map((p) => p.position));
    expect(scene.joints).toHaveLength(1);
    expect(scene.constraints).toHaveLength(1);
    expect(scene.parts[1].geometry.getAttribute('color')).toBeDefined();
    // Copies still share one mesh in the file.
    expect(scene.parts[0].geometry).toBe(scene.parts[2].geometry);
    expect((await readdir(folder)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('adds the extension, remembers the path, and guards other files', async () => {
    session.addParts([box('a')]);
    const base = join(folder, 'remembered');
    await session.saveScene(base);
    expect(session.path).toBe(`${base}.kitbash`);
    session.updateParts([{ id: 'a', translate: [1, 0, 0] }]);
    expect((await session.saveScene()).path).toBe(`${base}.kitbash`);
    const other = new Session();
    other.addParts([box('b')]);
    await expect(other.saveScene(base)).rejects.toThrow(/already exists/);
    await other.saveScene(base, true);
    await expect(new Session().saveScene()).rejects.toThrow(/no file yet/);
    await expect(new Session().saveScene(join(folder, 'bad.txt'))).rejects.toThrow(/\.kitbash/);
  });

  it('reopens a scene, keeps editing it, and saves to the same place', async () => {
    session.addParts([box('a')]);
    const file = join(folder, 'reopen.kitbash');
    await session.saveScene(file);
    const next = new Session();
    expect((await next.openScene(file)).part_count).toBe(1);
    expect(next.path).toBe(file);
    next.updateParts([{ id: 'a', translate: [9, 0, 0] }]);
    await next.saveScene();
    const scene = await readSceneFile(await openAsBlob(file));
    expect(scene.parts[0].position).toEqual([9, 0, 0]);
  });

  it('will not drop unsaved work unless told to', async () => {
    session.addParts([box('a')]);
    expect(() => session.newScene()).toThrow(/unsaved/);
    await expect(session.openScene(join(folder, 'reopen.kitbash'))).rejects.toThrow(/unsaved/);
    expect(session.summary().part_count).toBe(1);
    session.newScene('Fresh', false, true);
    expect(session.summary()).toMatchObject({ name: 'Fresh', part_count: 0, path: null });
  });

  it('loads the sample', () => {
    expect(session.newScene(undefined, true).part_count).toBe(15);
  });

  it('checks scene files it is asked to open', async () => {
    await expect(session.openScene(join(folder, 'absent.kitbash'))).rejects.toThrow(
      /does not exist/,
    );
    await expect(session.openScene(join(folder, 'model.stl'))).rejects.toThrow(/\.kitbash/);
    const junk = join(folder, 'junk.kitbash');
    await writeFile(junk, 'not a scene');
    await expect(session.openScene(junk)).rejects.toThrow(/could not be read/);
  });

  it('exports GLB with names, joints, and real-world scale', async () => {
    session.addParts([box('body', [100, 100, 100]), box('head', [10, 10, 10], [0, 80, 0])]);
    session.createJoint({
      child: 'head',
      parent: 'body',
      child_anchor: { face: '-y' },
      parent_anchor: { face: '+y' },
    });
    const file = join(folder, 'model.glb');
    const result = await session.exportScene(file);
    expect(result).toMatchObject({ parts: 2, triangles: 24 });
    const bytes = await readFile(file);
    const gltf = await new GLTFLoader().parseAsync(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      '',
    );
    expect(gltf.scene.getObjectByName('body')).toBeDefined();
    expect(gltf.scene.getObjectByName('head')).toBeDefined();
    expect(gltf.scene.children[0].userData.kitbasherJoints).toHaveLength(1);
    expect(gltf.scene.children[0].scale.x).toBeCloseTo(0.001, 6);
  });

  it('exports STL, 3MF, and a Blender package for chosen parts', async () => {
    session.addParts([box('a'), box('b', [10, 10, 10], [20, 0, 0])]);
    const stl = await session.exportScene(join(folder, 'one.stl'), ['a']);
    expect(stl.bytes).toBe(84 + 12 * 50);
    const threeMf = await session.exportScene(join(folder, 'two.3mf'));
    expect(threeMf.parts).toBe(2);
    await session.exportScene(join(folder, 'pack.zip'));
    const zip = unzipSync(new Uint8Array(await readFile(join(folder, 'pack.zip'))));
    expect(Object.keys(zip).sort()).toEqual(['README.txt', 'assembly.glb', 'import_assembly.py']);
  });

  it('guards exports', async () => {
    session.addParts([box('a')]);
    await expect(session.exportScene(join(folder, 'a.txt'))).rejects.toThrow(/\.glb/);
    await expect(session.exportScene(join(folder, 'one.stl'))).rejects.toThrow(/exists/);
    await session.exportScene(join(folder, 'one.stl'), undefined, true);
    await expect(new Session().exportScene(join(folder, 'none.stl'))).rejects.toThrow(/no parts/);
  });

  it('imports its own exports, in every format', async () => {
    session.addParts([box('body', [20, 10, 30]), box('head', [4, 4, 4], [0, 40, 0])]);
    for (const name of ['round.stl', 'round.glb', 'round.3mf'])
      await session.exportScene(join(folder, name), undefined, true);
    const stl = new Session();
    expect((await stl.importModel(join(folder, 'round.stl'), {})).added).toHaveLength(1);
    const glb = new Session();
    const glbParts = (await glb.importModel(join(folder, 'round.glb'), {})).added;
    expect(glbParts.map((p) => p.id).sort()).toEqual(['body', 'head']);
    expect(glbParts.find((p) => p.id === 'body')!.size).toEqual([20, 10, 30]);
    const threeMf = new Session();
    const threeParts = (await threeMf.importModel(join(folder, 'round.3mf'), {})).added;
    expect(threeParts).toHaveLength(2);
    expect(threeParts.find((p) => p.size[1] === 10)!.size[0]).toBeCloseTo(20, 3);
  });

  it('imports a GLB with an embedded texture, dropping the texture', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    );
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
    const padded = Buffer.concat([png, Buffer.alloc((4 - (png.length % 4)) % 4)]);
    const bin = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(uvs.buffer), padded]);
    const gltf = {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, name: 'Textured' }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      textures: [{ source: 0 }],
      images: [{ bufferView: 2, mimeType: 'image/png' }],
      buffers: [{ byteLength: bin.length }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36 },
        { buffer: 0, byteOffset: 36, byteLength: 24 },
        { buffer: 0, byteOffset: 60, byteLength: png.length },
      ],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 3,
          type: 'VEC3',
          min: [0, 0, 0],
          max: [1, 1, 0],
        },
        { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' },
      ],
    };
    const json = Buffer.from(JSON.stringify(gltf));
    const paddedJson = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546c67, 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(12 + 8 + paddedJson.length + 8 + bin.length, 8);
    const chunk = (type: number, data: Buffer) => {
      const head = Buffer.alloc(8);
      head.writeUInt32LE(data.length, 0);
      head.writeUInt32LE(type, 4);
      return Buffer.concat([head, data]);
    };
    const file = join(folder, 'textured.glb');
    await writeFile(
      file,
      Buffer.concat([header, chunk(0x4e4f534a, paddedJson), chunk(0x004e4942, bin)]),
    );
    const { added } = await session.importModel(file, {});
    expect(added).toHaveLength(1);
    expect(added[0].name).toBe('Textured');
  });

  it('applies import units and centering', async () => {
    const stl = new Session();
    stl.addParts([box('a', [10, 20, 30], [100, 100, 100])]);
    const file = join(folder, 'units.stl');
    await stl.exportScene(file, undefined, true);
    const scaled = new Session();
    const [part] = (await scaled.importModel(file, { units: 'cm', center: true })).added;
    expect(part.size).toEqual([100, 200, 300]);
    expect(part.bounds.min[1]).toBeCloseTo(0, 3);
  });

  it('explains a missing or unsupported import, changing nothing', async () => {
    await expect(session.importModel(join(folder, 'missing.stl'), {})).rejects.toThrow(
      /does not exist/,
    );
    const file = join(folder, 'notes.txt');
    await writeFile(file, 'hello');
    await expect(session.importModel(file, {})).rejects.toThrow(/supported formats/);
    const broken = join(folder, 'broken.glb');
    await writeFile(broken, 'not a glb at all');
    await expect(session.importModel(broken, {})).rejects.toThrow(/could not be read/);
    expect(session.summary().part_count).toBe(0);
  });
});

describe('scene summary', () => {
  it('pages through parts and filters by id', () => {
    session.addParts([box('a'), box('b'), box('c')]);
    const first = session.summary(undefined, 0, 2);
    expect(first.parts.map((p) => p.id)).toEqual(['a', 'b']);
    expect(first.next_offset).toBe(2);
    expect(session.summary(undefined, 2, 2).next_offset).toBeUndefined();
    expect(session.summary(['b']).parts.map((p) => p.id)).toEqual(['b']);
  });

  it('leaves out defaults, and shows what is unusual', () => {
    session.addParts([{ ...box('a'), locked: true, visible: false }]);
    const [described] = session.summary().parts;
    expect(described.rotation).toBeUndefined();
    expect(described.scale).toBeUndefined();
    expect(described.locked).toBe(true);
    expect(described.visible).toBe(false);
  });
});

describe('avoiding clipping', () => {
  const view = useEditor.getState().view;
  afterEach(() => useEditor.setState({ view }));

  it('is off until asked for, then keeps moves and fits out of other parts', () => {
    session.addParts([box('a'), box('b', [10, 10, 10], [30, 0, 0])]);
    expect(session.summary().avoid_clipping).toEqual({ enabled: false, max_overlap_mm: 0.1 });
    session.updateParts([{ id: 'b', position: [5, 0, 0] }]);
    expectVector(pos('b'), [5, 0, 0]);

    expect(session.setClipping(true, 0.2)).toEqual({ enabled: true, max_overlap_mm: 0.2 });
    session.updateParts([{ id: 'b', position: [30, 0, 0] }]);
    const moved = session.updateParts([{ id: 'b', position: [5, 0, 0] }]).updated[0];
    expectVector(pos('b'), [9.8, 0, 0], 3);
    expect(moved).toMatchObject({ constrained: true, note: 'b moved 4.80 mm to clear a' });

    session.updateParts([{ id: 'b', position: [30, 0, 0] }]);
    const placed = session.placeParts([{ id: 'b', target: 'a', side: '+x', gap: -3 }]).placed[0];
    expectVector(pos('b'), [9.8, 0, 0], 3);
    expect(placed.note).toMatch(/to clear a$/);

    const aligned = session.alignParts({
      source: 'b',
      target: 'a',
      method: 'point',
      pairs: [{ source: { local: [-2, 0, 0] }, target: { face: '+x' } }],
    });
    expectVector(pos('b'), [9.8, 0, 0], 3);
    expect(aligned.clip).toMatchObject({ blocked_by: ['a'], moved_mm: 2.8 });

    const fitted = session.fitAnchors('b', [{ point: { face: '-x' }, target: [2, 0, 0] }]);
    expectVector(pos('b'), [9.8, 0, 0], 2);
    expect(fitted.clip?.blocked_by).toEqual(['a']);
    expect(() => session.setClipping(true, 9)).toThrow('0 to 5');
  });
});
