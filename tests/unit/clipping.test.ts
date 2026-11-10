import { afterEach, describe, expect, it } from 'vitest';
import { BoxGeometry, PlaneGeometry, Quaternion, SphereGeometry, Vector3 } from 'three';
import { solveAlignment } from '../../src/core/alignment';
import { fitAnchors } from '../../src/core/anchor-fit';
import { clipNote, clippingDepth, placeClear, sanitizeClipSettings } from '../../src/core/clipping';
import type { ClipMode } from '../../src/core/clipping';
import { anchorError } from '../../src/core/constraints';
import { useEditor } from '../../src/core/store';
import type {
  AssemblyOperation,
  Joint,
  Part,
  Quat,
  SceneDocument,
  Vec3,
} from '../../src/core/types';

const part = (id: string, geometry: Part['geometry'], position: Vec3 = [0, 0, 0]): Part => ({
  id,
  name: id.toUpperCase(),
  geometry,
  position,
  quaternion: [0, 0, 0, 1],
  scale: [1, 1, 1],
  color: '#ffffff',
  visible: true,
  locked: false,
  source: 'test',
});
const box = (id: string, size: Vec3, position?: Vec3) =>
  part(id, new BoxGeometry(...size), position);

function move(parts: Part[], id: string, patch: Partial<Part>, mode: ClipMode, overlap = 0.1) {
  const current = parts.find((p) => p.id === id)!;
  const result = placeClear({
    parts,
    joints: [],
    ids: [id],
    target: [{ ...current, ...patch }],
    place: ([pose]) => parts.map((p) => (p.id === id ? pose : p)),
    overlap,
    mode,
  });
  return { ...result, pose: result.parts.find((p) => p.id === id)! };
}
/** Repeats a drag toward one target, as the frames of a held gesture do. */
function drag(parts: Part[], id: string, position: Vec3, frames = 12) {
  for (let i = 0; i < frames; i++) parts = move(parts, id, { position }, 'drag').parts;
  return parts.find((p) => p.id === id)!.position;
}
const close = (actual: number[], expected: number[], digits = 2) =>
  expected.forEach((value, i) => expect(actual[i]).toBeCloseTo(value, digits));

const original = useEditor.getState();
afterEach(() => useEditor.setState(original));

describe('measuring overlap', () => {
  it('reports how deep one part sits in another', () => {
    const parts = [box('a', [10, 10, 10]), box('b', [10, 10, 10], [9, 0, 0])];
    expect(clippingDepth(parts, ['b'])).toBeCloseTo(1, 3);
    parts[1] = { ...parts[1], position: [10.5, 0, 0] };
    expect(clippingDepth(parts, ['b'])).toBe(0);
  });

  it('ignores hidden parts', () => {
    const parts = [{ ...box('a', [10, 10, 10]), visible: false }, box('b', [10, 10, 10])];
    expect(move(parts, 'b', { position: [1, 0, 0] }, 'fit').pose.position).toEqual([1, 0, 0]);
  });

  it('clamps saved settings', () => {
    expect(sanitizeClipSettings({ enabled: false, overlap: 99 })).toEqual({
      enabled: false,
      overlap: 5,
    });
    expect(sanitizeClipSettings({ overlap: 'x' }).overlap).toBe(0.1);
  });
});

describe('placing a part clear of others', () => {
  it('stops at the surface, sunk by exactly the allowance and no farther', () => {
    const parts = [box('a', [10, 10, 10]), box('b', [10, 10, 10], [30, 0, 0])];
    for (const mode of ['adjust', 'fit'] as const) {
      const { pose, report } = move(parts, 'b', { position: [7, 0, 0] }, mode);
      close(pose.position, [9.9, 0, 0], 3);
      expect(report).toMatchObject({ blockers: ['a'], unresolved: false });
      expect(report!.moved).toBeCloseTo(2.9, 2);
      expect(report!.depth).toBeCloseTo(0.1, 3);
    }
    close(move(parts, 'b', { position: [7, 0, 0] }, 'fit', 0.5).pose.position, [9.5, 0, 0], 3);
    close(move(parts, 'b', { position: [7, 0, 0] }, 'fit', 0).pose.position, [10, 0, 0], 2);
  });

  it('leaves a clear request untouched', () => {
    const parts = [box('a', [10, 10, 10]), box('b', [10, 10, 10], [30, 0, 0])];
    const { pose, report } = move(parts, 'b', { position: [10.5, 2, 1] }, 'fit');
    expect(pose.position).toEqual([10.5, 2, 1]);
    expect(report?.moved ?? 0).toBe(0);
  });

  it('pushes a deeply buried part out by the nearest way', () => {
    const parts = [
      part('a', new SphereGeometry(10, 48, 32)),
      part('b', new SphereGeometry(4, 32, 24), [40, 0, 0]),
    ];
    const { pose, report } = move(parts, 'b', { position: [3, 1, 0] }, 'fit');
    expect(report!.unresolved).toBe(false);
    expect(Math.hypot(...pose.position)).toBeCloseTo(13.9, 1);
    expect(clippingDepth([parts[0], pose], ['b'])).toBeLessThan(0.12);
  });

  it('shifts a turned part clear instead of refusing the turn', () => {
    const parts = [box('wall', [10, 40, 40], [-5, 0, 0]), box('bar', [2, 20, 2], [1.5, 0, 0])];
    const quaternion = new Quaternion()
      .setFromAxisAngle(new Vector3(0, 0, 1), 0.3)
      .toArray() as Quat;
    const { pose } = move(parts, 'bar', { quaternion }, 'adjust');
    expect(pose.quaternion[2]).toBeCloseTo(quaternion[2], 6);
    expect(pose.position[0]).toBeGreaterThan(3.5);
    expect(clippingDepth([parts[0], pose], ['bar'])).toBeLessThan(0.11);
  });

  it('splits the difference in a fit tighter than the allowance, and says so', () => {
    const walls = (gap: number) => [
      box('l', [10, 20, 20], [-5 - gap / 2, 0, 0]),
      box('r', [10, 20, 20], [5 + gap / 2, 0, 0]),
      box('peg', [6, 10, 6], [0, 40, 0]),
    ];
    const snug = move(walls(5.8), 'peg', { position: [0.4, 0, 0] }, 'fit');
    close(snug.pose.position, [0, 0, 0], 2);
    expect(snug.report!.unresolved).toBe(false);
    const tight = move(walls(5.4), 'peg', { position: [0, 0, 0] }, 'fit');
    expect(Math.abs(tight.pose.position[0])).toBeLessThan(0.05);
    expect(tight.report).toMatchObject({ unresolved: true });
    expect(tight.report!.blockers.sort()).toEqual(['l', 'r']);
    expect(clipNote(tight.report, walls(5.4))).toMatch(/^still overlaps L, R by 0\.\d\d mm$/);
  });
});

describe('dragging a part against others', () => {
  it('slides along a surface toward the pointer', () => {
    const parts = [box('a', [10, 10, 10]), box('b', [4, 4, 4], [9, 0, 0])];
    close(drag(parts, 'b', [5, 2, 0]), [6.9, 2, 0]);
  });

  it('keeps sliding while seated at the full allowance', () => {
    let parts = [box('table', [100, 10, 100], [0, -5, 0]), box('b', [10, 10, 10], [0, 4.9, 0])];
    for (let x = 3; x <= 12; x += 3) {
      parts = move(parts, 'b', { position: [x, 4.5, 0] }, 'drag').parts;
      close(parts[1].position, [x, 4.9, 0], 3);
    }
  });

  it('lowers a snug peg between two walls', () => {
    const parts = [
      box('l', [10, 20, 20], [-7.9, 0, 0]),
      box('r', [10, 20, 20], [7.9, 0, 0]),
      box('peg', [6, 10, 6], [0, 16, 0]),
    ];
    close(drag(parts, 'peg', [0, 6, 0], 30), [0, 6, 0]);
  });

  it('never passes through a thin part, however far the pointer jumps', () => {
    const plate = box('plate', [1, 40, 40]);
    close(drag([plate, box('b', [6, 6, 6], [10, 0, 0])], 'b', [-10, 0, 0]), [3.4, 0, 0]);
    close(drag([plate, box('b', [6, 6, 6], [-10, 0, 0])], 'b', [10, 0, 0]), [-3.4, 0, 0]);
  });

  it('treats an open sheet as solid from both sides', () => {
    const sheet = part('sheet', new PlaneGeometry(40, 40));
    sheet.quaternion = new Quaternion()
      .setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2)
      .toArray() as Quat;
    expect(drag([sheet, box('b', [6, 6, 6], [10, 0, 0])], 'b', [-10, 0, 0])[0]).toBeCloseTo(2.9, 1);
    expect(drag([sheet, box('b', [6, 6, 6], [-10, 0, 0])], 'b', [10, 0, 0])[0]).toBeCloseTo(
      -2.9,
      1,
    );
  });

  it('keeps overlap that was already there, without deepening it', () => {
    const parts = [box('a', [10, 10, 10]), box('b', [10, 10, 10], [8, 0, 0])];
    close(move(parts, 'b', { position: [7, 0, 0] }, 'drag').pose.position, [8, 0, 0], 3);
    close(move(parts, 'b', { position: [8, 3, 0] }, 'drag').pose.position, [8, 3, 0], 3);
    close(move(parts, 'b', { position: [9, 0, 0] }, 'drag').pose.position, [9, 0, 0], 3);
    close(move(parts, 'b', { position: [7, 0, 0] }, 'adjust').pose.position, [8, 0, 0], 3);
    close(move(parts, 'b', { position: [7, 0, 0] }, 'fit').pose.position, [9.9, 0, 0], 3);
  });

  it('gives the same result when repeated', () => {
    const parts = [box('a', [10, 10, 10]), box('b', [4, 4, 4], [9, 0, 0])];
    const once = move(parts, 'b', { position: [5, 2, 0] }, 'drag').pose.position;
    expect(move(parts, 'b', { position: [5, 2, 0] }, 'drag').pose.position).toEqual(once);
  });
});

describe('editor moves', () => {
  const scene = (): SceneDocument => ({
    name: 'Clip',
    parts: [box('a', [10, 10, 10]), box('b', [10, 10, 10], [20, 0, 0])],
    joints: [],
  });
  const enable = (enabled: boolean, overlap = 0.1) =>
    useEditor.setState((state) => ({
      scene: scene(),
      toast: null,
      view: { ...state.view, clip: { enabled, overlap } },
    }));
  const b = () => useEditor.getState().scene.parts[1];

  it('is off outside a browser until enabled', () => {
    expect(original.view.clip).toEqual({ enabled: false, overlap: 0.1 });
    useEditor.setState({ scene: scene() });
    useEditor.getState().transform('b', { position: [5, 0, 0] });
    expect(b().position).toEqual([5, 0, 0]);
  });

  it('stops a typed position at the other part and explains', () => {
    enable(true);
    useEditor.getState().transform('b', { position: [5, 0, 0] });
    close(b().position, [9.9, 0, 0], 3);
    expect(useEditor.getState().toast).toMatchObject({
      kind: 'info',
      message: 'B moved 4.90 mm to clear A',
    });
    useEditor.getState().undo();
    expect(b().position).toEqual([20, 0, 0]);
  });

  it('follows the adjustable allowance, and validates it', () => {
    enable(true);
    useEditor.getState().setView({ clip: { enabled: true, overlap: 0.6 } });
    useEditor.getState().transform('b', { position: [5, 0, 0] });
    close(b().position, [9.4, 0, 0], 3);
    useEditor.getState().setView({ clip: { enabled: true, overlap: -3 } });
    expect(useEditor.getState().view.clip.overlap).toBe(0);
  });

  it('blocks a gizmo drag in one undo step, and settles when it ends', () => {
    enable(true);
    const patch = (x: number) => [{ id: 'b', patch: { ...b(), position: [x, 0, 0] as Vec3 } }];
    const { transformMany } = useEditor.getState();
    transformMany(patch(14), true, true);
    transformMany(patch(8), false, true);
    transformMany(patch(4), false, true);
    transformMany(patch(4), false, true, true);
    close(b().position, [9.9, 0, 0], 3);
    expect(useEditor.getState().past).toHaveLength(1);
  });

  it('lets a jointed part turn at its seat but not through its parent', () => {
    const joint: Joint = {
      id: 'j',
      name: 'Hinge',
      parentId: 'a',
      childId: 'arm',
      parentAnchor: [10, 0, 0],
      childAnchor: [-9, 0, 0],
      restRotation: [0, 0, 0, 1],
      rotationLocks: [true, true, false],
      keepConnected: true,
    };
    const jointed: SceneDocument = {
      name: 'Hinge',
      // The arm sits 1 mm into its parent at the joint, like a ball in a socket.
      parts: [box('a', [20, 20, 20]), box('arm', [20, 4, 4], [19, 0, 0])],
      joints: [joint],
    };
    useEditor.setState((state) => ({
      scene: jointed,
      view: { ...state.view, clip: { enabled: true, overlap: 0.1 } },
    }));
    const turn = (angle: number) => {
      const quaternion = new Quaternion()
        .setFromAxisAngle(new Vector3(0, 0, 1), angle)
        .toArray() as Quat;
      const pivot = new Vector3(10, 0, 0);
      const position = new Vector3(9, 0, 0)
        .applyQuaternion(new Quaternion(...quaternion))
        .add(pivot)
        .toArray();
      useEditor.getState().transform('arm', { position, quaternion });
      const arm = useEditor.getState().scene.parts[1];
      return 2 * Math.asin(Math.min(1, Math.abs(arm.quaternion[2])));
    };
    expect(turn(0.3)).toBeCloseTo(0.3, 3);
    const reached = turn(Math.PI / 2);
    expect(reached).toBeGreaterThan(0.3);
    expect(reached).toBeLessThan(1.3);
    const { parts } = useEditor.getState().scene;
    expect(anchorError(parts, joint)).toBeLessThan(1e-6);
    expect(useEditor.getState().toast?.message).toMatch(/to clear A$/);
  });
});

describe('fitting with clipping avoided', () => {
  const clip = { enabled: true, overlap: 0.1 };
  const operation = (patch: Partial<AssemblyOperation>): AssemblyOperation => ({
    mode: 'point',
    sourceId: 'b',
    targetId: 'a',
    pairs: [],
    surfacePairs: [],
    activeSurface: null,
    pending: null,
    flipNormal: true,
    offset: 0,
    rotationLocks: [true, false, true],
    keepConnected: true,
    ...patch,
  });
  const parts = () => [box('a', [10, 10, 10]), box('b', [10, 10, 10], [30, 4, 0])];
  const pair = (source: Vec3, target: Vec3, normal: Vec3 = [1, 0, 0]) => ({
    source: { partId: 'b', point: source, normal: [-1, 0, 0] as Vec3 },
    target: { partId: 'a', point: target, normal },
  });

  it('seats a point alignment on the surface when the picks would bury it', () => {
    const scene: SceneDocument = { name: 'Fit', parts: parts(), joints: [] };
    const op = operation({ pairs: [pair([-2, 0, 0], [5, 0, 0])] });
    expect(solveAlignment(scene, op).parts[1].position).toEqual([7, 0, 0]);
    const result = solveAlignment(scene, op, clip);
    close(result.parts[1].position, [9.9, 0, 0], 3);
    expect(result.clip).toMatchObject({ blockers: ['a'], unresolved: false });
    expect(result.rms).toBeCloseTo(2.9, 2);
    expect(result.constrained).toBe(false);
    expect(clipNote(result.clip, scene.parts)).toBe('moved 2.90 mm to clear A');
  });

  it('honors a negative plane offset only as far as the allowance', () => {
    const scene: SceneDocument = { name: 'Fit', parts: parts(), joints: [] };
    const op = operation({ mode: 'plane', offset: -1, pairs: [pair([-5, 0, 0], [5, 0, 0])] });
    close(solveAlignment(scene, op, clip).parts[1].position, [9.9, 0, 0], 3);
    close(solveAlignment(scene, op, { enabled: true, overlap: 2 }).parts[1].position, [9, 0, 0], 3);
  });

  it('keeps a three-point fit out of a bystander as well as its target', () => {
    const scene: SceneDocument = {
      name: 'Fit',
      parts: [...parts(), box('c', [4, 4, 4], [10, 6.5, 0])],
      joints: [],
    };
    const op = operation({
      mode: 'multi',
      pairs: [
        pair([-5, -4, -4], [5, -4, -4]),
        pair([-5, 4, -4], [5, 4, -4]),
        pair([-5, 0, 4], [5, 0, 4]),
      ],
    });
    const result = solveAlignment(scene, op, clip);
    expect(result.clip!.blockers).toContain('c');
    expect(clippingDepth(result.parts, ['b'])).toBeLessThan(0.12);
  });

  it('keeps an anchor fit clear, and reports it', () => {
    const scene: SceneDocument = { name: 'Fit', parts: parts(), joints: [] };
    const anchors = [{ id: '1', point: [-5, 0, 0] as Vec3, target: [3, 0, 0] as Vec3 }];
    expect(fitAnchors(scene, 'b', anchors)[1].position).toEqual([8, 0, 0]);
    let moved = 0;
    const fitted = fitAnchors(scene, 'b', anchors, {
      overlap: 0.1,
      mode: 'fit',
      report: (report) => (moved = report!.moved),
    });
    expect(clippingDepth(fitted, ['b'])).toBeLessThan(0.11);
    expect(moved).toBeGreaterThan(1.8);
    expect(fitted[1].anchors).toEqual(anchors);
  });
});
