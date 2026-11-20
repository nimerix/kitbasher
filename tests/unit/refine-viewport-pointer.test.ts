import { describe, expect, it } from 'vitest';
import {
  bindingBroken,
  chooseCandidate,
  gestureBinding,
  HeldPath,
  longestRun,
  surfaceAllowance,
} from '../../src/components/RefinePointer';
import type { RefineSession } from '../../src/core/store';
import type { GuidePoint } from '../../src/core/refine-band';

const candidate = (
  item: string,
  depth: number,
  surface: number | null,
  screen: number,
  offset: number | null = surface === null ? null : depth - surface,
) => ({ item, depth, surface, offset, screen });

describe('choosing a Refine handle or proposal under the pointer', () => {
  it('skips one behind the surface along its normal', () => {
    expect(chooseCandidate([candidate('rear', 19, 15, 0)], 0.05)).toBeNull();
    expect(
      chooseCandidate([candidate('rear', 19, 15, 0), candidate('front', 15, 15, 40)], 0.05),
    ).toBe('front');
  });

  it('takes one within the allowance of the surface, or with nothing in front', () => {
    expect(chooseCandidate([candidate('on', 15.04, 15, 0)], 0.05)).toBe('on');
    expect(chooseCandidate([candidate('off', 15.06, 15, 0)], 0.05)).toBeNull();
    expect(chooseCandidate([candidate('outline', 15, null, 0)], 0.05)).toBe('outline');
  });

  it('measures the allowance along the surface normal, so grazing views still see the surface', () => {
    // Seen nearly edge-on, a point 1 mm past the hit along the ray lies 0.02 mm off the surface.
    expect(chooseCandidate([candidate('grazing', 16, 15, 0, 0.02)], 0.05)).toBe('grazing');
    // A rear wall 0.3 mm behind the near one is hidden however far the camera is.
    expect(chooseCandidate([candidate('rear wall', 100.3, 100, 0, -0.3)], 0.15)).toBeNull();
  });

  it('prefers nearer in depth before nearer on screen', () => {
    // Both seen, as on a part's outline where nothing lies in front of either.
    expect(
      chooseCandidate([candidate('far', 18, null, 0), candidate('near', 15, null, 30)], 0.05),
    ).toBe('near');
    // At a level depth, the nearer on screen.
    expect(
      chooseCandidate([candidate('a', 15.02, 15.02, 30), candidate('b', 15, 15, 10)], 0.05),
    ).toBe('b');
    expect(
      chooseCandidate([candidate('a', 15, 15, 30), candidate('b', 15.02, 15.02, 10)], 0.05),
    ).toBe('b');
  });
});

describe('the depth allowance of Refine picking', () => {
  it('is one and a half edges of the mesh, at most 0.15 mm', () => {
    expect(surfaceAllowance(0.04)).toBeCloseTo(0.06);
    expect(surfaceAllowance(0.1)).toBeCloseTo(0.15);
    expect(surfaceAllowance(1.2)).toBe(0.15);
  });
});

describe('holding a gesture path while the picking index builds', () => {
  const at = (x: number, release = false) => ({ x, y: 0, release });

  it('handles positions at once while the index is ready', () => {
    const path = new HeldPath();
    expect(path.add(at(1), true)).toEqual([at(1)]);
    expect(path.waiting).toBe(false);
  });

  it('holds positions until ready, then gives them back in order before the live one', () => {
    const path = new HeldPath();
    expect(path.add(at(1), false)).toEqual([]);
    expect(path.add(at(2), false)).toEqual([]);
    expect(path.waiting).toBe(true);
    expect(path.flush(false)).toEqual([]);
    expect(path.add(at(3), true)).toEqual([at(1), at(2), at(3)]);
    expect(path.waiting).toBe(false);
    expect(path.add(at(4), true)).toEqual([at(4)]);
  });

  it('replays a release that came before the index, last', () => {
    const path = new HeldPath();
    path.add(at(1), false);
    path.add(at(2, true), false);
    expect(path.released).toBe(true);
    expect(path.flush(true)).toEqual([at(1), at(2, true)]);
    expect(path.waiting).toBe(false);
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
