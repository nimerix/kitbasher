import { expect, vi } from 'vitest';
import type { BufferGeometry } from 'three';
import { useEditor, type RefineSession, type RefineStep } from '../../src/core/store';
import { cloneRefineMesh, moveVertex } from '../../src/core/refine-mesh';
import { buffersOf, modelFromMesh, type RefineModel } from '../../src/core/refine-model';
import type { Part, SceneDocument } from '../../src/core/types';
import { softBox } from './soft-edges';

export const editor = () => useEditor.getState();
export const session = () => useEditor.getState().refine as RefineSession;
export const toast = () => useEditor.getState().toast?.message;

export const boxPart = (overrides: Partial<Part> = {}): Part => ({
  id: 'box',
  name: 'Box',
  geometry: softBox([2, 1.5, 1], 0.3),
  position: [0, 0, 0],
  quaternion: [0, 0, 0, 1],
  scale: [1, 1, 1],
  color: '#ccc',
  locked: false,
  visible: true,
  source: 'box.stl',
  ...overrides,
});

export function setup(parts: Part[], selected: string[] = []) {
  const scene: SceneDocument = { name: 'Refine', parts, joints: [] };
  editor().setScene(scene);
  useEditor.setState({ selected });
  return scene;
}

/** Chooses the tool and waits for the session's model. */
export async function ready() {
  editor().setTool('refine');
  await vi.waitFor(() => expect(session().stage).toBe('ready'));
}

/** The welded vertex nearest a world point. */
export function nearestVertex(model: RefineModel, point: [number, number, number]) {
  const { position, weldedCount } = model.mesh;
  let best = 0,
    nearest = Infinity;
  for (let v = 0; v < weldedCount; v++) {
    const d = Math.hypot(...[0, 1, 2].map((a) => position[v * 3 + a] - point[a]));
    if (d < nearest) [best, nearest] = [v, d];
  }
  return best;
}

/** The model with `vertices` moved by `offset`, sharing its weld map, corners and topology. */
export function movedModel(
  model: RefineModel,
  vertices: number[],
  offset: [number, number, number],
) {
  const mesh = cloneRefineMesh(model.mesh, false);
  for (const v of vertices)
    moveVertex(
      mesh,
      v,
      ...([0, 1, 2].map((a) => mesh.position[v * 3 + a] + offset[a]) as [number, number, number]),
    );
  return { ...model, mesh };
}

/** Bytes of the arrays a step holds that `model` and the `newer` steps do not. */
export function ownBytes(step: RefineStep, model: RefineModel, newer: RefineStep[] = []) {
  const shared = new Set([model, ...newer.map((s) => s.model)].flatMap((m) => buffersOf(m)));
  return buffersOf(step.model)
    .filter((buffer) => !shared.has(buffer))
    .reduce((sum, buffer) => sum + buffer.byteLength, 0);
}

/** A model rebuilt after a topology change, as an accepted edge leaves it. */
export const rebuiltModel = (model: RefineModel, change: (mesh: RefineModel['mesh']) => void) => {
  const mesh = cloneRefineMesh(model.mesh, true);
  change(mesh);
  return modelFromMesh(mesh, model);
};

const bits = (array: ArrayLike<number>) => {
  const typed = array as Float32Array;
  return new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
};

/** Names of the attributes, and the index, whose stored bits differ between two geometries. */
export function differingAttributes(a: BufferGeometry, b: BufferGeometry) {
  const names = new Set([...Object.keys(a.attributes), ...Object.keys(b.attributes)]);
  const differ = [...names].filter((name) => {
    const x = a.getAttribute(name),
      y = b.getAttribute(name);
    if (!x || !y || x.array.constructor !== y.array.constructor) return true;
    if (x.itemSize !== y.itemSize || x.count !== y.count) return true;
    const [bx, by] = [bits(x.array), bits(y.array)];
    return bx.some((byte, i) => byte !== by[i]);
  });
  const ia = a.index?.array,
    ib = b.index?.array;
  if (!!ia !== !!ib || (ia && ib && (ia.length !== ib.length || ia.some((v, i) => v !== ib[i]))))
    differ.push('index');
  return differ;
}
