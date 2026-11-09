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
  summarizePatch,
} from '../../src/core/sync';
import { anchorError } from '../../src/core/constraints';
import type { Joint, Part, PlaneConstraint, SceneDocument } from '../../src/core/types';

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
