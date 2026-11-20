import { afterEach, describe, expect, it } from 'vitest';
import { keyActions } from '../../src/core/keybindings';
import { keyTools } from '../../src/hooks/useWorkbench';
import {
  autoStart,
  endOption,
  featureCounts,
  fittedLabel,
  foldWarning,
  skippedWarning,
} from '../../src/components/refine-panel';
import type { EdgeSolve } from '../../src/core/refine-edge';
import {
  drawingRefineGuide,
  refineSolved,
  useEditor,
  type RefineFeature,
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

  it('starts a setting taken off Auto from the automatic rule', () => {
    const model = { noise: 0.01, step: 0.05 };
    expect(autoStart('blend', model)).toBeCloseTo(0.2);
    expect(autoStart('scale', model)).toBeCloseTo(0.9);
    expect(autoStart('scale', { noise: 0.01, step: 0.1 })).toBeCloseTo(1.5);
    expect(autoStart('detail', model)).toBeCloseTo(0.04);
    expect(autoStart('width', model, 0.73)).toBe(0.73);
    expect(autoStart('width', model)).toBeCloseTo(0.3);
    expect(autoStart('width', { noise: 0.01, step: 0.5 })).toBe(1);
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
