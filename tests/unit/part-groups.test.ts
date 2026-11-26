import { BoxGeometry } from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { captureComponents, instantiateComponents } from '../../src/core/clipboard';
import { editorCommands, shortcutCommand } from '../../src/core/commands';
import {
  canGroup,
  canUngroup,
  groupParts,
  partTree,
  renameGroup,
  selectionRange,
  treeOrder,
  ungroupParts,
  withGroups,
} from '../../src/core/part-tree';
import { parseScene, readSceneFile, sceneFileBlob } from '../../src/core/scene-file';
import { useEditor } from '../../src/core/store';
import { applyPatch, diffScenes, mergeScenes, sharedScene } from '../../src/core/sync';
import { parseSceneDocument } from '../../src/core/scene-file';
import type { Part, SceneDocument } from '../../src/core/types';
import { serializeScene } from '../helpers/legacy-scene';

const geometry = new BoxGeometry(10, 10, 10);
const part = (id: string, groupId?: string): Part => ({
  id,
  name: id,
  geometry,
  position: [0, 0, 0],
  quaternion: [0, 0, 0, 1],
  scale: [1, 1, 1],
  color: '#aabbcc',
  visible: true,
  locked: false,
  source: 'test',
  ...(groupId ? { groupId } : {}),
});

/** a, b(g1), c, d(g1), e(g2) */
const grouped = (): SceneDocument => ({
  name: 'Groups',
  parts: [part('a'), part('b', 'g1'), part('c'), part('d', 'g1'), part('e', 'g2')],
  joints: [],
  groups: [
    { id: 'g1', name: 'Arms' },
    { id: 'g2', name: 'Head' },
  ],
});

describe('selecting a range', () => {
  const order = ['a', 'b', 'c', 'd', 'e'];
  it('runs from the anchor to the target either way, the anchor first', () => {
    expect(selectionRange(order, 'b', ['d'])).toEqual(['b', 'c', 'd']);
    expect(selectionRange(order, 'd', ['a'])).toEqual(['d', 'c', 'b', 'a']);
    expect(selectionRange(order, 'c', ['c'])).toEqual(['c']);
  });
  it('reaches the far end of a group, and picks the target alone without an anchor', () => {
    expect(selectionRange(order, 'a', ['b', 'd'])).toEqual(['a', 'b', 'c', 'd']);
    expect(selectionRange(order, 'e', ['b', 'd'])).toEqual(['e', 'd', 'c', 'b']);
    expect(selectionRange(order, 'c', ['b', 'd'])).toEqual(['c', 'b', 'd']);
    expect(selectionRange(order, null, ['c'])).toEqual(['c']);
    expect(selectionRange(order, 'missing', ['c'])).toEqual(['c']);
  });
});

describe('groups', () => {
  it('lists a group where its first part is, with its parts under it', () => {
    const tree = partTree(grouped());
    expect(tree.map((entry) => (entry.kind === 'part' ? entry.part.id : entry.group.id))).toEqual([
      'a',
      'g1',
      'c',
      'g2',
    ]);
    expect(treeOrder(tree)).toEqual(['a', 'b', 'd', 'c', 'e']);
  });
  it('searches part names, and lists every part of a group whose name matches', () => {
    const scene = grouped();
    expect(treeOrder(partTree(scene, 'b'))).toEqual(['b']);
    expect(treeOrder(partTree(scene, 'arms'))).toEqual(['b', 'd']);
    const [entry] = partTree(scene, 'b');
    expect(entry.kind === 'group' && entry.parts.map((p) => p.id)).toEqual(['b', 'd']);
  });
  it('treats a part whose group is missing as ungrouped', () => {
    const scene = { ...grouped(), groups: [{ id: 'g2', name: 'Head' }] };
    expect(treeOrder(partTree(scene))).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(withGroups(scene, ['b'])).toEqual(['b']);
  });
  it('brings along the rest of a group', () => {
    expect(withGroups(grouped(), ['d'])).toEqual(['d', 'b']);
    expect(withGroups(grouped(), ['a', 'e'])).toEqual(['a', 'e']);
  });
  it('groups two or more parts, taking them from their old groups', () => {
    const scene = grouped();
    expect(canGroup(scene, ['a'])).toBe(false);
    expect(canGroup(scene, ['b', 'd'])).toBe(false);
    expect(canGroup(scene, ['b'])).toBe(false);
    expect(canGroup(scene, ['a', 'c'])).toBe(true);
    const result = groupParts(scene, ['d', 'e'])!;
    expect(result.group.name).toBe('Group 1');
    const ids = result.scene.parts.map((p) => p.groupId);
    expect(ids).toEqual([undefined, 'g1', undefined, result.group.id, result.group.id]);
    // Head lost its only part, so it is gone.
    expect(result.scene.groups).toEqual([{ id: 'g1', name: 'Arms' }, result.group]);
    expect(scene.parts[3].groupId).toBe('g1');
  });
  it('names a new group with the next free number', () => {
    const scene = { ...grouped(), groups: [{ id: 'g1', name: 'Group 1' }] };
    expect(groupParts(scene, ['a', 'c'])!.group.name).toBe('Group 2');
  });
  it('ends every group a part is in', () => {
    const scene = grouped();
    expect(canUngroup(scene, ['a', 'c'])).toBe(false);
    expect(ungroupParts(scene, ['a'])).toBeNull();
    const ended = ungroupParts(scene, ['d', 'e'])!;
    expect(ended.parts.some((p) => 'groupId' in p)).toBe(false);
    expect('groups' in ended).toBe(false);
    expect(ungroupParts(scene, ['b'])!.groups).toEqual([{ id: 'g2', name: 'Head' }]);
  });
  it('renames a group, ignoring a blank or unchanged name', () => {
    expect(renameGroup(grouped(), 'g1', '  Limbs ')!.groups![0].name).toBe('Limbs');
    expect(renameGroup(grouped(), 'g1', '  ')).toBeNull();
    expect(renameGroup(grouped(), 'g1', 'Arms')).toBeNull();
    expect(renameGroup(grouped(), 'missing', 'X')).toBeNull();
  });
});

describe('groups in scene files', () => {
  it('saves and opens groups, leaving out groups without parts', async () => {
    const scene = { ...grouped(), groups: [...grouped().groups!, { id: 'g3', name: 'Empty' }] };
    const restored = await readSceneFile(await sceneFileBlob(scene));
    expect(restored.groups).toEqual(grouped().groups);
    expect(restored.parts.map((p) => p.groupId)).toEqual([undefined, 'g1', undefined, 'g1', 'g2']);
    const plain = await readSceneFile(await sceneFileBlob({ ...scene, groups: undefined }));
    expect('groups' in plain).toBe(false);
    expect(plain.parts.some((p) => 'groupId' in p)).toBe(false);
  });
  it('drops bad groups and group ids rather than refusing the scene', () => {
    const file = serializeScene(grouped()) as unknown as Record<string, unknown>;
    file.groups = [{ id: 'g1', name: 'Arms' }, { id: 'g1', name: 'Again' }, { id: 3 }, null];
    (file.parts as Record<string, unknown>[])[4].groupId = 'g2';
    (file.parts as Record<string, unknown>[])[0].groupId = 7;
    const opened = parseScene(JSON.parse(JSON.stringify(file)));
    expect(opened.groups).toEqual([{ id: 'g1', name: 'Arms' }]);
    expect(opened.parts.map((p) => p.groupId)).toEqual([
      undefined,
      'g1',
      undefined,
      'g1',
      undefined,
    ]);
  });
});

describe('groups in shared scenes', () => {
  const shared = (scene: SceneDocument) =>
    parseSceneDocument(JSON.parse(JSON.stringify(sharedScene(scene))), 2, () => geometry);
  it('travels with a shared scene', () => {
    const scene = shared(grouped());
    expect(scene.groups).toEqual(grouped().groups);
    expect(scene.parts[1].groupId).toBe('g1');
  });
  it('undoes grouping and renaming as one step', () => {
    const before = grouped();
    const after = renameGroup(groupParts(before, ['a', 'c'])!.scene, 'g1', 'Limbs')!;
    const patch = diffScenes(before, after);
    const undone = applyPatch(after, patch, 'undo');
    expect(undone.changed).toBe(true);
    expect(undone.scene.groups).toEqual(before.groups);
    expect(undone.scene.parts.map((p) => p.groupId)).toEqual(before.parts.map((p) => p.groupId));
    expect(applyPatch(undone.scene, patch, 'redo').scene).toEqual({ ...after, constraints: [] });
  });
  it('merges a rename on one side with grouping on the other', () => {
    const base = grouped();
    const ours = renameGroup(base, 'g2', 'Optics')!;
    const theirs = groupParts(base, ['a', 'c'])!;
    const merged = mergeScenes(base, ours, theirs.scene);
    expect(merged.groups).toEqual([
      { id: 'g1', name: 'Arms' },
      { id: 'g2', name: 'Optics' },
      theirs.group,
    ]);
    expect(merged.parts.map((p) => p.groupId)).toEqual(theirs.scene.parts.map((p) => p.groupId));
  });
});

describe('copying grouped parts', () => {
  it('pastes a whole group as a new group, named like a copy', () => {
    const scene = grouped();
    const copies = instantiateComponents(captureComponents(scene, ['b', 'd']), scene);
    expect(copies.groups).toHaveLength(1);
    expect(copies.groups[0]).toMatchObject({ name: 'Arms copy' });
    expect(copies.groups[0].id).not.toBe('g1');
    expect(copies.parts.map((p) => p.groupId)).toEqual([copies.groups[0].id, copies.groups[0].id]);
  });
  it('puts copies of part of a group back in that group', () => {
    const scene = grouped();
    const copies = instantiateComponents(captureComponents(scene, ['d', 'a']), scene);
    expect(copies.groups).toEqual([]);
    expect(copies.parts.map((p) => p.groupId)).toEqual([undefined, 'g1']);
  });
  it('restores a cut group under its own name', () => {
    const scene = grouped();
    const clipboard = captureComponents(scene, ['e'], true);
    const remaining = { ...scene, parts: scene.parts.filter((p) => p.id !== 'e') };
    const copies = instantiateComponents(clipboard, remaining);
    expect(copies.groups.map((g) => g.name)).toEqual(['Head']);
    expect(copies.parts[0].groupId).toBe(copies.groups[0].id);
  });
});

describe('group commands', () => {
  beforeEach(() => {
    useEditor.setState({ scene: grouped(), selected: [], past: [], future: [] });
  });
  it('selects a whole group from the viewport and one part from the list', () => {
    const state = useEditor.getState();
    state.select('d', false, true);
    expect(useEditor.getState().selected).toEqual(['d', 'b']);
    state.select('a', true, true);
    expect(useEditor.getState().selected).toEqual(['d', 'b', 'a']);
    state.select('b', true, true);
    expect(useEditor.getState().selected).toEqual(['a']);
    state.select('d');
    expect(useEditor.getState().selected).toEqual(['d']);
  });
  it('groups and ungroups from commands and shortcuts, with undo', () => {
    useEditor.getState().selectParts(['a', 'c']);
    expect(editorCommands().ungroup.enabled).toBe(false);
    expect(
      shortcutCommand({ key: 'g', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false }),
    ).toBe('group');
    editorCommands().group.run();
    const { scene } = useEditor.getState();
    expect(scene.groups!.map((g) => g.name)).toEqual(['Arms', 'Head', 'Group 1']);
    expect(editorCommands().group.enabled).toBe(false);
    expect(
      shortcutCommand({ key: 'G', metaKey: true, ctrlKey: false, shiftKey: true, altKey: false }),
    ).toBe('ungroup');
    editorCommands().ungroup.run();
    expect(useEditor.getState().scene.groups!.map((g) => g.name)).toEqual(['Arms', 'Head']);
    useEditor.getState().undo();
    expect(useEditor.getState().scene).toBe(scene);
  });
});
