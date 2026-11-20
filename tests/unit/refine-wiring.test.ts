import { afterEach, describe, expect, it, vi } from 'vitest';
import { dismissNotification, useActivity } from '../../src/core/activity';
import { keyActions } from '../../src/core/keybindings';
import { keyTools, refineKey } from '../../src/hooks/useWorkbench';
import {
  autoRule,
  draftSkippedHint,
  endOption,
  extendsGuide,
  featureCounts,
  fittedLabel,
  foldWarning,
  manualStart,
  manualStarts,
  refineHoldsWork,
  refineLeaveHint,
  refineTargets,
  shared,
  skippedWarning,
  targetKey,
  withEnd,
} from '../../src/components/refine-panel';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { applyEdge, solveEdge, type EdgeInput, type EdgeSolve } from '../../src/core/refine-edge';
import { cloneRefineMesh } from '../../src/core/refine-mesh';
import { softBox } from '../helpers/soft-edges';
import {
  drawingRefineGuide,
  refineDraftLimit,
  refineSolved,
  reportFailures,
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

  it('starts each target from its own value and says whether any was held', () => {
    const range = { min: 0.1, max: 5 };
    expect(
      manualStarts(
        [
          { id: 'a', start: 0.45 },
          { id: 'b', start: 0.431 },
        ],
        range,
      ),
    ).toEqual({ each: { a: 0.45, b: 0.431 }, adjusted: false });
    expect(
      manualStarts(
        [
          { id: 'a', start: 0.45 },
          { id: 'b', start: 0.01 },
        ],
        range,
      ),
    ).toEqual({ each: { a: 0.45, b: 0.1 }, adjusted: true });
    expect(manualStarts([], range)).toEqual({ each: {}, adjusted: false });
  });

  it('changes one end of a pair and keeps the other', () => {
    expect(withEnd([null, 'taper'], 0, 'hold')).toEqual(['hold', 'taper']);
    expect(withEnd(['hold', 'hold'], 1, null)).toEqual(['hold', null]);
    expect(withEnd(undefined, 1, 'taper')).toEqual([null, 'taper']);
  });

  it('shows a shared value, or the first marked mixed', () => {
    expect(shared([0.4, 0.4], 1)).toEqual({ value: 0.4, mixed: false });
    expect(shared([0.4, 0.8], 1)).toEqual({ value: 0.4, mixed: true });
    expect(shared([null, 2], 1)).toEqual({ value: null, mixed: true });
    expect(shared([], 1)).toEqual({ value: 1, mixed: false });
  });
});

describe('Refine failure notices', () => {
  const small = 'too small';
  const noEdge = 'no edge';
  const run = (passes: { id: string; notice: string | null }[][]) => {
    let known: ReadonlyMap<string, string> = new Map();
    return passes.map((pass) => {
      const result = reportFailures(known, pass);
      known = result.known;
      return result.news;
    });
  };

  it('reports a failure once while the feature keeps failing for the same reason', () => {
    const fail = [{ id: 'a', notice: small }];
    expect(run([fail, fail, fail])).toEqual([[small], [], []]);
  });

  it('reports two features failing together once each, then not on the next pass', () => {
    const both = [
      { id: 'a', notice: small },
      { id: 'b', notice: small },
    ];
    expect(run([both, both])).toEqual([[small, small], []]);
  });

  it('reports again after the feature solved, or failed for another reason', () => {
    expect(
      run([
        [{ id: 'a', notice: small }],
        [{ id: 'a', notice: null }],
        [{ id: 'a', notice: small }],
      ]),
    ).toEqual([[small], [], [small]]);
    expect(run([[{ id: 'a', notice: small }], [{ id: 'a', notice: noEdge }]])).toEqual([
      [small],
      [noEdge],
    ]);
  });

  it('keeps each feature record when a different feature fails in between', () => {
    expect(
      run([
        [{ id: 'a', notice: noEdge }],
        [{ id: 'b', notice: noEdge }],
        [{ id: 'a', notice: noEdge }],
      ]),
    ).toEqual([[noEdge], [noEdge], []]);
  });

  it('keeps a failure not in the pass when nothing new failed', () => {
    expect(
      run([
        [{ id: 'a', notice: small }],
        [{ id: 'b', notice: null }],
        [{ id: 'a', notice: small }],
      ]),
    ).toEqual([[small], [], []]);
  });
});

describe('Refine preview limit hint', () => {
  it('says the preview is off above the draft limit', () => {
    expect(draftSkippedHint(refineDraftLimit)).toBe(
      'Preview is off while more than 8 are selected.',
    );
  });
});

describe('Refine work that leaving would lose', () => {
  const model = {};
  const base: Record<string, unknown> = { start: model, model, triangles: [], features: [] };
  const feature = (state: 'pending' | 'accepted', origin: 'hand' | 'detected', edited?: boolean) =>
    ({ id: 'f', state, origin, ...(edited ? { edited } : {}) }) as RefineFeature;
  const holds = (session: Record<string, unknown>) =>
    refineHoldsWork({ ...base, ...session } as unknown as RefineSession);

  it('counts accepted work not yet applied', () => {
    expect(holds({ model: {}, features: [feature('accepted', 'hand')] })).toBe(true);
  });
  it('counts a pending feature the user drew or made', () => {
    expect(holds({ features: [feature('pending', 'hand')] })).toBe(true);
  });
  it('counts a detected proposal the user edited', () => {
    expect(holds({ features: [feature('pending', 'detected', true)] })).toBe(true);
  });
  it('counts painted triangles', () => {
    expect(holds({ triangles: [4] })).toBe(true);
  });
  it('does not count an empty session', () => {
    expect(holds({})).toBe(false);
  });
  it('does not count untouched detected proposals', () => {
    expect(
      holds({ features: [feature('pending', 'detected'), feature('pending', 'detected')] }),
    ).toBe(false);
  });
  it('says how to leave in one sentence', () => {
    expect(refineLeaveHint).toBe('Apply to keep your changes, or Cancel to discard them.');
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
    // Brush acts on a selected pending edge: a crease guide waiting to be accepted.
    expect(ids('brush', selected)).toEqual(['e1']);
    expect(ids('brush', ['r1', 'e2'])).toEqual([]);
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

  it('routes Escape, Delete and Enter to a pending guide in Brush mode as in Edge mode', async () => {
    setup([boxPart()], ['box']);
    await ready();
    const pendingGuide = () => {
      editor().setRefineMode('edge');
      editor().selectRefine([]);
      editor().addRefinePoint(crest(-1.2));
      editor().addRefinePoint(crest(1.2));
      editor().setRefineMode('brush');
      return session().selected[0];
    };
    const state = (id: string) => session().features.find((f) => f.id === id)?.state;
    // Escape lets go of it and keeps it; a second Escape keeps the tool, since leaving would
    // lose the guide.
    const first = pendingGuide();
    expect(refineKey(editor(), 'cancel')).toBe(true);
    expect(session().selected).toEqual([]);
    expect(state(first)).toBe('pending');
    expect(refineKey(editor(), 'cancel')).toBe(true);
    expect(session().features.map((f) => f.state)).toEqual(['pending']);
    // Delete dismisses it.
    editor().selectRefine([first]);
    refineKey(editor(), 'delete');
    expect(state(first)).toBeUndefined();
    // Enter accepts it, in Brush mode.
    const second = pendingGuide();
    refineKey(editor(), 'apply');
    expect(state(second)).toBe('accepted');
    expect(session().mode).toBe('brush');
    // In Edge mode Escape still dismisses the guide being drawn.
    editor().setRefineMode('edge');
    editor().selectRefine([]);
    editor().addRefinePoint(crest(-1));
    const drawn = session().selected[0];
    expect(refineKey(editor(), 'cancel')).toBe(true);
    expect(state(drawn)).toBeUndefined();
  });

  it('keeps the tool on Escape in every mode while the session holds work, and only then', async () => {
    setup([boxPart()], ['box']);
    await ready();
    const modes = ['edge', 'region', 'brush', 'detect'] as const;
    // An empty session: Escape is not Refine's to handle, so the tool is left.
    for (const mode of modes) {
      editor().setRefineMode(mode);
      expect(refineKey(editor(), 'cancel'), mode).toBe(false);
    }
    // Painted triangles, then a pending hand guide nobody has selected.
    const works = [
      () => useEditor.setState({ refine: { ...session(), triangles: [0, 1] } }),
      () => {
        useEditor.setState({ refine: { ...session(), triangles: [] } });
        editor().setRefineMode('edge');
        editor().addRefinePoint(crest(-1.2));
        editor().addRefinePoint(crest(1.2));
        editor().selectRefine([]);
      },
    ];
    for (const work of works)
      for (const mode of modes) {
        work();
        editor().setRefineMode(mode);
        const before = session();
        expect(refineKey(editor(), 'cancel'), mode).toBe(true);
        expect(session(), mode).toBe(before);
      }
  });

  it('says once that a feature does not solve, whatever other features do', async () => {
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
    expect(noEdge()).toBe(2);
    editor().setRefineEdge({ strength: 0.3 });
    expect(noEdge()).toBe(2);
  });

  it('raises no notice again for regions that keep failing, from an edit or Accept', async () => {
    setup([boxPart()], ['box']);
    await ready();
    const notify = vi.fn(editor().notify);
    useEditor.setState({ notify });
    editor().setRefineMode('region');
    for (const triangle of [0, 20]) {
      useEditor.setState({ refine: { ...session(), triangles: [triangle] } });
      editor().makeRefineRegion();
    }
    editor().selectRefine(session().features.map((f) => f.id));
    const small = () =>
      notify.mock.calls.filter(([message]) => message.startsWith('This area is too small')).length;
    const before = small();
    editor().setRefineRegion({ strength: 0.7 });
    expect(small()).toBe(before);
    editor().acceptRefine();
    editor().acceptRefine();
    expect(small()).toBe(before);
    expect(session().features.every((f) => f.state === 'pending')).toBe(true);
    // With its banner dismissed, a press that changed nothing says why, once.
    for (const { id } of useActivity.getState().notifications) dismissNotification(id);
    editor().acceptRefine();
    expect(small()).toBe(before + 1);
    editor().acceptRefine();
    expect(small()).toBe(before + 1);
  });

  it('restores features to their input and edited mark from before an edit', async () => {
    setup([boxPart()], ['box']);
    await ready();
    editor().addRefinePoint(crest(-1.2));
    editor().addRefinePoint(crest(1.2));
    const id = session().selected[0];
    // As a detected proposal the user has not touched.
    useEditor.setState({
      refine: {
        ...session(),
        features: session().features.map((f) => ({ ...f, origin: 'detected', edited: undefined })),
      },
    });
    const before = session().features.find((f) => f.id === id)!;
    editor().setRefineEdge({ strength: 0.3 });
    expect(session().features.find((f) => f.id === id)!.edited).toBe(true);
    // The value and the mark come back in the same write (a draft rebuild may follow).
    const writes: { feature: unknown; edited: unknown }[] = [];
    const stop = useEditor.subscribe(({ refine }) => {
      const f = refine!.features.find((f) => f.id === id)!;
      writes.push({ feature: f.feature, edited: f.edited });
    });
    editor().restoreRefineFeatures([{ id, feature: before.feature, edited: before.edited }]);
    stop();
    expect(writes[0]).toEqual({ feature: before.feature, edited: undefined });
    const after = session().features.find((f) => f.id === id)!;
    expect(after.feature).toBe(before.feature);
    expect(after.edited).toBeUndefined();
    expect('edited' in after).toBe(false);
  });

  it('edits the selected features of a kind, or the defaults when none is selected', async () => {
    setup([boxPart()], ['box']);
    await ready();
    editor().setRefineMode('region');
    const region = () => {
      const f = session().features.find((f) => f.id === session().selected[0])!.feature;
      if (f.type !== 'region') throw new Error('not a region');
      return f.input;
    };
    useEditor.setState({ refine: { ...session(), triangles: [0, 1, 2] } });
    editor().makeRefineRegion();
    editor().setRefineRegion({ strength: 0.25 });
    expect(region().strength).toBe(0.25);
    expect(session().region.strength).toBe(1);
    editor().setRefineRegion({}, { [session().selected[0]]: { blend: 0.3 } });
    expect(region().blend).toBe(0.3);
    expect(session().region.blend).toBeNull();
    editor().selectRefine([]);
    editor().setRefineRegion({ strength: 0.5 });
    expect(session().region.strength).toBe(0.5);

    editor().setRefineMode('edge');
    editor().addRefinePoint(crest(-1.2));
    editor().addRefinePoint(crest(1.2));
    const edge = () => selectedFeature().feature.input as { strength: number; ends?: unknown };
    editor().setRefineEdge({ strength: 0.4, kind: 'arc' });
    expect(edge().strength).toBe(0.4);
    expect(session().edge).toMatchObject({ strength: 1, kind: 'arc' });
    editor().setRefineEdge({}, { [session().selected[0]]: { ends: ['hold', null] } });
    expect(edge().ends).toEqual(['hold', null]);
    expect(session().edge.ends).toEqual([null, null]);
  });

  it('reads the latest solve as previewed, made on the draft after an earlier edge', async () => {
    const geometry = mergeGeometries([
      softBox([2, 1.5, 1], 0.3),
      softBox([2, 1.5, 1], 0.25).translate(6, 0, 0),
    ]);
    setup([boxPart({ geometry })], ['box']);
    await ready();
    for (const [x, radius] of [
      [0, 0.3],
      [6, 0.25],
    ]) {
      editor().selectRefine([]);
      const cut = radius * (1 - Math.SQRT1_2);
      for (const dx of [-1.2, 1.2])
        editor().addRefinePoint(surfacePoint([x + dx, 1.5 - cut, 1 - cut]));
    }
    editor().selectRefine(session().features.map((f) => f.id));
    editor().setRefineEdge({ ends: ['hold', null] });
    const { model, features } = session();
    const { mesh, topology, noise } = model!;
    const draft = cloneRefineMesh(mesh, false);
    const expected = features.map(({ feature }, index) => {
      const input = feature.input as EdgeInput;
      const solve = solveEdge(index ? draft : mesh, topology, input, noise)!;
      if (!index) applyEdge(draft, topology, solve, input.strength, false);
      return solve.width;
    });
    expect(expected[0]).not.toBeCloseTo(expected[1], 3);
    const solved = features.map((f) => (refineSolved(session(), f) as EdgeSolve).width);
    expect(solved).toEqual(expected);
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
