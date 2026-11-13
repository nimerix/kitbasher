import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, BufferAttribute, BufferGeometry, SphereGeometry } from 'three';
import { ADDITION, Brush, Evaluator, HalfEdgeMap, INTERSECTION, SUBTRACTION } from 'three-bvh-csg';
import { NumericHalfEdgeMap } from '../../src/core/boolean-topology';
import { BooleanProcessor } from '../../src/core/boolean';
import { bakedPartGeometry, binaryGeometry } from '../../src/core/geometry';

describe('numeric Boolean topology', () => {
  it('matches upstream adjacency including duplicate edges, tolerance boundaries and int32 wrapping', () => {
    const unusual = new BufferGeometry().setAttribute(
      'position',
      new BufferAttribute(
        new Float32Array([
          0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0,
          0, 0, 0, 1, 0, 0, -0.0000006, 0, 0, 3000, 0, 0, -3000, 1, 0,
        ]),
        3,
      ),
    );
    for (const g of [
      new BoxGeometry(10, 8, 6, 12, 8, 6),
      new SphereGeometry(10, 40, 24),
      unusual,
    ]) {
      for (const geometry of [g, g.index ? g.toNonIndexed() : g]) {
        const original = new HalfEdgeMap() as NumericHalfEdgeMap;
        const numeric = new NumericHalfEdgeMap();
        original.updateFrom(geometry);
        numeric.updateFrom(geometry);
        expect(numeric.data).toEqual(original.data);
        expect(numeric.matchedEdges).toBe(original.matchedEdges);
        expect(numeric.unmatchedEdges).toBe(original.unmatchedEdges);
      }
    }
  });
});

const input = (key: string, x: number) => ({
  key,
  create: vi.fn(() =>
    bakedPartGeometry(
      {
        geometry: new BoxGeometry(10, 10, 10),
        position: [x, 0, 0],
        quaternion: [0, 0, 0, 1],
        scale: [1, 1, 1],
        color: '#ad683f',
        id: key,
        name: key,
        visible: true,
        locked: false,
        source: 'test',
      },
      true,
    ),
  ),
});

describe('prepared Boolean cache', () => {
  it('preserves upstream union, subtraction and intersection output exactly', () => {
    for (const shape of ['box', 'sphere'])
      for (const [operation, code] of [
        ['union', ADDITION],
        ['subtract', SUBTRACTION],
        ['intersect', INTERSECTION],
      ] as const) {
        const inputs = [0, 1].map((i) => ({
          create: () =>
            bakedPartGeometry(
              {
                id: String(i),
                name: shape,
                geometry:
                  shape === 'box'
                    ? new BoxGeometry(10, 8, 6, 6, 4, 3)
                    : new SphereGeometry(8, 24, 16),
                position: [i * 3, i * 2, 0],
                quaternion: [0, 0, 0, 1],
                scale: [i ? -1 : 1, 1, 1],
                color: i ? '#345678' : '#abcdef',
                visible: true,
                locked: false,
                source: 'test',
              },
              true,
            ),
        }));
        const brushes = inputs.map((input) => new Brush(input.create()));
        brushes.forEach((brush) => brush.updateMatrixWorld(true));
        const evaluator = new Evaluator();
        evaluator.attributes = ['position', 'normal', 'color'];
        evaluator.useGroups = false;
        const expected = evaluator.evaluate(brushes[0], brushes[1], code).geometry;
        const processor = new BooleanProcessor();
        const actual = processor.evaluate(inputs, operation);
        expect(binaryGeometry(actual)).toEqual(binaryGeometry(expected));
        actual.dispose();
        expected.dispose();
        brushes.forEach((brush) => brush.geometry.dispose());
        processor.dispose();
      }
  });
  it('reuses inputs, invalidates by key and owns separate result buffers', () => {
    const processor = new BooleanProcessor();
    const a = input('a', 0),
      b = input('b', 4);
    const first = processor.evaluate([a, b], 'union');
    const expected = first.attributes.position.array.slice();
    structuredClone(first.attributes.position.array, {
      transfer: [first.attributes.position.array.buffer as ArrayBuffer],
    });
    const second = processor.evaluate([a, b], 'union');
    expect(second.attributes.position.array).toEqual(expected);
    expect(a.create).toHaveBeenCalledOnce();
    expect(b.create).toHaveBeenCalledOnce();
    processor.evaluate([a, { ...b, key: 'changed' }], 'subtract').dispose();
    expect(b.create).toHaveBeenCalledTimes(2);
    expect(processor.retainedBytes).toBeGreaterThan(0);
    processor.dispose();
    expect(processor.retainedBytes).toBe(0);
    first.dispose();
    second.dispose();
  });

  it('does not retain entries over the byte budget and survives an empty intersection', () => {
    const processor = new BooleanProcessor(1);
    const a = input('a', 0),
      b = input('b', 40);
    expect(() => processor.evaluate([a, b], 'intersect')).toThrow('do not overlap');
    expect(processor.retainedBytes).toBe(0);
    processor.evaluate([a, b], 'union').dispose();
    expect(a.create).toHaveBeenCalledTimes(2);
    processor.dispose();
  });
});
