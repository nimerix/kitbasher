import { afterEach, describe, expect, it, vi } from 'vitest';
import { keyActions } from '../../src/core/keybindings';
import { keyTools } from '../../src/hooks/useWorkbench';
import {
  autoRule,
  endOption,
  extendsGuide,
  featureCounts,
  fittedLabel,
  foldWarning,
  manualStart,
  refineTargets,
  shared,
  skippedWarning,
  targetKey,
} from '../../src/components/refine-panel';
import type { EdgeSolve } from '../../src/core/refine-edge';
import {
  drawingRefineGuide,
  refineSolved,
  useEditor,
  type RefineFeature,
  type RefineSession,
} from '../../src/core/store';
import { boxPart, editor, ready, session, setup, surfacePoint } from '../helpers/refine-session';

const feature = (state: RefineFeature['state']) => ({ state }) as RefineFeature;

describe('Refine wiring', () => {
  it('gives Refine a key no other action uses', () => {
    const used = Object.entries(keyActions)
      .filter(([id]) => id !== 'refine')
      .flatMap(([, a]) => a.keys);
    expect(keyActions.refine.keys).toEqual(['E']);
    expect(used).not.toContain('E');
  });

  it('maps the key action to the tool', () => {
    expect(keyTools.refine).toBe('refine');
  });
});

describe('Refine panel text', () => {
  it('counts accepted and proposed features', () => {
    expect(featureCounts([])).toBe('0 accepted · 0 proposed');
    expect(featureCounts([feature('accepted'), feature('pending'), feature('pending')])).toBe(
      '1 accepted · 2 proposed',
    );
  });

  it('words the fold warning for one triangle and for several', () => {
    expect(foldWarning(1)).toBe('1 triangle folds over. Undo the last step or reduce Width.');
    expect(foldWarning(12)).toBe('12 triangles fold over. Undo the last step or reduce Width.');
  });

  it('words the skipped warning for one triangle and for several', () => {
    expect(skippedWarning(1)).toBe('1 triangle could not be cut cleanly.');
    expect(skippedWarning(3)).toBe('3 triangles could not be cut cleanly.');
  });

  it('names what Auto fitted', () => {
    expect(fittedLabel('cylinder')).toBe('Fits a cylinder');
    expect(fittedLabel('plane')).toBe('Fits a plane');
    expect(fittedLabel('sweep')).toBe('Fits a sweep');
    expect(fittedLabel(null)).toBeNull();
  });

  it('shows what Auto chose for an end once the edge is solved', () => {
    expect(endOption(undefined)).toBe('Auto');
    expect(endOption('taper')).toBe('Auto (Fade)');
    expect(endOption('hold')).toBe('Auto (Hold)');
  });

  it('applies the automatic rule for a setting no solve reports', () => {
    const model = { noise: 0.01, step: 0.05 };
    expect(autoRule('blend', model)).toBeCloseTo(0.2);
    expect(autoRule('scale', model)).toBeCloseTo(0.9);
    expect(autoRule('scale', { noise: 0.01, step: 0.1 })).toBeCloseTo(1.5);
    expect(autoRule('detail', model)).toBeCloseTo(0.04);
    expect(autoRule('width', model)).toBeCloseTo(0.3);
    expect(autoRule('width', { noise: 0.01, step: 0.5 })).toBe(1);
  });

  it('starts a manual value where Auto was, held to the control and saying so', () => {
    const range = { min: 0.1, max: 5 };
    expect(manualStart(0.73, range)).toEqual({ value: 0.73, adjusted: false });
    expect(manualStart(0.1, range)).toEqual({ value: 0.1, adjusted: false });
    expect(manualStart(0.0003, range)).toEqual({ value: 0.1, adjusted: true });
    expect(manualStart(25, range)).toEqual({ value: 5, adjusted: true });
  });

  it('shows a shared value, or the first marked mixed', () => {
    expect(shared([0.4, 0.4], 1)).toEqual({ value: 0.4, mixed: false });
    expect(shared([0.4, 0.8], 1)).toEqual({ value: 0.4, mixed: true });
    expect(shared([null, 2], 1)).toEqual({ value: null, mixed: true });
    expect(shared([], 1)).toEqual({ value: 1, mixed: false });
  });
});

describe('Refine panel targets', () => {
  const edge = (id: string, state: RefineFeature['state'] = 'pending', closed = false) =>
    ({
      id,
      state,
      feature: { type: 'edge', input: { closed } },
    }) as unknown as RefineFeature;
  const region = (id: string, state: RefineFeature['state'] = 'pending') =>
    ({ id, state, feature: { type: 'region', input: {} } }) as unknown as RefineFeature;
  const features = [edge('e1'), edge('e2', 'accepted'), region('r1'), region('r2'), edge('e3')];
  const ids = (mode: RefineSession['mode'], selected: string[]) =>
    refineTargets({ mode, features, selected }).map((f) => f.id);

  it('acts on the selected pending features of the mode', () => {
    const selected = ['e1', 'e2', 'r1'];
    expect(ids('edge', selected)).toEqual(['e1']);
    expect(ids('region', selected)).toEqual(['r1']);
    expect(ids('detect', selected)).toEqual(['e1', 'r1']);
    expect(ids('brush', selected)).toEqual([]);
    expect(ids('detect', ['e2'])).toEqual([]);
    expect(ids('region', [])).toEqual([]);
  });

  it('names a target by mode and features, or the next feature', () => {
    expect(targetKey('region', [])).toBe('region:defaults');
    expect(targetKey('region', [{ id: 'r1' }, { id: 'r2' }])).toBe('region:r1,r2');
    expect(targetKey('edge', [{ id: 'r1' }])).not.toBe(targetKey('region', [{ id: 'r1' }]));
  });

  it('knows when the next click extends the selected guide', () => {
    const all = [...features, edge('ring', 'pending', true)];
    const extends_ = (mode: RefineSession['mode'], selected: string[]) =>
      extendsGuide({ mode, features: all, selected });
    expect(extends_('edge', ['e1'])).toBe(true);
    expect(extends_('edge', ['ring'])).toBe(false);
    expect(extends_('edge', ['e2'])).toBe(false);
    expect(extends_('edge', ['e1', 'e3'])).toBe(false);
    expect(extends_('edge', ['r1'])).toBe(false);
    expect(extends_('region', ['e1'])).toBe(false);
  });
});

describe('Refine store helpers for the panel and keys', () => {
  const initial = useEditor.getState();
  afterEach(() => {
    editor().cancelRefine();
    useEditor.setState(initial);
  });
  const crest = (x: number) => surfacePoint([x, 1.5 - 0.0879, 1 - 0.0879]);
  const selectedFeature = () => session().features.find((f) => f.id === session().selected[0])!;

  it('names the guide still being drawn', async () => {
    setup([boxPart()], ['box']);
    await ready();
    editor().addRefinePoint(crest(-1.2));
    expect(drawingRefineGuide(session())).toBe(session().selected[0]);
    editor().addRefinePoint(crest(1.2));
    expect(drawingRefineGuide(session())).toBeNull();
    editor().selectRefine([]);
    editor().setRefineEdge({ kind: 'spline' });
    editor().addRefinePoint(crest(-1.2));
    editor().addRefinePoint(crest(0));
    expect(drawingRefineGuide(session())).toBe(session().selected[0]);
    editor().finishRefineGuide();
    expect(drawingRefineGuide(session())).toBeNull();
  });

  it('says once that a feature does not solve, until another fails', async () => {
    setup([boxPart()], ['box']);
    await ready();
    const notify = vi.fn();
    useEditor.setState({ notify });
    const noEdge = () =>
      notify.mock.calls.filter(([message]) => message.startsWith('No edge found')).length;
    const flatGuide = (z: number) => {
      editor().selectRefine([]);
      editor().addRefinePoint(surfacePoint([-1, 1.5, z]));
      editor().addRefinePoint(surfacePoint([1, 1.5, z]));
      return session().selected[0];
    };
    const first = flatGuide(0);
    expect(noEdge()).toBe(1);
    for (const strength of [0.8, 0.6, 0.4]) editor().setRefineEdge({ strength });
    expect(noEdge()).toBe(1);
    flatGuide(-0.4);
    expect(noEdge()).toBe(2);
    editor().selectRefine([first]);
    expect(noEdge()).toBe(3);
    editor().setRefineEdge({ strength: 0.3 });
    expect(noEdge()).toBe(3);
  });

  it('reads the solve the draft made, with the ends it chose', async () => {
    setup([boxPart()], ['box']);
    await ready();
    editor().addRefinePoint(crest(-1.2));
    editor().addRefinePoint(crest(1.2));
    const solved = refineSolved(session(), selectedFeature()) as EdgeSolve;
    expect(solved.ends).toHaveLength(2);
    expect(solved.width).toBeGreaterThan(0);
    editor().setRefineEdge({ ends: ['hold', 'taper'] });
    expect((refineSolved(session(), selectedFeature()) as EdgeSolve).ends).toEqual([
      'hold',
      'taper',
    ]);
  });
});
