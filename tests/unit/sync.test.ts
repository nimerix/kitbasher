import { BoxGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import {
  applyPatch,
  composePatches,
  diffScenes,
  keepUnchanged,
  mergeScenes,
  reconcile,
  same,
  sharedScene,
  summarizePatch,
} from '../../src/core/sync';
import { anchorError } from '../../src/core/constraints';
import { addLight, presetLighting, removeLight, updateLight } from '../../src/core/lighting';
import { parseSceneDocument } from '../../src/core/scene-file';
import type {
  Joint,
  Part,
  PlaneConstraint,
  SceneDocument,
  SceneLighting,
} from '../../src/core/types';

const geometry = new BoxGeometry(10, 10, 10);
const part = (id: string, patch: Partial<Part> = {}): Part => ({
  id,
  name: id,
  geometry,
  position: [0, 0, 0],
  quaternion: [0, 0, 0, 1],
  scale: [1, 1, 1],
  color: '#ffffff',
  visible: true,
  locked: false,
  source: 'test',
  ...patch,
});
const joint = (parentId: string, childId: string, patch: Partial<Joint> = {}): Joint => ({
  id: `${parentId}-${childId}`,
  name: 'Joint',
  parentId,
  childId,
  parentAnchor: [0, 5, 0],
  childAnchor: [0, -5, 0],
  restRotation: [0, 0, 0, 1],
  rotationLocks: [true, false, true],
  keepConnected: true,
  ...patch,
});
const scene = (parts: Part[], joints: Joint[] = [], constraints: PlaneConstraint[] = []) => ({
  name: 'Scene',
  parts,
  joints,
  constraints,
});
const change = (s: SceneDocument, id: string, patch: Partial<Part>): SceneDocument => ({
  ...s,
  parts: s.parts.map((p) => (p.id === id ? { ...p, ...patch } : p)),
});
const without = (s: SceneDocument, id: string): SceneDocument => ({
  ...s,
  parts: s.parts.filter((p) => p.id !== id),
  joints: s.joints.filter((j) => j.parentId !== id && j.childId !== id),
});
const find = (s: SceneDocument, id: string) => s.parts.find((p) => p.id === id);
const base = scene([part('a'), part('b'), part('c')]);

describe('value equality', () => {
  it('compares scene data by value, and meshes by identity', () => {
    expect(same([1, [2, 3]], [1, [2, 3]])).toBe(true);
    expect(same([1, 2], [1, 2, 3])).toBe(false);
    expect(same({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(same({ a: { b: [1] } }, { a: { b: [2] } })).toBe(false);
    expect(same(part('a'), { ...part('a') })).toBe(true);
    expect(same(part('a'), part('a', { geometry: new BoxGeometry(10, 10, 10) }))).toBe(false);
    expect(same(-0, 0)).toBe(true);
  });
});

describe('merging two edits of one scene', () => {
  it('keeps both sides when they changed different parts', () => {
    const ours = change(base, 'a', { position: [1, 0, 0] });
    const theirs = change(base, 'b', { position: [2, 0, 0] });
    const merged = mergeScenes(base, ours, theirs);
    expect(find(merged, 'a')!.position).toEqual([1, 0, 0]);
    expect(find(merged, 'b')!.position).toEqual([2, 0, 0]);
    // An untouched part keeps theirs's object, so views need not redraw it.
    expect(find(merged, 'c')).toBe(find(theirs, 'c'));
  });

  it('keeps both sides when they changed different properties of one part', () => {
    const ours = change(base, 'a', { position: [1, 0, 0] });
    const theirs = change(base, 'a', { color: '#ff0000', name: 'Renamed' });
    const merged = find(mergeScenes(base, ours, theirs), 'a')!;
    expect([merged.position, merged.color, merged.name]).toEqual([[1, 0, 0], '#ff0000', 'Renamed']);
  });

  it('settles a conflict in favor of the preferred side, and never mixes a pose', () => {
    const ours = change(base, 'a', { position: [1, 0, 0] });
    const theirs = change(base, 'a', { position: [2, 0, 0], quaternion: [0, 1, 0, 0] });
    const mine = find(mergeScenes(base, ours, theirs, 'ours'), 'a')!;
    expect([mine.position, mine.quaternion]).toEqual([
      [1, 0, 0],
      [0, 0, 0, 1],
    ]);
    const other = find(mergeScenes(base, ours, theirs, 'theirs'), 'a')!;
    expect(other.position).toEqual([2, 0, 0]);
  });

  it('keeps parts either side added, and removals either side made', () => {
    const ours = { ...without(base, 'a'), parts: [...without(base, 'a').parts, part('mine')] };
    const theirs = { ...base, parts: [...base.parts, part('theirs')] };
    const merged = mergeScenes(base, ours, theirs);
    expect(merged.parts.map((p) => p.id)).toEqual(['b', 'c', 'theirs', 'mine']);
  });

  it('lets the preferred side decide between removing and changing a part', () => {
    const ours = without(base, 'a');
    const theirs = change(base, 'a', { color: '#00ff00' });
    expect(find(mergeScenes(base, ours, theirs, 'ours'), 'a')).toBeUndefined();
    expect(find(mergeScenes(base, ours, theirs, 'theirs'), 'a')!.color).toBe('#00ff00');
  });

  it('drops a relationship to a part the other side removed', () => {
    const ours = { ...base, joints: [joint('a', 'b')] };
    const theirs = without(base, 'a');
    const merged = mergeScenes(base, ours, theirs);
    expect(merged.joints).toEqual([]);
    expect(merged.parts.map((p) => p.id)).toEqual(['b', 'c']);
  });

  it('merges the scene name and joint settings by field', () => {
    const start = { ...base, joints: [joint('a', 'b')] };
    const ours = { ...start, name: 'Ours', joints: [{ ...start.joints[0], name: 'Hinge' }] };
    const theirs = { ...start, joints: [{ ...start.joints[0], keepConnected: false }] };
    const merged = mergeScenes(start, ours, theirs);
    expect(merged.name).toBe('Ours');
    expect(merged.joints[0]).toMatchObject({ name: 'Hinge', keepConnected: false });
  });
});

describe('undo steps', () => {
  it('reverts a change, and applies it again', () => {
    const after = change(base, 'a', { position: [5, 0, 0], color: '#123456' });
    const patch = diffScenes(base, after);
    expect(patch).toHaveLength(1);
    const undone = applyPatch(after, patch, 'undo');
    expect(undone.changed).toBe(true);
    expect(find(undone.scene, 'a')).toEqual(find(base, 'a'));
    expect(find(applyPatch(undone.scene, patch, 'redo').scene, 'a')).toEqual(find(after, 'a'));
  });

  it('leaves fields someone else has changed since, and reverts the rest', () => {
    const after = change(base, 'a', { position: [5, 0, 0], color: '#123456' });
    const patch = diffScenes(base, after);
    const later = change(after, 'a', { position: [9, 0, 0] });
    const undone = applyPatch(later, patch, 'undo');
    expect(find(undone.scene, 'a')).toMatchObject({ position: [9, 0, 0], color: '#ffffff' });
  });

  it('reports when everything it would revert has been changed by others', () => {
    const after = change(base, 'a', { position: [5, 0, 0] });
    const later = change(after, 'a', { position: [9, 0, 0] });
    const undone = applyPatch(later, diffScenes(base, after), 'undo');
    expect(undone.changed).toBe(false);
  });

  it('removes a part it created even if others have edited it, and restores a removal in place', () => {
    const added = { ...base, parts: [...base.parts, part('new')] };
    const created = diffScenes(base, added);
    const edited = change(added, 'new', { position: [3, 3, 3] });
    expect(find(applyPatch(edited, created, 'undo').scene, 'new')).toBeUndefined();
    const start = { ...base, joints: [joint('a', 'b')] };
    const removed = without(start, 'b');
    const restored = applyPatch(removed, diffScenes(start, removed), 'undo').scene;
    expect(restored.parts.map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(restored.joints).toHaveLength(1);
  });

  it('describes what a change touched', () => {
    const after = { ...change(without(base, 'c'), 'a', { visible: false }), name: 'Renamed' };
    after.parts = [...after.parts, part('d')];
    expect(summarizePatch(diffScenes(base, after))).toEqual({
      partsAdded: ['d'],
      partsChanged: ['a'],
      partsRemoved: ['c'],
      joints: [],
      constraints: [],
      renamed: true,
    });
  });
});

describe('joining the changes of a drag into one step', () => {
  it('restores the earliest value and checks against the latest', () => {
    const one = change(base, 'a', { position: [1, 0, 0] });
    const two = change(one, 'a', { position: [2, 0, 0] });
    const patch = composePatches(diffScenes(base, one), diffScenes(one, two));
    expect(find(applyPatch(two, patch, 'undo').scene, 'a')!.position).toEqual([0, 0, 0]);
  });

  it('keeps a field set by an earlier change, and still sees a later change by others', () => {
    const one = change(base, 'a', { color: '#111111' });
    // Someone else moves it, then the same author moves it too.
    const moved = change(one, 'a', { position: [7, 0, 0], color: '#222222' });
    const two = change(moved, 'a', { position: [8, 0, 0] });
    const patch = composePatches(diffScenes(base, one), diffScenes(moved, two));
    const undone = find(applyPatch(two, patch, 'undo').scene, 'a')!;
    // The position goes back to what it was before this author moved it; the color someone else
    // set after the first change stays.
    expect(undone.position).toEqual([7, 0, 0]);
    expect(undone.color).toBe('#222222');
  });

  it('treats a creation that is then edited as a creation, and cancels one that is removed', () => {
    const added = { ...base, parts: [...base.parts, part('new')] };
    const edited = change(added, 'new', { color: '#00ff00' });
    const patch = composePatches(diffScenes(base, added), diffScenes(added, edited));
    expect(patch).toHaveLength(1);
    expect(patch[0].before).toBeUndefined();
    expect(composePatches(diffScenes(base, added), diffScenes(added, base))).toEqual([]);
  });

  it('restores the original values of a part that was changed and then removed', () => {
    const edited = change(base, 'a', { color: '#00ff00' });
    const removed = without(edited, 'a');
    const patch = composePatches(diffScenes(base, edited), diffScenes(edited, removed));
    expect(find(applyPatch(removed, patch, 'undo').scene, 'a')).toEqual(find(base, 'a'));
  });
});

describe('making a combined scene valid', () => {
  it('seats a child again on a parent that moved', () => {
    const start = scene(
      [part('parent'), part('child', { position: [0, 10, 0] })],
      [joint('parent', 'child')],
    );
    const pulled = change(start, 'parent', { position: [0, 30, 0] });
    const fixed = reconcile(pulled);
    expect(anchorError(pulled.parts, pulled.joints[0])).toBeGreaterThan(1);
    expect(anchorError(fixed.parts, fixed.joints[0])).toBeLessThan(1e-9);
    expect(find(fixed, 'child')!.position).toEqual([0, 40, 0]);
  });

  it('leaves a connected scene, and a locked child, untouched', () => {
    const start = scene(
      [part('parent'), part('child', { position: [0, 10, 0] })],
      [joint('parent', 'child')],
    );
    expect(reconcile(start).parts).toEqual(start.parts);
    const locked = change(change(start, 'child', { locked: true }), 'parent', {
      position: [0, 30, 0],
    });
    expect(find(reconcile(locked), 'child')!.position).toEqual([0, 10, 0]);
  });

  it('refuses joints that conflict', () => {
    const twoParents = scene(
      [part('a'), part('b'), part('c')],
      [joint('a', 'c'), { ...joint('b', 'c'), id: 'x' }],
    );
    expect(() => reconcile(twoParents)).toThrow(/already has a parent/);
    const circular = scene([part('a'), part('b')], [joint('a', 'b'), joint('b', 'a')]);
    expect(() => reconcile(circular)).toThrow();
  });
});

describe('reusing unchanged objects', () => {
  it('returns the previous scene when nothing changed, and reuses unchanged parts', () => {
    const copy = { ...base, parts: base.parts.map((p) => ({ ...p })) };
    expect(keepUnchanged(base, copy)).toBe(base);
    const moved = change(copy, 'a', { position: [1, 0, 0] });
    const kept = keepUnchanged(base, moved);
    expect(kept).not.toBe(base);
    expect(find(kept, 'b')).toBe(find(base, 'b'));
    expect(find(kept, 'a')!.position).toEqual([1, 0, 0]);
  });
});

describe('editor colors', () => {
  it('merge with a pose change to the same part from the other side', () => {
    const ours = change(base, 'a', { displayColor: '#ff0000' });
    const theirs = change(base, 'a', { position: [4, 0, 0] });
    for (const prefer of ['ours', 'theirs'] as const)
      for (const [x, y] of [
        [ours, theirs],
        [theirs, ours],
      ]) {
        const merged = find(mergeScenes(base, x, y, prefer), 'a')!;
        expect(merged).toMatchObject({ displayColor: '#ff0000', position: [4, 0, 0] });
        expect(merged.color).toBe('#ffffff');
      }
  });

  it('merge separately from the material color', () => {
    const ours = change(base, 'a', { displayColor: '#ff0000' });
    const theirs = change(base, 'a', { color: '#00ff00' });
    expect(find(mergeScenes(base, ours, theirs, 'theirs'), 'a')).toMatchObject({
      displayColor: '#ff0000',
      color: '#00ff00',
    });
  });

  it('settle two different editor colors by the preferred side, and a clear like any edit', () => {
    const start = change(base, 'a', { displayColor: '#111111' });
    const ours = change(start, 'a', { displayColor: '#222222' });
    const theirs = change(start, 'a', { displayColor: '#333333' });
    expect(find(mergeScenes(start, ours, theirs, 'ours'), 'a')!.displayColor).toBe('#222222');
    expect(find(mergeScenes(start, ours, theirs, 'theirs'), 'a')!.displayColor).toBe('#333333');
    const { displayColor: _, ...clearedPart } = find(start, 'a')!;
    const cleared = { ...start, parts: start.parts.map((p) => (p.id === 'a' ? clearedPart : p)) };
    const moved = change(start, 'a', { position: [1, 2, 3] });
    const merged = find(mergeScenes(start, cleared, moved), 'a')!;
    expect(merged.displayColor).toBeUndefined();
    expect(merged.position).toEqual([1, 2, 3]);
  });

  it('are undone and redone, set and cleared', () => {
    const colored = change(base, 'a', { displayColor: '#abcdef' });
    const setting = diffScenes(base, colored);
    expect(setting).toHaveLength(1);
    const undone = applyPatch(colored, setting, 'undo');
    expect(undone.changed).toBe(true);
    expect(find(undone.scene, 'a')!.displayColor).toBeUndefined();
    expect(same(find(undone.scene, 'a'), find(base, 'a'))).toBe(true);
    expect(find(applyPatch(undone.scene, setting, 'redo').scene, 'a')!.displayColor).toBe(
      '#abcdef',
    );
    const { displayColor: _, ...plain } = find(colored, 'a')!;
    const cleared = { ...colored, parts: colored.parts.map((p) => (p.id === 'a' ? plain : p)) };
    const clearing = diffScenes(colored, cleared);
    const restored = applyPatch(cleared, clearing, 'undo').scene;
    expect(find(restored, 'a')!.displayColor).toBe('#abcdef');
    expect(find(applyPatch(restored, clearing, 'redo').scene, 'a')!.displayColor).toBeUndefined();
    // Someone else moved the part since; undoing the color keeps their move.
    const moved = change(colored, 'a', { position: [6, 0, 0] });
    expect(find(applyPatch(moved, setting, 'undo').scene, 'a')).toMatchObject({
      position: [6, 0, 0],
      displayColor: undefined,
    });
  });

  it('are not news to an agent unless the part also changed otherwise', () => {
    const colored = change(base, 'a', { displayColor: '#abcdef' });
    expect(summarizePatch(diffScenes(base, colored)).partsChanged).toEqual([]);
    const both = change(colored, 'b', { displayColor: '#123456', position: [1, 0, 0] });
    expect(summarizePatch(diffScenes(base, both)).partsChanged).toEqual(['b']);
    const tinted = change(base, 'c', { color: '#123456' });
    expect(summarizePatch(diffScenes(base, tinted)).partsChanged).toEqual(['c']);
    // A drag that colored, then moved, the same part reports it.
    const moved = change(colored, 'a', { position: [2, 0, 0] });
    const composed = composePatches(diffScenes(base, colored), diffScenes(colored, moved));
    expect(summarizePatch(composed).partsChanged).toEqual(['a']);
    const added = { ...base, parts: [...base.parts, part('d', { displayColor: '#00ff00' })] };
    expect(summarizePatch(diffScenes(base, added)).partsAdded).toEqual(['d']);
  });

  it('travel to the live view with the part', () => {
    const shared = sharedScene(change(base, 'a', { displayColor: '#abcdef' }));
    expect(shared.parts[0]).toMatchObject({ id: 'a', displayColor: '#abcdef' });
    expect('displayColor' in shared.parts[1]).toBe(false);
  });
});

describe('scene lighting', () => {
  const studio = presetLighting('studio');
  const lit = (lighting: SceneLighting): SceneDocument => ({ ...base, lighting });
  const unlit = (s: SceneDocument): SceneDocument => {
    const { lighting: _, ...rest } = s;
    return rest;
  };
  const start = lit(studio);

  it('merges edits to different settings from either side', () => {
    const ours = lit({ ...studio, exposure: 1.5 });
    const theirs = lit(updateLight(studio, 'key', { position: [10, 20, 30] }));
    for (const prefer of ['ours', 'theirs'] as const) {
      const merged = mergeScenes(start, ours, theirs, prefer).lighting!;
      expect(merged.exposure).toBe(1.5);
      expect(merged.lights[0].position).toEqual([10, 20, 30]);
      expect('id' in merged).toBe(false);
      expect(merged).toEqual({
        ...updateLight(studio, 'key', { position: [10, 20, 30] }),
        exposure: 1.5,
      });
    }
    const ambient = lit({ ...studio, ambient: 3 });
    const sky = lit({ ...studio, sky: '#000000', shadows: false });
    expect(mergeScenes(start, ambient, sky).lighting).toEqual({
      ...studio,
      ambient: 3,
      sky: '#000000',
      shadows: false,
    });
  });

  it('settles a conflict by the preferred side, never mixing a group', () => {
    const ours = lit({ ...studio, sky: '#111111' });
    const theirs = lit({ ...studio, hemisphere: 4 });
    expect(mergeScenes(start, ours, theirs, 'ours').lighting).toEqual({
      ...studio,
      sky: '#111111',
    });
    expect(mergeScenes(start, ours, theirs, 'theirs').lighting).toEqual({
      ...studio,
      hemisphere: 4,
    });
    const a = lit(updateLight(studio, 'key', { intensity: 9 }));
    const b = lit(updateLight(studio, 'rim', { color: '#000000' }));
    expect(mergeScenes(start, a, b, 'ours').lighting).toEqual(a.lighting);
    expect(mergeScenes(start, a, b, 'theirs').lighting).toEqual(b.lighting);
    const exposureA = lit({ ...studio, exposure: 2 });
    const exposureB = lit({ ...studio, exposure: 3 });
    expect(mergeScenes(start, exposureA, exposureB, 'ours').lighting!.exposure).toBe(2);
    expect(mergeScenes(start, exposureA, exposureB, 'theirs').lighting!.exposure).toBe(3);
  });

  it('keeps lighting created on one side, alongside the other side’s edits', () => {
    const created = lit({ ...studio, exposure: 2 });
    const moved = change(base, 'b', { position: [0, 9, 0] });
    for (const prefer of ['ours', 'theirs'] as const) {
      for (const [x, y] of [
        [created, moved],
        [moved, created],
      ]) {
        const merged = mergeScenes(base, x, y, prefer);
        expect(merged.lighting).toEqual(created.lighting);
        expect(find(merged, 'b')!.position).toEqual([0, 9, 0]);
      }
    }
    expect('lighting' in mergeScenes(base, moved, base)).toBe(false);
    const other = lit(presetLighting('soft'));
    expect(mergeScenes(base, created, other, 'ours').lighting).toEqual(created.lighting);
    expect(mergeScenes(base, created, other, 'theirs').lighting).toEqual(other.lighting);
  });

  it('lets the preferred side decide between resetting and editing lighting', () => {
    const reset = unlit(start);
    const edited = lit({ ...studio, ambient: 2 });
    expect('lighting' in mergeScenes(start, reset, edited, 'ours')).toBe(false);
    expect(mergeScenes(start, reset, edited, 'theirs').lighting).toEqual(edited.lighting);
    expect('lighting' in mergeScenes(start, reset, start)).toBe(false);
  });

  it('undoes and redoes creating, editing, and removing lighting', () => {
    const creating = diffScenes(base, start);
    expect(creating).toHaveLength(1);
    const uncreated = applyPatch(start, creating, 'undo');
    expect(uncreated.changed).toBe(true);
    expect('lighting' in uncreated.scene).toBe(false);
    expect(applyPatch(uncreated.scene, creating, 'redo').scene.lighting).toEqual(studio);

    const edited = lit(addLight(updateLight(studio, 'rim', { enabled: false }), 'point')!.lighting);
    const editing = diffScenes(start, {
      ...edited,
      lighting: { ...edited.lighting!, exposure: 2 },
    });
    const after = applyPatch(start, editing, 'redo').scene;
    expect(after.lighting).toEqual({ ...edited.lighting, exposure: 2 });
    expect(applyPatch(after, editing, 'undo').scene.lighting).toEqual(studio);
    expect('id' in applyPatch(after, editing, 'undo').scene.lighting!).toBe(false);

    const removed = unlit(start);
    const removing = diffScenes(start, removed);
    const back = applyPatch(removed, removing, 'undo').scene;
    expect(back.lighting).toEqual(studio);
    expect('lighting' in applyPatch(back, removing, 'redo').scene).toBe(false);
  });

  it('keeps a lighting setting someone else changed since', () => {
    const mine = lit({ ...studio, exposure: 2, ambient: 3 });
    const patch = diffScenes(start, mine);
    const later = lit({ ...mine.lighting!, exposure: 0.5 });
    expect(applyPatch(later, patch, 'undo').scene.lighting).toEqual({ ...studio, exposure: 0.5 });
    const removedSince = unlit(mine);
    const undone = applyPatch(removedSince, patch, 'undo');
    expect(undone.changed).toBe(false);
    expect('lighting' in undone.scene).toBe(false);
  });

  it('joins the changes of a slider drag into one step', () => {
    const one = lit({ ...studio, exposure: 1.1 });
    const two = lit({ ...studio, exposure: 1.4 });
    const fromNothing = composePatches(diffScenes(base, one), diffScenes(one, two));
    expect(fromNothing).toHaveLength(1);
    expect('lighting' in applyPatch(two, fromNothing, 'undo').scene).toBe(false);
    const edits = composePatches(diffScenes(start, one), diffScenes(one, two));
    expect(applyPatch(two, edits, 'undo').scene.lighting).toEqual(studio);
    expect(composePatches(diffScenes(base, start), diffScenes(start, base))).toEqual([]);
  });

  it('is not part of what an agent is told changed', () => {
    const lighting = summarizePatch(diffScenes(base, lit({ ...studio, exposure: 3 })));
    expect(lighting).toEqual({
      partsAdded: [],
      partsChanged: [],
      partsRemoved: [],
      joints: [],
      constraints: [],
      renamed: false,
    });
  });

  it('reuses the previous scene when lighting is equal, and not when it changed', () => {
    const copy = { ...start, lighting: structuredClone(studio) };
    expect(keepUnchanged(start, copy)).toBe(start);
    expect(keepUnchanged(base, { ...base })).toBe(base);
    const brighter = keepUnchanged(start, lit({ ...studio, exposure: 2 }));
    expect(brighter).not.toBe(start);
    expect(brighter.lighting!.exposure).toBe(2);
    brighter.parts.forEach((p, i) => expect(p).toBe(start.parts[i]));
    const reset = keepUnchanged(start, unlit(copy));
    expect(reset).not.toBe(start);
    expect('lighting' in reset).toBe(false);
    const created = keepUnchanged(base, copy);
    expect(created).not.toBe(base);
    expect(created.lighting).toEqual(studio);
    // A part change keeps the lighting object, so lights need not be rebuilt.
    const moved = keepUnchanged(start, change(copy, 'a', { position: [1, 0, 0] }));
    expect(moved).not.toBe(start);
    expect(moved.lighting).toBe(start.lighting);
    const removedLight = keepUnchanged(start, lit(removeLight(studio, 'rim')));
    expect(removedLight.lighting!.lights.map((l) => l.id)).toEqual(['key', 'fill']);
  });

  it('comes back from the live view equal, so the view keeps its objects', () => {
    const local = change(lit(addLight(studio, 'point')!.lighting), 'a', {
      displayColor: '#abcdef',
    });
    const received = parseSceneDocument(
      JSON.parse(JSON.stringify(sharedScene(local))),
      2,
      (key) => {
        expect(key).toBe(geometry.uuid);
        return geometry;
      },
    );
    expect(received.lighting).toEqual(local.lighting);
    expect(received.lighting).not.toBe(local.lighting);
    expect(find(received, 'a')!.displayColor).toBe('#abcdef');
    expect(keepUnchanged(local, received)).toBe(local);
    // A merge result carries a cleared color as undefined, which the wire drops.
    const cleared = mergeScenes(local, change(local, 'a', { displayColor: undefined }), local);
    const back = parseSceneDocument(
      JSON.parse(JSON.stringify(sharedScene(cleared))),
      2,
      () => geometry,
    );
    expect('displayColor' in find(back, 'a')!).toBe(false);
    expect(keepUnchanged(cleared, back)).toBe(cleared);
  });

  it('survives reconciling and travels to the live view', () => {
    expect(reconcile(start).lighting).toBe(start.lighting);
    expect(sharedScene(start).lighting).toEqual(studio);
    expect('lighting' in sharedScene(base)).toBe(false);
  });
});
