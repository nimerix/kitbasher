import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, BufferAttribute, BufferGeometry } from 'three';
import { SharedDocument } from '../../mcp/document';
import { geometryBytes, trimHistory } from '../../src/core/history-budget';
import { useEditor } from '../../src/core/store';
import type { Part, SceneDocument } from '../../src/core/types';

function mesh(floats: number, shared?: BufferGeometry) {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(floats), 3));
  if (shared) geometry.setAttribute('color', shared.getAttribute('position'));
  return geometry;
}
const part = (id: string, geometry: BufferGeometry): Part => ({
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
});
const sceneOf = (...geometries: BufferGeometry[]): SceneDocument => ({
  name: 's',
  parts: geometries.map((g, i) => part(`p${i}`, g)),
  joints: [],
});

const tiny = vi.hoisted(() => ({ on: false }));
vi.mock('../../src/core/history-budget', async (original) => {
  const actual = await original<typeof import('../../src/core/history-budget')>();
  return {
    ...actual,
    trimHistory: (...args: Parameters<typeof actual.trimHistory>) =>
      actual.trimHistory(args[0], args[1], args[2], tiny.on ? 1 : args[3]),
  };
});

const initial = useEditor.getState();
afterEach(() => {
  tiny.on = false;
  useEditor.setState(initial);
});

describe('history budget', () => {
  it('counts shared arrays once', () => {
    const a = mesh(300);
    const b = mesh(30, a);
    expect(geometryBytes([a, b, a])).toBe(1200 + 120);
    expect(geometryBytes([a, b], new Set([a.getAttribute('position').array]))).toBe(120);
  });

  it('does not trim below budget', () => {
    const past = [sceneOf(mesh(300)), sceneOf(mesh(300))];
    const result = trimHistory(past, [], [sceneOf(mesh(3))], 10_000);
    expect(result.trimmed).toBe(false);
    expect(result.past).toEqual(past);
  });

  it('drops oldest past entries first and keeps the newest', () => {
    const past = [sceneOf(mesh(300)), sceneOf(mesh(300)), sceneOf(mesh(300))];
    const future = [sceneOf(mesh(300))];
    const two = trimHistory(past, future, [sceneOf(mesh(3))], 3700);
    expect(two.past).toEqual(past.slice(1));
    expect(two.future).toEqual(future);
    const none = trimHistory(past, future, [sceneOf(mesh(3))], 1);
    expect(none.past).toEqual([past[2]]);
    expect(none.future).toEqual([]);
    const reachable = trimHistory(past, [], [past[0]], 1);
    expect(reachable.past).toEqual([past[2]]);
  });

  it('leaves history untouched for transform-only checkpoints', () => {
    const scene = sceneOf(new BoxGeometry(1, 1, 1));
    useEditor.getState().setScene(scene);
    for (let i = 0; i < 41; i++) useEditor.getState().transform('p0', { position: [i + 1, 0, 0] });
    const state = useEditor.getState();
    expect(state.past.length).toBe(40);
    expect(state.historyTrimNotified).toBe(false);
    expect(state.toast).toBeNull();
  });

  it('trims history and notifies once when geometry checkpoints exceed the budget', () => {
    tiny.on = true;
    const notice = 'Undo history was shortened to free memory.';
    useEditor.getState().setScene(sceneOf(mesh(30)));
    for (let i = 0; i < 4; i++) useEditor.getState().patchParts(['p0'], { geometry: mesh(30 + i) });
    let state = useEditor.getState();
    expect(state.past.length).toBe(1);
    expect(state.historyTrimNotified).toBe(true);
    expect(state.toast?.message).toBe(notice);
    const id = state.toast!.id;
    useEditor.getState().patchParts(['p0'], { geometry: mesh(99) });
    state = useEditor.getState();
    expect(state.toast!.id).toBe(id);
    useEditor.getState().setScene(sceneOf(mesh(30)));
    expect(useEditor.getState().historyTrimNotified).toBe(false);
  });

  it('keeps undo steps when Cut retains the removed meshes in the new clipboard', () => {
    tiny.on = true;
    useEditor.getState().setScene(sceneOf(mesh(30), mesh(30)));
    useEditor.getState().renameScene('first change');
    useEditor.getState().renameScene('second change');
    useEditor.setState({ selected: ['p0', 'p1'] });
    useEditor.getState().copySelected(true);
    expect(useEditor.getState().clipboard?.parts).toHaveLength(2);
    expect(useEditor.getState().past).toHaveLength(3);
  });

  it('trims the shared document history and frees adopted uploads when dropped', () => {
    const doc = new SharedDocument(1024 * 1024);
    doc.replace(sceneOf(mesh(100_000)));
    const uuids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const before = doc.scene;
      const geometry = mesh(100_000 + i);
      uuids.push(geometry.uuid);
      doc.addMesh(geometry.uuid, geometry);
      useEditor.setState((state) => ({
        scene: { ...before, parts: [part('p0', geometry)] },
        revision: state.revision + 1,
      }));
      doc.commit('agent', before);
    }
    const internal = doc as unknown as {
      meshes: Map<string, BufferGeometry>;
      versions: Map<number, SceneDocument>;
    };
    expect(doc.counts('agent').undo).toBeLessThan(6);
    expect(doc.counts('agent').undo).toBeGreaterThanOrEqual(1);
    expect(doc.version).toBe(7);
    expect(internal.versions.has(7)).toBe(true);
    const reachable = new Set<string>();
    for (const scene of internal.versions.values())
      for (const p of scene.parts) reachable.add(p.geometry.uuid);
    expect(internal.versions.size).toBeLessThan(7);
    const dropped = uuids.filter((id) => !reachable.has(id));
    expect(dropped.length).toBeGreaterThan(0);
    for (const id of dropped) expect(internal.meshes.has(id)).toBe(false);
    expect(internal.meshes.has(doc.scene.parts[0].geometry.uuid)).toBe(true);
  });

  it('trims deleted geometry while still reporting unseen changes', () => {
    const doc = new SharedDocument(1);
    const start = sceneOf(mesh(30), mesh(30));
    doc.replace(start);
    const seen = doc.version;
    for (const id of ['p0', 'p1']) {
      const before = doc.scene;
      useEditor.setState({ scene: { ...before, parts: before.parts.filter((p) => p.id !== id) } });
      doc.commit('browser', before);
    }
    expect(doc.counts('browser').undo).toBe(1);
    expect(doc.mesh(start.parts[0].geometry.uuid)).toBeUndefined();
    expect(doc.changesSince(seen, 'agent')).toEqual({ parts_removed: ['p0', 'p1'] });
  });
});
