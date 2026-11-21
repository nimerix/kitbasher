import { describe, expect, it } from 'vitest';
import {
  bindingBroken,
  changedModelTriangles,
  chooseCandidate,
  draftMoved,
  gestureBinding,
  handleClickHolds,
  OrderedSamples,
  PressTrack,
  boundsEntry,
  trianglePlaneHit,
  longestRun,
  pressGesture,
  rayCrossesBounds,
  sameAsModel,
  surfaceAllowance,
  surfaceReady,
  trianglesHit,
  type HandleClick,
} from '../../src/components/RefinePointer';
import { BoxGeometry, BufferAttribute, BufferGeometry, Mesh, Ray, Vector3 } from 'three';
import type { RefineMesh } from '../../src/core/refine-mesh';
import { workerIndexTriangles } from '../../src/core/spatial-index';
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

describe('the gate on starting a Refine gesture', () => {
  /** A preview of `triangles` triangles, with or without its picking index. */
  const preview = (triangles: number, indexed: boolean) => {
    const geometry = new BufferGeometry();
    geometry.setIndex(new BufferAttribute(new Uint32Array(triangles * 3), 1));
    if (indexed) geometry.boundsTree = {} as BufferGeometry['boundsTree'];
    return geometry;
  };
  const session = (geometry: BufferGeometry) =>
    ({
      refine: {
        id: 's1',
        partId: 'block',
        stage: 'ready',
        mode: 'brush',
        brush: { kind: 'smooth', strength: 0.5 },
        preview: geometry,
      } as RefineSession,
    }) as Parameters<typeof pressGesture>[0];

  it('starts nothing while a dense preview has no index', () => {
    const state = session(preview(workerIndexTriangles + 1, false));
    expect(surfaceReady(state.refine)).toBe(false);
    expect(pressGesture(state, true)).toBeNull();
    expect(pressGesture(state, false)).toBeNull();
  });

  it('starts a gesture once the preview has its index, read from the geometry each time', () => {
    const geometry = preview(workerIndexTriangles + 1, false);
    const state = session(geometry);
    expect(pressGesture(state, true)).toBeNull();
    geometry.boundsTree = {} as BufferGeometry['boundsTree'];
    expect(pressGesture(state, true)).toMatchObject({ session: 's1', kind: 'smooth' });
    expect(pressGesture(state, false)).toMatchObject({ session: 's1', kind: null });
  });

  it('starts a gesture on a preview small enough to pick without an index', () => {
    expect(pressGesture(session(preview(1000, false)), true)).not.toBeNull();
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

describe('the surface a selected guide draft moved', () => {
  // Two triangles over welded vertices 0 to 3; the draft moves vertex 3 and adds vertex 4.
  const mesh = (position: number[], corners: number[], weldedCount: number) =>
    ({
      position: Float64Array.from(position),
      weldedCount,
      weldOf: Uint32Array.from({ length: weldedCount }, (_, i) => i),
      corners: Uint32Array.from(corners),
      triangleCount: corners.length / 3,
    }) as unknown as RefineSession['draft'] & object;
  const model = mesh([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0], [0, 1, 2, 1, 3, 2], 4);
  const moved = mesh([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0.2], [0, 1, 2, 1, 3, 2], 4);
  const cut = mesh([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0.5, 0.5, 0], [0, 1, 2, 1, 3, 4], 5);
  const session = (draft: typeof model | null) =>
    ({ draft, model: { mesh: model } }) as unknown as Parameters<typeof draftMoved>[0];

  it('marks only triangles with a corner the draft moved or made', () => {
    expect(draftMoved(session(moved), 0)).toBe(false);
    expect(draftMoved(session(moved), 1)).toBe(true);
    expect(draftMoved(session(cut), 0)).toBe(false);
    expect(draftMoved(session(cut), 1)).toBe(true);
  });

  it('marks nothing without a draft', () => {
    expect(draftMoved(session(null), 1)).toBe(false);
    expect(draftMoved(session(model), 1)).toBe(false);
  });
});

describe('the model surface a selected handle is tested against', () => {
  const mesh = (position: number[], corners: number[], weldedCount: number) =>
    ({
      position: Float64Array.from(position),
      weldedCount,
      weldOf: Uint32Array.from({ length: weldedCount }, (_, i) => i),
      corners: Uint32Array.from(corners),
      triangleCount: corners.length / 3,
    }) as unknown as RefineMesh;
  // Two triangles making the unit square at z = 0; the draft lifts vertex 3 to z = 0.5.
  const square = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0];
  const model = mesh(square, [0, 1, 2, 1, 3, 2], 4);
  const draft = mesh([...square.slice(0, 9), 1, 1, 0.5], [0, 1, 2, 1, 3, 2], 4);
  const session = { draft, model: { mesh: model } } as unknown as Pick<
    RefineSession,
    'draft' | 'model'
  >;

  it('lists the model triangles the draft does not show unchanged', () => {
    expect(sameAsModel(session, 0)).toBe(true);
    expect(sameAsModel(session, 1)).toBe(false);
    expect(Array.from(changedModelTriangles(session))).toEqual([1]);
    expect(changedModelTriangles({ draft: null, model: { mesh: model } } as never)).toHaveLength(0);
  });

  it('crosses a ray with those triangles at the model positions, from either side', () => {
    const down = new Ray(new Vector3(0.8, 0.8, 2), new Vector3(0, 0, -1));
    const hit = trianglesHit(model, [1], down)!;
    expect(hit.distance).toBeCloseTo(2);
    expect(Math.abs(hit.normal.z)).toBeCloseTo(1);
    // The draft's lifted corner would be met sooner; the model is met where it lies.
    expect(trianglesHit(draft, [1], down)!.distance).toBeLessThan(2);
    const up = new Ray(new Vector3(0.8, 0.8, -1), new Vector3(0, 0, 1));
    expect(trianglesHit(model, [1], up)!.distance).toBeCloseTo(1);
    expect(trianglesHit(model, [1], down, 2.5)).toBeNull();
    expect(trianglesHit(model, [0], down)).toBeNull();
  });
});

describe('a handle press kept as a click while the surface has no index', () => {
  const point: GuidePoint = { triangle: 0, position: [0, 0, 0] };
  const other: GuidePoint = { triangle: 1, position: [1, 0, 0] };
  const guide = { type: 'edge', input: { segments: [{ points: [point, other] }] } };
  const refine = (changes: Record<string, unknown> = {}) =>
    ({
      id: 's1',
      mode: 'edge',
      selected: ['g1'],
      features: [{ id: 'g1', state: 'pending', feature: guide }],
      ...changes,
    }) as unknown as RefineSession;
  const press: HandleClick = {
    session: 's1',
    mode: 'edge',
    handle: { feature: 'g1', segment: 0, index: 0, point, first: true },
    feature: guide,
  };

  it('holds for the same handle of the same selected guide', () => {
    expect(handleClickHolds(press, refine())).toBe(true);
  });

  it('lapses when the session, mode, selection or that guide changes', () => {
    expect(handleClickHolds(press, refine({ id: 's2' }))).toBe(false);
    expect(handleClickHolds(press, refine({ mode: 'region' }))).toBe(false);
    expect(handleClickHolds(press, refine({ selected: ['g2'] }))).toBe(false);
    const edited = { ...guide, input: { segments: [{ points: [point, other] }] } };
    expect(
      handleClickHolds(
        press,
        refine({ features: [{ id: 'g1', state: 'pending', feature: edited }] }),
      ),
    ).toBe(false);
    expect(handleClickHolds(press, null)).toBe(false);
  });
});

describe("a gesture's samples near a part with no index", () => {
  it('handles a sample at once while none waits before it', () => {
    const samples = new OrderedSamples<number>();
    expect(samples.behind()).toBe(false);
  });

  it('keeps every waiting sample, in order, with later ones behind them', () => {
    const samples = new OrderedSamples<number>();
    samples.hold(1);
    expect(samples.behind()).toBe(true);
    samples.hold(2);
    samples.hold(3);
    const handled: number[] = [];
    // A budget that allows two this frame leaves the third for the next, not dropped.
    let allowed = 2;
    expect(
      samples.drain(
        (n) => handled.push(n),
        () => allowed-- > 0,
      ),
    ).toBe(true);
    expect(handled).toEqual([1, 2]);
    expect(
      samples.drain(
        (n) => handled.push(n),
        () => true,
      ),
    ).toBe(false);
    expect(handled).toEqual([1, 2, 3]);
  });

  it('drops what waits when the gesture ends', () => {
    const samples = new OrderedSamples<number>();
    samples.hold(1);
    samples.clear();
    expect(samples.waiting).toBe(false);
  });
});

describe('a refused press kept as a click', () => {
  it('stays a click while every sample stays within the slop', () => {
    const press = new PressTrack(100, 100, 5);
    press.see(103, 102);
    press.see(100, 100);
    expect(press.moved).toBe(false);
  });

  it('is no click once any sample left the slop, though it came back', () => {
    const press = new PressTrack(100, 100, 5);
    for (const [x, y] of [
      [144, 100],
      [100, 100],
    ])
      press.see(x, y);
    expect(press.moved).toBe(true);
    press.see(100, 100);
    expect(press.moved).toBe(true);
  });
});

describe("where a ray enters a part's bounds", () => {
  it('measures along the ray in world space, 0 from inside', () => {
    const part = new Mesh(new BoxGeometry(2, 2, 2));
    part.position.set(0, 0, -5);
    part.updateMatrixWorld();
    const down = new Ray(new Vector3(0, 0, 10), new Vector3(0, 0, -1));
    expect(boundsEntry(down, part)).toBeCloseTo(14);
    expect(boundsEntry(new Ray(new Vector3(0, 0, -5), new Vector3(0, 0, -1)), part)).toBe(0);
    expect(boundsEntry(new Ray(new Vector3(3, 0, 10), new Vector3(0, 0, -1)), part)).toBeNull();
  });
});

describe('a dragged point on the model surface', () => {
  const mesh = {
    position: Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    weldOf: Uint32Array.from([0, 1, 2]),
    corners: Uint32Array.from([0, 1, 2]),
  };
  it("comes from the triangle's own positions alone, the same bits for the same ray", () => {
    const ray = () => new Ray(new Vector3(0.25, 0.25, 3), new Vector3(0.1, 0.05, -1).normalize());
    const a = trianglePlaneHit(mesh, 0, ray())!,
      b = trianglePlaneHit(mesh, 0, ray())!;
    expect(a.z).toBeCloseTo(0, 12);
    expect(a.toArray()).toEqual(b.toArray());
    expect(
      trianglePlaneHit(mesh, 0, new Ray(new Vector3(0, 0, 1), new Vector3(1, 0, 0))),
    ).toBeNull();
  });
});

describe('whether a ray passes close to a part', () => {
  it('tests the part’s own bounding box, in its own space', () => {
    const part = new Mesh(new BoxGeometry(0.5, 16, 0.5));
    part.position.set(0, 0, 3);
    part.updateMatrixWorld();
    const at = (x: number) => new Ray(new Vector3(x, 0, 20), new Vector3(0, 0, -1));
    expect(rayCrossesBounds(at(0), part)).toBe(true);
    expect(rayCrossesBounds(at(1), part)).toBe(false);
    part.scale.set(5, 1, 1);
    part.updateMatrixWorld();
    expect(rayCrossesBounds(at(1), part)).toBe(true);
  });
});
