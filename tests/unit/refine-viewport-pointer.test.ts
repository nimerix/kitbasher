import { describe, expect, it } from 'vitest';
import {
  bindingBroken,
  chooseCandidate,
  gestureBinding,
  longestRun,
} from '../../src/components/RefinePointer';
import type { RefineSession } from '../../src/core/store';
import type { GuidePoint } from '../../src/core/refine-band';

const candidate = (item: string, depth: number, surface: number | null, screen: number) => ({
  item,
  depth,
  surface,
  screen,
  allowance: 0.05,
});

describe('choosing a Refine handle or proposal under the pointer', () => {
  it('skips one behind the surface along the view ray', () => {
    expect(chooseCandidate([candidate('rear', 19, 15, 0)])).toBeNull();
    expect(chooseCandidate([candidate('rear', 19, 15, 0), candidate('front', 15, 15, 40)])).toBe(
      'front',
    );
  });

  it('takes one on the surface within the depth allowance, or with nothing in front', () => {
    expect(chooseCandidate([candidate('on', 15.04, 15, 0)])).toBe('on');
    expect(chooseCandidate([candidate('off', 15.06, 15, 0)])).toBeNull();
    expect(chooseCandidate([candidate('outline', 15, null, 0)])).toBe('outline');
  });

  it('prefers nearer in depth before nearer on screen', () => {
    // Both seen, as on a part's outline where nothing lies in front of either.
    expect(chooseCandidate([candidate('far', 18, null, 0), candidate('near', 15, null, 30)])).toBe(
      'near',
    );
    // At a level depth, the nearer on screen.
    expect(chooseCandidate([candidate('a', 15.02, 15.02, 30), candidate('b', 15, 15, 10)])).toBe(
      'b',
    );
    expect(chooseCandidate([candidate('a', 15, 15, 30), candidate('b', 15.02, 15.02, 10)])).toBe(
      'b',
    );
  });
});

describe('binding a Refine gesture to what it began in', () => {
  const refine = {
    id: 's1',
    partId: 'block',
    stage: 'ready',
    mode: 'brush',
    brush: { kind: 'flatten', strength: 0.5 },
  } as RefineSession;
  const state = (changes: Partial<RefineSession> = {}, tool = 'refine') =>
    ({ tool, refine: { ...refine, ...changes } }) as Parameters<typeof bindingBroken>[1];

  it('holds while nothing it began with changes', () => {
    const stroke = gestureBinding(state(), true)!;
    expect(bindingBroken(stroke, state())).toBe(false);
    expect(bindingBroken(stroke, state({ brush: { kind: 'flatten', strength: 0.9 } }))).toBe(false);
  });

  it('breaks on a change of session, part, mode, brush kind or tool', () => {
    const stroke = gestureBinding(state(), true)!;
    expect(bindingBroken(stroke, state({ id: 's2' }))).toBe(true);
    expect(bindingBroken(stroke, state({ partId: 'other' }))).toBe(true);
    expect(bindingBroken(stroke, state({ mode: 'region' }))).toBe(true);
    expect(bindingBroken(stroke, state({ brush: { kind: 'crease', strength: 0.5 } }))).toBe(true);
    expect(bindingBroken(stroke, state({}, 'select'))).toBe(true);
    expect(bindingBroken(stroke, { tool: 'refine', refine: null })).toBe(true);
  });

  it('ignores the brush for a handle drag or a proposal press', () => {
    const drag = gestureBinding(state({ mode: 'edge' }), false)!;
    expect(drag.kind).toBeNull();
    expect(
      bindingBroken(drag, state({ mode: 'edge', brush: { kind: 'crease', strength: 0.5 } })),
    ).toBe(false);
    expect(bindingBroken(drag, state({ mode: 'detect' }))).toBe(true);
  });
});

describe('the runs of a crease stroke', () => {
  const run = (...xs: number[]): GuidePoint[] =>
    xs.map((x) => ({ triangle: 0, position: [x, 0, 0] }));

  it('keeps the longest run along the surface, the first of equals', () => {
    expect(longestRun([run(0, 1), run(5, 5.5, 9), run(20, 21)])).toEqual(run(5, 5.5, 9));
    expect(longestRun([run(0, 2), run(5, 7)])).toEqual(run(0, 2));
    expect(longestRun([run(3)])).toEqual(run(3));
  });
});
