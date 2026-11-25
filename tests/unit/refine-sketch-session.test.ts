import { afterEach, describe, expect, it } from 'vitest';
import type { EdgeInput } from '../../src/core/refine-edge';
import type { GuidePoint } from '../../src/core/refine-band';
import { useEditor } from '../../src/core/store';
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
