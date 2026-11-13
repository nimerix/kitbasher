import { describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  bakedPartGeometry,
  binaryGeometry,
  combineParts,
  deserializeGeometry,
} from '../../src/core/geometry';
import { geometryKey, restoreGeometry, snapshotGeometry } from '../../src/core/geometry-transfer';
import { assertClosed, mergedPart } from '../../src/core/merge';
import { MeshProcessor, processMesh } from '../../src/core/mesh-processing';
import { hasClosedEdges, weldedPositionIndex } from '../../src/core/mesh-topology';
import { exportStl } from '../../src/core/files';
import type { Part } from '../../src/core/types';
import { evaluateBoolean } from '../../src/core/boolean';

const part = (geometry: BufferGeometry, mirrored = false): Part => ({
  id: geometry.uuid,
  name: 'Scan',
  geometry,
  position: [19.25, -3.125, 5.7],
  quaternion: new Quaternion().setFromAxisAngle(new Vector3(1, 2, 3).normalize(), 0.7).toArray(),
  scale: [mirrored ? -2 : 2, 0.7, 1.3],
  color: '#db753f',
  visible: true,
  locked: false,
  source: 'test',
});

describe('lossless mesh preparation', () => {
  it.each([false, true])(
    'preserves exact triangle attributes and STL bytes, mixed inputs: %s',
    (mixed) => {
      const indexed = new BoxGeometry(10, 8, 6, 8, 6, 4);
      const colors = new Float32Array(indexed.getAttribute('position').count * 3);
      for (let i = 0; i < colors.length; i++) colors[i] = (i % 17) / 17;
      indexed.setAttribute('color', new BufferAttribute(colors, 3));
      const inputs = [part(indexed), part(mixed ? indexed.toNonIndexed() : indexed.clone(), true)];
      const originals = inputs.map((p) => p.geometry.clone());
      const expanded = inputs.map((p) => bakedPartGeometry(p));
      const reference = mergeGeometries(expanded)!;
      const combined = combineParts(inputs);
      expect(combined.index).not.toBeNull();
      expect(combined.attributes.position.count).toBeLessThan(reference.attributes.position.count);
      const triangles = combined.toNonIndexed();
      for (const name of ['position', 'normal', 'color'])
        expect(triangles.getAttribute(name).array).toEqual(reference.getAttribute(name).array);
      const a = mergedPart(reference, 'Reference', 'test');
      const b = mergedPart(combined, 'Optimized', 'test');
      expect(new Uint8Array(exportStl([b]))).toEqual(new Uint8Array(exportStl([a])));
      for (let i = 0; i < inputs.length; i++) {
        expect(inputs[i].geometry.index?.array).toEqual(originals[i].index?.array);
        expect(inputs[i].geometry.attributes.position.array).toEqual(
          originals[i].attributes.position.array,
        );
      }
    },
  );

  it('round-trips worker attributes without rounding Float64 positions or losing bounds', () => {
    const geometry = new BoxGeometry();
    geometry.setAttribute(
      'position',
      new BufferAttribute(new Float64Array(geometry.attributes.position.array), 3),
    );
    geometry.attributes.position.setX(0, 0.12345678912345);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const restored = restoreGeometry(structuredClone(snapshotGeometry(geometry)));
    expect(restored.attributes.position.array).toEqual(geometry.attributes.position.array);
    expect(restored.boundingBox).toEqual(geometry.boundingBox);
    expect(restored.boundingSphere).toEqual(geometry.boundingSphere);
  });

  it('preserves normalized interleaved storage in worker snapshots', () => {
    const geometry = new BoxGeometry();
    const buffer = new InterleavedBuffer(new Int16Array([7, 32767, 0, -32768, 9, 0, 16384, 0]), 4);
    geometry.setAttribute('normal', new InterleavedBufferAttribute(buffer, 3, 1, true));
    const restored = restoreGeometry(structuredClone(snapshotGeometry(geometry)));
    expect(restored.attributes.normal.normalized).toBe(true);
    expect(restored.attributes.normal.array).toEqual(
      new Int16Array([32767, 0, -32768, 0, 16384, 0]),
    );
  });

  it('preserves flat normals and excludes unused position outliers', () => {
    for (const kind of ['missing-normal', 'unused-vertex']) {
      const geometry = new BoxGeometry();
      if (kind === 'missing-normal') geometry.deleteAttribute('normal');
      else {
        for (const name of ['position', 'normal']) {
          const previous = geometry.getAttribute(name).array;
          const next = new Float32Array(previous.length + 3);
          next.set(previous);
          next.set([1_000_000, 0, 0], previous.length);
          geometry.setAttribute(name, new BufferAttribute(next, 3));
        }
      }
      const input = part(geometry);
      const reference = bakedPartGeometry(input);
      const result = bakedPartGeometry(input, true);
      expect(result.attributes.position.array).toEqual(reference.attributes.position.array);
      expect(result.attributes.normal.array).toEqual(reference.attributes.normal.array);
    }
  });

  it.each(['union', 'subtract', 'intersect'] as const)(
    'keeps Boolean %s triangle attributes identical with indexed preparation',
    (mode) => {
      const inputs = [
        part(new SphereGeometry(10, 24, 16)),
        part(new BoxGeometry(15, 15, 15), true),
      ];
      inputs[1].position = [22, -1, 7];
      const oldInputs = inputs.map((p) => binaryGeometry(bakedPartGeometry(p)));
      const newInputs = inputs.map((p) => binaryGeometry(bakedPartGeometry(p, true)));
      const actual = deserializeGeometry(evaluateBoolean(newInputs, mode));
      const expected = deserializeGeometry(evaluateBoolean(oldInputs, mode));
      const a = actual.index ? actual.toNonIndexed() : actual;
      const b = expected.index ? expected.toNonIndexed() : expected;
      for (const name of ['position', 'normal', 'color']) {
        const x = a.getAttribute(name).array,
          y = b.getAttribute(name).array;
        expect(x.length, name).toBe(y.length);
        expect(
          x.every((value, i) => Object.is(value, y[i])),
          name,
        ).toBe(true);
      }
    },
  );

  it('invalidates validation when index or position attributes change', () => {
    const geometry = new BoxGeometry();
    const input = part(geometry);
    assertClosed(input);
    const key = geometryKey(geometry);
    expect(geometryKey(geometry)).toBe(key);
    geometry.index!.setX(0, geometry.index!.getX(1));
    geometry.index!.needsUpdate = true;
    expect(geometryKey(geometry)).not.toBe(key);
    expect(() => assertClosed(input)).toThrow('open or non-manifold');
    const positionKey = geometryKey(geometry);
    geometry.attributes.position.needsUpdate = true;
    expect(geometryKey(geometry)).not.toBe(positionKey);
  });

  it('rejects missing and multiply shared edges without confusing numeric keys', () => {
    const tetra = new Uint32Array([0, 1, 2, 0, 3, 1, 0, 2, 3, 1, 3, 2]);
    expect(hasClosedEdges(tetra, 4)).toBe(true);
    expect(hasClosedEdges(tetra.subarray(3), 4)).toBe(false);
    expect(hasClosedEdges(new Uint32Array([...tetra, 0, 1, 2]), 4)).toBe(false);
    expect(hasClosedEdges(new Uint32Array([0, 0, 1]), 2)).toBe(false);
    expect(() => hasClosedEdges(tetra, 100_000_000)).toThrow('too large');
  });

  it('matches legacy welding exactly at tolerance boundaries and large coordinates', () => {
    for (const indexed of [false, true]) {
      for (const offset of [0, -1, 100_000, -100_000]) {
        const positions: number[] = [];
        for (let i = 0; i < 400; i++) {
          const x = (i % 13) * 0.00001 + offset;
          for (const delta of [-0.000005001, -0.000004999, 0, 0.000004999, 0.000005001])
            positions.push(x + delta, (i % 17) * 0.125, (i % 7) * -0.25);
        }
        const geometry = new BufferGeometry().setAttribute(
          'position',
          new BufferAttribute(new Float64Array(positions), 3),
        );
        if (indexed)
          geometry.setIndex(
            Array.from({ length: positions.length / 3 }, (_, i) => positions.length / 3 - i - 1),
          );
        const legacy = mergeVertices(geometry, 1e-5);
        const result = weldedPositionIndex(geometry);
        expect(Array.from(result.indices)).toEqual(Array.from(legacy.index!.array));
        expect(result.vertices).toBe(legacy.attributes.position.count);
      }
    }
  });
});

describe('prepared mesh reuse', () => {
  it('returns the same reduction and remesh as cold processing, including after transfer', async () => {
    const data = binaryGeometry(new BoxGeometry(10, 10, 10, 24, 24, 24).toNonIndexed());
    const before = structuredClone(data);
    const processor = new MeshProcessor(data);
    for (const options of [
      { mode: 'decimate' as const, ratio: 0.5, error: 0.01, lockBorder: true },
      { mode: 'remesh' as const, resolution: 32 },
      { mode: 'decimate' as const, ratio: 0.2, error: 0.001, lockBorder: true },
      { mode: 'remesh' as const, resolution: 40 },
    ]) {
      const warm = await processor.process(options);
      const cold = await processMesh(data, options);
      expect(warm).toEqual(cold);
      // Worker results are transferred; cached inputs must remain usable afterward.
      const transfer = [
        ...new Set(
          Object.values(warm.mesh)
            .filter(Boolean)
            .map((a) => a!.buffer),
        ),
      ];
      structuredClone(warm, { transfer });
    }
    expect(data).toEqual(before);
    const stages: string[] = [];
    await processor.process({ mode: 'remesh', resolution: 32 }, (stage) => stages.push(stage));
    expect(stages).toEqual(['Reusing prepared mesh', 'Rebuilding surface on voxel grid']);
  });

  it('keeps rejecting an open surface across retries but still allows reduction', async () => {
    const processor = new MeshProcessor(binaryGeometry(new PlaneGeometry(10, 10, 8, 8)));
    for (let i = 0; i < 2; i++)
      await expect(processor.process({ mode: 'remesh', resolution: 32 })).rejects.toThrow('closed');
    await expect(
      processor.process({ mode: 'decimate', ratio: 0.5, error: 0.01, lockBorder: true }),
    ).resolves.toHaveProperty('mesh');
    await expect(processor.process({ mode: 'remesh', resolution: 512 })).rejects.toThrow(
      'resolution',
    );
  });
});
