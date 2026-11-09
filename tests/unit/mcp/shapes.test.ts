import { describe, expect, it } from 'vitest';
import type { BufferGeometry } from 'three';
import { Box3, Vector3 } from 'three';
import { assertClosed } from '../../../src/core/merge';
import type { Part } from '../../../src/core/types';
import { buildPartGeometry, buildShape, parseColor } from '../../../mcp/shapes';
import type { ShapeSpec } from '../../../mcp/shapes';

function signedVolume(geometry: BufferGeometry) {
  const position = geometry.getAttribute('position');
  const a = new Vector3(),
    b = new Vector3(),
    c = new Vector3();
  let volume = 0;
  for (let i = 0; i < position.count; i += 3) {
    a.fromBufferAttribute(position, i);
    b.fromBufferAttribute(position, i + 1);
    c.fromBufferAttribute(position, i + 2);
    volume += a.dot(b.cross(c));
  }
  return volume / 6;
}

const closed = (geometry: BufferGeometry) =>
  assertClosed({ name: 'shape', geometry } as unknown as Part);
const bounds = (geometry: BufferGeometry) =>
  new Box3().setFromBufferAttribute(geometry.getAttribute('position') as never);

const { PI } = Math;
const circleArea = (radius: number, segments: number) =>
  (segments / 2) * radius * radius * Math.sin((2 * PI) / segments);

const cases: {
  name: string;
  shape: ShapeSpec;
  volume: number;
  tolerance?: number;
  size: number[];
}[] = [
  { name: 'box', shape: { type: 'box', size: [10, 20, 30] }, volume: 6000, size: [10, 20, 30] },
  {
    name: 'rounded box',
    shape: { type: 'box', size: [20, 20, 20], corner_radius: 2, segments: 6 },
    // Core, six face slabs, twelve quarter-cylinder edges, and eight sphere-octant corners.
    volume: 16 ** 3 + 6 * 2 * 16 ** 2 + 3 * PI * 4 * 16 * 1 + (4 / 3) * PI * 8,
    tolerance: 0.01,
    size: [20, 20, 20],
  },
  {
    name: 'cylinder',
    shape: { type: 'cylinder', radius: 10, height: 30, segments: 64 },
    volume: circleArea(10, 64) * 30,
    size: [20, 30, 20],
  },
  {
    name: 'tapered cylinder',
    shape: { type: 'cylinder', radius_top: 5, radius_bottom: 10, height: 30, segments: 96 },
    volume: (PI * 30 * (25 + 50 + 100)) / 3,
    tolerance: 0.005,
    size: [20, 30, 20],
  },
  {
    name: 'cone',
    shape: { type: 'cone', radius: 10, height: 30, segments: 96 },
    volume: (PI * 100 * 30) / 3,
    tolerance: 0.005,
    size: [20, 30, 20],
  },
  {
    name: 'sphere',
    shape: { type: 'sphere', radius: 10, segments: 96 },
    volume: (4 / 3) * PI * 1000,
    tolerance: 0.005,
    size: [20, 20, 20],
  },
  {
    name: 'capsule',
    shape: { type: 'capsule', radius: 5, height: 40, segments: 96 },
    volume: PI * 25 * 30 + (4 / 3) * PI * 125,
    tolerance: 0.005,
    size: [10, 40, 10],
  },
  {
    name: 'torus',
    shape: { type: 'torus', radius: 20, tube: 3, segments: 192 },
    volume: 2 * PI * PI * 20 * 9,
    tolerance: 0.01,
    size: [46, 6, 46],
  },
  {
    name: 'lathe with open ends',
    shape: {
      type: 'lathe',
      profile: [
        [10, 0],
        [10, 20],
      ],
      segments: 128,
    },
    volume: PI * 100 * 20,
    tolerance: 0.005,
    size: [20, 20, 20],
  },
  {
    name: 'lathe listed top to bottom',
    shape: {
      type: 'lathe',
      profile: [
        [10, 20],
        [10, 0],
      ],
      segments: 128,
    },
    volume: PI * 100 * 20,
    tolerance: 0.005,
    size: [20, 20, 20],
  },
  {
    name: 'extrude with a hole',
    shape: {
      type: 'extrude',
      outline: [
        [-10, -10],
        [10, -10],
        [10, 10],
        [-10, 10],
      ],
      holes: [
        [
          [-5, -5],
          [5, -5],
          [5, 5],
          [-5, 5],
        ],
      ],
      depth: 10,
    },
    volume: (400 - 100) * 10,
    size: [20, 20, 10],
  },
  {
    name: 'extrude listed clockwise',
    shape: {
      type: 'extrude',
      outline: [
        [-10, 10],
        [10, 10],
        [10, -10],
        [-10, -10],
      ],
      depth: 10,
    },
    volume: 4000,
    size: [20, 20, 10],
  },
  {
    name: 'bevelled extrude keeps its overall size',
    shape: {
      type: 'extrude',
      outline: [
        [-10, -10],
        [10, -10],
        [10, 10],
        [-10, 10],
      ],
      depth: 10,
      bevel: 1,
    },
    volume: 3900,
    tolerance: 0.03,
    size: [20, 20, 10],
  },
  {
    name: 'open tube',
    shape: {
      type: 'tube',
      path: [
        [0, 0, 0],
        [0, 40, 0],
      ],
      radius: 2,
      segments: 64,
    },
    volume: PI * 4 * 40,
    tolerance: 0.005,
    size: [4, 40, 4],
  },
  {
    name: 'closed tube',
    shape: {
      type: 'tube',
      path: [
        [20, 0, 0],
        [0, 0, 20],
        [-20, 0, 0],
        [0, 0, -20],
      ],
      radius: 2,
      closed: true,
      segments: 32,
    },
    volume: 2 * PI * PI * 20 * 4,
    tolerance: 0.1,
    size: [44, 4, 44],
  },
  {
    name: 'loft between circles',
    shape: {
      type: 'loft',
      sections: [
        { y: 0, radius: 10 },
        { y: 30, radius: 5 },
      ],
      segments: 128,
    },
    volume: (PI * 30 * (100 + 50 + 25)) / 3,
    tolerance: 0.005,
    size: [20, 30, 20],
  },
  {
    name: 'loft between rectangles keeps its corners',
    shape: {
      type: 'loft',
      sections: [
        { y: 0, size: [20, 10] },
        { y: 30, size: [20, 10] },
      ],
      segments: 16,
    },
    volume: 6000,
    size: [20, 30, 10],
  },
  {
    name: 'loft between polygons',
    shape: {
      type: 'loft',
      sections: [
        {
          y: 0,
          outline: [
            [-5, -5],
            [5, -5],
            [5, 5],
            [-5, 5],
          ],
        },
        {
          y: 10,
          outline: [
            [5, 5],
            [-5, 5],
            [-5, -5],
            [5, -5],
          ],
          center: [20, 0],
        },
      ],
    },
    volume: 1000,
    size: [30, 10, 10],
  },
  {
    name: 'loft from a rectangle to a circle',
    shape: {
      type: 'loft',
      sections: [
        { y: 0, size: [20, 20] },
        { y: 20, radius: 10 },
      ],
      segments: 64,
    },
    volume: 20 * (400 + PI * 100) * 0.5,
    tolerance: 0.1,
    size: [20, 20, 20],
  },
  {
    name: 'raw mesh',
    shape: {
      type: 'mesh',
      positions: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10],
      indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3],
    },
    volume: 1000 / 6,
    size: [10, 10, 10],
  },
];

describe('shape builders', () => {
  it.each(cases)(
    '$name is a closed solid of the expected size',
    ({ shape, volume, tolerance, size }) => {
      const geometry = buildShape(shape);
      closed(geometry);
      const measured = signedVolume(geometry);
      expect(measured).toBeGreaterThan(0);
      expect(Math.abs(measured - volume) / volume).toBeLessThan(tolerance ?? 0.001);
      bounds(geometry)
        .getSize(new Vector3())
        .toArray()
        .forEach((value, i) => expect(value).toBeCloseTo(size[i], 3));
    },
  );

  it.each(cases)('$name stays closed through any placement', ({ shape }) => {
    for (const [position, rotation, scale] of [
      [
        [13.7, -41.2, 900.1],
        [33, 71, -12],
        [1, 1, 1],
      ],
      [
        [-0.3, 0.7, 0.1],
        [90, 0, 45],
        [1.7, 0.4, 2.3],
      ],
    ]) {
      const placed = buildShape({ ...shape, position, rotation, scale });
      closed(placed);
      expect(signedVolume(placed)).toBeGreaterThan(0);
    }
  });

  it('keeps solids facing outward when a shape is mirrored', () => {
    const shape: ShapeSpec = { type: 'cylinder', radius: 5, height: 10 };
    const plain = signedVolume(buildShape(shape));
    expect(signedVolume(buildShape({ ...shape, scale: [-1, 1, 1] }))).toBeCloseTo(plain, 3);
  });

  it('gives every vertex a unit normal that faces away from a convex shape', () => {
    const geometry = buildShape({ type: 'capsule', radius: 5, height: 20 });
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    for (let i = 0; i < position.count; i++) {
      const n = new Vector3().fromBufferAttribute(normal, i);
      const p = new Vector3().fromBufferAttribute(position, i);
      expect(n.length()).toBeCloseTo(1, 4);
      expect(n.dot(p)).toBeGreaterThan(0);
    }
  });

  it('points round shapes along Y, including the torus', () => {
    const size = bounds(buildShape({ type: 'torus', radius: 10, tube: 1 })).getSize(new Vector3());
    expect(size.y).toBeCloseTo(2, 4);
    expect(size.x).toBeGreaterThan(21);
  });

  it('explains what a shape is missing', () => {
    const invalid: [ShapeSpec, RegExp][] = [
      [{ type: 'box' }, /size/],
      [{ type: 'box', size: [1, 2, -3] }, /size/],
      [{ type: 'box', size: [4, 4, 4], corner_radius: 3 }, /corner_radius/],
      [{ type: 'cylinder', height: 2 }, /radius/],
      [{ type: 'cylinder', radius: 0, height: 2 }, /positive/],
      [{ type: 'sphere', radius: -1 }, /radius/],
      [{ type: 'capsule', radius: 5, height: 2 }, /height/],
      [{ type: 'torus', radius: 5 }, /tube/],
      [
        {
          type: 'lathe',
          profile: [
            [0, 0],
            [0, 5],
          ],
        },
        /off the axis/,
      ],
      [
        {
          type: 'lathe',
          profile: [
            [-1, 0],
            [2, 5],
          ],
        },
        /negative/,
      ],
      [
        {
          type: 'extrude',
          outline: [
            [0, 0],
            [1, 1],
          ],
          depth: 2,
        },
        /at least 3/,
      ],
      [
        {
          type: 'extrude',
          outline: [
            [0, 0],
            [1, 0],
            [0, 1],
          ],
          depth: 2,
          bevel: 1,
        },
        /bevel/,
      ],
      [{ type: 'tube', path: [[0, 0, 0]], radius: 1 }, /path/],
      [{ type: 'loft', sections: [{ y: 0, radius: 2 }] }, /sections/],
      [{ type: 'loft', sections: [{ y: 0 }, { y: 1, radius: 2 }] }, /one of/],
      [{ type: 'mesh', positions: [0, 0] }, /positions/],
      [{ type: 'sphere', radius: 2, segments: 2 }, /segments/],
      [{ type: 'sphere', radius: 2, scale: [1, 0, 1] }, /scale/],
    ];
    for (const [shape, message] of invalid) expect(() => buildShape(shape)).toThrow(message);
    expect(() => buildShape({ type: 'blob' } as unknown as ShapeSpec)).toThrow(/Unknown shape/);
  });
});

describe('part geometry', () => {
  it('uses the part color when no shape sets its own', () => {
    const { geometry, color } = buildPartGeometry([{ type: 'box', size: [1, 1, 1] }], '#123456');
    expect(color).toBe('#123456');
    expect(geometry.getAttribute('color')).toBeUndefined();
  });

  it('stores mixed colors per vertex, under an untinted part', () => {
    const { geometry, color } = buildPartGeometry(
      [
        { type: 'box', size: [1, 1, 1], color: '#ff0000' },
        { type: 'box', size: [1, 1, 1], position: [5, 0, 0] },
      ],
      '#0000ff',
    );
    expect(color).toBe('#ffffff');
    const colors = geometry.getAttribute('color');
    expect([colors.getX(0), colors.getZ(0)]).toEqual([1, 0]);
    const last = colors.count - 1;
    expect([colors.getX(last), colors.getZ(last)]).toEqual([0, 1]);
  });

  it('merges shapes in the local space they were written in', () => {
    const { geometry } = buildPartGeometry([
      { type: 'box', size: [2, 2, 2] },
      { type: 'box', size: [2, 2, 2], position: [10, 0, 0] },
    ]);
    expect(geometry.boundingBox!.max.x).toBe(11);
    expect(geometry.boundingBox!.min.x).toBe(-1);
  });

  it('accepts hex and CSS colors, and refuses anything else', () => {
    expect(parseColor('#ABCDEF')).toBe('#abcdef');
    expect(parseColor('#abc')).toBe('#aabbcc');
    expect(parseColor('Tomato')).toBe('#ff6347');
    expect(() => parseColor('shiny')).toThrow(/color/);
  });

  it('needs at least one shape', () => {
    expect(() => buildPartGeometry([])).toThrow(/at least one/);
  });
});
