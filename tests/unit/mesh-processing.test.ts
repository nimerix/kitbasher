import { afterEach, describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  BufferAttribute,
  type BufferGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  IcosahedronGeometry,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Raycaster,
  Shape,
  SphereGeometry,
  Vector2,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { binaryGeometry, deserializeGeometry, triangleCount } from '../../src/core/geometry';
import { decimateMesh, MeshProcessor, remeshMesh } from '../../src/core/mesh-processing';
import { sparseRemesh } from '../../src/core/sparse-remesh';
import { MeshoptSimplifier } from '../../src/vendor/meshoptimizer/simplifier';
import {
  DEFAULT_REMESH_RESOLUTION,
  DENSE_REMESH_RESOLUTION,
  MAX_REMESH_RESOLUTION,
  MIN_REMESH_RESOLUTION,
} from '../../src/core/remesh-settings';
import { shouldDrawProxy, sourceRaycast } from '../../src/core/display-performance';
import { useEditor } from '../../src/core/store';
import type { Part } from '../../src/core/types';

const initial = useEditor.getState();
afterEach(() => useEditor.setState(initial));
const scan = (): Part => ({
  id: 'scan',
  name: 'Scan',
  geometry: new SphereGeometry(10, 64, 48),
  position: [5, 7, 9],
  quaternion: [0, 0, 0, 1],
  scale: [1, 2, 1],
  color: '#ffffff',
  visible: true,
  locked: false,
  source: 'scan.stl',
});

describe('mesh processing', () => {
  it('decimates triangle soup without changing source buffers or local placement', async () => {
    const original = new SphereGeometry(10, 96, 64).translate(100, 20, -50).toNonIndexed();
    const data = binaryGeometry(original);
    const positions = data.positions.slice(),
      normals = data.normals!.slice();
    const result = await decimateMesh(data, 0.2, 0.01);
    const reduced = deserializeGeometry(result.mesh);
    expect(triangleCount(reduced)).toBeLessThan(triangleCount(original) * 0.3);
    expect(result.error).toBeLessThanOrEqual(0.01);
    expect(data.positions).toEqual(positions);
    expect(data.normals).toEqual(normals);
    reduced.computeBoundingBox();
    expect(
      reduced.boundingBox!.getCenter(new Vector3()).distanceTo(new Vector3(100, 20, -50)),
    ).toBeLessThan(0.2);
    expect(reduced.getAttribute('position').count).toBeLessThan(
      original.getAttribute('position').count,
    );
  });

  it('retains vertex colors and open borders through decimation', async () => {
    const original = new PlaneGeometry(20, 20, 24, 24);
    const position = original.getAttribute('position');
    const colors = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i++)
      colors.set([(position.getX(i) + 10) / 20, 0.25, 0.5], i * 3);
    original.setAttribute('color', new BufferAttribute(colors, 3));
    const reduced = deserializeGeometry(
      (await decimateMesh(binaryGeometry(original), 0.1, 0.1)).mesh,
    );
    const after = reduced.getAttribute('position');
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i),
        y = position.getY(i);
      if (Math.abs(x) !== 10 && Math.abs(y) !== 10) continue;
      expect(
        Array.from({ length: after.count }, (_, j) => [after.getX(j), after.getY(j)]),
      ).toContainEqual([x, y]);
    }
    expect(reduced.getAttribute('color').count).toBe(after.count);
  });

  it('rebuilds closed geometry with outward normals in the same coordinate frame', async () => {
    const geometry = new BoxGeometry(10, 10, 10).translate(30, -20, 40);
    const source = binaryGeometry(geometry),
      before = source.positions.slice();
    const rebuilt = deserializeGeometry(await remeshMesh(source, 32));
    rebuilt.computeBoundingBox();
    expect(
      rebuilt.boundingBox!.getCenter(new Vector3()).distanceTo(new Vector3(30, -20, 40)),
    ).toBeLessThan(0.5);
    const size = rebuilt.boundingBox!.getSize(new Vector3());
    expect(Math.abs(size.x - 10)).toBeLessThan(1);
    expect(triangleCount(rebuilt)).toBeGreaterThan(12);
    const p = rebuilt.getAttribute('position'),
      n = rebuilt.getAttribute('normal');
    let outward = 0;
    for (let i = 0; i < p.count; i++)
      outward += new Vector3()
        .fromBufferAttribute(p, i)
        .sub(new Vector3(30, -20, 40))
        .dot(new Vector3().fromBufferAttribute(n, i));
    expect(outward).toBeGreaterThan(0);
    expect(source.positions).toEqual(before);
  });

  it('rejects open remesh inputs and invalid controls', async () => {
    await expect(remeshMesh(binaryGeometry(new PlaneGeometry(10, 10)), 32)).rejects.toThrow(
      'closed',
    );
    const box = binaryGeometry(new BoxGeometry());
    for (const resolution of [MIN_REMESH_RESOLUTION - 1, MAX_REMESH_RESOLUTION + 1, 128.5])
      await expect(remeshMesh(box, resolution)).rejects.toThrow('resolution');
    await expect(decimateMesh(binaryGeometry(new BoxGeometry()), NaN, 0.1)).rejects.toThrow(
      'percentage',
    );
  });

  it('retains a 0.3 mm groove between raised details on a 32 mm part at maximum resolution', async () => {
    // Extrude two ridges and their shared base as one closed mesh.
    const outline = new Shape([
      new Vector2(-16, 0),
      new Vector2(16, 0),
      new Vector2(16, 2),
      new Vector2(0.8, 2),
      new Vector2(0.8, 3),
      new Vector2(0.15, 3),
      new Vector2(0.15, 2),
      new Vector2(-0.15, 2),
      new Vector2(-0.15, 3),
      new Vector2(-0.8, 3),
      new Vector2(-0.8, 2),
      new Vector2(-16, 2),
    ]);
    const source = new ExtrudeGeometry(outline, { depth: 6, bevelEnabled: false }).translate(
      0,
      0,
      -3,
    );
    const processor = new MeshProcessor(binaryGeometry(source));
    const material = new MeshBasicMaterial();
    const heightAt = (geometry: BufferGeometry, x: number) =>
      new Raycaster(new Vector3(x, 4, 0), new Vector3(0, -1, 0)).intersectObject(
        new Mesh(geometry, material),
      )[0]?.point.y;
    expect(heightAt(source, 0)).toBeCloseTo(2);

    const rebuild = async (resolution: number) =>
      deserializeGeometry((await processor.process({ mode: 'remesh', resolution })).mesh);
    const previousDefault = await rebuild(64);
    const currentDefault = await rebuild(DEFAULT_REMESH_RESOLUTION);
    const fine = await rebuild(MAX_REMESH_RESOLUTION);
    expect(heightAt(previousDefault, -0.45)).toBeLessThan(2.9);
    expect(heightAt(currentDefault, -0.45)).toBeCloseTo(3);
    expect(heightAt(currentDefault, 0)).toBeGreaterThan(2.8);
    expect(heightAt(fine, 0)).toBeCloseTo(2);
    expect(heightAt(fine, -0.45)).toBeCloseTo(3);
    expect(heightAt(fine, 0.45)).toBeCloseTo(3);
  });

  it.each([
    [8, DENSE_REMESH_RESOLUTION, 'one million triangles'],
    [18, DENSE_REMESH_RESOLUTION, 'voxel memory limit'],
    [3, MAX_REMESH_RESOLUTION, 'voxel memory limit'],
  ])(
    'rejects an over-budget remesh of %i stacked slabs at %i and allows a coarser retry',
    async (count, resolution, limit) => {
      const slabs = mergeGeometries(
        Array.from({ length: count }, (_, i) =>
          new BoxGeometry(32, 32, 0.5).translate(0, 0, i * 1.5),
        ),
      );
      const processor = new MeshProcessor(binaryGeometry(slabs));
      await expect(processor.process({ mode: 'remesh', resolution })).rejects.toThrow(limit);
      const retry = await processor.process({ mode: 'remesh', resolution: 64 });
      expect(retry.mesh.positions.length).toBeGreaterThan(0);
    },
  );
});

describe('sparse remeshing', () => {
  const welded = (geometry: BufferGeometry) => {
    const data = binaryGeometry(geometry);
    const remap = MeshoptSimplifier.generatePositionRemap(data.positions, 3);
    const count = data.indices?.length ?? data.positions.length / 3;
    const indices = new Uint32Array(count);
    for (let i = 0; i < count; i++) indices[i] = remap[data.indices?.[i] ?? i];
    return { positions: data.positions, indices };
  };

  it('reproduces the dense kernel on its grid when quadric placement is off', async () => {
    await MeshoptSimplifier.ready;
    // Well-shaped triangles take the same square sampling grid in both kernels.
    const { positions, indices } = welded(new IcosahedronGeometry(10, 16).translate(3, -2, 5));
    for (const resolution of [32, DENSE_REMESH_RESOLUTION]) {
      const dense = MeshoptSimplifier.remesh(indices, positions, 3, resolution);
      const sparse = sparseRemesh(indices, positions, resolution);
      expect(sparse.indices.length * 3).toBe(dense.length);
      // Identify vertices within 0.0001 mm as one; the dense soup repeats voxels with float noise.
      const cell = (value: number) => Math.floor(value * 1000);
      const grid = new Map<string, number[]>();
      const points: number[] = [];
      const identify = (p: ArrayLike<number>, add: boolean) => {
        for (const dx of [-1, 0, 1])
          for (const dy of [-1, 0, 1])
            for (const dz of [-1, 0, 1])
              for (const id of grid.get(
                [cell(p[0]) + dx, cell(p[1]) + dy, cell(p[2]) + dz].join(),
              ) ?? [])
                if (
                  Math.hypot(
                    points[id * 3] - p[0],
                    points[id * 3 + 1] - p[1],
                    points[id * 3 + 2] - p[2],
                  ) < 1e-4
                )
                  return id;
        if (!add) return -1;
        const id = points.length / 3;
        points.push(p[0], p[1], p[2]);
        const key = [cell(p[0]), cell(p[1]), cell(p[2])].join();
        grid.set(key, [...(grid.get(key) ?? []), id]);
        return id;
      };
      const ids: number[] = [];
      for (let i = 0; i < dense.length; i += 3) ids.push(identify(dense.subarray(i, i + 3), true));
      const match = (p: ArrayLike<number>) => identify(p, false);
      const canonical = (a: number, b: number, c: number) => {
        const first = Math.min(a, b, c);
        return first === a ? `${a},${b},${c}` : first === b ? `${b},${c},${a}` : `${c},${a},${b}`;
      };
      const expected = new Set<string>();
      for (let t = 0; t < ids.length; t += 3)
        expected.add(canonical(ids[t], ids[t + 1], ids[t + 2]));
      const vertex = Array.from({ length: sparse.positions.length / 3 }, (_, v) =>
        match(sparse.positions.subarray(v * 3, v * 3 + 3)),
      );
      expect(vertex).not.toContain(-1);
      for (let t = 0; t < sparse.indices.length; t += 3)
        expect(
          expected.has(
            canonical(
              vertex[sparse.indices[t]],
              vertex[sparse.indices[t + 1]],
              vertex[sparse.indices[t + 2]],
            ),
          ),
        ).toBe(true);
    }
  }, 30_000);

  it('rebuilds a closed, manifold surface at maximum resolution within a small fraction of a voxel', async () => {
    // A 2 x 30 mm rod: sharp rims, a curved side and flat caps.
    const source = new CylinderGeometry(1, 1, 30, 256, 1).translate(4, 5, 6);
    const data = binaryGeometry(source);
    const result = await new MeshProcessor(data).process({
      mode: 'remesh',
      resolution: MAX_REMESH_RESOLUTION,
    });
    const { positions } = result.mesh;
    const indices = result.mesh.indices as Uint32Array;
    expect(indices).toBeInstanceOf(Uint32Array);
    const voxel = 30 / (MAX_REMESH_RESOLUTION - 2);
    const vertices = positions.length / 3;

    // Every edge is shared by exactly two triangles.
    const edges = new Map<number, number>();
    for (let t = 0; t < indices.length; t += 3)
      for (let k = 0; k < 3; k++) {
        const a = indices[t + k],
          b = indices[t + ((k + 1) % 3)];
        const key = Math.min(a, b) * vertices + Math.max(a, b);
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    expect([...edges.values()].every((n) => n === 2)).toBe(true);

    // The surface is rebuilt: no source vertex survives, and edges follow the voxel size.
    const sourceVertices = new Set<string>();
    for (let i = 0; i < data.positions.length; i += 3)
      sourceVertices.add(data.positions.subarray(i, i + 3).join(','));
    let shared = 0,
      worst = 0,
      edgeLength = 0;
    for (let v = 0; v < vertices; v++) {
      const [x, y, z] = positions.subarray(v * 3, v * 3 + 3);
      if (sourceVertices.has(`${x},${y},${z}`)) shared++;
      // Distance to the ideal rod; the 256-sided source is within 0.0001 mm of it.
      const radial = Math.hypot(x - 4, z - 6) - 1,
        axial = Math.abs(y - 5) - 15;
      const distance =
        Math.hypot(Math.max(radial, 0), Math.max(axial, 0)) + Math.min(Math.max(radial, axial), 0);
      worst = Math.max(worst, Math.abs(distance));
    }
    for (let t = 0; t < indices.length; t += 3) {
      const a = indices[t] * 3,
        b = indices[t + 1] * 3;
      edgeLength += Math.hypot(
        positions[a] - positions[b],
        positions[a + 1] - positions[b + 1],
        positions[a + 2] - positions[b + 2],
      );
    }
    edgeLength /= indices.length / 3;
    expect(shared).toBe(0);
    expect(edgeLength).toBeGreaterThan(voxel * 0.7);
    expect(edgeLength).toBeLessThan(voxel * 1.6);
    expect(worst).toBeLessThan(voxel * 0.25);

    // Both rims stay sharp: some vertices sit within a tenth of a voxel of each rim.
    for (const rim of [-15, 15])
      expect(
        Array.from({ length: vertices }, (_, v) =>
          Math.hypot(
            Math.hypot(positions[v * 3] - 4, positions[v * 3 + 2] - 6) - 1,
            positions[v * 3 + 1] - 5 - rim,
          ),
        ).some((d) => d < voxel * 0.1),
      ).toBe(true);
  });
});

describe('display geometry and editing', () => {
  it('picks original surfaces and restores display geometry even if raycasting fails', () => {
    const source = new BoxGeometry(2, 2, 2),
      proxy = new BoxGeometry(1, 1, 1);
    const mesh = new Mesh(proxy, new MeshBasicMaterial());
    mesh.raycast = sourceRaycast(source, Mesh.prototype.raycast);
    const hit = new Raycaster(new Vector3(0, 0, 5), new Vector3(0, 0, -1)).intersectObject(mesh)[0];
    expect(hit.point.z).toBe(1);
    expect(mesh.geometry).toBe(proxy);
    mesh.raycast = sourceRaycast(source, () => {
      throw new Error('test');
    });
    expect(() => new Raycaster().intersectObject(mesh)).toThrow('test');
    expect(mesh.geometry).toBe(proxy);
  });

  it('uses proxies in VR and motion, and original detail for precision tools or Full mode', () => {
    expect(shouldDrawProxy('auto', false, true, false)).toBe(true);
    expect(shouldDrawProxy('auto', true, false, false)).toBe(true);
    expect(shouldDrawProxy('auto', false, false, false)).toBe(false);
    expect(shouldDrawProxy('full', true, true, false)).toBe(false);
    expect(shouldDrawProxy('fast', true, true, true)).toBe(false);
  });

  it('adds an independent copy, retains original anchors, and undoes atomically', () => {
    const part = {
      ...scan(),
      anchors: [
        {
          id: 'anchor',
          point: [0, 10, 0] as [number, number, number],
          target: [5, 27, 9] as [number, number, number],
        },
      ],
    };
    useEditor.getState().setScene({ name: 'Test', parts: [part], joints: [] });
    const state = useEditor.getState(),
      reduced = new BoxGeometry();
    expect(
      state.applyProcessedMesh(
        part.id,
        part.geometry,
        reduced,
        true,
        state.sceneEpoch,
        'Decimated',
      ),
    ).toBe(true);
    const parts = useEditor.getState().scene.parts;
    expect(parts[0].geometry).toBe(part.geometry);
    expect(parts[0].visible).toBe(false);
    expect(parts[0].anchors).toEqual(part.anchors);
    expect(parts[1].position).toEqual(part.position);
    expect(parts[1].scale).toEqual(part.scale);
    expect(parts[1].anchors).toBeUndefined();
    useEditor.getState().undo();
    expect(useEditor.getState().scene.parts).toEqual([part]);
    useEditor.getState().redo();
    expect(useEditor.getState().scene.parts[1].geometry).toBe(reduced);
  });

  it('rejects stale results, locked parts and replacing constrained geometry', () => {
    const part = scan();
    useEditor.getState().setScene({ name: 'Test', parts: [part], joints: [] });
    const state = useEditor.getState(),
      reduced = new BoxGeometry();
    expect(
      state.applyProcessedMesh(
        part.id,
        part.geometry,
        reduced,
        false,
        state.sceneEpoch - 1,
        'Decimated',
      ),
    ).toBe(false);
    expect(
      state.applyProcessedMesh(
        part.id,
        new BoxGeometry(),
        reduced,
        false,
        state.sceneEpoch,
        'Decimated',
      ),
    ).toBe(false);
    state.patchParts([part.id], { locked: true });
    expect(
      state.applyProcessedMesh(
        part.id,
        part.geometry,
        reduced,
        true,
        state.sceneEpoch,
        'Decimated',
      ),
    ).toBe(false);
    state.patchParts([part.id], {
      locked: false,
      anchors: [{ id: 'a', point: [0, 0, 0], target: [0, 0, 0] }],
    });
    expect(
      state.applyProcessedMesh(
        part.id,
        part.geometry,
        reduced,
        false,
        state.sceneEpoch,
        'Decimated',
      ),
    ).toBe(false);
  });
});
