import { afterEach, describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  BufferAttribute,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Raycaster,
  SphereGeometry,
  Vector3,
} from 'three';
import { binaryGeometry, deserializeGeometry, triangleCount } from '../../src/core/geometry';
import { decimateMesh, remeshMesh } from '../../src/core/mesh-processing';
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
    await expect(remeshMesh(binaryGeometry(new BoxGeometry()), 512)).rejects.toThrow('resolution');
    await expect(decimateMesh(binaryGeometry(new BoxGeometry()), NaN, 0.1)).rejects.toThrow(
      'percentage',
    );
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
