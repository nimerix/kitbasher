import { afterEach, describe, expect, it, vi } from 'vitest';
import { BufferAttribute, BufferGeometry } from 'three';
import { requestTaskCancellation, useActivity } from '../../src/core/activity';
import { editorCommands, undoTarget } from '../../src/core/commands';
import { partMatrix, triangleCount } from '../../src/core/geometry';
import { detectDefaults } from '../../src/core/refine-detect';
import { writeRefinedGeometry } from '../../src/core/refine-mesh';
import { patchRefinedGeometry } from '../../src/core/refine-preview';
import {
  commitRefine,
  refineEdited,
  refineUndoBytes,
  refineUndoLimit,
  shownRefinePreview,
  trimRefineSteps,
  useEditor,
  type RefineStep,
} from '../../src/core/store';
import { useXR } from '../../src/core/xr-session';
import type { Part } from '../../src/core/types';
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
  toast,
} from '../helpers/refine-session';
import { softBox } from '../helpers/soft-edges';

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
    expect(trimRefineSteps(current, steps, [], 0).undo).toEqual([]);
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
