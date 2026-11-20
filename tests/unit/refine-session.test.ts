import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  type Intersection,
  Mesh,
  PlaneGeometry,
  Raycaster,
  Vector3,
} from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { pickRaycast } from '../../src/core/bvh';
import { requestTaskCancellation, useActivity } from '../../src/core/activity';
import { editorCommands, undoTarget } from '../../src/core/commands';
import { partMatrix, triangleCount } from '../../src/core/geometry';
import { detectDefaults } from '../../src/core/refine-detect';
import { writeRefinedGeometry } from '../../src/core/refine-mesh';
import { patchRefinedGeometry } from '../../src/core/refine-preview';
import { solveEdge } from '../../src/core/refine-edge';
import {
  brushingRefine,
  commitRefine,
  fittedWarpBrushRadius,
  paintingRefine,
  refineBrushRadius,
  refineEdited,
  refineUndoBytes,
  refineUndoLimit,
  shownRefinePreview,
  trimRefineSteps,
  useEditor,
  type RefineStep,
} from '../../src/core/store';
import { useXR } from '../../src/core/xr-session';
import type { Joint, Part } from '../../src/core/types';
import { changedVertices, closed, modelOf, splitEdge } from '../helpers/refine';
import {
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
import { rivetedPlate, softBox } from '../helpers/soft-edges';

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
    useEditor.setState({ toast: null });
    editor().acceptRefine();
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
