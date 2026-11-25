import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  type Intersection,
  Line3,
  Mesh,
  PlaneGeometry,
  Raycaster,
  Vector3,
} from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { pickRaycast, prepareEditedForPicking, type BvhRequest } from '../../src/core/bvh';
import { runRefineRequest, type RefineRequest } from '../../src/core/refine-model';
import { dismissNotification, requestTaskCancellation, useActivity } from '../../src/core/activity';
import { editorCommands, undoTarget } from '../../src/core/commands';
import { partMatrix, triangleCount } from '../../src/core/geometry';
import { detectDefaults } from '../../src/core/refine-detect';
import { writeRefinedGeometry } from '../../src/core/refine-mesh';
import { fitCurve, GuideLengthError, type EdgeCurve } from '../../src/core/refine-curve';
import type { GuidePoint } from '../../src/core/refine-band';
import type { RefineProposal } from '../../src/core/refine-detect';
import type { RegionInput } from '../../src/core/refine-region';
import * as edgeCode from '../../src/core/refine-edge';
import { patchRefinedGeometry } from '../../src/core/refine-preview';
import { solveEdge } from '../../src/core/refine-edge';
import {
  brushingRefine,
  commitRefine,
  fittedWarpBrushRadius,
  heldRefineState,
  paintingRefine,
  refineBrushRadius,
  refineDraftLimit,
  refineDragRest,
  refineEdited,
  refineHoldsWork,
  refineUndoBytes,
  refineUndoLimit,
  shownRefinePreview,
  trimRefineSteps,
  useEditor,
  type RefineStep,
} from '../../src/core/store';
import { useXR } from '../../src/core/xr-session';
import type { Joint, Part } from '../../src/core/types';
import { changedVertices, closed, edgeNeighbours, modelOf, splitEdge } from '../helpers/refine';
import {
  alongPreset,
  boxPart,
  differingAttributes,
  editor,
  movedModel,
  nearestVertex,
  ownBytes,
  ready,
  rebuiltModel,
  session,
  setup,
  surfacePoint,
  toast,
  trianglesArea,
} from '../helpers/refine-session';
import { rivetedPlate, softBox, softCylinder } from '../helpers/soft-edges';

const job = vi.hoisted(() => ({ failure: null as Error | null }));
vi.mock('../../src/core/refine-job', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/refine-job')>();
  return {
    ...actual,
    buildRefineModelJob: (...args: Parameters<typeof actual.buildRefineModelJob>) =>
      job.failure ? Promise.reject(job.failure) : actual.buildRefineModelJob(...args),
  };
});

const initial = useEditor.getState();
afterEach(() => {
  job.failure = null;
  editor().cancelRefine();
  useEditor.setState(initial);
  useXR.setState({ session: null });
  useActivity.setState({ tasks: [], notifications: [] });
});

/** The preview as writeRefinedGeometry writes the session's model afresh. */
const fresh = () => {
  const part = editor().scene.parts.find((p) => p.id === session().partId)!;
  return writeRefinedGeometry(session().source, partMatrix(part), session().model!.mesh);
};

/** Welded vertices around the middle of the box's top face. */
const topVertices = () => {
  const model = session().model!;
  const centre = nearestVertex(model, [0.3, 1.5, 0.2]);
  const { neighbourStart, neighbours } = model.topology;
  return [centre, ...neighbours.subarray(neighbourStart[centre], neighbourStart[centre + 1])];
};

const plate = (id: string): Part => ({ ...boxPart(), id, name: id, position: [10, 0, 0] });

describe('refine session lifecycle', () => {
  it('starts on one selected part and builds a preview that matches the source', async () => {
    setup([boxPart()], ['box']);
    await ready();
    expect(session().preview!.getAttribute('position').array).toEqual(
      session().source.getAttribute('position').array,
    );
    expect(useActivity.getState().tasks.some((t) => t.title === 'Preparing to refine')).toBe(true);
    expect(editor().tool).toBe('refine');
    expect(session().start).toBe(session().model);
    expect(refineEdited(session())).toBe(false);
    expect(shownRefinePreview(session(), 'box')).toBe(session().preview);
    expect(shownRefinePreview(session(), 'other')).toBeNull();
    expect(session().mode).toBe('edge');
    expect(session().edge).toEqual({
      kind: 'line',
      width: null,
      joint: 'sharp',
      strength: 1,
      ends: [null, null],
      position: 'corner',
      fit: 0,
      path: true,
      wallAngle: null,
      usePlane: true,
      plane: null,
    });
    expect(session().region).toEqual({
      treatment: 'smooth',
      shape: 'auto',
      strength: 1,
      keepDetail: true,
      detail: null,
      blend: null,
      scale: null,
    });
    expect(session().brush).toEqual({ kind: 'smooth', strength: 0.5 });
    expect(session().detect).toEqual({ where: 'part', ...detectDefaults, running: false });
  });

  it('refuses with nothing selected, a locked part, or a hidden part', () => {
    const refused = (parts: Part[], selected: string[]) => {
      setup(parts, selected);
      expect(editor().startRefine()).toBe(false);
      expect(editor().refine).toBeNull();
      expect(toast()).toBe('Select one visible, unlocked part to refine.');
      editor().setTool('refine');
      expect(editor().tool).toBe('select');
      useEditor.setState({ toast: null });
    };
    refused([boxPart()], []);
    refused([boxPart(), plate('other')], ['box', 'other']);
    refused([boxPart({ locked: true })], ['box']);
    refused([boxPart({ visible: false })], ['box']);
  });

  it('refuses in a headset session', () => {
    setup([boxPart()], ['box']);
    useXR.setState({ session: {} as XRSession });
    expect(editor().startRefine()).toBe(false);
    expect(editor().refine).toBeNull();
  });

  it('refuses a part over the triangle limit with the exact message', () => {
    const geometry = new BufferGeometry();
    geometry.attributes.position = {
      count: 30_000_003,
      itemSize: 3,
      array: { BYTES_PER_ELEMENT: 4 },
    } as unknown as BufferAttribute;
    setup([boxPart({ name: 'Dense scan', geometry })], ['box']);
    expect(editor().startRefine()).toBe(false);
    expect(editor().refine).toBeNull();
    expect(toast()).toBe('Dense scan has too many triangles to refine. The limit is 10 million.');
  });

  it('applies nothing and adds no history when nothing was accepted', async () => {
    setup([boxPart()], ['box']);
    await ready();
    const past = editor().past.length;
    expect(editor().applyRefine()).toBe(false);
    expect(editor().past.length).toBe(past);
  });

  it('cancels when the part moves, is replaced, or the scene is replaced', async () => {
    setup([boxPart()], ['box']);
    await ready();
    editor().transform('box', { position: [1, 0, 0] });
    expect(editor().refine).toBeNull();
    expect(toast()).toBeUndefined();

    setup([boxPart()], ['box']);
    await ready();
    commitRefine({ model: movedModel(session().model!, topVertices(), [0, 0.01, 0]) });
    useEditor.setState((state) => ({
      scene: {
        ...state.scene,
        parts: state.scene.parts.map((p) => ({ ...p, geometry: softBox([1, 1, 1], 0.2) })),
      },
    }));
    expect(editor().refine).toBeNull();
    expect(toast()).toBe('The part changed, so the refinement was cancelled.');

    setup([boxPart()], ['box']);
    await ready();
    setup([boxPart()], ['box']);
    expect(editor().refine).toBeNull();
  });

  it('cancels when the tool changes and leaves part.geometry untouched', async () => {
    setup([boxPart()], ['box']);
    await ready();
    const geometry = editor().scene.parts[0].geometry;
    const bits = geometry.getAttribute('position').array.slice();
    editor().setTool('select');
    expect(editor().refine).toBeNull();
    expect(geometry.getAttribute('position').array).toEqual(bits);
    expect(toast()).toBeUndefined();

    await ready();
    commitRefine({ model: movedModel(session().model!, topVertices(), [0, 0.01, 0]) });
    editor().setTool('select');
    expect(editor().refine).toBeNull();
    expect(toast()).toBe('Refinement discarded. Use Apply to keep it.');
    expect(editor().scene.parts[0].geometry).toBe(geometry);
    expect(geometry.getAttribute('position').array).toEqual(bits);
  });

  it('cancels with a notice and fails its task when the model cannot be built', async () => {
    job.failure = new Error('out of memory');
    setup([boxPart()], ['box']);
    editor().setTool('refine');
    await vi.waitFor(() => expect(editor().refine).toBeNull());
    expect(toast()).toBe('Box could not be prepared for refining.');
    const task = useActivity.getState().tasks.find((t) => t.title === 'Preparing to refine')!;
    expect(task.status).toBe('failed');
  });

  it('ends the session quietly when its preparation is cancelled', async () => {
    setup([boxPart()], ['box']);
    editor().setTool('refine');
    const task = useActivity.getState().tasks.find((t) => t.title === 'Preparing to refine')!;
    requestTaskCancellation(task.id);
    await vi.waitFor(() => expect(editor().refine).toBeNull());
    expect(toast()).toBeUndefined();
    expect(useActivity.getState().tasks.find((t) => t.id === task.id)!.status).toBe('cancelled');
  });

  it('routes undo to the session only while it has steps', async () => {
    setup([boxPart()], ['box']);
    await ready();
    expect(undoTarget(editor())).toBe('scene');
    const start = session().model!;
    commitRefine({ model: movedModel(start, topVertices(), [0, 0.01, 0]) });
    const edited = session().model!;
    expect(undoTarget(editor())).toBe('refine');
    expect(editorCommands().redo.enabled).toBe(false);
    editorCommands().undo.run();
    expect(session().model).toBe(start);
    expect(undoTarget(editor())).toBe('scene');
    expect(editorCommands().redo.enabled).toBe(true);
    editorCommands().redo.run();
    expect(session().model).toBe(edited);
    // With work held and no steps left, scene undo would discard it.
    useEditor.setState({ refine: { ...session(), undo: [] } });
    expect(undoTarget(editor())).toBeNull();
    expect(editorCommands().cut.enabled).toBe(false);
  });
});

describe('refine session steps', () => {
  it('records a step that shares every unchanged array, and patches the preview in place', async () => {
    setup([boxPart()], ['box']);
    await ready();
    const start = session().model!;
    const preview = session().preview!;
    commitRefine({ model: movedModel(start, topVertices(), [0, 0.02, 0]) });
    const { model, undo, redo } = session();
    expect(undo).toHaveLength(1);
    expect(undo[0].model).toBe(start);
    expect(redo).toHaveLength(0);
    expect(model!.mesh.corners).toBe(start.mesh.corners);
    expect(model!.mesh.weldOf).toBe(start.mesh.weldOf);
    expect(model!.mesh.color).toBe(start.mesh.color);
    expect(model!.topology).toBe(start.topology);
    expect(session().preview).toBe(preview);
    expect(differingAttributes(preview, fresh())).toEqual([]);
  });

  it('keeps the patched preview equal to a fresh one through moves, undo and redo', async () => {
    for (const overrides of [
      {},
      { geometry: softBox([2, 1.5, 1], 0.3, { indexed: true }) },
      { position: [3, -2, 1], scale: [1, 2, -1] } as Partial<Part>,
    ]) {
      setup([boxPart(overrides)], ['box']);
      await ready();
      const preview = session().preview!;
      const [centre, ...ring] = topVertices();
      const start = session().model!;
      commitRefine({ model: movedModel(start, [centre], [0, 0.03, 0.01]) });
      expect(differingAttributes(preview, fresh())).toEqual([]);
      // New vertices move, and the first moves back onto its source position.
      const second = movedModel(session().model!, ring, [0.01, -0.01, 0]);
      second.mesh.position.set(
        start.mesh.position.subarray(centre * 3, centre * 3 + 3),
        centre * 3,
      );
      commitRefine({ model: second });
      expect(differingAttributes(preview, fresh())).toEqual([]);
      // Only the centre moves, so the moved ring around it keeps its place and turns its normals.
      const third = movedModel(second, [centre], [0, 0.02, -0.01]);
      commitRefine({ model: third });
      expect(differingAttributes(preview, fresh())).toEqual([]);
      for (let i = 0; i < 3; i++) {
        editor().undoRefine();
        expect(differingAttributes(preview, fresh())).toEqual([]);
      }
      expect(session().model).toBe(start);
      for (let i = 0; i < 3; i++) {
        editor().redoRefine();
        expect(differingAttributes(preview, fresh())).toEqual([]);
      }
      expect(session().model).toBe(third);
      expect(differingAttributes(preview, fresh())).toEqual([]);
      expect(session().preview).toBe(preview);
    }
  });

  it('matches a fresh preview when a crease splits a fan', async () => {
    for (const indexed of [false, true]) {
      setup([boxPart({ geometry: softBox([2, 1.5, 1], 0.3, { indexed }) })], ['box']);
      await ready();
      const vertices = topVertices();
      const moved = movedModel(session().model!, vertices, [0, 0.01, 0]);
      commitRefine({ model: moved });
      // A creased line through the centre, from one side of its ring to the other.
      const { position } = moved.mesh;
      const [centre, ...ring] = vertices;
      const across = (a: number, b: number) =>
        [0, 2].reduce(
          (dot, axis) =>
            dot +
            (position[a * 3 + axis] - position[centre * 3 + axis]) *
              (position[b * 3 + axis] - position[centre * 3 + axis]),
          0,
        );
      const ends = ring.flatMap((a) => ring.map((b) => [a, b]));
      const [a, b] = ends.reduce((best, pair) =>
        across(pair[0], pair[1]) < across(best[0], best[1]) ? pair : best,
      );
      const creased = movedModel(moved, [], [0, 0, 0]);
      for (const v of [a, centre, b]) creased.mesh.crease[v] = 1;
      commitRefine({ model: creased });
      expect(differingAttributes(session().preview!, fresh())).toEqual([]);
      editor().undoRefine();
      expect(differingAttributes(session().preview!, fresh())).toEqual([]);
    }
  });

  it('writes a new preview when the triangle count changes, and disposes the old one', async () => {
    setup([boxPart()], ['box']);
    await ready();
    const before = session().preview!;
    const disposed = vi.fn();
    before.addEventListener('dispose', disposed);
    const start = session().model!;
    const triangle = start.topology.trianglesOf[start.topology.triangleStart[topVertices()[0]]];
    const cut = rebuiltModel(start, (mesh) => splitEdge(mesh, triangle));
    commitRefine({ model: cut });
    expect(session().preview).not.toBe(before);
    expect(disposed).toHaveBeenCalled();
    expect(triangleCount(session().preview!)).toBe(start.mesh.triangleCount + 2);
    expect(differingAttributes(session().preview!, fresh())).toEqual([]);
    editor().undoRefine();
    expect(triangleCount(session().preview!)).toBe(start.mesh.triangleCount);
    expect(differingAttributes(session().preview!, fresh())).toEqual([]);
  });

  it('refuses to patch across a topology change', async () => {
    setup([boxPart()], ['box']);
    await ready();
    const start = session().model!;
    const cut = rebuiltModel(start, (mesh) => splitEdge(mesh, 0));
    const preview = writeRefinedGeometry(session().source, partMatrix(boxPart()), start.mesh);
    const position = preview.getAttribute('position').array.slice();
    expect(
      patchRefinedGeometry(
        preview,
        session().source,
        partMatrix(boxPart()),
        start.mesh,
        cut.mesh,
        cut.topology,
      ),
    ).toBe(false);
    expect(preview.getAttribute('position').array).toEqual(position);
  });

  it(`keeps at most ${refineUndoLimit} steps`, async () => {
    setup([boxPart()], ['box']);
    await ready();
    const [centre] = topVertices();
    for (let i = 0; i < refineUndoLimit + 3; i++)
      commitRefine({ model: movedModel(session().model!, [centre], [0, 0.001, 0]) });
    expect(session().undo).toHaveLength(refineUndoLimit);
  });

  it('trims the oldest steps to a byte budget, counting shared arrays once', () => {
    const start = modelOf(softBox([2, 1.5, 1], 0.3));
    const step = (model: typeof start): RefineStep => ({
      model,
      features: [],
      selected: [],
      triangles: [],
      drawing: false,
      planes: [],
    });
    const models = [start];
    for (let i = 0; i < 4; i++) models.push(movedModel(models[i], [i], [0, 0.01, 0]));
    const current = models[4];
    const steps = models.slice(0, 4).map(step);
    const { position, touched, crease } = start.mesh;
    const positionOnly = position.byteLength + touched.byteLength + crease.byteLength;
    // Each position-only step holds its own positions and flags; the shared topology counts for none.
    for (let i = 1; i < 4; i++)
      expect(ownBytes(steps[i], current, steps.slice(i + 1))).toBe(positionOnly);
    const all = trimRefineSteps(current, steps, []);
    expect(all.undo).toEqual(steps);
    expect(4 * positionOnly).toBeLessThan(refineUndoBytes);
    const two = trimRefineSteps(current, steps, [], 2 * positionOnly);
    expect(two.undo).toEqual(steps.slice(2));
    const redo = trimRefineSteps(current, [], [...steps].reverse(), 3 * positionOnly);
    expect(redo.redo).toEqual([...steps].reverse().slice(1));
    // The newest step stays, whatever it costs.
    expect(trimRefineSteps(current, steps, [], 0).undo).toEqual(steps.slice(-1));
  });
});

describe('refine apply', () => {
  it('writes the working surface as one undo step and starts again on the result', async () => {
    const other = plate('other');
    setup([boxPart(), other], ['box']);
    await ready();
    const [centre] = topVertices();
    const { weldOf, vertexCount } = session().model!.mesh;
    const copies = weldOf.subarray(0, vertexCount).filter((v) => v === centre).length;
    commitRefine({ model: movedModel(session().model!, [centre], [0, 0.05, 0]) });
    const expected = fresh();
    const before = editor().scene;
    const past = editor().past.length;
    expect(editor().applyRefine()).toBe(true);
    const part = editor().scene.parts[0];
    expect(editor().past.length).toBe(past + 1);
    expect(part.source).toBe('Refine · box.stl');
    expect(differingAttributes(part.geometry, expected)).toEqual([]);
    expect(editor().scene.parts[1]).toBe(other);
    expect(closed(part.geometry)).toBe(true);
    // Only the moved vertex's own copies change; every other vertex keeps its bits.
    const source = before.parts[0].geometry;
    expect(changedVertices(source, part.geometry)).toHaveLength(copies);
    expect(session().source).toBe(part.geometry);
    await vi.waitFor(() => expect(session().stage).toBe('ready'));
    expect(refineEdited(session())).toBe(false);
    editor().setTool('select');
    editor().undo();
    expect(editor().scene.parts[0].geometry).toBe(source);
  });

  it('refuses when the part is locked', async () => {
    setup([boxPart()], ['box']);
    await ready();
    commitRefine({ model: movedModel(session().model!, topVertices(), [0, 0.01, 0]) });
    const past = editor().past.length;
    useEditor.setState((state) => ({
      scene: { ...state.scene, parts: state.scene.parts.map((p) => ({ ...p, locked: true })) },
    }));
    expect(editor().applyRefine()).toBe(false);
    expect(toast()).toBe('Unlock Box to apply the refinement.');
    expect(editor().past.length).toBe(past);
  });
});

const crest = (x: number) => surfacePoint([x, 1.5 - 0.0879, 1 - 0.0879]); // 0.3 - 0.3 / sqrt(2)
const top = (x: number, z = 0) => surfacePoint([x, 1.5, z]);
const shownMesh = () => session().draft ?? session().model!.mesh;
/** The preview as writeRefinedGeometry writes what it shows afresh. */
const freshShown = () => {
  const part = editor().scene.parts.find((p) => p.id === session().partId)!;
  return writeRefinedGeometry(session().source, partMatrix(part), shownMesh());
};
const edgeInput = (id = session().features[0].id) => {
  const feature = session().features.find((f) => f.id === id)!.feature;
  if (feature.type !== 'edge') throw new Error('not an edge');
  return feature.input;
};
/** Draws a line guide along the box's front top crest and returns its id. */
const crestGuide = (from = -1.6, to = 1.6) => {
  editor().selectRefine([]);
  editor().addRefinePoint(crest(from));
  editor().addRefinePoint(crest(to));
  return session().selected[0];
};
/** Paints with one press at each world point, on a part at the origin. */
const paint = (points: [number, number, number][], erase = false) => {
  for (const p of points) {
    const { triangle, position } = surfacePoint(p);
    editor().paintRefineRegion(
      { partId: session().partId, point: position, normal: [0, 1, 0] },
      triangle,
      erase,
      true,
    );
    editor().endPaintStroke();
  }
};

describe('refine guides', () => {
  it('previews a line guide without changing the model, then bakes it on accept', async () => {
    setup([boxPart()], ['box']);
    await ready();
    editor().setRefineEdge(alongPreset);
    const model = session().model!;
    editor().addRefinePoint(crest(-1.6));
    editor().addRefinePoint(crest(1.6));
    expect(session().model).toBe(model);
    expect(session().draft).not.toBeNull();
    expect(session().features[0].curve).toBeDefined();
    expect(differingAttributes(session().preview!, freshShown())).toEqual([]);
    editor().acceptRefine();
    expect(session().features[0].state).toBe('accepted');
    expect(session().model!.mesh.triangleCount).toBeGreaterThan(model.mesh.triangleCount);
    expect(triangleCount(session().preview!)).toBe(session().model!.mesh.triangleCount);
    expect(session().features[0].pieces).toBe(1);
    expect(session().selected).toEqual([]);
    expect(session().draft).toBeNull();
    expect(differingAttributes(session().preview!, fresh())).toEqual([]);
  });

  it('steps back and forward through accepts', async () => {
    setup([boxPart()], ['box']);
    await ready();
    const start = session().model!;
    crestGuide();
    editor().acceptRefine();
    const accepted = session().model!;
    editor().undoRefine();
    expect(session().model).toBe(start);
    expect(session().features[0].state).toBe('pending');
    expect(triangleCount(session().preview!)).toBe(start.mesh.triangleCount);
    editor().redoRefine();
    expect(session().model).toBe(accepted);
    expect(session().features[0].state).toBe('accepted');
    expect(differingAttributes(session().preview!, fresh())).toEqual([]);
  });

  it('applies as one undo step, keeps links, and scene undo restores the source geometry', async () => {
    const pin = {
      id: 'pin',
      point: [0, 0, 0],
      target: [0, 0, 0],
      kind: 'hard',
      priority: 50,
    } as NonNullable<Part['pins']>[number];
    const anchor = { id: 'anchor', point: [1, 0, 0], target: [1, 0, 0] } as NonNullable<
      Part['anchors']
    >[number];
    const other = plate('other');
    const joint: Joint = {
      id: 'j',
      name: 'Hinge',
      parentId: 'other',
      childId: 'box',
      parentAnchor: [-20, 0, 0],
      childAnchor: [20, 0, 0],
      restRotation: [0, 0, 0, 1],
      rotationLocks: [true, true, false],
      keepConnected: true,
    };
    setup([boxPart({ pins: [pin], anchors: [anchor] }), other], ['box'], { joints: [joint] });
    await ready();
    crestGuide();
    editor().acceptRefine();
    const before = editor().scene;
    const past = editor().past.length;
    expect(editor().applyRefine()).toBe(true);
    const part = editor().scene.parts[0];
    expect(editor().past.length).toBe(past + 1);
    expect(part.source).toBe('Refine · box.stl');
    expect(part.pins).toEqual(before.parts[0].pins);
    expect(part.anchors).toEqual(before.parts[0].anchors);
    expect(editor().scene.joints).toEqual(before.joints);
    expect(editor().scene.parts[1]).toBe(before.parts[1]);
    expect(closed(part.geometry)).toBe(true);
    editor().setTool('select');
    editor().undo();
    expect(editor().scene.parts[0].geometry).toBe(before.parts[0].geometry);
  });

  it('keeps a zero-strength guide pending without a new working model or Apply', async () => {
    const part = boxPart();
    setup([part], ['box']);
    await ready();
    const id = crestGuide();
    editor().setRefineEdge({ strength: 0 });
    const { model, undo } = session();
    const oldPositions = Buffer.from(Buffer.from(model!.mesh.position.buffer));
    const oldPreview = fresh();
    editor().acceptRefine();
    expect(session().features[0]).toMatchObject({ id, state: 'pending' });
    expect(session().selected).toEqual([id]);
    expect(session().model).toBe(model);
    expect(session().undo).toBe(undo);
    expect(Buffer.from(session().model!.mesh.position.buffer).equals(oldPositions)).toBe(true);
    expect(differingAttributes(session().preview!, oldPreview)).toEqual([]);
    expect(refineEdited(session())).toBe(false);
    expect(editor().applyRefine()).toBe(false);
    expect(editor().scene.parts[0].geometry).toBe(part.geometry);
    expect(toast()).toBe('This changes nothing at 0 % strength.');
  });

  it('leaves a positive-strength edge pending if its cut writes no position or topology bits', async () => {
    setup([boxPart()], ['box']);
    await ready();
    const id = crestGuide();
    const before = session().model!;
    const applyEdge = edgeCode.applyEdge;
    const apply = vi.spyOn(edgeCode, 'applyEdge').mockImplementation((...args) =>
      args[4]
        ? {
            changed: Uint32Array.of(0),
            cut: {
              chain: Uint32Array.of(0),
              children: new Map(),
              edges: new Uint32Array(),
              skipped: new Uint32Array(),
            },
            folded: new Uint32Array(),
            skipped: new Uint32Array(),
            stationary: new Uint32Array(),
            pieces: 0,
          }
        : applyEdge(...args),
    );
    try {
      editor().acceptRefine();
      expect(session().features[0]).toMatchObject({ id, state: 'pending' });
      expect(session().model).toBe(before);
      expect(refineEdited(session())).toBe(false);
      expect(toast()).toBe(
        'This feature did not change the surface. Adjust its settings and try again.',
      );
    } finally {
      apply.mockRestore();
    }
  });

  it('accepts only changing features in a batch and keeps the zero-strength guide selected', async () => {
    setup([boxPart()], ['box']);
    await ready();
    const zero = crestGuide(-1.3, 1.3);
    editor().setRefineEdge({ strength: 0 });
    const edge = crestGuide();
    editor().setRefineMode('detect');
    editor().selectRefine([zero, edge]);
    const undo = session().undo.length;
    editor().acceptRefine();
    expect(session().features.map((f) => [f.id, f.state])).toEqual([
      [zero, 'pending'],
      [edge, 'accepted'],
    ]);
    expect(session().selected).toEqual([zero]);
    expect(session().undo).toHaveLength(undo + 1);
    expect(refineEdited(session())).toBe(true);
    expect(toast()).toBe('This changes nothing at 0 % strength.');
  });

  it('reports an overlong spline once for the guide and leaves it pending', async () => {
    setup([boxPart()], ['box']);
    await ready();
    const solve = vi.spyOn(edgeCode, 'solveEdge').mockImplementation(() => {
      throw new GuideLengthError();
    });
    try {
      editor().setRefineEdge({ kind: 'spline' });
      editor().addRefinePoint(crest(-1));
      editor().addRefinePoint(crest(1));
      const id = session().features[0].id;
      expect(toast()).toBe('This guide is too long for this mesh. Try a shorter guide.');
      for (const { id } of useActivity.getState().notifications) dismissNotification(id);
      editor().setRefineEdge({ width: 0.3 });
      editor().acceptRefine();
      expect(session().features[0]).toMatchObject({ id, state: 'pending' });
      expect(useActivity.getState().notifications).toHaveLength(1);
    } finally {
      solve.mockRestore();
    }
  });

  it('keeps a guide that finds no edge, changes nothing, and says why', async () => {
    setup([boxPart()], ['box']);
    await ready();
    editor().addRefinePoint(top(-1, 0));
    editor().addRefinePoint(top(1, 0));
    expect(session().features).toHaveLength(1);
    expect(session().features[0].curve).toBeUndefined();
    expect(session().draft!.position).toEqual(session().model!.mesh.position);
    expect(toast()).toBe(
      'No edge found under this guide. Move it onto the rounded edge or change Width.',
    );
    const model = session().model;
    // While its banner shows, Accept does not repeat it; once dismissed, Accept says it again.
    const banners = () => useActivity.getState().notifications.length;
    const shown = banners();
    editor().acceptRefine();
    expect(banners()).toBe(shown);
    for (const { id } of useActivity.getState().notifications) dismissNotification(id);
    useEditor.setState({ toast: null });
    editor().acceptRefine();
    expect(banners()).toBe(shown + 1);
    expect(session().model).toBe(model);
    expect(session().features[0].state).toBe('pending');
    expect(toast()).toBe(
      'No edge found under this guide. Move it onto the rounded edge or change Width.',
    );
  });

  it('passes forced ends to the solve', async () => {
    setup([boxPart()], ['box']);
    await ready();
    crestGuide(-1.2, 1.2);
    const { mesh, topology, noise } = session().model!;
    const drafts: Float64Array[] = [];
    for (const end of ['hold', 'taper'] as const) {
      editor().setRefineEdge({ ends: [end, end] });
      // The selected edge takes them; the next edge's defaults stay as they were.
      expect(session().edge.ends).toEqual([null, null]);
      expect(edgeInput().ends).toEqual([end, end]);
      expect(solveEdge(mesh, topology, edgeInput(), noise)!.ends).toEqual([end, end]);
      drafts.push(session().draft!.position.slice());
    }
    expect(drafts[0]).not.toEqual(drafts[1]);
    expect(differingAttributes(session().preview!, freshShown())).toEqual([]);
  });

  it('builds segments, joints and closed paths point by point, one step each', async () => {
    setup([boxPart()], ['box']);
    await ready();
    const undo = session().undo.length;
    const [a, b, c, d] = [top(-1, -0.5), top(1, -0.5), top(1, 0.5), top(-1, 0.5)];
    editor().addRefinePoint(a);
    editor().addRefinePoint(b);
    editor().setRefineEdge({ joint: 'smooth' });
    editor().addRefinePoint(c);
    expect(session().undo.length).toBe(undo + 3);
    let input = edgeInput();
    expect(input.segments.map((s) => s.points)).toEqual([
      [a, b],
      [b, c],
    ]);
    expect(input.joints).toEqual(['smooth']);
    editor().setRefineEdge({ kind: 'arc', joint: 'sharp' });
    editor().addRefinePoint(d);
    editor().addRefinePoint(a, true);
    input = edgeInput();
    expect(input.segments.map((s) => s.kind)).toEqual(['line', 'line', 'arc']);
    expect(input.segments[2].points).toEqual([c, d, a]);
    expect(input.joints).toEqual(['smooth', 'sharp', 'sharp']);
    expect(input.closed).toBe(true);
    // Moving the closing point moves it in both segments that share it, as one step per drag.
    const steps = session().undo.length;
    editor().moveRefinePoint(session().features[0].id, 0, 0, top(-1.1, -0.5));
    editor().moveRefinePoint(session().features[0].id, 0, 0, top(-1.2, -0.5));
    expect(session().undo.length).toBe(steps + 1);
    input = edgeInput();
    expect(input.segments[0].points[0]).toEqual(top(-1.2, -0.5));
    expect(input.segments[2].points[2]).toEqual(top(-1.2, -0.5));
    // Removing the closing point opens the path there.
    editor().removeRefinePoint(session().features[0].id, 0, 0);
    input = edgeInput();
    expect(input.closed).toBe(false);
    expect(input.segments.map((s) => s.points)).toEqual([
      [b, c],
      [c, d],
    ]);
    // The first segment, left with one point, goes with the joint at that point.
    expect(input.joints).toEqual(['sharp']);
    // A point shared by two segments leaves the earlier, which the later starts from.
    editor().removeRefinePoint(session().features[0].id, 0, 1);
    expect(edgeInput().segments.map((s) => s.points)).toEqual([[b, d]]);
    expect(edgeInput().joints).toEqual([]);
    editor().undoRefine();
    expect(edgeInput().segments).toHaveLength(2);

    // A spline takes points until it is finished; the next point starts a new segment.
    editor().selectRefine([]);
    editor().setRefineEdge({ kind: 'spline' });
    for (const x of [-1, -0.5, 0, 0.5]) editor().addRefinePoint(top(x, 0.2));
    const spline = session().selected[0];
    expect(edgeInput(spline).segments).toHaveLength(1);
    expect(edgeInput(spline).segments[0].points).toHaveLength(4);
    editor().finishRefineGuide();
    editor().addRefinePoint(top(1, 0.2));
    expect(edgeInput(spline).segments).toHaveLength(2);
    expect(edgeInput(spline).segments[1].points).toEqual([top(0.5, 0.2), top(1, 0.2)]);
    editor().dismissRefine();
    expect(session().features.some((f) => f.id === spline)).toBe(false);
    expect(session().draft).toBeNull();
  });

  it('keeps the preview equal to a fresh one through draft rebuilds', async () => {
    setup([boxPart()], ['box']);
    await ready();
    const preview = session().preview!;
    const id = crestGuide(-1.4, 1.2);
    expect(differingAttributes(preview, freshShown())).toEqual([]);
    editor().moveRefinePoint(id, 0, 1, crest(1.5));
    expect(differingAttributes(preview, freshShown())).toEqual([]);
    editor().setRefineEdge({ strength: 0.5 });
    expect(differingAttributes(preview, freshShown())).toEqual([]);
    editor().selectRefine([]);
    expect(session().draft).toBeNull();
    expect(differingAttributes(preview, fresh())).toEqual([]);
    expect(session().preview).toBe(preview);
  });
});

describe('refine regions', () => {
  it('paints a region, makes it pending, and flattens on accept', async () => {
    const { geometry, rivets } = rivetedPlate();
    setup([boxPart({ id: 'plate', name: 'Plate', geometry })], ['plate']);
    await ready();
    editor().setRefineMode('region');
    editor().setRefineBrushRadius(1);
    const undo = session().undo.length;
    paint(
      [-1.4, 0, 1.4].flatMap((x) =>
        [-0.6, 0.6].map((z) => [x, 0.5, z] as [number, number, number]),
      ),
    );
    expect(session().undo.length).toBe(undo + 6);
    expect(session().triangles.length).toBeGreaterThan(1000);
    editor().makeRefineRegion();
    expect(session().triangles).toEqual([]);
    expect(session().features).toHaveLength(1);
    expect(session().selected).toEqual([session().features[0].id]);
    editor().setRefineRegion({ treatment: 'flatten' });
    const feature = session().features[0].feature;
    expect(feature.type === 'region' && feature.input.treatment).toBe('flatten');
    expect(differingAttributes(session().preview!, freshShown())).toEqual([]);
    const start = session().model!;
    editor().acceptRefine();
    expect(session().features[0].state).toBe('accepted');
    const { mesh } = session().model!;
    let base = 0;
    for (let v = 0; v < mesh.weldedCount; v++) {
      const [x, y, z] = [0, 1, 2].map((k) => mesh.position[v * 3 + k]);
      if (y < 0.4 || Math.abs(x) > 1.8 || Math.abs(z) > 0.9) continue;
      if (rivets.some((r) => Math.hypot(x - r.x, z - r.z) < 0.7)) continue;
      base++;
      expect(Math.abs(y - 0.5)).toBeLessThan(0.005);
    }
    expect(base).toBeGreaterThan(500);
    expect(mesh.corners).toBe(start.mesh.corners);
    expect(differingAttributes(session().preview!, fresh())).toEqual([]);
  });

  it('erases paint and refuses an area too small to fit', async () => {
    setup([boxPart()], ['box']);
    await ready();
    editor().setRefineMode('region');
    editor().setRefineBrushRadius(0.3);
    paint([[0, 1.5, 0]]);
    const painted = session().triangles.length;
    expect(painted).toBeGreaterThan(0);
    paint([[0, 1.5, 0]], true);
    expect(session().triangles).toEqual([]);
    editor().setRefineBrushRadius(0.05);
    editor().setRefineRegion({ treatment: 'flatten' });
    paint([[0, 1.5, 0]]);
    editor().makeRefineRegion();
    expect(toast()).toBe('This area is too small to fit a surface. Paint more of it.');
  });

  it('remaps a pending region when an edge is accepted through it', async () => {
    setup([boxPart()], ['box']);
    await ready();
    editor().setRefineMode('region');
    editor().setRefineBrushRadius(2);
    paint([[0, 1.5, 0]]);
    editor().makeRefineRegion();
    const regionId = session().features[0].id;
    const regionOf = () => {
      const f = session().features.find((f) => f.id === regionId)!.feature;
      if (f.type !== 'region') throw new Error('not a region');
      return f.input.triangles;
    };
    const before = regionOf();
    editor().setRefineMode('edge');
    // A light edge still cuts, and bends the triangles it splits little.
    editor().setRefineEdge({ strength: 0.3 });
    const edge = crestGuide();
    editor().acceptRefine([edge]);
    const previous = session().undo.at(-1)!.model.mesh;
    const { mesh } = session().model!;
    expect(mesh.triangleCount).toBeGreaterThan(previous.triangleCount);
    const after = regionOf();
    expect(after.length).toBeGreaterThan(before.length);
    expect(after.every((t) => t < mesh.triangleCount)).toBe(true);
    // The original triangles, through their own corners on the new surface, cover the same area.
    const original = trianglesArea({ ...mesh, corners: previous.corners }, before);
    expect(Math.abs(trianglesArea(mesh, after) / original - 1)).toBeLessThan(0.01);
    expect(session().features.find((f) => f.id === regionId)!.state).toBe('pending');
  });
});

describe('refine brushes', () => {
  it('brushes as one undo step per stroke', async () => {
    setup([boxPart()], ['box']);
    await ready();
    editor().setRefineMode('brush');
    editor().setRefineBrushRadius(0.4);
    const start = session().model!;
    const position = start.mesh.position.slice();
    const undo = session().undo.length;
    editor().beginRefineStroke(top(-0.5));
    for (let i = 1; i <= 5; i++) editor().moveRefineStroke(top(-0.5 + i * 0.15));
    editor().endRefineStroke();
    expect(session().undo.length).toBe(undo + 1);
    const { mesh } = session().model!;
    expect(mesh.position).not.toEqual(position);
    expect(mesh.corners).toBe(start.mesh.corners);
    expect(mesh.weldOf).toBe(start.mesh.weldOf);
    expect(session().model!.topology).toBe(start.topology);
    expect(differingAttributes(session().preview!, fresh())).toEqual([]);
    editor().undoRefine();
    expect(session().model!.mesh.position).toEqual(position);
    expect(differingAttributes(session().preview!, fresh())).toEqual([]);

    editor().setRefineBrush({ kind: 'flatten' });
    editor().beginRefineStroke(top(0.5));
    editor().moveRefineStroke(top(0.6));
    editor().endRefineStroke();
    expect(session().undo.length).toBe(undo + 1);
    expect(differingAttributes(session().preview!, fresh())).toEqual([]);
  });

  it('adds an accepted edge from a crease stroke', async () => {
    setup([boxPart()], ['box']);
    await ready();
    editor().setRefineMode('brush');
    editor().setRefineBrush({ kind: 'crease', strength: 1 });
    editor().setRefineBrushRadius(0.4);
    const undo = session().undo.length;
    editor().beginRefineStroke(crest(-1.5));
    for (let x = -1.4; x <= 1.5; x += 0.1) editor().moveRefineStroke(crest(x));
    editor().endRefineStroke();
    expect(session().features).toHaveLength(1);
    expect(session().features[0]).toMatchObject({ state: 'accepted', origin: 'hand' });
    expect(session().features[0].feature.type).toBe('edge');
    expect(session().model!.mesh.crease.includes(1)).toBe(true);
    expect(session().undo.length).toBe(undo + 1);

    // Too short a stroke changes nothing.
    const model = session().model;
    editor().beginRefineStroke(crest(0));
    editor().moveRefineStroke(crest(0.05));
    editor().endRefineStroke();
    expect(session().model).toBe(model);
    expect(toast()).toBe(
      'No edge found under this guide. Move it onto the rounded edge or change Width.',
    );
  });

  it('keeps the brush radius per part, starting from the fitted radius', async () => {
    setup([boxPart()], ['box']);
    await ready();
    const part = editor().scene.parts[0];
    expect(refineBrushRadius(editor())).toBe(fittedWarpBrushRadius(part));
    editor().setRefineBrushRadius(0.7);
    expect(refineBrushRadius(editor())).toBe(0.7);
    expect(editor().warpBrush.get('box')).toBe(0.7);
    editor().setRefineMode('region');
    expect(paintingRefine(editor())).toBe(true);
    expect(brushingRefine(editor())).toBe(false);
    editor().setRefineMode('detect');
    expect(paintingRefine(editor())).toBe(false);
    editor().setRefineDetect({ where: 'painted' });
    expect(paintingRefine(editor())).toBe(true);
    editor().setRefineMode('brush');
    expect(brushingRefine(editor())).toBe(true);
  });
});

describe('refine detection', () => {
  it('adds detected proposals without touching the model or the undo stack', async () => {
    setup([boxPart()], ['box']);
    await ready();
    const model = session().model,
      undo = session().undo.length;
    await editor().detectRefine();
    expect(
      session().features.filter((f) => f.origin === 'detected' && f.state === 'pending'),
    ).toHaveLength(18);
    expect(session().model).toBe(model);
    expect(session().undo.length).toBe(undo);
    expect(session().selected).toEqual([]);
    expect(session().detect.running).toBe(false);
    const task = useActivity
      .getState()
      .tasks.find((t) => t.title === 'Finding edges and surfaces')!;
    expect(task.status).toBe('completed');
  });

  it('accepts several selected proposals together as one step', async () => {
    setup([boxPart()], ['box']);
    await ready();
    await editor().detectRefine();
    const edges = session()
      .features.filter((f) => f.feature.type === 'edge')
      .slice(0, 3)
      .map((f) => f.id);
    editor().selectRefine(edges);
    expect(session().draft).not.toBeNull();
    expect(differingAttributes(session().preview!, freshShown())).toEqual([]);
    const undo = session().undo.length;
    editor().acceptRefine();
    expect(
      session()
        .features.filter((f) => f.state === 'accepted')
        .map((f) => f.id),
    ).toEqual(edges);
    expect(session().undo.length).toBe(undo + 1);
    expect(differingAttributes(session().preview!, fresh())).toEqual([]);
  });

  it('drops a detection that finished after the model changed', async () => {
    setup([boxPart()], ['box']);
    await ready();
    const detection = editor().detectRefine();
    crestGuide();
    editor().acceptRefine();
    await detection;
    expect(session().features.filter((f) => f.origin === 'detected')).toHaveLength(0);
    expect(toast()).toBe('The surface changed, so detection was stopped.');
    expect(session().detect.running).toBe(false);
  });

  it('never applies a proposal that was not accepted', async () => {
    setup([boxPart()], ['box']);
    await ready();
    const geometry = editor().scene.parts[0].geometry;
    await editor().detectRefine();
    expect(editor().applyRefine()).toBe(false);
    expect(editor().scene.parts[0].geometry).toBe(geometry);
  });

  it('stops a running detection and its worker on cancel', async () => {
    setup([boxPart()], ['box']);
    await ready();
    const terminate = vi.fn();
    class StuckWorker {
      onmessage = null;
      onerror = null;
      onmessageerror = null;
      postMessage() {}
      terminate = terminate;
    }
    vi.stubGlobal('Worker', StuckWorker);
    try {
      const detection = editor().detectRefine();
      expect(session().detect.running).toBe(true);
      editor().cancelRefineDetect();
      await detection;
    } finally {
      vi.unstubAllGlobals();
    }
    expect(terminate).toHaveBeenCalled();
    expect(session().detect.running).toBe(false);
    expect(session().features).toEqual([]);
    const task = useActivity
      .getState()
      .tasks.find((t) => t.title === 'Finding edges and surfaces')!;
    expect(task.status).toBe('cancelled');
  });
});

describe('refine clean', () => {
  const cleanTask = () =>
    useActivity.getState().tasks.find((t) => t.title === 'Cleaning the surface')!;

  it('cleans the whole working surface as one undo step', async () => {
    setup([boxPart()], ['box']);
    await ready();
    editor().setRefineMode('clean');
    expect(paintingRefine(editor())).toBe(false);
    const start = session().model!;
    const position = start.mesh.position.slice();
    const undo = session().undo.length;
    const cleaning = editor().cleanRefine();
    expect(session().clean.running).toBe(true);
    await cleaning;
    expect(session().clean.running).toBe(false);
    expect(cleanTask().status).toBe('completed');
    expect(session().undo.length).toBe(undo + 1);
    const { mesh } = session().model!;
    expect(mesh.position).not.toEqual(position);
    expect(mesh.corners).toBe(start.mesh.corners);
    expect(session().model!.topology).toBe(start.topology);
    expect(refineEdited(session())).toBe(true);
    expect(differingAttributes(session().preview!, fresh())).toEqual([]);
    editor().undoRefine();
    expect(session().model!.mesh.position).toEqual(position);
    expect(differingAttributes(session().preview!, fresh())).toEqual([]);
    editor().redoRefine();
    const cleaned = fresh();
    expect(editor().applyRefine()).toBe(true);
    expect(differingAttributes(editor().scene.parts[0].geometry, cleaned)).toEqual([]);
    expect(closed(editor().scene.parts[0].geometry)).toBe(true);
    await vi.waitFor(() => expect(session().stage).toBe('ready'));
    expect(session().mode).toBe('clean');
  });

  it('cleans only a painted area, and nothing before one is painted', async () => {
    setup([boxPart()], ['box']);
    await ready();
    editor().setRefineMode('clean');
    editor().setRefineClean({ where: 'painted' });
    expect(paintingRefine(editor())).toBe(true);
    const model = session().model;
    await editor().cleanRefine();
    expect(session().model).toBe(model);
    paint([[0.3, 1.5, 0.2]]);
    const painted = new Set<number>();
    const { mesh } = session().model!;
    for (const t of session().triangles)
      for (let k = 0; k < 3; k++) painted.add(mesh.weldOf[mesh.corners[t * 3 + k]]);
    expect(painted.size).toBeGreaterThan(0);
    await editor().cleanRefine();
    const after = session().model!.mesh;
    let moved = 0;
    for (let v = 0; v < after.weldedCount; v++) {
      const same = [0, 1, 2].every((a) => after.position[v * 3 + a] === mesh.position[v * 3 + a]);
      if (same) continue;
      moved++;
      expect(painted.has(v)).toBe(true);
    }
    expect(moved).toBeGreaterThan(0);
  });

  it('says so when the settings leave the surface as it is', async () => {
    setup([boxPart()], ['box']);
    await ready();
    editor().setRefineMode('clean');
    editor().setRefineClean({ smooth: 0, sharpen: 0, depth: 0 });
    const model = session().model;
    await editor().cleanRefine();
    expect(session().model).toBe(model);
    expect(toast()).toBe('These settings leave the surface as it is.');
  });

  it('drops a clean that finished after the model changed', async () => {
    setup([boxPart()], ['box']);
    await ready();
    editor().setRefineMode('clean');
    const cleaning = editor().cleanRefine();
    commitRefine({ model: movedModel(session().model!, topVertices(), [0, 0.01, 0]) });
    const model = session().model;
    await cleaning;
    expect(session().model).toBe(model);
    expect(toast()).toBe('The surface changed, so cleaning was stopped.');
    expect(session().clean.running).toBe(false);
  });

  it('stops a running clean and its worker on cancel', async () => {
    setup([boxPart()], ['box']);
    await ready();
    editor().setRefineMode('clean');
    const terminate = vi.fn();
    class StuckWorker {
      onmessage = null;
      onerror = null;
      onmessageerror = null;
      postMessage() {}
      terminate = terminate;
    }
    vi.stubGlobal('Worker', StuckWorker);
    const model = session().model;
    try {
      const cleaning = editor().cleanRefine();
      expect(session().clean.running).toBe(true);
      expect(heldRefineState()).toContain('clean');
      editor().cancelRefineClean();
      await cleaning;
    } finally {
      vi.unstubAllGlobals();
    }
    expect(terminate).toHaveBeenCalled();
    expect(session().clean.running).toBe(false);
    expect(session().model).toBe(model);
    expect(cleanTask().status).toBe('cancelled');
    expect(heldRefineState()).toEqual([]);
  });
});

describe('refine lifecycle edges', () => {
  const preparing = () =>
    useActivity.getState().tasks.filter((t) => t.title === 'Preparing to refine');

  it('starts no task when the session is cancelled as it turns building', async () => {
    setup([boxPart()], ['box']);
    const stop = useEditor.subscribe((state) => {
      if (state.refine?.stage === 'building') state.cancelRefine();
    });
    try {
      editor().setTool('refine');
      expect(editor().refine).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(preparing().filter((t) => t.status === 'running')).toHaveLength(0);
    } finally {
      stop();
    }
  });

  it('does not decode the source when cancelled before the code loads', async () => {
    const part = boxPart({ geometry: new BoxGeometry().toNonIndexed() });
    setup([part], ['box']);
    const getX = vi.spyOn(part.geometry.getAttribute('position'), 'getX');
    editor().setTool('refine');
    editor().setTool('select');
    await import('../../src/core/refine-job');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(editor().refine).toBeNull();
    expect(getX).not.toHaveBeenCalled();
  });

  it('fails and closes the session when the preview cannot be made', async () => {
    const geometry = new BoxGeometry();
    vi.spyOn(geometry.getAttribute('normal') as BufferAttribute, 'clone').mockImplementation(() => {
      throw new Error('preview allocation failed');
    });
    setup([boxPart({ geometry })], ['box']);
    editor().setTool('refine');
    await vi.waitFor(() => expect(preparing()[0].status).not.toBe('running'));
    expect(preparing()[0].status).toBe('failed');
    expect(editor().refine).toBeNull();
    expect(toast()).toBe('Box could not be prepared for refining.');
  });

  it('never gives a cut preview the source tree', async () => {
    const geometry = new BoxGeometry().toNonIndexed();
    geometry.boundsTree = new MeshBVH(geometry, { indirect: true });
    setup([boxPart({ geometry })], ['box']);
    await ready();
    const start = session().model!;
    const cut = rebuiltModel(start, (mesh) => splitEdge(mesh, 0));
    commitRefine({ model: cut });
    const preview = session().preview!;
    expect(preview.boundsTree).toBeUndefined();
    commitRefine({ model: movedModel(cut, [0], [0, 0, 0.05]) });
    expect(session().preview).toBe(preview);
    if (preview.boundsTree)
      expect(MeshBVH.serialize(preview.boundsTree as MeshBVH).indirectBuffer!.length).toBe(
        cut.mesh.triangleCount,
      );
  });

  it('makes a dense preview pickable once the source index arrives', async () => {
    const geometry = new PlaneGeometry(24, 24, 225, 225);
    setup([boxPart({ geometry })], ['box']);
    await ready();
    const preview = session().preview!;
    geometry.boundsTree = new MeshBVH(geometry, { indirect: true });
    useEditor.setState({ indexingMeshes: 0 });
    const ray = new Raycaster(new Vector3(0.123, 0.456, 1), new Vector3(0, 0, -1));
    const hits: Intersection[] = [];
    pickRaycast.call(new Mesh(preview), ray, hits);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('indexes a dense preview whose first stroke lands while its index is building', async () => {
    let reply: (() => void) | undefined;
    class HeldWorker {
      onmessage?: (event: { data: unknown }) => void;
      onerror = null;
      onmessageerror = null;
      terminate() {}
      postMessage(message: BvhRequest | RefineRequest, transfer: Transferable[] = []) {
        const payload = structuredClone(message, { transfer });
        if ('type' in payload) {
          const signal = new AbortController().signal;
          const result = runRefineRequest(payload, () => {}, signal);
          queueMicrotask(() => this.onmessage?.({ data: { result } }));
          return;
        }
        reply = () => {
          const geometry = new BufferGeometry();
          geometry.setAttribute('position', new BufferAttribute(payload.positions, 3));
          if (payload.index) geometry.setIndex(new BufferAttribute(payload.index, 1));
          const bvh = MeshBVH.serialize(new MeshBVH(geometry, payload.options));
          this.onmessage?.({ data: { bvh } });
        };
      }
    }
    vi.stubGlobal('Worker', HeldWorker);
    try {
      const geometry = new PlaneGeometry(11.25, 11.25, 225, 225);
      const position = geometry.getAttribute('position');
      for (let v = 0; v < position.count; v++)
        position.setZ(v, 0.03 * Math.cos(position.getX(v) * 15) * Math.cos(position.getY(v) * 6));
      geometry.computeVertexNormals();
      setup([boxPart({ geometry })], ['box']);
      await ready();
      await vi.waitFor(() => expect(reply).toBeDefined());
      editor().setRefineMode('brush');
      editor().setRefineBrush({ kind: 'flatten', strength: 1 });
      editor().setRefineBrushRadius(0.3);
      const preview = session().preview!;
      const version = (preview.getAttribute('position') as BufferAttribute).version;
      editor().beginRefineStroke({ triangle: 2 * (112 * 225 + 112), position: [0, 0, 0.03] });
      expect(session().preview).toBe(preview);
      expect((preview.getAttribute('position') as BufferAttribute).version).toBeGreaterThan(
        version,
      );
      reply!();
      await vi.waitFor(() => expect(preview.boundsTree).toBeDefined());
      const ray = new Raycaster(new Vector3(0.002, 0.012, 1), new Vector3(0, 0, -1));
      const expected: Intersection[] = [],
        actual: Intersection[] = [];
      new Mesh(preview).raycast(ray, expected);
      pickRaycast.call(new Mesh(preview), ray, actual);
      expect(expected).toHaveLength(1);
      expect(actual.map((hit) => [hit.faceIndex, hit.distance])).toEqual(
        expected.map((hit) => [hit.faceIndex, hit.distance]),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('builds the index of an edited geometry again when its triangles changed while it built', async () => {
    const replies: (() => void)[] = [];
    class HeldWorker {
      onmessage?: (event: { data: unknown }) => void;
      onerror = null;
      onmessageerror = null;
      terminate() {}
      postMessage(message: BvhRequest, transfer: Transferable[] = []) {
        const payload = structuredClone(message, { transfer });
        replies.push(() => {
          const geometry = new BufferGeometry();
          geometry.setAttribute('position', new BufferAttribute(payload.positions, 3));
          if (payload.index) geometry.setIndex(new BufferAttribute(payload.index, 1));
          const bvh = MeshBVH.serialize(new MeshBVH(geometry, payload.options));
          this.onmessage?.({ data: { bvh } });
        });
      }
    }
    vi.stubGlobal('Worker', HeldWorker);
    try {
      const geometry = new PlaneGeometry(10, 10, 260, 260);
      prepareEditedForPicking(geometry);
      await vi.waitFor(() => expect(replies).toHaveLength(1));
      const index = geometry.index!.array.slice();
      // The same triangles each turned, a new layout for the tree.
      for (let t = 0; t < index.length; t += 3)
        [index[t], index[t + 1], index[t + 2]] = [index[t + 1], index[t + 2], index[t]];
      geometry.setIndex(new BufferAttribute(index, 1));
      replies[0]();
      await vi.waitFor(() => expect(replies).toHaveLength(2));
      expect(geometry.boundsTree).toBeUndefined();
      replies[1]();
      await vi.waitFor(() => expect(geometry.boundsTree).toBeDefined());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('matches a fresh preview for interleaved colour and custom position accessors', async () => {
    class ScaledPosition extends BufferAttribute {
      override setXYZ(index: number, x: number, y: number, z: number) {
        return super.setXYZ(index, x * 2, y, z);
      }
    }
    const coloured = new BoxGeometry();
    const count = coloured.getAttribute('position').count;
    const packed = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) packed.set([7, i / count, 0.5, 1], i * 4);
    coloured.setAttribute(
      'color',
      new InterleavedBufferAttribute(new InterleavedBuffer(packed, 4), 3, 1),
    );
    const scaled = new BoxGeometry();
    scaled.setAttribute(
      'position',
      new ScaledPosition(Float64Array.from(scaled.getAttribute('position').array), 3),
    );
    for (const part of [
      boxPart({ geometry: coloured }),
      boxPart({ geometry: scaled, scale: [-1, 2, 0.5] }),
    ]) {
      setup([part], ['box']);
      await ready();
      const start = session().model!;
      commitRefine({ model: movedModel(start, [0], [0.005, 0, 0]) });
      expect(differingAttributes(session().preview!, fresh())).toEqual([]);
      commitRefine({ model: movedModel(session().model!, [1], [0, 0.005, 0]) });
      expect(differingAttributes(session().preview!, fresh())).toEqual([]);
      editor().undoRefine();
      editor().undoRefine();
      expect(differingAttributes(session().preview!, fresh())).toEqual([]);
    }
  });

  it('shares the unchanged crease array of a position-only edit', async () => {
    setup([boxPart()], ['box']);
    await ready();
    const start = session().model!;
    commitRefine({ model: movedModel(start, topVertices(), [0, 0.01, 0]) });
    expect(session().model!.mesh.crease).toBe(start.mesh.crease);
  });

  it('keeps the newest step even when it alone is over the byte budget', async () => {
    setup([boxPart()], ['box']);
    await ready();
    const start = session().model!;
    const step = (model: typeof start): RefineStep => ({
      model,
      features: [],
      selected: [],
      triangles: [],
      drawing: false,
      planes: [],
    });
    const oversized = {
      ...start,
      topology: {
        ...start.topology,
        neighbours: new Uint32Array(new ArrayBuffer(refineUndoBytes + 4), 0, 1),
      },
    };
    const older = movedModel(start, [0], [0, 0.01, 0]);
    expect(trimRefineSteps(start, [step(older), step(oversized)], []).undo).toEqual([
      step(oversized),
    ]);
    const positions = new Float64Array(
      new ArrayBuffer(refineUndoBytes + 8),
      0,
      start.mesh.position.length,
    );
    positions.set(start.mesh.position);
    const large = { ...start, mesh: { ...start.mesh, position: positions } };
    commitRefine({ model: large });
    commitRefine({ model: movedModel(large, [0], [0, 0.01, 0]) });
    expect(session().undo).toHaveLength(1);
    expect(session().undo[0].model).toBe(large);
    expect(undoTarget(editor())).toBe('refine');
  });
});

// Several detections and cuts each; slow when the machine is loaded, so no timing is asserted.
describe('refine session integrity', { timeout: 20_000 }, () => {
  const rimRadius = 1.2 + 0.3 / Math.SQRT2,
    rimHeight = 0.7 + 0.3 / Math.SQRT2;
  /** A point on the rounded top rim of softCylinder(1.5, 1, 0.3) at `angle`. */
  const rim = (angle: number) =>
    surfacePoint([rimRadius * Math.cos(angle), rimHeight, rimRadius * Math.sin(angle)]);
  const canPart = () => boxPart({ id: 'can', name: 'Can', geometry: softCylinder(1.5, 1, 0.3) });
  const positionBytes = (model = session().model!) =>
    Buffer.from(model.mesh.position.buffer).toString('base64');

  /** Holds the next detection's worker until `finish` replies with `proposals`. */
  function holdDetect() {
    let reply: ((proposals: RefineProposal[]) => void) | undefined;
    const terminate = vi.fn();
    class HeldWorker {
      onmessage?: (event: { data: unknown }) => void;
      onerror = null;
      onmessageerror = null;
      terminate = terminate;
      postMessage() {
        reply = (result) => this.onmessage?.({ data: { result } });
      }
    }
    vi.stubGlobal('Worker', HeldWorker);
    return { finish: (proposals: RefineProposal[]) => reply!(proposals), terminate };
  }
  const detectTask = () =>
    useActivity.getState().tasks.find((t) => t.title === 'Finding edges and surfaces');

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('closes a spline being drawn on its first point as one step, and solves it on a rim', async () => {
    setup([canPart()], ['can']);
    await ready();
    editor().setRefineEdge({ kind: 'spline', joint: 'smooth', width: 0.6, ...alongPreset });
    const points = [0, 1, 2, 3, 4].map((i) => rim((2 * Math.PI * i) / 5));
    for (const point of points) editor().addRefinePoint(point);
    const undo = session().undo.length;
    editor().addRefinePoint(points[0], true);
    const input = edgeInput();
    expect(input.closed).toBe(true);
    expect(input.segments).toHaveLength(1);
    expect(input.segments[0].points).toEqual([...points, points[0]]);
    expect(input.joints).toEqual(['smooth']);
    expect(session().undo.length).toBe(undo + 1);
    expect(session().drawing).toBe(false);
    const curve = session().features[0].curve!;
    expect(curve.closed).toBe(true);
    // The rim's sharp edge, where the side and the top meet, at radius 1.5 and height 1.
    for (let i = 0; i < curve.points.length; i += 3) {
      const [x, y, z] = curve.points.subarray(i, i + 3);
      expect(Math.abs(Math.hypot(x, z) - 1.5)).toBeLessThan(0.1);
      expect(Math.abs(y - 1)).toBeLessThan(0.1);
    }
    editor().acceptRefine();
    expect(session().features[0].state).toBe('accepted');
  });

  it('restores whether a spline is still being drawn on undo and redo', async () => {
    setup([boxPart()], ['box']);
    await ready();
    editor().setRefineEdge({ kind: 'spline' });
    for (const x of [-1.6, 0, 1.6]) editor().addRefinePoint(crest(x));
    editor().undoRefine();
    expect(session().drawing).toBe(true);
    editor().redoRefine();
    expect(session().drawing).toBe(true);
    editor().addRefinePoint(crest(1.7));
    expect(edgeInput().segments.map((s) => s.points.length)).toEqual([4]);
  });

  it('gives each drag of a handle its own step', async () => {
    setup([boxPart()], ['box']);
    await ready();
    const id = crestGuide();
    const steps = session().undo.length;
    // Without `begin`, a move after anything else starts a new step.
    editor().moveRefinePoint(id, 0, 1, crest(1.3));
    editor().selectRefine([]);
    editor().selectRefine([id]);
    editor().moveRefinePoint(id, 0, 1, crest(1.1));
    expect(session().undo.length).toBe(steps + 2);
    editor().undoRefine();
    expect(edgeInput(id).segments[0].points[1]).toEqual(crest(1.3));
    editor().redoRefine();
    // `begin` starts a step even right after a move of the same point; moves without it extend it.
    editor().moveRefinePoint(id, 0, 1, crest(1.2), true);
    editor().moveRefinePoint(id, 0, 1, crest(1.0));
    editor().moveRefinePoint(id, 0, 1, crest(0.9), true);
    editor().moveRefinePoint(id, 0, 1, crest(0.8), false);
    expect(session().undo.length).toBe(steps + 4);
    editor().undoRefine();
    expect(edgeInput(id).segments[0].points[1]).toEqual(crest(1.0));
  });

  it('keeps the brush settings a stroke began with, and the committed surface, to its end', async () => {
    setup([boxPart()], ['box']);
    await ready();
    editor().setRefineMode('brush');
    editor().setRefineBrushRadius(0.4);
    editor().setRefineBrush({ kind: 'crease', strength: 1 });
    const model = session().model!;
    const before = positionBytes(model);
    editor().beginRefineStroke(top(-0.5));
    editor().setRefineBrush({ kind: 'smooth' });
    editor().moveRefineStroke(top(0.1));
    expect(positionBytes(model)).toBe(before);
    editor().endRefineStroke();
    expect(session().model).toBe(model);

    const stroke = (change: boolean) => {
      editor().setRefineBrush({ kind: 'smooth', strength: 0.5 });
      editor().setRefineBrushRadius(0.4);
      editor().beginRefineStroke(top(-0.5));
      if (change) {
        editor().setRefineBrush({ kind: 'flatten', strength: 1 });
        editor().setRefineBrushRadius(1.5);
      }
      for (let i = 1; i <= 4; i++) editor().moveRefineStroke(top(-0.5 + i * 0.15));
      expect(positionBytes(model)).toBe(before);
      editor().endRefineStroke();
      const bytes = positionBytes();
      editor().undoRefine();
      return bytes;
    };
    expect(stroke(true)).toBe(stroke(false));
  });

  it('lets a stroke own the preview: a draft queued before it does not overwrite it', async () => {
    setup([boxPart()], ['box']);
    await ready();
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal('window', {});
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    crestGuide();
    editor().setRefineMode('brush');
    editor().setRefineBrushRadius(0.4);
    editor().beginRefineStroke(top(-0.5));
    const shown = session().preview!.clone();
    expect(differingAttributes(fresh(), shown)).not.toEqual([]);
    frame!(0);
    editor().moveRefineStroke(top(-0.3));
    editor().selectRefine([]);
    expect(heldRefineState()).not.toContain('frame');
    editor().endRefineStroke();
    expect(differingAttributes(session().preview!, fresh())).toEqual([]);
  });

  it('rebuilds a dragged handle draft after a rest or on release, while its guide follows each move', async () => {
    setup([boxPart()], ['box']);
    await ready();
    const id = crestGuide(-1.4, 1.2);
    const draft = session().draft;
    expect(draft).not.toBeNull();
    let frame: FrameRequestCallback | undefined;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('window', {});
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => (frame = undefined));
    try {
      const end = () => edgeInput(id).segments[0].points[1].position;
      editor().moveRefinePoint(id, 0, 1, crest(1.3), true);
      editor().moveRefinePoint(id, 0, 1, crest(1.25));
      expect(end()).toEqual(crest(1.25).position);
      expect(frame).toBeUndefined();
      expect(session().draft).toBe(draft);
      expect(heldRefineState()).toContain('rest');
      vi.advanceTimersByTime(refineDragRest - 1);
      expect(frame).toBeUndefined();
      vi.advanceTimersByTime(1);
      frame!(0);
      frame = undefined;
      const rested = session().draft;
      expect(rested).not.toBe(draft);
      expect(rested).not.toBeNull();
      editor().moveRefinePoint(id, 0, 1, crest(1.2));
      expect(end()).toEqual(crest(1.2).position);
      expect(session().draft).toBe(rested);
      editor().endRefineDrag();
      expect(heldRefineState()).not.toContain('rest');
      frame!(0);
      expect(session().draft).not.toBe(rested);
      expect(differingAttributes(session().preview!, freshShown())).toEqual([]);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it.each(['release', 'mode', 'selection'] as const)(
    'guards Accept when a handle draft is pending on %s',
    async (change) => {
      setup([boxPart()], ['box']);
      await ready();
      const first = crestGuide(-1.4, 1.2);
      editor().selectRefine([]);
      const second = crestGuide(-1.4, 1.1);
      editor().selectRefine([first]);
      const { model, draft } = session();
      let frame: FrameRequestCallback | undefined;
      let frameId = 0;
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      vi.stubGlobal('window', {});
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        frame = callback;
        return ++frameId;
      });
      vi.stubGlobal('cancelAnimationFrame', () => (frame = undefined));
      try {
        editor().moveRefinePoint(first, 0, 1, crest(0.6), true);
        editor().acceptRefine();
        expect(session().model).toBe(model);
        expect(session().draft).toBe(draft);
        vi.advanceTimersByTime(refineDragRest);
        frame!(0);
        expect(session().draft).not.toBe(draft);
        editor().presentRefineDraft(session());
        editor().acceptRefine();
        expect(session().model).toBe(model);

        editor().moveRefinePoint(first, 0, 1, crest(0.9));
        editor().endRefineDrag();
        const released = session();
        const queued = frame!;
        if (change === 'mode') editor().setRefineMode('region');
        if (change === 'selection') editor().selectRefine([second]);
        editor().presentRefineDraft(released);
        editor().acceptRefine();
        expect(session().model).toBe(model);
        const solve = vi.spyOn(edgeCode, 'solveEdge');
        queued(0);
        if (change !== 'release') {
          expect(solve).not.toHaveBeenCalled();
          frame!(0);
        }
        editor().acceptRefine();
        expect(session().model).toBe(model);
        editor().presentRefineDraft(session());
        editor().acceptRefine();
        const accepted = session()
          .features.filter((f) => f.state === 'accepted')
          .map((f) => f.id);
        expect(accepted).toEqual(change === 'mode' ? [] : [change === 'release' ? first : second]);
        if (change === 'mode') {
          expect(solve).not.toHaveBeenCalled();
          expect(session().draft).toBeNull();
        }
      } finally {
        vi.useRealTimers();
        vi.unstubAllGlobals();
      }
    },
  );

  it('discards a stroke on a mode change: nothing is committed and the preview shows the model', async () => {
    setup([boxPart()], ['box']);
    await ready();
    editor().setRefineMode('brush');
    editor().setRefineBrushRadius(0.4);
    const model = session().model,
      undo = session().undo.length;
    editor().beginRefineStroke(top(-0.5));
    editor().moveRefineStroke(top(-0.2));
    expect(differingAttributes(session().preview!, fresh())).not.toEqual([]);
    editor().setRefineMode('edge');
    expect(differingAttributes(session().preview!, fresh())).toEqual([]);
    editor().endRefineStroke();
    expect(session().model).toBe(model);
    expect(session().undo.length).toBe(undo);
    expect(differingAttributes(session().preview!, fresh())).toEqual([]);
  });

  it.each(['cancel', 'tool', 'part', 'scene undo', 'apply'] as const)(
    'leaves nothing held after a %s',
    async (exit) => {
      for (const holding of ['guide', 'stroke'] as const) {
        setup([boxPart()], ['box']);
        if (exit === 'scene undo') editor().renameScene('Undoable rename');
        await ready();
        // Something accepted, so Apply has work to write.
        editor().setRefineEdge({ strength: 0.3 });
        editor().acceptRefine([crestGuide()]);
        const model = session().model!;
        if (holding === 'guide') {
          const id = crestGuide(-1.4, 1.2);
          editor().moveRefinePoint(id, 0, 1, crest(1.3));
          expect(heldRefineState()).toEqual(['draft', 'drag']);
        } else {
          editor().setRefineMode('brush');
          editor().setRefineBrushRadius(0.4);
          editor().beginRefineStroke(top(-0.5));
          expect(heldRefineState()).toContain('stroke');
        }
        if (exit === 'cancel') editor().cancelRefine();
        if (exit === 'tool') editor().setTool('select');
        if (exit === 'part') editor().transform('box', { position: [1, 0, 0] });
        if (exit === 'scene undo') editor().undo();
        if (exit === 'apply') expect(editor().applyRefine()).toBe(true);
        expect(heldRefineState()).toEqual([]);
        editor().endRefineStroke();
        if (exit !== 'apply') {
          expect(editor().refine).toBeNull();
          continue;
        }
        // Apply writes the accepted model, never the stroke, and starts afresh.
        const part = editor().scene.parts[0];
        const written = writeRefinedGeometry(holdingSource(), partMatrix(part), model.mesh);
        expect(differingAttributes(part.geometry, written)).toEqual([]);
        expect(session()).toMatchObject({ draft: null, draftSkipped: false, undo: [], redo: [] });
        await vi.waitFor(() => expect(session().stage).toBe('ready'));
        editor().cancelRefine();
      }
    },
  );
  let source: BufferGeometry | null = null;
  const holdingSource = () => source!;
  beforeEach(() => {
    source = null;
    const unsubscribe = useEditor.subscribe((state) => {
      if (state.refine && !source) source = state.refine.source;
    });
    return unsubscribe;
  });

  it('settles detection on a cancel that comes after the job replied', async () => {
    setup([boxPart()], ['box']);
    await ready();
    const job = editor().detectRefine();
    await Promise.resolve();
    editor().cancelRefineDetect();
    await job;
    expect(session().features).toEqual([]);
    expect(session().detect.running).toBe(false);
    expect(detectTask()?.status).toBe('cancelled');

    const held = holdDetect();
    const closing = editor().detectRefine();
    held.finish([]);
    editor().cancelRefine();
    await closing;
    expect(detectTask()?.status).toBe('cancelled');
    expect(heldRefineState()).toEqual([]);
  });

  it('replaces pending detected proposals and leaves out what is accepted', async () => {
    setup([boxPart()], ['box']);
    await ready();
    const hand = crestGuide();
    await editor().detectRefine();
    // 18 on the bare box; the edge the hand-drawn guide lies on is not proposed again.
    const first = session().features.filter((f) => f.origin === 'detected');
    expect(first).toHaveLength(17);
    editor().selectRefine([hand, first[0].id]);
    const undo = session().undo.length;
    await editor().detectRefine();
    const second = session().features.filter((f) => f.origin === 'detected');
    expect(second).toHaveLength(17);
    expect(second.map((f) => f.feature)).toEqual(first.map((f) => f.feature));
    expect(second.some((f) => first.includes(f))).toBe(false);
    expect(session().features[0].id).toBe(hand);
    // The selected proposal's replacement takes its place in the selection.
    expect(session().selected).toEqual([hand, second[0].id]);
    expect(session().undo.length).toBe(undo);

    const target = second.find((f) => f.feature.type === 'edge')!;
    editor().acceptRefine([target.id]);
    const accepted = session().features.find((f) => f.id === target.id)!;
    expect(accepted.state).toBe('accepted');
    await editor().detectRefine();
    const third = session().features.filter(
      (f) => f.origin === 'detected' && f.state === 'pending',
    );
    const along = third.filter(
      ({ feature }) =>
        feature.type === 'edge' &&
        feature.input.segments
          .flatMap((s) => s.points)
          .every((p) => nearestOnCurve(accepted.curve!, p.position) <= 0.15),
    );
    expect(third.length).toBeGreaterThan(0);
    expect(along).toEqual([]);
    expect(session().features.filter((f) => f.state === 'accepted')).toEqual([accepted]);
  });

  it('leaves out a detected region mostly inside an accepted one', async () => {
    const { geometry } = rivetedPlate();
    setup([boxPart({ id: 'plate', name: 'Plate', geometry })], ['plate']);
    await ready();
    editor().setRefineMode('region');
    editor().setRefineBrushRadius(0.8);
    paint([[0, 0.5, 0]]);
    editor().makeRefineRegion();
    const region = session().features[0];
    if (region.feature.type !== 'region') throw new Error('not a region');
    const { triangles } = region.feature.input;
    editor().acceptRefine();
    const covered = new Set(triangles);
    const outside: number[] = [];
    for (let t = 0; outside.length < triangles.length; t++) if (!covered.has(t)) outside.push(t);
    // Six tenths and four tenths of each proposal inside the accepted region.
    const mixed = (share: number) => {
      const count = Math.round(triangles.length * share);
      return Uint32Array.from([...triangles.subarray(0, count), ...outside.slice(count)]).sort();
    };
    const [inside, half] = [mixed(0.6), mixed(0.4)];
    const held = holdDetect();
    const detection = editor().detectRefine();
    const proposal = (t: Uint32Array): RefineProposal => ({
      type: 'region',
      input: { ...region.feature.input, triangles: t } as RegionInput,
    });
    held.finish([proposal(inside), proposal(half)]);
    await detection;
    const found = session().features.filter((f) => f.origin === 'detected');
    expect(found.map((f) => f.feature.type === 'region' && f.feature.input.triangles)).toEqual([
      half,
    ]);
  });

  it('cancels a stroke under way, leaving the steps and the model as they were', async () => {
    setup([boxPart()], ['box']);
    await ready();
    crestGuide();
    editor().acceptRefine();
    editor().undoRefine();
    editor().setRefineMode('brush');
    editor().setRefineBrushRadius(0.4);
    const { model, undo, redo } = session();
    editor().beginRefineStroke(top(-0.5));
    for (let i = 1; i <= 4; i++) editor().moveRefineStroke(top(-0.5 + i * 0.15));
    expect(differingAttributes(session().preview!, fresh())).not.toEqual([]);
    editor().cancelRefineStroke();
    editor().endRefineStroke();
    expect(session().model).toBe(model);
    expect(session().undo).toEqual(undo);
    expect(session().redo).toEqual(redo);
    expect(session().redo).toHaveLength(1);
    expect(differingAttributes(session().preview!, fresh())).toEqual([]);
    expect(heldRefineState()).not.toContain('stroke');
  });

  /** The end-to-end fixture: a coarse 0.2 mm mesh with a 0.6 mm fillet. */
  const coarseBox = () =>
    boxPart({ geometry: softBox([4, 3, 2], 0.6, { step: 0.2, ripple: 0.04, noise: 0.008 }) });
  const coarseCrest = (x: number) => surfacePoint([x, 3 - 0.1757, 2 - 0.1757]); // 0.6 - 0.6 / sqrt(2)
  const creaseStroke = () => {
    editor().setRefineMode('brush');
    editor().setRefineBrush({ kind: 'crease', strength: 1 });
    editor().beginRefineStroke(coarseCrest(-3));
    for (let i = 1; i <= 30; i++) editor().moveRefineStroke(coarseCrest(-3 + i * 0.2));
    editor().endRefineStroke();
  };

  it('adds an edge from a crease stroke on a coarse mesh with a brush as wide as the fillet', async () => {
    setup([coarseBox()], ['box']);
    await ready();
    editor().setRefineBrushRadius(1.2);
    creaseStroke();
    expect(session().features).toHaveLength(1);
    expect(session().features[0]).toMatchObject({ state: 'accepted', origin: 'hand' });
  });

  // The default radius here is 0.24 mm and this 0.6 mm fillet needs a guide about 1 mm wide.
  it('falls back to the automatic width when a crease stroke is narrower than the rounding', async () => {
    setup([coarseBox()], ['box']);
    await ready();
    const model = session().model,
      undo = session().undo.length;
    creaseStroke();
    // Wider than the brush: previewed, selected and waiting, never accepted on release.
    expect(session().features).toHaveLength(1);
    expect(session().features[0]).toMatchObject({ state: 'pending', origin: 'hand' });
    expect(edgeInput(session().features[0].id).width).toBeNull();
    expect(session().selected).toEqual([session().features[0].id]);
    expect(session().model).toBe(model);
    expect(session().undo.length).toBe(undo + 1);
    expect(session().draft).not.toBeNull();
    expect(toast()).toBe('The edge is wider than the brush. Check the preview, then accept it.');
  });

  it('accepts a crease guide wider than the brush once the user accepts it', async () => {
    setup([coarseBox()], ['box']);
    await ready();
    creaseStroke();
    const id = session().features[0].id;
    const undo = session().undo.length;
    editor().acceptRefine();
    expect(session().features[0]).toMatchObject({ id, state: 'accepted' });
    expect(session().model!.mesh.crease.includes(1)).toBe(true);
    expect(session().undo.length).toBe(undo + 1);
    editor().undoRefine();
    editor().undoRefine();
    expect(session().features).toEqual([]);
  });

  it('keeps detected proposals the user edited, and their selection, across Detect', async () => {
    setup([boxPart()], ['box']);
    await ready();
    const line: RefineProposal = {
      type: 'edge',
      input: {
        segments: [{ kind: 'line', points: [crest(-1), crest(1)] }],
        joints: [],
        closed: false,
        width: null,
        strength: 1,
      },
    };
    const area: RefineProposal = {
      type: 'region',
      input: { ...session().region, triangles: Uint32Array.of(0, 1, 2, 3) },
    };
    const publish = async (proposals: RefineProposal[]) => {
      const held = holdDetect();
      const detection = editor().detectRefine();
      held.finish(proposals);
      await detection;
    };
    await publish([line, area, line]);
    const [a, b, c] = session().features.map((f) => f.id);
    editor().selectRefine([a, b, c]);
    editor().setRefineEdge({}, { [a]: { width: 0.6 } });
    editor().moveRefinePoint(a, 0, 0, crest(-1.2), true);
    editor().setRefineRegion({ strength: 0.3 });
    const edited = [a, b].map((id) => session().features.find((f) => f.id === id)!);
    expect(edited.map((f) => f.edited)).toEqual([true, true]);
    expect(session().features.find((f) => f.id === c)!.edited).toBeUndefined();
    await publish([line, area]);
    expect(
      session()
        .features.slice(0, 2)
        .map((f) => f.feature),
    ).toEqual(edited.map((f) => f.feature));
    expect(
      session()
        .features.slice(0, 2)
        .map((f) => f.id),
    ).toEqual([a, b]);
    expect(session().features.some((f) => f.id === c)).toBe(false);
    // The run's line and area repeat the edited ones, so nothing new is added.
    expect(session().features).toHaveLength(2);
    expect(session().selected).toEqual([a, b]);
  });

  it('repeats an accepted edge only along it, and a region only by most of its area', async () => {
    setup([boxPart()], ['box']);
    await ready();
    const edge = (kind: 'line' | 'arc', points: [number, number, number][]): RefineProposal => ({
      type: 'edge',
      input: {
        segments: [{ kind, points: points.map((position) => ({ position, triangle: 0 })) }],
        joints: [],
        closed: false,
        width: null,
        strength: 1,
      },
    });
    const arcPoints: [number, number, number][] = [
      [-1, 0, 0],
      [0, 1, 0],
      [1, 0, 0],
    ];
    const chord = edge('line', [arcPoints[0], arcPoints[2]]);
    const along = edge('line', [
      [-0.8, 0.6, 0],
      [-0.6, 0.8, 0],
    ]);
    const { mesh } = session().model!;
    const areas = Array.from({ length: mesh.triangleCount }, (_, t) => trianglesArea(mesh, [t]));
    // A small accepted region inside a large proposal: most of its triangles, little of its area.
    const order = areas.map((_, t) => t).sort((x, y) => areas[x] - areas[y]);
    const small = order.slice(0, 18),
      large = order.slice(-8);
    const region = (triangles: number[]): RefineProposal => ({
      type: 'region',
      input: { ...session().region, triangles: Uint32Array.from(triangles).sort() },
    });
    const surrounding = region([...small, ...large]);
    const mostly = region([...small, ...order.slice(18, 20)]);
    useEditor.setState({
      refine: {
        ...session(),
        features: [
          {
            id: 'arc',
            state: 'accepted',
            origin: 'hand',
            feature: edge('arc', arcPoints),
            curve: fitCurve('arc', arcPoints.flat(), 3, 0.025),
          },
          { id: 'small', state: 'accepted', origin: 'hand', feature: region(small) },
        ],
      },
    });
    expect(trianglesArea(mesh, small)).toBeLessThan(trianglesArea(mesh, large) / 2);
    const held = holdDetect();
    const detection = editor().detectRefine();
    held.finish([chord, along, surrounding, mostly]);
    await detection;
    expect(
      session()
        .features.filter((f) => f.state === 'pending')
        .map((f) => f.feature),
    ).toEqual([chord, surrounding]);
  });

  it('proposes nothing again along a detected edge the user edited', async () => {
    setup([boxPart()], ['box']);
    await ready();
    await editor().detectRefine();
    const first = session().features;
    const target = first.find((f) => f.feature.type === 'edge')!;
    editor().selectRefine([target.id]);
    editor().setRefineEdge({}, { [target.id]: { width: 0.4 } });
    editor().selectRefine([]);
    const edited = session().features.find((f) => f.id === target.id)!;
    expect(edited.edited).toBe(true);
    await editor().detectRefine();
    const pending = session().features.filter((f) => f.origin === 'detected');
    expect(pending.filter((f) => f.id === target.id)).toEqual([edited]);
    // The run's own copy of that edge is left out; every other proposal is back.
    expect(pending).toHaveLength(first.length);
    expect(pending.filter((f) => sameProposal(f.feature, target.feature))).toEqual([]);
  });

  it('proposes nothing again along or inside edited proposals', async () => {
    setup([boxPart()], ['box']);
    await ready();
    const line: RefineProposal = {
      type: 'edge',
      input: {
        segments: [{ kind: 'line', points: [crest(-1), crest(1)] }],
        joints: [],
        closed: false,
        width: null,
        strength: 1,
      },
    };
    const area: RefineProposal = {
      type: 'region',
      input: { ...session().region, triangles: Uint32Array.of(0, 1, 2, 3) },
    };
    const publish = async (proposals: RefineProposal[]) => {
      const held = holdDetect();
      const detection = editor().detectRefine();
      held.finish(proposals);
      await detection;
    };
    await publish([line, area]);
    const [edge, region] = session().features.map((f) => f.id);
    editor().selectRefine([edge, region]);
    editor().setRefineEdge({}, { [edge]: { width: 0.6 } });
    editor().setRefineRegion({ strength: 0.4 });
    editor().selectRefine([]);
    const kept = session().features;
    await publish([line, area]);
    expect(session().features).toEqual(kept);
  });

  it('proposes nothing along a hand-drawn guide, and keeps its selection', async () => {
    setup([boxPart()], ['box']);
    await ready();
    await editor().detectRefine();
    const all = session().features.map((f) => f.feature);
    editor().dismissRefine(session().features.map((f) => f.id));
    const hand = crestGuide();
    const guide = session().features.find((f) => f.id === hand)!;
    expect(guide.curve).toBeDefined();
    await editor().detectRefine();
    expect(session().selected).toEqual([hand]);
    const found = session().features.filter((f) => f.origin === 'detected');
    expect(found).toHaveLength(all.length - 1);
    // The one left out is the edge the guide lies on: its middle is on the guide's curve.
    const missing = all.filter((p) => !found.some((f) => sameProposal(f.feature, p)));
    expect(missing).toHaveLength(1);
    const [left] = missing;
    if (left.type !== 'edge') throw new Error('not an edge');
    const points = left.input.segments.flatMap((s) => s.points.map((p) => p.position));
    const middle = [0, 1, 2].map((k) => (points[0][k] + points.at(-1)![k]) / 2);
    expect(nearestOnCurve(guide.curve!, middle as [number, number, number])).toBeLessThan(0.15);
  });

  it('keeps a pending crease guide selected through Detect, and a new stroke lets go of it', async () => {
    setup([coarseBox()], ['box']);
    await ready();
    creaseStroke();
    const crease = session().features[0];
    expect(session().selected).toEqual([crease.id]);
    editor().setRefineMode('detect');
    await editor().detectRefine();
    expect(session().selected).toEqual([crease.id]);
    expect(session().features[0]).toBe(crease);
    editor().setRefineMode('brush');
    expect(session().draft).not.toBeNull();
    // A new stroke owns the preview: the guide stays pending, deselected, without a draft.
    editor().setRefineBrush({ kind: 'smooth' });
    editor().beginRefineStroke(coarseCrest(0));
    editor().endRefineStroke();
    expect(session().features[0]).toMatchObject({ id: crease.id, state: 'pending' });
    expect(session().selected).toEqual([]);
    expect(session().draft).toBeNull();
  });

  it('says failure before pieces before skipped triangles and undo removes the cut marks', async () => {
    setup([boxPart()], ['box']);
    await ready();
    editor().setRefineEdge(alongPreset);
    editor().addRefinePoint(top(-1));
    editor().addRefinePoint(top(1));
    const failed = session().selected[0];
    const edge = crestGuide();
    const apply = edgeCode.applyEdge;
    const cut = vi.spyOn(edgeCode, 'applyEdge').mockImplementation((...args) => {
      const result = apply(...args);
      if (!result.cut) return result;
      const pairs = result.cut.edges;
      const position = args[0].position;
      const kept = [];
      for (let i = 0; i < pairs.length; i += 2) {
        const [a, b] = [pairs[i], pairs[i + 1]];
        if (
          (position[a * 3] < -0.2 && position[b * 3] < -0.2) ||
          (position[a * 3] > 0.2 && position[b * 3] > 0.2)
        )
          kept.push(a, b);
      }
      return {
        ...result,
        pieces: 2,
        cut: { ...result.cut, edges: Uint32Array.from(kept) },
        skipped: Uint32Array.of(10),
      };
    });
    try {
      editor().setRefineMode('detect');
      editor().selectRefine([failed, edge]);
      useActivity.setState({ notifications: [] });
      editor().acceptRefine();
      expect(useActivity.getState().notifications.map((n) => n.message)).toEqual([
        'No edge found under this guide. Move it onto the rounded edge or change Width.',
      ]);
      editor().undoRefine();
      editor().selectRefine([edge]);
      useActivity.setState({ notifications: [] });
      editor().acceptRefine();
      expect(useActivity.getState().notifications.map((n) => n.message)).toEqual([
        'The edge was cut in 2 pieces. Undo to adjust the guide, or keep it.',
      ]);
      const accepted = (id: string) => session().features.find((f) => f.id === id)!;
      expect(accepted(edge).pieces).toBe(2);
      expect(accepted(edge).cutDisplay?.breaks).toHaveLength(6);
      expect(session().skipped).toEqual(Uint32Array.of(10));
      editor().undoRefine();
      expect(accepted(edge).pieces).toBeUndefined();
      expect(accepted(edge).cutDisplay).toBeUndefined();
    } finally {
      cut.mockRestore();
    }
  });

  it('says one thing per Accept press when a batch both fails a guide and leaves a rough cut', async () => {
    setup(
      [boxPart({ geometry: softBox([2, 1.5, 1], 0.3, { seed: 8, step: 0.2, noise: 0.012 }) })],
      ['box'],
    );
    await ready();
    const said: string[] = [];
    const notify = editor().notify;
    useEditor.setState({
      notify: (message, kind) => {
        said.push(message);
        notify(message, kind);
      },
    });
    // A guide across the middle of the front face, 1.5 mm from the edges above and below it, past
    // this coarse mesh's reach of 1.39 mm (6 edge lengths): no pair of flanks meets within reach,
    // whatever the width is measured from. A guide on the middle of the top face, 1.0 mm from the
    // front and back edges, is within that reach: it was refused only while the width was measured
    // from the guide, which left the far flank outside the band.
    editor().addRefinePoint(surfacePoint([-1.2, 0, 1]));
    editor().addRefinePoint(surfacePoint([1.2, 0, 1]));
    // A closed loop of lines round the top's four crests, sharp at its corners: cut, but not cleanly.
    const inset = 0.3 * (1 - Math.SQRT1_2);
    const [x, y, z] = [2 - inset, 1.5 - inset, 1 - inset];
    const corners = [
      [x, y, z],
      [x, y, -z],
      [-x, y, -z],
      [-x, y, z],
    ].map((p) => surfacePoint(p as [number, number, number]));
    const refine = session();
    useEditor.setState({
      refine: {
        ...refine,
        selected: [],
        features: [
          ...refine.features,
          {
            id: 'loop',
            state: 'pending',
            origin: 'hand',
            feature: {
              type: 'edge',
              input: {
                segments: corners.map((point, i) => ({
                  kind: 'line' as const,
                  points: [point, corners[(i + 1) % 4]],
                })),
                joints: ['sharp', 'sharp', 'sharp', 'sharp'],
                closed: true,
                width: null,
                strength: 1,
              },
            },
          },
        ],
      },
    });
    editor().setRefineMode('detect');
    editor().selectRefine(session().features.map((f) => f.id));
    expect(said.filter((m) => m.startsWith('No edge found'))).toHaveLength(1);
    for (const { id } of useActivity.getState().notifications) dismissNotification(id);
    const before = said.length;
    editor().acceptRefine();
    expect(session().features.map((f) => f.state)).toEqual(['pending', 'accepted']);
    // The cut left marks, which the footer and the surface show; the press says only the failure.
    expect(session().skipped.length + session().folds.length).toBeGreaterThan(0);
    expect(said.slice(before)).toEqual([said[0]]);

    // Without a failure in the press, the cut warning is the one thing said.
    editor().undoRefine();
    editor().selectRefine(['loop']);
    const next = said.length;
    editor().acceptRefine();
    expect(session().skipped.length + session().folds.length).toBeGreaterThan(0);
    expect(said.slice(next)).toEqual([
      'Some triangles along this edge could not be cut cleanly. Check the marked area.',
    ]);
  });

  /** The detected proposal on the coarse box's top front edge. */
  const topFrontProposal = () =>
    session().features.find(
      (f) =>
        f.origin === 'detected' &&
        f.feature.type === 'edge' &&
        f.feature.input.segments
          .flatMap((s) => s.points)
          .every((p) => p.position[1] > 2 && p.position[2] > 1),
    )!;
  const sameSegments = (a: RefineProposal, b: RefineProposal) =>
    a.type === 'edge' &&
    b.type === 'edge' &&
    JSON.stringify(a.input.segments) === JSON.stringify(b.input.segments);

  it('proposes an edited edge once, though its solved edge lies off its guide', async () => {
    setup([coarseBox()], ['box']);
    await ready();
    editor().setRefineMode('detect');
    await editor().detectRefine();
    const count = session().features.length;
    const target = topFrontProposal();
    editor().selectRefine([target.id]);
    editor().setRefineEdge({ strength: 0.74 });
    const edited = session().features.find((f) => f.id === target.id)!;
    expect(edited.edited).toBe(true);
    // The case at issue: the rebuilt sharp edge is farther from the guide than the 0.15 mm test.
    if (edited.feature.type !== 'edge') throw new Error('not an edge');
    const guide = edited.feature.input.segments.flatMap((s) => s.points);
    expect(
      Math.max(...guide.map((p) => nearestOnCurve(edited.curve!, p.position))),
    ).toBeGreaterThan(0.15);
    await editor().detectRefine();
    expect(session().selected).toEqual([target.id]);
    expect(session().features.find((f) => f.id === target.id)).toEqual(edited);
    const along = session().features.filter((f) => sameSegments(f.feature, target.feature));
    expect(along.map((f) => f.id)).toEqual([target.id]);
    expect(session().features).toHaveLength(count);
  });

  it('passes the place of a replaced proposal in the selection to its counterpart', async () => {
    setup([coarseBox()], ['box']);
    await ready();
    editor().setRefineMode('detect');
    await editor().detectRefine();
    const target = topFrontProposal();
    editor().selectRefine([target.id]);
    await editor().detectRefine();
    const replacement = session().features.find(
      (f) => JSON.stringify(f.feature) === JSON.stringify(target.feature),
    )!;
    expect(replacement.id).not.toBe(target.id);
    expect(session().selected).toEqual([replacement.id]);
    expect(session().draft).not.toBeNull();
  });

  it('passes the selection of a region on to a counterpart only, and drops one without', async () => {
    setup([boxPart()], ['box']);
    await ready();
    const region = (triangles: number[]): RefineProposal => ({
      type: 'region',
      input: { ...session().region, triangles: Uint32Array.from(triangles) },
    });
    const line: RefineProposal = {
      type: 'edge',
      input: {
        segments: [{ kind: 'line', points: [crest(-1), crest(1)] }],
        joints: [],
        closed: false,
        width: null,
        strength: 1,
      },
    };
    const publish = async (proposals: RefineProposal[]) => {
      const held = holdDetect();
      const detection = editor().detectRefine();
      held.finish(proposals);
      await detection;
    };
    await publish([region([0, 1, 2, 3]), line]);
    const [area, edge] = session().features.map((f) => f.id);
    editor().selectRefine([area, edge]);
    // The same area, a little larger; no edge this time.
    await publish([region([0, 1, 2, 3, 4])]);
    const [next] = session().features;
    expect(next.id).not.toBe(area);
    expect(session().selected).toEqual([next.id]);
    // A region mostly outside the old one is not its counterpart.
    await publish([region([2, 3, 4, 5, 6, 7, 8, 9])]);
    expect(session().selected).toEqual([]);
  });

  it('tells the user when leaving discards work they made, and only then', async () => {
    const notice = 'Refinement discarded. Use Apply to keep it.';
    const cases: [string, () => Promise<void> | void, boolean][] = [
      ['nothing', () => {}, false],
      ['untouched detections', () => editor().detectRefine(), false],
      ['a hand-drawn guide', () => void crestGuide(), true],
      [
        'an edited detection',
        async () => {
          await editor().detectRefine();
          editor().selectRefine([session().features.find((f) => f.feature.type === 'edge')!.id]);
          editor().setRefineEdge({ strength: 0.5 });
        },
        true,
      ],
      [
        'painted triangles',
        () => {
          editor().setRefineMode('region');
          editor().setRefineBrushRadius(0.3);
          paint([[0, 1.5, 0]]);
        },
        true,
      ],
      [
        'an accepted edge',
        () => {
          editor().setRefineEdge({ strength: 0.3 });
          editor().acceptRefine([crestGuide()]);
        },
        true,
      ],
    ];
    for (const [name, make, work] of cases) {
      setup([boxPart()], ['box']);
      await ready();
      await make();
      expect(refineHoldsWork(session()), name).toBe(work);
      useEditor.setState({ toast: null });
      editor().setTool('select');
      expect(editor().refine, name).toBeNull();
      expect(toast(), name).toBe(work ? notice : undefined);
    }
    // A pending crease guide, then the part changing under the session.
    setup([coarseBox()], ['box']);
    await ready();
    creaseStroke();
    expect(session().features[0]).toMatchObject({ origin: 'hand', state: 'pending' });
    expect(refineHoldsWork(session())).toBe(true);
    useEditor.setState({ toast: null });
    editor().transform('box', { position: [1, 0, 0] });
    expect(editor().refine).toBeNull();
    expect(toast()).toBe('The part changed, so the refinement was cancelled.');
  });

  it.each(['short first', 'whole first'] as const)(
    'passes a selected edge on to its exact replacement, not a fragment of it (%s)',
    async (order) => {
      setup([boxPart()], ['box']);
      await ready();
      const [from, to] = [crest(-1.2), crest(1.2)];
      const at = (t: number): GuidePoint => ({
        triangle: from.triangle,
        position: [0, 1, 2].map(
          (k) => from.position[k] + t * (to.position[k] - from.position[k]),
        ) as [number, number, number],
      });
      const line = (a: GuidePoint, b: GuidePoint): RefineProposal => ({
        type: 'edge',
        input: {
          segments: [{ kind: 'line', points: [a, b] }],
          joints: [],
          closed: false,
          width: null,
          strength: 1,
        },
      });
      const whole = line(from, to);
      const short = line(at(0.4), at(0.6));
      const publish = async (proposals: RefineProposal[]) => {
        const held = holdDetect();
        const detection = editor().detectRefine();
        held.finish(proposals.map((p) => structuredClone(p)));
        await detection;
      };
      await publish([whole]);
      editor().selectRefine([session().features[0].id]);
      await publish(order === 'short first' ? [short, whole] : [whole, short]);
      const chosen = session().features.find((f) => f.id === session().selected[0])!;
      expect(session().selected).toHaveLength(1);
      expect(chosen.feature).toEqual(whole);
      // Without an exact match, a fragment alone does not stand in for the whole.
      await publish([short]);
      expect(session().selected).toEqual([]);
    },
  );

  it('passes a selected edge on to one that covers it and is covered by it', async () => {
    setup([boxPart()], ['box']);
    await ready();
    const line = (a: GuidePoint, b: GuidePoint): RefineProposal => ({
      type: 'edge',
      input: {
        segments: [{ kind: 'line', points: [a, b] }],
        joints: [],
        closed: false,
        width: null,
        strength: 1,
      },
    });
    const publish = async (proposals: RefineProposal[]) => {
      const held = holdDetect();
      const detection = editor().detectRefine();
      held.finish(proposals);
      await detection;
    };
    await publish([line(crest(-1.2), crest(1.2))]);
    editor().selectRefine([session().features[0].id]);
    // The same edge drawn a little differently: each covers the other.
    const again = line(crest(-1.18), crest(1.21));
    await publish([again]);
    expect(session().features.find((f) => f.id === session().selected[0])!.feature).toEqual(again);
  });

  it('puts the Edge default back as captured, whatever is selected by then', async () => {
    setup([boxPart()], ['box']);
    await ready();
    const id = crestGuide();
    editor().setRefineEdge({ strength: 0.8 });
    editor().selectRefine([]);
    const feature = session().features.find((f) => f.id === id)!;
    const saved = session().edge.strength;
    // A live drag of the default, then the panel retargets to the guide before the restore.
    editor().setRefineEdge({ strength: 0.2 });
    expect(session().edge.strength).toBe(0.2);
    editor().selectRefine([id]);
    editor().restoreRefineDefaults({ edge: { strength: saved } });
    expect(session().edge.strength).toBe(saved);
    expect(session().features.find((f) => f.id === id)).toBe(feature);
  });

  it('removes only a chosen point that leaves a complete guide, in one undo step', async () => {
    setup([boxPart()], ['box']);
    await ready();
    editor().setRefineEdge({ kind: 'spline' });
    const points = [-1, 0, 1].map(crest);
    for (const point of points) editor().addRefinePoint(point);
    const id = session().selected[0];
    const steps = session().undo.length;
    editor().clickRefinePoint(id, 0, 1);
    expect(session().chosenPoint).toEqual({ feature: id, segment: 0, index: 1 });
    expect(session().undo).toHaveLength(steps);
    editor().removeChosenRefinePoint();
    expect(edgeInput(id).segments[0].points).toEqual([points[0], points[2]]);
    expect(session().features[0].id).toBe(id);
    expect(session().chosenPoint).toBeNull();
    expect(session().undo).toHaveLength(steps + 1);
    editor().clickRefinePoint(id, 0, 1);
    editor().removeChosenRefinePoint();
    expect(edgeInput(id).segments[0].points).toEqual([points[0], points[2]]);
    expect(session().undo).toHaveLength(steps + 1);
    editor().undoRefine();
    expect(edgeInput(id).segments[0].points).toEqual(points);
    expect(session().chosenPoint).toBeNull();
    editor().clickRefinePoint(id, 0, 0);
    expect(edgeInput(id).closed).toBe(true);
    expect(session().chosenPoint).toBeNull();
    editor().clickRefinePoint(id, 0, 0);
    expect(session().chosenPoint).toEqual({ feature: id, segment: 0, index: 0 });
  });

  it('keeps a closed path closed when its shared first and last point is removed', async () => {
    setup([boxPart()], ['box']);
    await ready();
    const [p, q, r, s] = [top(-1, -0.5), top(1, -0.5), top(1, 0.5), top(-1, 0.5)];
    editor().setRefineEdge({ joint: 'smooth' });
    for (const point of [p, q, r, s]) editor().addRefinePoint(point);
    editor().setRefineEdge({ joint: 'sharp' });
    editor().addRefinePoint(p, true);
    const id = session().selected[0];
    expect(edgeInput(id).joints).toEqual(['smooth', 'smooth', 'sharp', 'sharp']);
    for (const [segment, index] of [
      [0, 0],
      [3, 1],
    ]) {
      editor().removeRefinePoint(id, segment, index);
      expect(edgeInput(id).closed).toBe(true);
      expect(edgeInput(id).segments.map((x) => x.points)).toEqual([
        [q, r],
        [r, s],
        [s, q],
      ]);
      // The joints at the corners that stay, r and s, then the closing one at q.
      expect(edgeInput(id).joints).toEqual(['smooth', 'sharp', 'smooth']);
      editor().undoRefine();
    }
  });

  it('puts the session back as the cancelled drag found it, steps and draft included', async () => {
    setup([boxPart()], ['box']);
    await ready();
    const id = crestGuide(-1.4, 1.2);
    editor().moveRefinePoint(id, 0, 1, crest(1.3), true);
    editor().undoRefine();
    const before = session();
    expect(before.redo).toHaveLength(1);
    editor().moveRefinePoint(id, 0, 1, crest(1.4), true);
    editor().moveRefinePoint(id, 0, 1, crest(1.5));
    expect(session().redo).toHaveLength(0);
    editor().cancelRefineDrag();
    for (const key of ['features', 'selected', 'undo', 'redo', 'drawing', 'draft'] as const)
      expect(session()[key]).toBe(before[key]);
    expect(differingAttributes(session().preview!, freshShown())).toEqual([]);
    expect(heldRefineState()).not.toContain('drag');
    // Nothing to put back: no drag, or one that something else has followed.
    const unchanged = session();
    editor().cancelRefineDrag();
    expect(session()).toBe(unchanged);
    editor().moveRefinePoint(id, 0, 1, crest(1.4), true);
    editor().selectRefine([id]);
    const moved = session();
    editor().cancelRefineDrag();
    expect(session()).toBe(moved);
  });

  it('cancels only the drag when detection replaces a selected proposal during it', async () => {
    setup([boxPart()], ['box']);
    await ready();
    const id = crestGuide(-1.4, 1.2);
    const region: RefineProposal = {
      type: 'region',
      input: { ...session().region, triangles: Uint32Array.of(10, 11, 12) },
    };
    editor().setRefineMode('detect');
    const { finish } = holdDetect();
    const initialDetection = editor().detectRefine();
    finish([region]);
    await initialDetection;
    const previous = session().features.find((f) => f.origin === 'detected')!;
    editor().selectRefine([id, previous.id]);
    const beforeDrag = session();
    const detection = editor().detectRefine();
    editor().beginRefineDrag();
    editor().moveRefinePoint(id, 0, 1, crest(1.4), true);
    finish([region]);
    await detection;
    const published = session().features.find((f) => f.origin === 'detected')!;
    expect(published.id).not.toBe(previous.id);
    expect(session().selected).toEqual([id, published.id]);

    editor().cancelRefineDrag();
    expect(session().features[0].feature).toBe(beforeDrag.features[0].feature);
    expect(session().features.find((f) => f.origin === 'detected')).toBe(published);
    expect(session().selected).toEqual([id, published.id]);
    expect(session().undo).toBe(beforeDrag.undo);
    expect(session().redo).toBe(beforeDrag.redo);
    expect(session().draggingHandle).toBe(false);
    expect(differingAttributes(session().preview!, freshShown())).toEqual([]);
  });

  it('can still cancel a handle drag after the mode changes under it', async () => {
    setup([boxPart()], ['box']);
    await ready();
    const id = crestGuide(-1.4, 1.2);
    const before = session();
    editor().moveRefinePoint(id, 0, 1, crest(1.4), true);
    editor().setRefineMode('region');
    editor().cancelRefineDrag();
    expect(session().features).toBe(before.features);
    expect(session().undo).toBe(before.undo);
    expect(session().mode).toBe('region');
  });

  it('keeps each failure record, and says at most one thing per Accept press', async () => {
    setup([boxPart()], ['box']);
    await ready();
    const said: string[] = [];
    const notify = editor().notify;
    useEditor.setState({
      notify: (message, kind) => {
        said.push(message);
        notify(message, kind);
      },
    });
    editor().addRefinePoint(top(-1));
    editor().addRefinePoint(top(1));
    const edge = session().selected[0];
    editor().setRefineMode('region');
    useEditor.setState({ refine: { ...session(), triangles: [0] } });
    editor().makeRefineRegion();
    const region = session().selected[0];
    expect(said.map((m) => m.slice(0, 12))).toEqual(['No edge foun', 'This area is']);
    // The region's failure leaves the edge's record alone: reselecting the edge says nothing.
    editor().setRefineMode('edge');
    editor().selectRefine([edge]);
    expect(said).toHaveLength(2);
    // With both banners gone, each press on both failures says one thing it is not showing.
    for (const { id } of useActivity.getState().notifications) dismissNotification(id);
    editor().setRefineMode('detect');
    editor().selectRefine([edge, region]);
    expect(said).toHaveLength(2);
    editor().acceptRefine();
    expect(said.slice(2)).toEqual([said[0]]);
    editor().acceptRefine();
    expect(said.slice(3)).toEqual([said[1]]);
    editor().acceptRefine();
    expect(said).toHaveLength(4);
  });

  it('opens a closed loop left with too few corners, keeping its segments in order', async () => {
    setup([boxPart()], ['box']);
    await ready();
    const [a, b, c] = [crest(-1), crest(0), top(1)];
    for (const point of [a, b, c]) editor().addRefinePoint(point);
    editor().addRefinePoint(a, true);
    const id = session().selected[0];
    expect(edgeInput(id).closed).toBe(true);
    editor().removeRefinePoint(id, 1, 1);
    expect(edgeInput(id)).toMatchObject({ closed: false, joints: [] });
    expect(edgeInput(id).segments.map((s) => s.points)).toEqual([[a, b]]);
    editor().undoRefine();

    // A square left with three corners stays a closed triangle.
    editor().selectRefine([]);
    const [p, q, r, s] = [top(-1, -0.5), top(1, -0.5), top(1, 0.5), top(-1, 0.5)];
    for (const point of [p, q, r, s]) editor().addRefinePoint(point);
    editor().addRefinePoint(p, true);
    const square = session().selected[0];
    editor().removeRefinePoint(square, 2, 0);
    expect(edgeInput(square).closed).toBe(true);
    expect(edgeInput(square).segments.map((x) => x.points)).toEqual([
      [p, q],
      [q, s],
      [s, p],
    ]);
  });

  it('keeps triangle 10 erased from paint and a pending region through an unrelated cut', async () => {
    setup([boxPart()], ['box']);
    await ready();
    const edge = crestGuide(-1.4, 1.2);
    const { mesh, topology } = session().model!;
    const hole = 10;
    const ring = edgeNeighbours(mesh, topology, hole);
    expect(ring).toHaveLength(3);
    editor().setRefineMode('region');
    useEditor.setState({ refine: { ...session(), triangles: ring } });
    editor().makeRefineRegion();
    useEditor.setState({ refine: { ...session(), triangles: ring } });
    const regionId = session().features.find((f) => f.feature.type === 'region')!.id;
    editor().setRefineMode('detect');
    editor().selectRefine([edge]);
    editor().acceptRefine();
    expect(session().model!.mesh.triangleCount).toBeGreaterThan(mesh.triangleCount);
    const region = session().features.find((f) => f.id === regionId)!.feature;
    if (region.type !== 'region') throw new Error('not a region');
    for (const set of [session().triangles, [...region.input.triangles]]) {
      expect([...set].sort((a, b) => a - b)).toEqual([...ring].sort((a, b) => a - b));
    }
  });

  it(`builds no draft with more than ${refineDraftLimit} pending features selected`, async () => {
    setup([boxPart()], ['box']);
    await ready();
    await editor().detectRefine();
    const ids = session().features.map((f) => f.id);
    const solve = vi.spyOn(edgeCode, 'solveEdge');
    editor().selectRefine(ids.slice(0, refineDraftLimit + 1));
    expect(solve).not.toHaveBeenCalled();
    expect(session()).toMatchObject({ draft: null, draftSkipped: true });
    expect(differingAttributes(session().preview!, fresh())).toEqual([]);
    editor().selectRefine(ids.slice(0, refineDraftLimit));
    expect(session().draft).not.toBeNull();
    expect(session().draftSkipped).toBe(false);
    expect(differingAttributes(session().preview!, freshShown())).toEqual([]);
    editor().selectRefine(ids.slice(0, refineDraftLimit + 1));
    expect(session()).toMatchObject({ draft: null, draftSkipped: true });
    expect(differingAttributes(session().preview!, fresh())).toEqual([]);
    const undo = session().undo.length;
    editor().acceptRefine();
    expect(session().features.filter((f) => f.state === 'accepted').length).toBeGreaterThan(
      refineDraftLimit,
    );
    expect(session().undo.length).toBe(undo + 1);
    expect(session().draftSkipped).toBe(false);
  });
});

/** Distance from `p` to the polyline of `curve`. */
function nearestOnCurve(curve: EdgeCurve, p: [number, number, number]) {
  const a = new Vector3(),
    b = new Vector3(),
    point = new Vector3(...p),
    closest = new Vector3();
  const count = curve.points.length / 3;
  let nearest = Infinity;
  for (let i = 0; i < (curve.closed ? count : count - 1); i++) {
    a.fromArray(curve.points, i * 3);
    b.fromArray(curve.points, ((i + 1) % count) * 3);
    new Line3(a, b).closestPointToPoint(point, true, closest);
    nearest = Math.min(nearest, closest.distanceTo(point));
  }
  return nearest;
}

/** Whether two proposals have the same input, value for value. */
const sameProposal = (a: RefineProposal, b: RefineProposal) =>
  JSON.stringify(a) === JSON.stringify(b);
