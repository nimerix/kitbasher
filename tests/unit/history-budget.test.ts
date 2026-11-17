import { afterEach, describe, expect, it } from 'vitest';
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

const initial = useEditor.getState();
afterEach(() => useEditor.setState(initial));

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

  it('trims the shared document history over budget', () => {
    const doc = new SharedDocument(1024 * 1024);
    const first = sceneOf(mesh(100_000));
    doc.replace(first);
    for (let i = 0; i < 6; i++) {
      const before = doc.scene;
      useEditor.setState((state) => ({
        scene: { ...before, parts: [part('p0', mesh(100_000 + i))] },
        revision: state.revision + 1,
      }));
      doc.commit('agent', before);
    }
    expect(doc.counts('agent').undo).toBeLessThan(6);
    expect(doc.counts('agent').undo).toBeGreaterThanOrEqual(1);
    expect(doc.version).toBe(7);
  });
});
