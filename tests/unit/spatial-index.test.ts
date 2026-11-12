import { afterEach, expect, it, vi } from 'vitest';
import { BoxGeometry } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { prepareForPicking } from '../../src/core/bvh';
import { placeClear, treeOf } from '../../src/core/clipping';
import { useEditor } from '../../src/core/store';
import type { Part } from '../../src/core/types';

afterEach(() => vi.unstubAllGlobals());

function workerMock() {
  const workers: {
    terminate: ReturnType<typeof vi.fn>;
    postMessage: ReturnType<typeof vi.fn>;
    onmessage: null | ((event: { data: unknown }) => void);
  }[] = [];
  vi.stubGlobal(
    'Worker',
    class {
      terminate = vi.fn();
      postMessage = vi.fn();
      onmessage = null;
      constructor() {
        workers.push(this);
      }
    },
  );
  return workers;
}

it('indexes moderate scans off-thread and preserves original vertex and face ordering', async () => {
  const workers = workerMock(),
    geometry = new BoxGeometry(10, 10, 10, 100, 100, 100);
  const positions = geometry.attributes.position.array.slice(),
    indices = geometry.index!.array.slice();
  expect(treeOf(geometry)).toBeNull();
  const pending = useEditor.getState().indexingMeshes;
  prepareForPicking(geometry);
  prepareForPicking(geometry);
  await vi.waitFor(() => expect(workers).toHaveLength(1));
  const request = workers[0].postMessage.mock.calls[0][0];
  expect(request.positions.buffer).not.toBe(geometry.attributes.position.array.buffer);
  expect(request.index.buffer).not.toBe(geometry.index!.array.buffer);
  const serialized = MeshBVH.serialize(
    new MeshBVH(geometry.clone(), { indirect: true, targetLeafSize: 10 }),
  );
  workers[0].onmessage!({ data: { bvh: { ...serialized, index: null } } });
  await vi.waitFor(() => expect(useEditor.getState().indexingMeshes).toBe(pending));
  expect(geometry.boundsTree).toBeTruthy();
  expect(geometry.attributes.position.array).toEqual(positions);
  expect(geometry.index!.array).toEqual(indices);
  expect(workers[0].terminate).toHaveBeenCalledOnce();
});

it('cancels indexing when a scan is disposed and lets the next queued scan start', async () => {
  const workers = workerMock(),
    first = new BoxGeometry(10, 10, 10, 100, 100, 100),
    second = first.clone();
  const pending = useEditor.getState().indexingMeshes;
  prepareForPicking(first);
  prepareForPicking(second);
  await vi.waitFor(() => expect(workers).toHaveLength(1));
  first.dispose();
  await vi.waitFor(() => expect(workers).toHaveLength(2));
  expect(workers[0].terminate).toHaveBeenCalledOnce();
  second.dispose();
  await vi.waitFor(() => expect(useEditor.getState().indexingMeshes).toBe(pending));
  expect(workers[1].terminate).toHaveBeenCalledOnce();
  expect(first.boundsTree).toBeUndefined();
});

it.each(['obstacle', 'mover'] as const)(
  'holds nearby moves until the dense %s is indexed, without blocking distant moves',
  async (dense) => {
    const workers = workerMock(),
      geometry = new BoxGeometry(10, 10, 10, 100, 100, 100),
      small = new BoxGeometry(10, 10, 10);
    const wall: Part = {
      id: 'wall',
      name: 'Wall',
      geometry: dense === 'obstacle' ? geometry : small,
      position: [0, 0, 0],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
      color: '#fff',
      visible: true,
      locked: false,
      source: 'test',
    };
    const moving: Part = {
      ...wall,
      id: 'moving',
      geometry: dense === 'mover' ? geometry : small,
      position: [30, 0, 0],
    };
    const parts = [wall, moving];
    const move = (x: number) =>
      placeClear({
        parts,
        joints: [],
        ids: ['moving'],
        target: [{ ...moving, position: [x, 0, 0] }],
        place: ([pose]) => [wall, pose],
        overlap: 0.1,
        mode: 'adjust',
      });
    expect(move(25).parts[1].position[0]).toBe(25);
    expect(workers).toHaveLength(0);
    const pending = useEditor.getState().indexingMeshes;
    expect(() => move(9)).toThrow('Dense meshes are still preparing');
    expect(moving.position[0]).toBe(30);
    expect(geometry.boundsTree).toBeUndefined();
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    const serialized = MeshBVH.serialize(
      new MeshBVH(geometry.clone(), { indirect: true, targetLeafSize: 10 }),
    );
    workers[0].onmessage!({ data: { bvh: { ...serialized, index: null } } });
    await vi.waitFor(() => expect(useEditor.getState().indexingMeshes).toBe(pending));
    expect(move(9).parts[1].position[0]).toBeCloseTo(9.9, 2);
  },
);
