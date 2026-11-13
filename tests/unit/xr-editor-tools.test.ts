import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Quaternion, Vector3 } from 'three';
import { partPivot } from '../../src/core/geometry';
import { useEditor } from '../../src/core/store';
import type { Part, SurfacePair, SurfacePoint, Vec3 } from '../../src/core/types';
import {
  xrAdjust,
  xrAdvance,
  xrApply,
  xrBack,
  xrCanApply,
  xrFinishAdjustment,
  xrPick,
  xrRunToolAction,
  xrToolButtons,
  xrToolChoices,
  xrToolStatus,
} from '../../src/xr/editor-tools';
import type { XRAdjustmentGesture } from '../../src/xr/editor-tools';

const original = useEditor.getState();
const point = (partId: string, position: Vec3 = [0, 0, 0]): SurfacePoint => ({
  partId,
  point: position,
  normal: [0, 1, 0],
});
const makePart = (id: string, position: Vec3): Part => ({
  id,
  name: id,
  geometry: new BoxGeometry(10, 10, 10),
  position,
  quaternion: [0, 0, 0, 1],
  scale: [1, 1, 1],
  color: '#aaaaaa',
  visible: true,
  locked: false,
  source: 'test',
});
const state = () => useEditor.getState();

beforeEach(() => {
  useEditor.setState(original);
  state().setScene({
    name: 'VR tools',
    joints: [],
    parts: [makePart('moving', [0, 0, 0]), makePart('target', [30, 0, 0])],
  });
  state().select('moving');
  state().setView({ clip: { enabled: false, overlap: 0 } });
});
afterEach(() => useEditor.setState(original));

describe('VR operation stages', () => {
  it('offers every editor tool and exposes all alignment modes', () => {
    expect(xrToolChoices.map((choice) => choice.tool)).toEqual([
      'select',
      'translate',
      'rotate',
      'scale',
      'align',
      'joint',
      'measure',
      'anchors',
    ]);
    state().setTool('align');
    const modes = [state().operation.mode];
    for (let i = 0; i < 4; i++) {
      xrRunToolAction('alignMode');
      modes.push(state().operation.mode);
    }
    expect(modes).toEqual(['point', 'point-plane', 'plane', 'multi', 'surface']);
    expect(state().operation.activeSurface?.side).toBe('source');
    expect(xrToolButtons().length).toBeLessThanOrEqual(8);
  });

  it('advances from source to target to a single undoable alignment', () => {
    state().setTool('align');
    xrAdvance(point('moving'));
    expect(xrToolStatus()).toContain('target');
    expect(xrCanApply()).toBe(false);
    xrAdvance(point('target'));
    expect(xrCanApply()).toBe(true);
    expect(state().scene.parts[0].position).toEqual([0, 0, 0]);
    xrAdvance();
    expect(state().tool).toBe('select');
    expect(state().scene.parts[0].position).toEqual([30, 0, 0]);
    expect(state().past).toHaveLength(1);
    state().undo();
    expect(state().scene.parts[0].position).toEqual([0, 0, 0]);
  });

  it('backs up one point while preserving previous pairs and scene history', () => {
    state().setTool('align');
    state().setOperation({ mode: 'multi' });
    xrPick(point('moving', [0, 0, 0]));
    xrPick(point('target', [0, 0, 0]));
    xrPick(point('moving', [2, 0, 0]));
    xrPick(point('target', [2, 0, 0]));
    xrBack();
    expect(state().operation.pairs).toHaveLength(1);
    expect(state().operation.pending).toEqual(point('moving', [2, 0, 0]));
    xrBack();
    expect(state().operation.pending).toBeNull();
    expect(state().operation.pairs).toHaveLength(1);
    expect(state().past).toHaveLength(0);
  });

  it('keeps 3-point alignment incomplete until three complete pairs exist', () => {
    state().setTool('align');
    state().setOperation({ mode: 'multi' });
    const points: Vec3[] = [
      [0, 0, 0],
      [4, 0, 0],
      [0, 3, 0],
    ];
    for (const [i, p] of points.entries()) {
      xrAdvance(point('moving', p));
      xrAdvance(point('target', p));
      expect(xrCanApply()).toBe(i === 2);
    }
    // A trigger can add another pair without the advance button applying the fit.
    xrPick(point('moving', [1, 1, 0]));
    expect(xrCanApply()).toBe(false);
    xrBack();
    xrApply();
    expect(state().scene.parts[0].position[0]).toBeCloseTo(30, 6);
  });

  it('rejects locked moving points and retains the target-part guard', () => {
    state().patchParts(['moving'], { locked: true });
    state().setTool('align');
    xrPick(point('moving'));
    expect(state().operation.pending).toBeNull();
    state().patchParts(['moving'], { locked: false });
    xrPick(point('moving'));
    xrPick(point('moving', [1, 0, 0]));
    expect(state().operation.pairs).toHaveLength(0);
    expect(state().operation.pending?.partId).toBe('moving');
  });

  it('creates a joint using the same advance path and configured rotation locks', () => {
    state().setTool('joint');
    xrRunToolAction('jointLockZ');
    xrAdvance(point('moving'));
    xrAdvance(point('target'));
    xrAdvance();
    expect(state().scene.joints).toHaveLength(1);
    expect(state().scene.joints[0].rotationLocks).toEqual([true, false, false]);
    expect(state().scene.parts[0].position).toEqual([30, 0, 0]);
  });

  it('advances painted source/target/end pair, and back reopens the previous stage', () => {
    state().setTool('align');
    state().setOperation({ mode: 'surface' });
    const id = state().operation.surfacePairs[0].id;
    xrAdvance();
    expect(state().operation.activeSurface?.side).toBe('source');
    const pair: SurfacePair = { id, source: { partId: 'moving', faces: [0] }, target: null };
    state().setOperation({ surfacePairs: [pair] });
    xrAdvance();
    expect(state().operation.activeSurface?.side).toBe('target');
    xrAdvance();
    expect(state().operation.activeSurface?.side).toBe('target');
    state().setOperation({ surfacePairs: [{ ...pair, target: { partId: 'target', faces: [0] } }] });
    xrAdvance();
    expect(state().operation.activeSurface).toBeNull();
    xrAdvance();
    expect(state().operation.surfacePairs).toHaveLength(2);
    xrBack();
    expect(state().operation.surfacePairs).toHaveLength(1);
    expect(state().operation.activeSurface).toEqual({ pairId: id, side: 'target' });
    xrBack();
    expect(state().operation.activeSurface?.side).toBe('source');
    expect(state().operation.surfacePairs[0].target?.faces).toEqual([0]);
  });

  it('requires three contact pairs but only one flush/plane pair, and blocks incomplete pairs', () => {
    state().setTool('align');
    state().setOperation({ mode: 'surface', targetId: 'target' });
    const pairs: SurfacePair[] = Array.from({ length: 3 }, (_, i) => ({
      id: String(i),
      source: { partId: 'moving', faces: [i] },
      target: { partId: 'target', faces: [i] },
    }));
    state().setOperation({ surfacePairs: pairs.slice(0, 1) });
    expect(xrCanApply()).toBe(false);
    state().setOperation({ surfaceMethod: 'mate' });
    expect(xrCanApply()).toBe(true);
    state().setOperation({ surfaceMethod: 'contact', surfacePairs: pairs });
    expect(xrCanApply()).toBe(true);
    state().addSurfacePair();
    expect(xrCanApply()).toBe(false);
    xrRunToolAction('resetPicks');
    expect(state().operation.surfacePairs).toHaveLength(1);
    expect(state().operation.activeSurface?.side).toBe('source');
  });

  it('measures transformed mesh-local points and backs up without undoing the scene', () => {
    state().setTool('measure');
    xrPick(point('moving', [2, 0, 0]));
    xrPick(point('target', [2, 0, 0]));
    expect(xrToolStatus()).toContain('30.000 mm');
    xrBack();
    expect(state().measurement).toHaveLength(1);
    expect(xrToolStatus()).toContain('end point');
    expect(state().past).toHaveLength(0);
  });

  it('places an anchor then sets its target on another part without deforming the mesh', () => {
    state().setTool('anchors');
    const geometry = state().scene.parts[0].geometry;
    xrPick(point('moving', [1, 0, 0]));
    expect(state().scene.parts[0].anchors).toHaveLength(1);
    xrAdvance();
    expect(state().anchorPicking).toBe(false);
    xrPick(point('target', [1, 0, 0]));
    expect(state().scene.parts[0].anchors![0].target).toEqual([31, 0, 0]);
    expect(state().scene.parts[0].position[0]).toBeCloseTo(30, 6);
    expect(state().scene.parts[0].geometry).toBe(geometry);
    expect(state().scene.parts[0].scale).toEqual([1, 1, 1]);
  });
});

describe('VR thumbstick adjustments', () => {
  it('adjusts painted plane angles and offsets while keeping vertical input for the brush', () => {
    state().setTool('align');
    state().setOperation({ mode: 'surface', surfaceMethod: 'angle' });
    xrAdjust('x', 1, 'context', false);
    expect(state().operation.planeAngle).toBe(45);
    const radius = state().brushRadius;
    xrAdjust('y', 0.2, 'context', false);
    expect(state().brushRadius).toBeGreaterThan(radius);
    xrAdjust('x', 100, 'context', false);
    expect(state().operation.planeAngle).toBe(180);
    state().setOperation({ surfaceMethod: 'parallel' });
    xrAdjust('x', 1, 'context', true);
    expect(state().operation.offset).toBeCloseTo(0.1);
    expect(state().past).toHaveLength(0);
  });

  it('settles a stick gesture against original geometry without adding another undo step', () => {
    state().setView({ clip: { enabled: true, overlap: 0 } });
    const gesture: XRAdjustmentGesture = { baseline: state().scene.parts, patches: null };
    xrAdjust('x', 2.5, 'translate', false, true, 'y', gesture);
    expect(gesture.patches?.[0].patch.position).toEqual([25, 0, 0]);
    xrFinishAdjustment(gesture);
    expect(state().scene.parts[0].position[0]).toBeLessThanOrEqual(20.001);
    expect(state().scene.parts[1].position).toEqual([30, 0, 0]);
    expect(state().past).toHaveLength(1);
    state().undo();
    expect(state().scene.parts[0].position).toEqual([0, 0, 0]);
  });

  it('groups incremental moves as one undo step and uses the selected vertical axis', () => {
    xrAdjust('x', 0.1, 'translate', false, true);
    xrAdjust('y', 0.2, 'translate', false, false, 'z');
    xrAdjust('x', 0.1, 'translate', false, false);
    expect(state().scene.parts[0].position).toEqual([2, 0, 2]);
    expect(state().past).toHaveLength(1);
    state().undo();
    expect(state().scene.parts[0].position).toEqual([0, 0, 0]);
    state().redo();
    expect(state().scene.parts[0].position).toEqual([2, 0, 2]);
  });

  it('reduces translation and rotation tenfold in precision mode', () => {
    xrAdjust('x', 1, 'translate', true);
    expect(state().scene.parts[0].position[0]).toBeCloseTo(1);
    xrAdjust('x', 1, 'rotate', true);
    const turn = new Quaternion(...state().scene.parts[0].quaternion);
    expect(turn.angleTo(new Quaternion())).toBeCloseTo(Math.PI / 40, 8);
  });

  it('rotates and scales about the actual mesh pivot while preserving geometry', () => {
    const part = state().scene.parts[0];
    part.geometry.translate(5, 0, 0);
    const pivot = partPivot(part),
      geometry = part.geometry;
    xrAdjust('x', 1, 'rotate', false);
    expect(partPivot(state().scene.parts[0]).distanceTo(pivot)).toBeLessThan(1e-8);
    state().setTool('scale');
    xrAdjust('y', 1, 'context', false);
    const result = state().scene.parts[0];
    expect(partPivot(result).distanceTo(pivot)).toBeLessThan(1e-8);
    expect(result.scale[0]).toBeCloseTo(Math.exp(0.5));
    expect(result.geometry).toBe(geometry);
  });

  it('leaves locked and isolated-out parts alone and ignores unsupported input', () => {
    state().selectAll();
    state().patchParts(['target'], { locked: true });
    xrAdjust('x', 0.1, 'translate', false);
    expect(state().scene.parts[0].position).toEqual([1, 0, 0]);
    expect(state().scene.parts[1].position).toEqual([30, 0, 0]);
    state().isolate(['target']);
    expect(xrAdjust('x', 0.1, 'translate', false)).toBe(false);
    expect(xrAdjust('x', Infinity, 'rotate', false)).toBe(false);
    expect(xrAdjust('x', 0, 'rotate', false)).toBe(false);
  });

  it('keeps a connected locked parent and joint limits authoritative', () => {
    state().setScene({
      ...state().scene,
      joints: [
        {
          id: 'joint',
          name: 'joint',
          childId: 'moving',
          parentId: 'target',
          childAnchor: [0, 0, 0],
          parentAnchor: [-30, 0, 0],
          restRotation: [0, 0, 0, 1],
          rotationLocks: [true, true, true],
          keepConnected: true,
        },
      ],
    });
    state().patchParts(['target'], { locked: true });
    state().select('moving');
    xrAdjust('x', 0.1, 'rotate', false);
    expect(state().scene.parts[0].quaternion).toEqual([0, 0, 0, 1]);
    expect(state().scene.parts[1].position).toEqual([30, 0, 0]);
  });

  it('adjusts the brush or offset without modifying placement or scene history', () => {
    state().setTool('align');
    xrAdjust('y', 0.5, 'context', true);
    expect(state().operation.offset).toBeCloseTo(0.05);
    state().setOperation({ mode: 'surface' });
    const radius = state().brushRadius;
    xrAdjust('y', 0.5, 'context', false);
    expect(state().brushRadius).toBeCloseTo(radius * Math.exp(0.5));
    expect(xrAdjust('x', 0.5, 'context', false)).toBe(true);
    expect(state().operation.offset).toBeCloseTo(0.55);
    expect(state().scene.parts[0].position).toEqual([0, 0, 0]);
    expect(state().past).toHaveLength(0);
  });

  it('nudges an anchor target through the rigid fitting path', () => {
    state().setTool('anchors');
    xrPick(point('moving'));
    xrAdvance();
    xrAdjust('y', 0.1, 'context', true);
    expect(state().scene.parts[0].anchors![0].target[1]).toBeCloseTo(0.1);
    expect(new Vector3(...state().scene.parts[0].position).y).toBeCloseTo(0.1);
    expect(state().scene.parts[0].scale).toEqual([1, 1, 1]);
  });
});
