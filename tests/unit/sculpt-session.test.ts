import { BoxGeometry } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { EditConflict, SharedDocument } from '../../mcp/document';
import type { SculptStrokeCommit } from '../../src/core/sculpt-session';
import {
  restoreSculptAfterRefusal,
  stopSharedSculptHistory,
  useEditor,
  useSharedHistory,
  useSharedSculptQueueGuard,
} from '../../src/core/store';
import type { Part, SceneDocument } from '../../src/core/types';

function fixture() {
  const part: Part = {
    id: 'sculpt-target',
    name: 'Sculpt target',
    geometry: new BoxGeometry(),
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    color: '#ffffff',
    visible: true,
    locked: false,
    source: 'test.stl',
  };
  const scene: SceneDocument = { name: 'Sculpt', parts: [part], joints: [] };
  return { part, scene };
}

function openSculpt() {
  const { part, scene } = fixture();
  useEditor.getState().setScene(scene);
  useEditor.getState().select(part.id);
  expect(useEditor.getState().startSculpt()).toBe(true);
  return { part, scene };
}

function stroke(patch: Partial<SculptStrokeCommit>): SculptStrokeCommit {
  const state = useEditor.getState();
  const part = state.scene.parts[0];
  return {
    ...part,
    partId: part.id,
    source: part.geometry,
    epoch: state.sceneEpoch,
    revision: state.sculpt!.revision,
    geometry: null,
    mask: state.sculpt!.mask,
    ...patch,
  };
}

afterEach(() => {
  useSharedHistory(null);
  useSharedSculptQueueGuard(null);
  useEditor.setState({ sharedHistory: null });
  useEditor.getState().setScene({ name: 'Empty', parts: [], joints: [] });
});

describe('sculpt session', () => {
  it('steps through temporary masks and geometry together while preserving committed history', () => {
    const { part, scene } = openSculpt();
    const store = useEditor.getState;
    store().changeSculptMask('invert');
    const firstMask = store().sculpt!.mask;
    const geometry = part.geometry.clone();
    const newMask = new Float32Array(geometry.getAttribute('position').count).fill(0.25);
    expect(store().commitSculpt(stroke({ geometry, mask: newMask }))).toBe(true);
    store().changeSculptMask('clear');
    expect(store().revision - store().savedRevision).toBe(1);
    expect(store().past).toEqual([scene]);
    store().undo();
    expect(store().sculpt!.mask).toBe(newMask);
    expect(store().scene.parts[0].geometry).toBe(geometry);
    store().undo();
    expect(store().sculpt!.mask).toBe(firstMask);
    expect(store().scene.parts[0].geometry).toBe(part.geometry);
    store().undo();
    expect(store().sculpt!.mask).toBeNull();
    store().redo();
    store().redo();
    expect(store().sculpt!.mask).toBe(newMask);
    expect(store().scene.parts[0].geometry).toBe(geometry);
    store().redo();
    expect(store().sculpt!.mask).toBeNull();
    store().setTool('select');
    expect(store().sculpt).toBeNull();
    store().undo();
    expect(store().scene.parts[0].geometry).toBe(part.geometry);
  });

  it('remembers settings per brush and rejects a cancelled or moved stroke', () => {
    const { part } = openSculpt();
    const store = useEditor.getState;
    store().setSculptSettings({ radius: 7 });
    store().setSculptBrush('crease');
    store().setSculptSettings({ pinch: 0.9 });
    store().setSculptBrush('draw');
    expect(store().sculpt!.settings.radius).toBe(7);
    store().resetSculptBrush();
    expect(store().sculpt!.settings.radius).toBe(store().sculpt!.defaultRadius);
    store().setSculptBrush('crease');
    expect(store().sculpt!.settings.pinch).toBe(0.9);
    const stale = stroke({ geometry: part.geometry.clone() });
    store().cancelSculptStroke();
    expect(store().commitSculpt(stale)).toBe(false);
    const moved = stroke({ geometry: part.geometry.clone() });
    store().receiveScene({ ...store().scene, parts: [{ ...part, position: [1, 0, 0] }] });
    expect(store().commitSculpt(moved)).toBe(false);
    expect(store().past).toHaveLength(0);
  });

  it('leaves the mesh and weights unchanged when the shared stroke queue is full', () => {
    const { part, scene } = openSculpt();
    const store = useEditor.getState;
    useSharedSculptQueueGuard(() => false);
    store().changeSculptMask('invert');
    const session = store().sculpt;
    expect(store().commitSculpt(stroke({ geometry: part.geometry.clone(), mask: null }))).toBe(
      false,
    );
    expect(store().scene).toBe(scene);
    expect(store().sculpt).toBe(session);
    expect(store().toast?.message).toMatch(/pending sculpt strokes/);
  });

  it('restores the appropriate weights on shared undo, redo, and refusal', () => {
    const { part, scene } = openSculpt();
    const store = useEditor.getState;
    const geometry = part.geometry.clone();
    const next = { ...scene, parts: [{ ...part, geometry }] };
    store().changeSculptMask('invert');
    const initialMask = store().sculpt!.mask;
    expect(store().commitSculpt(stroke({ geometry, mask: null }))).toBe(true);

    useEditor.setState({ sharedHistory: { undo: 2, redo: 0 } });
    let ordinaryUndo = false;
    useSharedHistory({
      undo: () => {
        if (ordinaryUndo) store().receiveScene(scene);
        else {
          const pending = store().sculpt!.pending!.id;
          store().receiveScene({ ...next, name: 'Ordinary change reverted' });
          stopSharedSculptHistory(true, pending);
          ordinaryUndo = true;
        }
      },
      redo: () => store().receiveScene(next),
    });
    store().undo();
    expect(store().sculpt!.pending).toBeNull();
    expect(store().sculpt!.past).toHaveLength(2);
    expect(store().scene.parts[0].geometry).toBe(geometry);
    store().undo();
    expect(store().sculpt!.mask).toBe(initialMask);
    expect(store().scene.parts[0].geometry).toBe(part.geometry);
    store().redo();
    expect(store().sculpt!.mask).toBeNull();
    expect(store().scene.parts[0].geometry).toBe(geometry);

    const refused = store().sculpt;
    store().receiveScene(scene);
    restoreSculptAfterRefusal(scene, refused);
    expect(store().sculpt!.mask).toBe(initialMask);
    expect(store().sculpt!.past).toHaveLength(1);
    expect(store().sculpt!.future).toHaveLength(0);
  });
});

describe('shared sculpt transactions', () => {
  it('rejects stale geometry and pose while preserving other authors’ changes', () => {
    const { part, scene } = fixture();
    const document = new SharedDocument();
    document.replace(scene);
    const first = document.version;
    const geometry = part.geometry.clone();
    const target = {
      partId: part.id,
      source: part.geometry.uuid,
      position: part.position,
      quaternion: part.quaternion,
      scale: part.scale,
    };
    const edit = {
      scene: { ...scene, parts: [{ ...part, geometry }] },
      base: first,
      epoch: document.epoch,
      checkpoint: true,
      sculpt: target,
    };
    document.apply('another-tab', {
      ...edit,
      sculpt: undefined,
      scene: { ...scene, name: 'Renamed' },
    });
    document.apply('sculpt-tab', edit);
    expect(document.scene.name).toBe('Renamed');
    expect(document.scene.parts[0].geometry).toBe(geometry);
    const installed = document.version;
    expect(document.apply('sculpt-tab', edit)).toBe(installed);
    expect(document.counts('sculpt-tab').undo).toBe(1);
    expect(() =>
      document.apply('sculpt-tab', {
        ...edit,
        scene: { ...scene, parts: [{ ...part, geometry: geometry.clone() }] },
      }),
    ).toThrow(EditConflict);
    document.undo('sculpt-tab');
    const base = document.version;
    document.apply('another-tab', {
      ...edit,
      base,
      sculpt: undefined,
      scene: { ...document.scene, parts: [{ ...part, position: [1, 0, 0] }] },
    });
    expect(() => document.apply('sculpt-tab', { ...edit, base })).toThrow(EditConflict);
    expect(document.scene.parts[0].position).toEqual([1, 0, 0]);
    expect(document.scene.parts[0].geometry).toBe(part.geometry);
  });
});
