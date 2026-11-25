import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EdgeInput } from '../../src/core/refine-edge';
import { nearestTriangle } from '../../src/core/refine-sketch';
import type { GuidePoint } from '../../src/core/refine-band';
import { refineStatus, useEditor } from '../../src/core/store';
import type { Vec3 } from '../../src/core/types';
import { boxPart, editor, ready, session, setup, surfacePoint } from '../helpers/refine-session';
import { useActivity } from '../../src/core/activity';

const initial = useEditor.getState();
afterEach(() => {
  editor().cancelRefine();
  useEditor.setState(initial);
  useActivity.setState({ tasks: [], notifications: [] });
});

/** The box's top face, y = 1.5, as a click on it. */
const top = (x: number, z = 0) => surfacePoint([x, 1.5, z]);
const guide = (id = session().selected[0]): EdgeInput => {
  const feature = session().features.find((f) => f.id === id)!.feature;
  if (feature.type !== 'edge') throw new Error('not an edge');
  return feature.input;
};
const pointOf = (segment: number, index: number) => guide().segments[segment].points[index];
const offPlane = (p: Vec3) => {
  const { origin, normal } = guide().plane!;
  return Math.abs([0, 1, 2].reduce((sum, a) => sum + (p[a] - origin[a]) * normal[a], 0));
};
/** A point at `p` exactly, on the triangle the surface click nearest it found. */
const at = (p: Vec3): GuidePoint => ({ triangle: surfacePoint(p).triangle, position: p });

/** A plane through three clicks on the box's top face. */
function topPlane() {
  editor().startRefinePicking({ kind: 'plane', from: 'points', points: [], lock: null });
  for (const p of [top(-1, -0.5), top(1, -0.5), top(0, 0.5)]) editor().pickRefine(p);
  return session().planes.at(-1)!;
}

describe('sketch planes', () => {
  it('makes a plane from 3 points, chosen for the next guide, and undoes it', async () => {
    setup([boxPart()], ['box']);
    await ready();
    const undo = session().undo.length;
    const plane = topPlane();
    expect(session().picking).toBeNull();
    expect(plane.name).toBe('Plane 1');
    expect(Math.abs(plane.normal[1])).toBeGreaterThan(0.999);
    expect(plane.u[0]).toBeGreaterThan(0.999);
    expect(session().edge.plane).toBe(plane.id);
    expect(session().undo.length).toBe(undo + 1);
    editor().undoRefine();
    expect(session().planes).toEqual([]);
    editor().redoRefine();
    expect(session().planes).toEqual([plane]);
  });

  it('fits a plane to a flat face from one click', async () => {
    setup([boxPart()], ['box']);
    await ready();
    editor().startRefinePicking({ kind: 'plane', from: 'face', points: [], lock: null });
    editor().pickRefine(top(0.2, 0.1));
    const plane = session().planes[0];
    expect(plane.normal[1]).toBeGreaterThan(0.999);
    expect(Math.abs(plane.origin[1] - 1.5)).toBeLessThan(0.01);
  });

  it('refuses a plane through points in a line and keeps nothing', async () => {
    setup([boxPart()], ['box']);
    await ready();
    editor().startRefinePicking({ kind: 'plane', from: 'points', points: [], lock: null });
    for (const x of [-1, 0, 1]) editor().pickRefine({ ...top(x), position: [x, 1.5, 0] });
    expect(session().planes).toEqual([]);
    expect(session().picking).toBeNull();
  });

  it('draws a guide on the plane, its points in it wherever they were placed', async () => {
    setup([boxPart()], ['box']);
    await ready();
    const plane = topPlane();
    editor().addRefinePoint(at([-1, 1.6, 0.9]));
    editor().addRefinePoint(at([1, 1.4, 1.1]));
    expect(guide().plane).toEqual(plane);
    for (const p of guide().segments[0].points) expect(offPlane(p.position)).toBeLessThan(1e-9);
  });

  it('puts a guide on a plane from the point menu, and off it', async () => {
    setup([boxPart()], ['box']);
    await ready();
    editor().addRefinePoint(top(-1, 0.9));
    editor().addRefinePoint(top(1, 0.9));
    const id = session().selected[0];
    editor().setRefinePlane(null);
    const plane = topPlane();
    // The plane was made for the next guide; the drawn one stays where it was until locked.
    expect(guide(id).plane).toBeUndefined();
    editor().setRefineGuidePlane(id, plane.id);
    for (const p of guide(id).segments[0].points) expect(offPlane(p.position)).toBeLessThan(1e-9);
    editor().undoRefine();
    expect(guide(id).plane).toBeUndefined();
  });
});

describe('point locks', () => {
  async function planedGuide() {
    setup([boxPart()], ['box']);
    await ready();
    topPlane();
    editor().addRefinePoint(at([-1, 1.5, 0.9]));
    editor().addRefinePoint(at([1, 1.5, 0.9]));
    return session().selected[0];
  }

  it('slides a point locked to a line along it, in the plane', async () => {
    const id = await planedGuide();
    editor().startRefinePicking({
      kind: 'line',
      point: { feature: id, segment: 0, index: 1 },
      points: [],
    });
    editor().pickRefine(at([1, 1.5, 0.9]));
    editor().pickRefine(at([1, 1.5, -0.5]));
    const lock = pointOf(0, 1).lock;
    expect(lock?.kind).toBe('line');
    editor().moveRefinePoint(id, 0, 1, at([1.3, 1.5, 0.2]), true);
    const p = pointOf(0, 1).position;
    // On the line, which lies in the plane through the clicks, not quite level.
    if (lock?.kind !== 'line') return;
    const d = [0, 1, 2].map((a) => p[a] - lock.origin[a]);
    const t = [0, 1, 2].reduce((sum, a) => sum + d[a] * lock.direction[a], 0);
    expect(Math.hypot(...d.map((x, a) => x - t * lock.direction[a]))).toBeLessThan(1e-9);
    expect(Math.abs(p[0] - 1)).toBeLessThan(0.01);
    expect(Math.abs(p[2] - 0.2)).toBeLessThan(0.01);
    expect(offPlane(p)).toBeLessThan(1e-9);
    expect(pointOf(0, 1).lock).toEqual(lock);
  });

  it('keeps sketch locks and refreshes triangle seeds after a neighbouring cut', async () => {
    setup([boxPart()], ['box']);
    await ready();
    topPlane();
    for (const x of [-0.6, 0.7]) editor().addRefinePoint(at([x, 1.5, 1]));
    const id = session().selected[0];
    editor().lockRefinePoint(id, 0, 0, { kind: 'fixed' });
    const before = guide(id);
    editor().setRefineMode('brush');
    editor().setRefineBrush({ kind: 'crease', strength: 1 });
    editor().setRefineBrushRadius(0.4);
    const crest = (x: number) => surfacePoint([x, 1.5 - 0.0879, 1 - 0.0879]);
    editor().beginRefineStroke(crest(-1.5));
    for (let x = -1.4; x <= 1.5; x += 0.1) editor().moveRefineStroke(crest(x));
    editor().endRefineStroke();
    expect(session().features.some((f) => f.state === 'accepted')).toBe(true);
    const points = guide(id).segments[0].points;
    expect(points.map((p) => p.position)).toEqual(before.segments[0].points.map((p) => p.position));
    expect(points[0].lock).toEqual({ kind: 'fixed' });
    for (const point of points)
      expect(point.triangle).toBe(nearestTriangle(session().model!.mesh, point.position)!.triangle);
    editor().undoRefine();
    expect(guide(id)).toEqual(before);
  });

  it('keeps a fixed point where it is, until unlocked', async () => {
    const id = await planedGuide();
    const before = pointOf(0, 0).position;
    editor().lockRefinePoint(id, 0, 0, { kind: 'fixed' });
    editor().moveRefinePoint(id, 0, 0, at([-1.5, 1.5, 0.5]), true);
    expect(pointOf(0, 0).position).toEqual(before);
    editor().lockRefinePoint(id, 0, 0, null);
    expect(pointOf(0, 0).lock).toBeUndefined();
    editor().moveRefinePoint(id, 0, 0, at([-1.5, 1.5, 0.5]), true);
    expect(pointOf(0, 0).position).not.toEqual(before);
    expect(offPlane(pointOf(0, 0).position)).toBeLessThan(1e-9);
    editor().undoRefine();
    editor().undoRefine();
    expect(pointOf(0, 0).lock).toEqual({ kind: 'fixed' });
  });

  it('moves a point of a guide on a plane within the plane', async () => {
    const id = await planedGuide();
    editor().moveRefinePoint(id, 0, 1, at([1.2, 1.7, 0.5]), true);
    expect(offPlane(pointOf(0, 1).position)).toBeLessThan(1e-9);
  });

  it('deletes a point and puts it back on undo', async () => {
    const id = await planedGuide();
    editor().addRefinePoint(at([1, 1.5, -0.5]));
    expect(guide(id).segments).toHaveLength(2);
    editor().removeRefinePoint(id, 1, 1);
    expect(guide(id).segments).toHaveLength(1);
    editor().undoRefine();
    expect(guide(id).segments).toHaveLength(2);
  });

  it('keeps the chosen point chosen while it moves, for its widget', async () => {
    const id = await planedGuide();
    editor().clickRefinePoint(id, 0, 1);
    editor().moveRefinePoint(id, 0, 1, at([1.2, 1.5, 0.5]), true);
    expect(session().chosenPoint).toEqual({ feature: id, segment: 0, index: 1 });
  });
});

describe('constraints', () => {
  /** A U of three lines on the top face's plane: A to B, B to C, C to D. */
  async function uGuide() {
    setup([boxPart()], ['box']);
    await ready();
    topPlane();
    for (const p of [
      [-1, 1.5, 0.5],
      [-1, 1.5, -0.5],
      [1, 1.5, -0.5],
      [1.2, 1.5, 0.6],
    ] as Vec3[])
      editor().addRefinePoint(at(p));
    return session().selected[0];
  }
  const directionOf = (segment: number) => {
    const [a, b] = guide().segments[segment].points.map((p) => p.position);
    const d = [0, 1, 2].map((k) => b[k] - a[k]);
    const length = Math.hypot(...d);
    return d.map((x) => x / length);
  };
  const crossLength = (a: number[], b: number[]) =>
    Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]);

  it('keeps two lines parallel through a drag, and through undo and redo', async () => {
    const id = await uGuide();
    expect(editor().addRefineConstraint(id, { kind: 'parallel', segments: [0, 2] })).toBe(true);
    expect(crossLength(directionOf(0), directionOf(2))).toBeLessThan(1e-6);
    editor().moveRefinePoint(id, 2, 1, at([1.5, 1.5, 0.9]), true);
    expect(crossLength(directionOf(0), directionOf(2))).toBeLessThan(1e-6);
    for (const s of guide().segments)
      for (const p of s.points) expect(offPlane(p.position)).toBeLessThan(1e-9);
    editor().undoRefine();
    expect(guide().constraints).toHaveLength(1);
    editor().undoRefine();
    expect(guide().constraints ?? []).toHaveLength(0);
    editor().redoRefine();
    expect(guide().constraints).toHaveLength(1);
  });

  it('refuses a constraint that conflicts, changing nothing', async () => {
    const id = await uGuide();
    editor().lockRefinePoint(id, 0, 0, { kind: 'fixed' });
    editor().lockRefinePoint(id, 0, 1, { kind: 'fixed' });
    const before = session().features;
    // Segment 0 runs along z; u runs along x, so Horizontal cannot hold with both ends fixed.
    expect(editor().addRefineConstraint(id, { kind: 'horizontal', segments: [0] })).toBe(false);
    expect(session().features).toBe(before);
  });

  it('refuses a rotated plane that conflicts with a fixed horizontal line', async () => {
    const id = await uGuide();
    expect(editor().addRefineConstraint(id, { kind: 'horizontal', segments: [1] })).toBe(true);
    editor().lockRefinePoint(id, 1, 0, { kind: 'fixed' });
    editor().lockRefinePoint(id, 1, 1, { kind: 'fixed' });
    const before = session();
    editor().startRefinePicking({ kind: 'plane', from: 'points', points: [], lock: id });
    for (const p of [top(-1, -0.5), top(-1, 0.5), top(1, 0.5)]) editor().pickRefine(p);
    expect(session().features).toBe(before.features);
    expect(session().planes).toBe(before.planes);
    expect(session().undo).toBe(before.undo);
    editor().setRefineGuidePlane(id, null);
    expect(guide().constraints).toBeUndefined();
    expect(useActivity.getState().notifications.map((n) => n.message)).toContainEqual(
      expect.stringMatching(/removed its guide constraints/),
    );
    editor().undoRefine();
    expect(guide()).toEqual(before.features[0].feature.input);
  });

  it('aligns a point level with another it is clicked onto, and keeps it so', async () => {
    const id = await uGuide();
    editor().startRefinePicking({
      kind: 'align',
      axis: 'horizontal',
      point: { feature: id, segment: 2, index: 1 },
      points: [],
    });
    editor().pickRefine(pointOf(0, 1), { point: { feature: id, segment: 0, index: 1 } });
    const plane = guide().plane!;
    const v = (p: Vec3) => [0, 1, 2].reduce((s, a) => s + (p[a] - plane.origin[a]) * plane.v[a], 0);
    expect(Math.abs(v(pointOf(2, 1).position) - v(pointOf(0, 1).position))).toBeLessThan(1e-6);
    expect(guide().constraints?.[0]).toMatchObject({ kind: 'align', axis: 'horizontal' });
    editor().moveRefinePoint(id, 0, 1, at([-1.2, 1.5, -0.8]), true);
    expect(Math.abs(v(pointOf(2, 1).position) - v(pointOf(0, 1).position))).toBeLessThan(1e-6);
  });

  it('keeps the constraints of the segments a deleted point leaves', async () => {
    const id = await uGuide();
    editor().addRefineConstraint(id, { kind: 'parallel', segments: [0, 2] });
    editor().addRefineConstraint(id, { kind: 'horizontal', segments: [1] });
    editor().removeRefinePoint(id, 2, 1);
    expect(guide().segments).toHaveLength(2);
    expect(guide().constraints).toEqual([
      expect.objectContaining({ kind: 'horizontal', segments: [1] }),
    ]);
    editor().removeRefineConstraint(id, guide().constraints![0].id);
    expect(guide().constraints).toEqual([]);
  });

  it('refuses a constraint on a guide with no plane', async () => {
    setup([boxPart()], ['box']);
    await ready();
    editor().addRefinePoint(top(-1, 0.5));
    editor().addRefinePoint(top(1, 0.5));
    expect(
      editor().addRefineConstraint(session().selected[0], { kind: 'horizontal', segments: [0] }),
    ).toBe(false);
    expect(useActivity.getState().notifications.map((n) => n.message)).toContainEqual(
      expect.stringMatching(/sketch plane/),
    );
  });
});

describe('the status line', () => {
  it('says what the session waits for while it picks, and counts the picks', async () => {
    setup([boxPart()], ['box']);
    await ready();
    expect(refineStatus(session())).toBeNull();
    editor().startRefinePicking({ kind: 'plane', from: 'points', points: [], lock: null });
    expect(refineStatus(session())).toBe(
      'Click 3 points on the part for the plane. 0 of 3 picked. Esc stops picking.',
    );
    editor().pickRefine(top(-1, -0.5));
    expect(refineStatus(session())).toMatch(/1 of 3 picked/);
    editor().cancelRefinePicking();
    expect(refineStatus(session())).toBeNull();
  });

  it('says why the selected guide was refused', async () => {
    setup([boxPart()], ['box']);
    await ready();
    // On the flat middle of the top face there is no edge to rebuild.
    editor().addRefinePoint(top(-1, 0));
    editor().addRefinePoint(top(1, 0));
    await vi.waitFor(() =>
      expect(refineStatus(session())).toMatch(/^No edge found under this guide/),
    );
    editor().selectRefine([]);
    expect(refineStatus(session())).toBeNull();
  });
});
