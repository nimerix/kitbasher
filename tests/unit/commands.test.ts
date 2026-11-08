import { beforeEach, describe, expect, it } from 'vitest';
import { BoxGeometry } from 'three';
import { captureComponents, instantiateComponents } from '../../src/core/clipboard';
import { editorCommands, executeEditorCommand, shortcutCommand } from '../../src/core/commands';
import { useEditor } from '../../src/core/store';
import { anchorError } from '../../src/core/constraints';
import type { Part, SceneDocument } from '../../src/core/types';

function fixture(): SceneDocument {
  const part = (id: string, x: number, locked = false): Part => ({
    id,
    name: id,
    position: [x, 0, 0],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    geometry: new BoxGeometry(10, 10, 10),
    source: 'test',
    color: '#c0ffee',
    visible: true,
    locked,
    pivot: [1, 2, 3],
  });
  return {
    name: 'Clipboard test',
    parts: [part('a', 0), part('b', 10), part('fixed', 30, true)],
    joints: [
      {
        id: 'a-b',
        name: 'Contact',
        parentId: 'a',
        childId: 'b',
        parentAnchor: [5, 0, 0],
        childAnchor: [-5, 0, 0],
        restRotation: [0, 0, 0, 1],
        rotationLocks: [false, true, true],
        keepConnected: true,
      },
    ],
  };
}

beforeEach(() => {
  useEditor.getState().setScene(fixture());
  useEditor.setState({ selected: ['a', 'b'], clipboard: null, busy: null, contextMenu: null });
});

describe('component clipboard and selection', () => {
  it('selects every component, including hidden and locked parts, without editing the scene', () => {
    const state = useEditor.getState();
    state.patchParts(['a'], { visible: false });
    const revision = useEditor.getState().revision;
    executeEditorCommand('selectAll');
    expect(useEditor.getState().selected).toEqual(['a', 'b', 'fixed']);
    expect(useEditor.getState().revision).toBe(revision);
    executeEditorCommand('deselect');
    expect(useEditor.getState().selected).toEqual([]);
  });
  it('preserves internal joint constraints and part pivots with fresh ids on repeated pastes', () => {
    const scene = useEditor.getState().scene;
    executeEditorCommand('copy');
    const revision = useEditor.getState().revision;
    executeEditorCommand('paste');
    const first = useEditor.getState();
    const copies = first.scene.parts.filter((part) => first.selected.includes(part.id));
    const joint = first.scene.joints.at(-1)!;
    expect(copies).toHaveLength(2);
    expect(copies[0].position).toEqual([12, 0, 0]);
    expect(copies[0].pivot).toEqual([1, 2, 3]);
    expect(copies[0].geometry).toBe(scene.parts[0].geometry);
    expect(joint.parentId).toBe(copies[0].id);
    expect(joint.childId).toBe(copies[1].id);
    expect(joint.rotationLocks).toEqual([false, true, true]);
    expect(anchorError(copies, joint)).toBeCloseTo(0);
    expect(first.revision).toBe(revision + 1);
    executeEditorCommand('paste');
    const second = useEditor.getState();
    expect(second.selected.some((id) => first.selected.includes(id))).toBe(false);
    expect(second.scene.parts.at(-2)?.position).toEqual([24, 0, 0]);
    expect(second.scene.parts.at(-2)?.name).toBe('a copy 2');
    expect(scene.parts.map((part) => part.position[0])).toEqual([0, 10, 30]);
  });
  it('snapshots mutable transforms, leaves external joints behind, and preserves paused joints', () => {
    const scene = fixture();
    scene.joints[0].keepConnected = false;
    const clipboard = captureComponents(scene, ['a', 'b']);
    scene.parts[0].position[0] = 400;
    scene.parts[0].pivot![0] = 900;
    scene.joints[0].rotationLocks[0] = true;
    const copies = instantiateComponents(clipboard, []);
    expect(copies.parts[0].position).toEqual([12, 0, 0]);
    expect(copies.parts[0].pivot).toEqual([1, 2, 3]);
    expect(copies.joints[0].rotationLocks[0]).toBe(false);
    expect(copies.joints[0].keepConnected).toBe(false);
    expect(captureComponents(scene, ['b']).joints).toEqual([]);
  });
  it('cuts only unlocked components and restores the cut in place, with undoable scene edits', () => {
    useEditor.setState({ selected: ['a', 'fixed'] });
    executeEditorCommand('cut');
    const cut = useEditor.getState();
    expect(cut.scene.parts.map((part) => part.id)).toEqual(['b', 'fixed']);
    expect(cut.clipboard?.parts.map((part) => part.id)).toEqual(['a']);
    expect(cut.selected).toEqual(['fixed']);
    expect(cut.scene.joints).toHaveLength(0);
    executeEditorCommand('paste');
    expect(useEditor.getState().scene.parts.at(-1)?.position).toEqual([0, 0, 0]);
    expect(useEditor.getState().scene.parts.at(-1)?.name).toBe('a');
    executeEditorCommand('undo');
    executeEditorCommand('undo');
    expect(useEditor.getState().scene.parts.map((part) => part.id)).toEqual(['a', 'b', 'fixed']);
    expect(useEditor.getState().scene.joints).toHaveLength(1);
    expect(useEditor.getState().clipboard?.parts).toHaveLength(1);
    executeEditorCommand('redo');
    expect(useEditor.getState().scene.parts).toHaveLength(2);
  });
  it('duplicates an entire selected subassembly without replacing the clipboard', () => {
    useEditor.getState().select('fixed');
    executeEditorCommand('copy');
    useEditor.setState({ selected: ['a', 'b'] });
    executeEditorCommand('duplicate');
    expect(useEditor.getState().scene.joints).toHaveLength(2);
    expect(useEditor.getState().clipboard?.parts[0].id).toBe('fixed');
    executeEditorCommand('undo');
    expect(useEditor.getState().scene.parts).toHaveLength(3);
    expect(useEditor.getState().scene.joints).toHaveLength(1);
  });
  it('isolates in one history step, can show all again, and enables commands for the actual selection', () => {
    useEditor.getState().select('b');
    expect(editorCommands().merge.enabled).toBe(false);
    executeEditorCommand('isolate');
    expect(useEditor.getState().past).toHaveLength(1);
    expect(
      useEditor
        .getState()
        .scene.parts.filter((part) => part.visible)
        .map((part) => part.id),
    ).toEqual(['b']);
    executeEditorCommand('showAll');
    expect(useEditor.getState().scene.parts.every((part) => part.visible)).toBe(true);
    executeEditorCommand('undo');
    expect(
      useEditor
        .getState()
        .scene.parts.filter((part) => part.visible)
        .map((part) => part.id),
    ).toEqual(['b']);
    executeEditorCommand('undo');
    expect(useEditor.getState().scene.parts.every((part) => part.visible)).toBe(true);
    useEditor.getState().select('fixed');
    expect(editorCommands().cut.enabled).toBe(false);
    expect(editorCommands().delete.enabled).toBe(false);
    expect(editorCommands().copy.enabled).toBe(true);
  });
  it('preserves a multiselection when opening on one of its parts and targets a different part explicitly', () => {
    useEditor.getState().openContextMenu({ x: 10, y: 20, partId: 'b' });
    expect(useEditor.getState().selected).toEqual(['a', 'b']);
    useEditor.getState().openContextMenu({ x: 10, y: 20, partId: 'fixed' });
    expect(useEditor.getState().selected).toEqual(['fixed']);
    useEditor.getState().closeContextMenu();
    expect(useEditor.getState().contextMenu).toBeNull();
  });
  it('disables destructive commands during a geometry worker operation', () => {
    executeEditorCommand('copy');
    useEditor.setState({ busy: 'Merging' });
    const revision = useEditor.getState().revision;
    for (const id of ['paste', 'delete', 'duplicate', 'cut', 'undo'] as const)
      executeEditorCommand(id);
    expect(useEditor.getState().revision).toBe(revision);
  });
});

describe('standard OS shortcuts', () => {
  const base = { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
  for (const modifier of ['metaKey', 'ctrlKey'] as const) {
    it(`maps ${modifier} combinations without turning them into tool keys`, () => {
      const event = { ...base, [modifier]: true };
      expect(shortcutCommand({ ...event, key: 'a' })).toBe('selectAll');
      expect(shortcutCommand({ ...event, key: 'A', shiftKey: true })).toBe('deselect');
      expect(shortcutCommand({ ...event, key: 'c' })).toBe('copy');
      expect(shortcutCommand({ ...event, key: 'x' })).toBe('cut');
      expect(shortcutCommand({ ...event, key: 'v' })).toBe('paste');
      expect(shortcutCommand({ ...event, key: 'Z', shiftKey: true })).toBe('redo');
      expect(shortcutCommand({ ...event, key: 'y' })).toBe('redo');
      expect(shortcutCommand({ ...event, key: 'I', shiftKey: true })).toBeNull();
      expect(shortcutCommand({ ...event, key: 'a', altKey: true })).toBeNull();
      expect(shortcutCommand({ ...event, key: 'r' })).toBeNull();
    });
  }
  it('leaves ordinary tool keys alone and recognizes rename/help function keys', () => {
    expect(shortcutCommand({ ...base, key: 'a' })).toBeNull();
    expect(shortcutCommand({ ...base, key: 'F2' })).toBe('rename');
    expect(shortcutCommand({ ...base, key: 'F1' })).toBe('help');
  });
});
