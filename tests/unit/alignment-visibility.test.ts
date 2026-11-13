import { beforeEach, describe, expect, it } from 'vitest';
import { BoxGeometry } from 'three';
import { alignmentPartDisplay, partDisplay } from '../../src/core/alignment-visibility';
import { useEditor } from '../../src/core/store';
import type { AlignmentView, Part, SurfacePoint } from '../../src/core/types';

const state = () => useEditor.getState();
const pick = (partId: string): SurfacePoint => ({ partId, point: [0, 0, 8], normal: [0, 0, 1] });
const display = () => state().scene.parts.map((part) => partDisplay(state(), part.id));
const view = (view: AlignmentView) => state().setOperation({ view });

beforeEach(() => {
  state().setScene({
    name: 'Alignment visibility',
    parts: ['a', 'b', 'c'].map((id, i): Part => ({
      id,
      name: id,
      geometry: new BoxGeometry(16, 16, 16),
      position: [i * 20, 20, 0],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
      color: '#c7a48c',
      visible: true,
      locked: false,
      source: 'test',
    })),
    joints: [],
  });
  state().setView({ clip: { enabled: false, overlap: 0.1 } });
  useEditor.setState({ selected: ['a', 'b'] });
  state().setTool('align');
});

describe('alignment visibility', () => {
  it('isolates the chosen pair without editing the scene or the previous isolation', () => {
    state().isolate(['c']);
    const before = state();
    view('pair');
    expect(display()).toEqual(['solid', 'solid', 'hidden']);
    expect(state().scene).toBe(before.scene);
    expect(state().revision).toBe(before.revision);
    expect(state().past).toBe(before.past);
    expect(state().isolated).toBe(before.isolated);
    view('scene');
    expect(display()).toEqual(['hidden', 'hidden', 'solid']);
  });

  it.each(['point', 'point-plane', 'plane'] as const)(
    'follows the active %s pick and shows both parts when the pair is complete',
    (mode) => {
      state().setOperation({ mode, view: 'active' });
      expect(display()).toEqual(['solid', 'hidden', 'hidden']);
      state().pick(pick('b'));
      expect(state().operation.pending).toBeNull();
      state().pick(pick('a'));
      expect(display()).toEqual(['hidden', 'solid', 'hidden']);
      state().setOperation({ pending: null });
      expect(display()).toEqual(['solid', 'hidden', 'hidden']);
      state().pick(pick('a'));
      state().pick(pick('b'));
      expect(display()).toEqual(['solid', 'solid', 'hidden']);
      state().resetPicks();
      expect(display()).toEqual(['solid', 'hidden', 'hidden']);
    },
  );

  it('cycles through every multi-point pair, including additional best-fit points', () => {
    state().setOperation({ mode: 'multi', view: 'ghost' });
    for (let i = 0; i < 4; i++) {
      expect(display()).toEqual(['solid', 'ghost', 'hidden']);
      state().pick(pick('a'));
      expect(display()).toEqual(['ghost', 'solid', 'hidden']);
      state().pick(pick('c'));
      expect(state().operation.pending?.partId).toBe('a');
      state().pick(pick('b'));
    }
    expect(state().operation.pairs).toHaveLength(4);
    expect(display()).toEqual(['solid', 'ghost', 'hidden']);
    state().setTool('align');
    expect(state().operation.pairs).toHaveLength(4);
    expect(state().operation.view).toBe('ghost');
  });

  it('changing views preserves picks, and changing either part starts with the moving part', () => {
    state().pick(pick('a'));
    const pending = state().operation.pending;
    for (const value of ['pair', 'active', 'ghost', 'scene'] as const) {
      view(value);
      expect(state().operation.pending).toBe(pending);
    }
    state().setOperation({ view: 'ghost', targetId: 'c' });
    expect(display()).toEqual(['solid', 'hidden', 'ghost']);
    expect(state().operation.pending).toBeNull();
    state().setOperation({ sourceId: 'b' });
    expect(display()).toEqual(['hidden', 'solid', 'ghost']);
  });

  it('falls back to the normal view until two parts are known, including plane targets', () => {
    view('active');
    for (const targetId of [null, 'plane-xy', 'a']) {
      state().setOperation({ targetId });
      expect(display()).toEqual(['solid', 'solid', 'solid']);
      expect(alignmentPartDisplay('align', state().operation, 'plane-xy')).toBeNull();
    }
    state().setOperation({ targetId: 'b' });
    expect(display()).toEqual(['solid', 'hidden', 'hidden']);
    state().select('b');
    state().deleteSelected();
    expect(display()).toEqual(['solid', 'solid']);
  });

  it.each(['cancel', 'apply', 'tool', 'load'] as const)(
    'restores ordinary visibility on %s without changing saved visibility flags',
    (end) => {
      state().patchParts(['c'], { visible: false });
      state().isolate(['a']);
      view('ghost');
      state().pick(pick('a'));
      state().pick(pick('b'));
      if (end === 'apply') {
        state().applyAlignment();
        expect(state().tool).toBe('select');
        state().undo();
      } else if (end === 'load') state().setScene(state().scene);
      else state().setTool(end === 'cancel' ? 'select' : 'measure');
      expect(state().scene.parts.map((p) => p.visible)).toEqual([true, true, false]);
      expect(alignmentPartDisplay(state().tool, state().operation, 'b')).toBeNull();
      expect(state().isolated).toEqual(end === 'load' ? null : ['a']);
    },
  );

  it('follows explicit painted patch steps and prevents painting a ghost', () => {
    state().setOperation({ mode: 'surface', view: 'ghost' });
    const id = state().operation.surfacePairs[0].id;
    expect(display()).toEqual(['solid', 'ghost', 'hidden']);
    expect(state().paintSurface(pick('b'), 8, false, true)).toBe(false);
    state().chooseSurface(id, 'target');
    expect(display()).toEqual(['ghost', 'solid', 'hidden']);
    state().setOperation({ activeSurface: null });
    expect(display()).toEqual(['solid', 'solid', 'hidden']);
  });

  it('follows each flush seam target instead of hiding the active neighbor', () => {
    state().setOperation({ mode: 'surface', surfaceMethod: 'flush', view: 'ghost' });
    state().setOperation({
      surfacePairs: [
        { id: 'first', source: { partId: 'a', faces: [0] }, target: { partId: 'b', faces: [0] } },
        { id: 'second', source: { partId: 'a', faces: [1] }, target: { partId: 'c', faces: [1] } },
      ],
      activeSurface: { pairId: 'second', side: 'target' },
    });
    expect(display()).toEqual(['ghost', 'hidden', 'solid']);
    state().chooseSurface('first', 'source');
    expect(display()).toEqual(['solid', 'ghost', 'hidden']);
  });
});
