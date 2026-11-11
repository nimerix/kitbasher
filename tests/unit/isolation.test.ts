import { beforeEach, describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  Euler,
  IcosahedronGeometry,
  Matrix4,
  Quaternion,
  TorusKnotGeometry,
  Vector3,
} from 'three';
import type { BufferGeometry } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { editorCommands, executeEditorCommand, shortcutCommand } from '../../src/core/commands';
import {
  defaultIsolationSettings,
  hiddenByIsolation,
  isolationLimits,
  nearbyLimit,
  nearbyReach,
  nearbySpec,
  nextIsolation,
  sameField,
  sanitizeIsolationSettings,
  showsNearby,
} from '../../src/core/isolation';
import { bindingsFor, matchKeyAction } from '../../src/core/keybindings';
import { bakeProximityField, fieldDistance, fieldLimits } from '../../src/core/proximity';
import type { ProximityField, ProximitySource } from '../../src/core/proximity';
import { useEditor } from '../../src/core/store';
import type { Part, SceneDocument } from '../../src/core/types';

function bake(sources: ProximitySource[], reach: number, limits = fieldLimits) {
  const task = bakeProximityField(sources, reach, limits);
  let steps = 0;
  for (;;) {
    const result = task.next();
    if (result.done) return { field: result.value!, steps };
    steps++;
  }
}

const identity = new Matrix4();
const turned = new Matrix4().makeRotationFromEuler(new Euler(0.5, 0.7, 0.3)).setPosition(4, -3, 9);

/** Exact distance to the meshes, to compare a field with. */
function exact(sources: ProximitySource[]) {
  const meshes = sources.map(({ geometry, matrix }) => ({
    bvh: new MeshBVH(geometry.clone().applyMatrix4(matrix)),
  }));
  const hit = { point: new Vector3(), distance: 0, faceIndex: 0 };
  return (point: Vector3) =>
    Math.min(...meshes.map(({ bvh }) => bvh.closestPointToPoint(point, hit)!.distance));
}

function random(seed: number) {
  let state = seed;
  return () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

/** The largest error over points spread through the grid, and the largest reading on a surface. */
function measure(sources: ProximitySource[], field: ProximityField, reach: number) {
  const distance = exact(sources);
  const next = random(11);
  const point = new Vector3();
  let error = 0;
  for (let i = 0; i < 6000; i++) {
    point.set(
      field.origin[0] + next() * (field.size[0] - 1) * field.cell,
      field.origin[1] + next() * (field.size[1] - 1) * field.cell,
      field.origin[2] + next() * (field.size[2] - 1) * field.cell,
    );
    const actual = distance(point);
    if (actual <= reach)
      error = Math.max(error, Math.abs(fieldDistance(field, point.x, point.y, point.z) - actual));
  }
  let surface = 0;
  const a = new Vector3(),
    b = new Vector3(),
    c = new Vector3();
  for (const { geometry, matrix } of sources) {
    const position = geometry.getAttribute('position');
    const triangles = (geometry.index?.count ?? position.count) / 3;
    for (let i = 0; i < 4000; i++) {
      const t = Math.floor(next() * triangles) * 3;
      a.fromBufferAttribute(position, geometry.index?.getX(t) ?? t);
      b.fromBufferAttribute(position, geometry.index?.getX(t + 1) ?? t + 1);
      c.fromBufferAttribute(position, geometry.index?.getX(t + 2) ?? t + 2);
      let u = next(),
        v = next();
      if (u + v > 1) [u, v] = [1 - u, 1 - v];
      point.copy(a).addScaledVector(b.sub(a), u).addScaledVector(c.sub(a), v).applyMatrix4(matrix);
      surface = Math.max(surface, fieldDistance(field, point.x, point.y, point.z));
    }
  }
  return { error: error / field.cell, surface: surface / field.cell };
}

describe('proximity field', () => {
  const shapes: [string, BufferGeometry, Matrix4, number][] = [
    ['a coarse box', new BoxGeometry(60, 40, 30), identity, 2],
    ['a turned box', new BoxGeometry(60, 40, 30), turned, 2],
    ['a thin plate', new BoxGeometry(60, 40, 0.2), turned, 1],
    ['a dense sphere', new IcosahedronGeometry(30, 60), identity, 4],
    ['an unindexed coarse sphere', new IcosahedronGeometry(30, 3), turned, 2],
    ['a knot', new TorusKnotGeometry(20, 6, 300, 48), turned, 4],
    ['long slivers', new BoxGeometry(60, 40, 30, 600, 1, 1), identity, 2],
    [
      'a stretched, mirrored box',
      new BoxGeometry(20, 20, 20),
      new Matrix4().compose(
        new Vector3(5, 5, 5),
        new Quaternion().setFromEuler(new Euler(0.2, 0.4, 0.6)),
        new Vector3(-3, 1, 0.4),
      ),
      2,
    ],
  ];
  for (const [name, geometry, matrix, reach] of shapes)
    it(`measures ${name} to within a cell and reads contact below the drawing limit`, () => {
      const sources = [{ geometry, matrix }];
      const { field } = bake(sources, reach);
      const { error, surface } = measure(sources, field, reach);
      expect(error).toBeLessThan(0.75);
      // A surface in contact must pass nearbyLimit even when the distance is zero.
      expect(surface).toBeLessThan(0.75);
      expect(nearbyLimit(0, reach, field.cell)).toBeGreaterThan(surface * field.cell);
    });

  it('keeps contact drawn on a part far larger than the distance', () => {
    // Here a cell is wider than the whole reach.
    const sources = [{ geometry: new BoxGeometry(500, 400, 300), matrix: turned }];
    const { field } = bake(sources, 1);
    expect(field.cell).toBeGreaterThan(2);
    const { surface } = measure(sources, field, 1);
    expect(nearbyLimit(1, 1, field.cell)).toBeGreaterThan(surface * field.cell);
    expect(nearbyLimit(0, 1, field.cell)).toBeLessThan(field.range);
  });

  it('never makes a grid side longer than the limit', () => {
    const next = random(5);
    for (const axis of [64, 256, 512])
      for (let i = 0; i < 40; i++) {
        const geometry = new BoxGeometry(50 + next() * 3000, 1 + next() * 40, 1 + next() * 40);
        const task = bakeProximityField([{ geometry, matrix: identity }], 1, {
          nodes: 20000,
          axis,
        });
        let result = task.next();
        while (!result.done) result = task.next();
        expect(Math.max(...result.value!.size)).toBeLessThanOrEqual(axis);
      }
  });

  it('measures to the nearest of several meshes', () => {
    const sources = [
      { geometry: new BoxGeometry(10, 10, 10), matrix: identity },
      { geometry: new BoxGeometry(6, 6, 6), matrix: new Matrix4().makeTranslation(20, 2, 0) },
    ];
    const { field } = bake(sources, 4);
    expect(measure(sources, field, 4).error).toBeLessThan(0.75);
    // Between the two: 3 mm from the first box and 9 mm from the second.
    expect(fieldDistance(field, 8, 0, 0)).toBeCloseTo(3, 0);
    expect(fieldDistance(field, 15.5, 2, 0)).toBeCloseTo(1.5, 0);
  });

  it('holds the far value beyond its reach and nothing outside the grid', () => {
    const { field } = bake([{ geometry: new BoxGeometry(40, 40, 40), matrix: identity }], 2);
    expect(field.range).toBeGreaterThan(2);
    // The middle of the box is 20 mm from every face.
    expect(fieldDistance(field, 0, 0, 0)).toBeCloseTo(field.range, 6);
    expect(fieldDistance(field, 21, 0, 0)).toBeCloseTo(1, 0);
    expect(fieldDistance(field, 500, 0, 0)).toBe(Infinity);
    expect(fieldDistance(field, 0, -23.5 - field.cell, 0)).toBe(Infinity);
  });

  it('sizes its grid to the limits, and no finer than a wide reach needs', () => {
    const geometry = new BoxGeometry(300, 300, 5);
    const { field } = bake([{ geometry, matrix: identity }], 1, { nodes: 100000, axis: 64 });
    expect(Math.max(...field.size)).toBeLessThanOrEqual(64);
    expect(field.size[0] * field.size[1] * field.size[2]).toBeLessThan(150000);
    const wide = bake([{ geometry: new BoxGeometry(10, 10, 10), matrix: identity }], 64).field;
    expect(wide.cell).toBeCloseTo(4, 6);
    expect(wide.data.length).toBeLessThan(100000);
    const fine = bake([{ geometry: new BoxGeometry(10, 10, 10), matrix: identity }], 1).field;
    expect(fine.data.length).toBeGreaterThan(fieldLimits.nodes * 0.9);
    expect(fine.data.length).toBeLessThan(fieldLimits.nodes * 1.2);
  });

  it('yields throughout, so a dense mesh never holds a frame', () => {
    const { steps } = bake([{ geometry: new IcosahedronGeometry(30, 120), matrix: identity }], 2);
    expect(steps).toBeGreaterThan(100);
    expect(bake([], 2).field).toBeNull();
  });
});

function part(id: string, x: number, extra: Partial<Part> = {}): Part {
  return {
    id,
    name: id,
    position: [x, 0, 0],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    geometry: new BoxGeometry(16, 16, 16),
    source: 'test',
    color: '#c0ffee',
    visible: true,
    locked: false,
    ...extra,
  };
}

function fixture(): SceneDocument {
  return {
    name: 'Isolation test',
    parts: [part('a', -8.5), part('b', 8.5), part('c', 40), part('hidden', 80, { visible: false })],
    joints: [],
  };
}

describe('isolation settings and fields', () => {
  it('validates stored settings', () => {
    expect(sanitizeIsolationSettings(null)).toEqual(defaultIsolationSettings);
    expect(sanitizeIsolationSettings({ nearby: true, distance: 3.5 })).toEqual({
      nearby: true,
      distance: 3.5,
    });
    expect(sanitizeIsolationSettings({ nearby: 'yes', distance: -4 })).toEqual({
      nearby: false,
      distance: isolationLimits.min,
    });
    expect(sanitizeIsolationSettings({ distance: 1e9 }).distance).toBe(isolationLimits.max);
    expect(sanitizeIsolationSettings({ distance: NaN }, { nearby: true, distance: 7 })).toEqual({
      nearby: true,
      distance: 7,
    });
  });

  it('steps the reach so nearby distances share a field', () => {
    expect([0, 0.5, 1, 1.1, 2, 2.5, 4, 100].map(nearbyReach)).toEqual([1, 1, 1, 2, 2, 4, 4, 128]);
    expect(nearbyLimit(2, 2, 0.4)).toBe(2);
    expect(nearbyLimit(0.1, 1, 0.4)).toBeCloseTo(0.3);
    // A field measured for 2 mm stands in while one for 10 mm is on the way.
    expect(nearbyLimit(10, 2, 0.4)).toBe(2);
  });

  it('pauses nearby surfaces in exploded and interference views', () => {
    const view = useEditor.getState().view;
    const on = { ...view, explode: 0, isolation: { nearby: true, distance: 2 } };
    expect(showsNearby(on)).toBe(true);
    expect(showsNearby({ ...on, explode: 30 })).toBe(false);
    expect(showsNearby({ ...on, inspection: { ...on.inspection, enabled: true } })).toBe(false);
    expect(showsNearby({ ...on, isolation: { nearby: false, distance: 2 } })).toBe(false);
  });

  it('hides the parts outside an isolated view that are not drawn nearby', () => {
    expect(hiddenByIsolation(null, null, 'b')).toBe(false);
    expect(hiddenByIsolation(['a'], null, 'a')).toBe(false);
    expect(hiddenByIsolation(['a'], null, 'b')).toBe(true);
    expect(hiddenByIsolation(['a'], ['b'], 'b')).toBe(false);
    expect(hiddenByIsolation(['a'], ['b'], 'c')).toBe(true);
  });

  it('isolates the selection, switches to a new one, and exits on the same or none', () => {
    const { parts } = fixture();
    expect(nextIsolation(parts, ['a'], null)).toEqual(['a']);
    expect(nextIsolation(parts, ['b', 'a'], ['a'])).toEqual(['b', 'a']);
    expect(nextIsolation(parts, ['a'], ['a'])).toBeNull();
    expect(nextIsolation(parts, ['b', 'a'], ['a', 'b'])).toBeNull();
    expect(nextIsolation(parts, [], ['a'])).toBeNull();
    // A hidden part cannot be isolated, and does not make the selection differ.
    expect(nextIsolation(parts, ['hidden'], null)).toBeNull();
    expect(nextIsolation(parts, ['a', 'hidden'], ['a'])).toBeNull();
  });

  it('rides the field on the first part, so moving the isolated parts together keeps it', () => {
    const { parts } = fixture();
    const spec = nearbySpec(parts, ['a', 'b', 'hidden'], 2)!;
    expect(spec.parts).toEqual(['a', 'b']);
    expect(spec.reach).toBe(2);
    expect(nearbySpec(parts, ['hidden'], 2)).toBeNull();

    const delta = new Matrix4().compose(
      new Vector3(120, -40, 300),
      new Quaternion().setFromEuler(new Euler(1.1, -0.4, 2.2)),
      new Vector3(1, 1, 1),
    );
    const moved = parts.map((p) => {
      const position = new Vector3(),
        quaternion = new Quaternion(),
        scale = new Vector3();
      delta
        .clone()
        .multiply(
          new Matrix4().compose(
            new Vector3(...p.position),
            new Quaternion(...p.quaternion),
            new Vector3(...p.scale),
          ),
        )
        .decompose(position, quaternion, scale);
      return { ...p, position: position.toArray(), quaternion: quaternion.toArray() };
    });
    const carried = nearbySpec(moved, ['a', 'b'], 1.5)!;
    expect(sameField(spec, carried)).toBe(true);
    expect(carried.frame.elements).not.toEqual(spec.frame.elements);

    const apart = parts.map((p) => (p.id === 'b' ? { ...p, position: [9, 0, 0] as const } : p));
    expect(sameField(spec, nearbySpec(apart as Part[], ['a', 'b'], 2)!)).toBe(false);
    const scaled = parts.map((p) => (p.id === 'a' ? { ...p, scale: [1, 2, 1] as const } : p));
    expect(sameField(spec, nearbySpec(scaled as Part[], ['a', 'b'], 2)!)).toBe(false);
    expect(sameField(spec, nearbySpec(parts, ['a', 'b'], 3)!)).toBe(false);
    expect(sameField(spec, nearbySpec(parts, ['a'], 2)!)).toBe(false);
    const swapped = parts.map((p) => (p.id === 'b' ? { ...p, geometry: p.geometry.clone() } : p));
    expect(sameField(spec, nearbySpec(swapped, ['a', 'b'], 2)!)).toBe(false);
  });

  it('finds the facing surface of a neighbor and not its far side, wherever the parts sit', () => {
    const turn = new Quaternion().setFromEuler(new Euler(0.3, 1.2, -0.8));
    const offset = new Vector3(400, 25, -90);
    const place = (p: Part): Part => ({
      ...p,
      position: new Vector3(...p.position).applyQuaternion(turn).add(offset).toArray(),
      quaternion: turn.toArray(),
    });
    const parts = fixture().parts.map(place);
    const spec = nearbySpec(parts, ['a'], 2)!;
    const { field } = bake(spec.sources, spec.reach);
    const inverse = spec.frame.clone().invert();
    const distance = (x: number, y: number, z: number) => {
      const point = new Vector3(x, y, z).applyQuaternion(turn).add(offset).applyMatrix4(inverse);
      return fieldDistance(field, point.x, point.y, point.z);
    };
    const limit = nearbyLimit(2, spec.reach, field.cell);
    // The neighbor's facing side is 1 mm from the isolated box.
    expect(distance(0.5, 3, -2)).toBeCloseTo(1, 1);
    expect(distance(0.5, 3, -2)).toBeLessThan(limit);
    // Around its corner, the adjoining face stays within 2 mm for one more millimeter.
    expect(distance(1.2, 8, 0)).toBeLessThan(limit);
    expect(distance(1.8, 8, 0)).toBeGreaterThan(limit);
    expect(distance(16.5, 0, 0)).toBeGreaterThan(limit);
  });
});

describe('isolating in the editor', () => {
  beforeEach(() => {
    useEditor.getState().setScene(fixture());
    useEditor.getState().setView({ isolation: defaultIsolationSettings });
    useEditor.setState({ selected: ['a'], clipboard: null, busy: null, toast: null });
  });
  const state = () => useEditor.getState();

  it('isolates without editing the scene, its history, or part visibility', () => {
    const before = state();
    state().toggleIsolation();
    expect(state().isolated).toEqual(['a']);
    expect(state().revision).toBe(before.revision);
    expect(state().past).toBe(before.past);
    expect(state().scene).toBe(before.scene);
    state().toggleIsolation();
    expect(state().isolated).toBeNull();
    expect(state().scene).toBe(before.scene);
  });

  it('switches to a new selection, and asks for one when there is nothing to isolate', () => {
    state().toggleIsolation();
    state().select('b');
    state().toggleIsolation();
    expect(state().isolated).toEqual(['b']);
    state().select(null);
    state().toggleIsolation();
    expect(state().isolated).toBeNull();
    state().toggleIsolation();
    expect(state().isolated).toBeNull();
    expect(state().toast?.message).toBe('Select a visible part to isolate.');
    useEditor.setState({ toast: null, selected: ['hidden'] });
    state().toggleNearby();
    expect(state().isolated).toBeNull();
    expect(state().view.isolation.nearby).toBe(false);
    expect(state().toast?.message).toBe('Select a visible part to isolate.');
  });

  it('turns nearby surfaces on with the isolation, then toggles them in place', () => {
    state().toggleNearby();
    expect(state().isolated).toEqual(['a']);
    expect(state().view.isolation).toEqual({ nearby: true, distance: 2 });
    // Moving the isolation to another part keeps them, and a new isolation starts plain.
    state().select('b');
    state().toggleIsolation();
    expect(state().isolated).toEqual(['b']);
    expect(state().view.isolation.nearby).toBe(true);
    state().toggleIsolation();
    expect(state().isolated).toBeNull();
    state().toggleIsolation();
    expect(state().isolated).toEqual(['b']);
    expect(state().view.isolation.nearby).toBe(false);
    state().toggleNearby();
    expect(state().view.isolation.nearby).toBe(true);
    state().toggleNearby();
    expect(state().isolated).toEqual(['b']);
    expect(state().view.isolation.nearby).toBe(false);
    state().setView({ isolation: { nearby: true, distance: 9999 } });
    expect(state().view.isolation.distance).toBe(isolationLimits.max);
  });

  it('leaves isolation when its parts leave the scene, and survives undo of other edits', () => {
    state().toggleIsolation();
    state().transform('a', { position: [-20, 0, 0] });
    state().undo();
    expect(state().isolated).toEqual(['a']);
    state().deleteSelected();
    expect(state().isolated).toBeNull();
    state().undo();
    expect(state().isolated).toBeNull();

    useEditor.setState({ selected: ['a', 'b'] });
    state().toggleIsolation();
    state().select('b');
    state().deleteSelected();
    expect(state().isolated).toEqual(['a']);
    state().setScene(fixture());
    expect(state().isolated).toBeNull();
  });

  it('adds parts made while isolating to the isolated view', () => {
    state().toggleIsolation();
    state().duplicateSelected();
    const copy = state().selected[0];
    expect(state().isolated).toEqual(['a', copy]);
    state().copySelected();
    state().pasteClipboard();
    expect(state().isolated).toEqual(['a', copy, state().selected[0]]);
    state().addParts([part('new', 100)]);
    expect(state().isolated).toContain('new');
    // Undo takes a copy out of the view with it, and redo brings both back.
    state().undo();
    expect(state().isolated).not.toContain('new');
    state().redo();
    expect(state().isolated).toContain('new');
    state().isolate(null);
    state().addParts([part('later', 120)]);
    expect(state().isolated).toBeNull();
  });

  it('keeps hiding the other parts as a separate, undoable scene edit', () => {
    state().toggleIsolation();
    executeEditorCommand('hideOthers');
    expect(
      state()
        .scene.parts.filter((p) => p.visible)
        .map((p) => p.id),
    ).toEqual(['a']);
    expect(state().past).toHaveLength(1);
    expect(state().isolated).toEqual(['a']);
  });

  it('names its commands for what they will do', () => {
    expect(editorCommands().isolate).toMatchObject({ label: 'Isolate selected', enabled: true });
    expect(editorCommands().isolateNearby.label).toBe('Isolate with nearby surfaces');
    executeEditorCommand('isolate');
    expect(state().isolated).toEqual(['a']);
    expect(editorCommands().isolate.label).toBe('Exit isolation');
    expect(editorCommands().isolateNearby.label).toBe('Show nearby surfaces');
    executeEditorCommand('isolateNearby');
    expect(editorCommands().isolateNearby.label).toBe('Hide nearby surfaces');
    state().select('b');
    expect(editorCommands().isolate.label).toBe('Isolate selected');
    state().select(null);
    expect(editorCommands().isolate).toMatchObject({ label: 'Exit isolation', enabled: true });
    executeEditorCommand('isolate');
    expect(state().isolated).toBeNull();
    expect(editorCommands().isolate.enabled).toBe(false);
    expect(editorCommands().isolateNearby.enabled).toBe(false);
  });

  it('binds I and Shift+I without disturbing import', () => {
    const key = (extra: object) => ({
      key: 'i',
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      ...extra,
    });
    expect(matchKeyAction(key({}), {})).toBe('isolate');
    expect(matchKeyAction(key({ key: 'I', shiftKey: true }), {})).toBe('isolateNearby');
    expect(matchKeyAction(key({ metaKey: true }), {})).toBe('import');
    expect(shortcutCommand(key({}))).toBeNull();
    // A key someone already gave to another action stays with it.
    const custom = { projection: ['I'] };
    expect(matchKeyAction(key({}), custom)).toBe('projection');
    expect(bindingsFor('isolate', custom)).toEqual([]);
    expect(bindingsFor('isolateNearby', custom)).toEqual(['Shift+I']);
    expect(bindingsFor('focus', custom)).toEqual(['F']);
    expect(editorCommands().isolate.shortcut).toBe('I');
    expect(editorCommands().isolateNearby.shortcut).toBe('Shift+I');
  });
});
