import { unzlibSync } from 'fflate';
import { beforeEach, describe, expect, it } from 'vitest';
import { Session, requirePart } from '../../../mcp/session';
import { encodePng, renderScene } from '../../../mcp/render';
import { viewDirections } from '../../../src/core/navigation';
import type { Part } from '../../../src/core/types';

let session: Session;
beforeEach(() => {
  session = new Session();
});

const box = (id: string, color: string, position = [0, 0, 0], size = [10, 10, 10]) => ({
  id,
  name: id,
  color,
  position,
  shapes: [{ type: 'box' as const, size }],
});

function pixel(result: ReturnType<typeof renderScene>, x: number, y: number) {
  const i = (y * result.width + x) * 3;
  return [result.rgb[i], result.rgb[i + 1], result.rgb[i + 2]];
}
const reddish = ([r, g, b]: number[]) => r > g + 40 && r > b + 40;
const bluish = ([r, g, b]: number[]) => b > r + 40 && b > g + 40;
const greenish = ([r, g, b]: number[]) => g > r + 40 && g > b + 40;
const parts = (...ids: string[]): Part[] => ids.map((id) => requirePart(id));

describe('renderer', () => {
  it('centers a framed part at its true scale', () => {
    session.addParts([box('a', '#ff0000', [0, 0, 0], [100, 100, 100])]);
    const result = renderScene(parts('a'), { views: ['front'], width: 400, grid: false });
    expect(result.views[0].mm_per_pixel).toBeCloseTo(100 / (400 * 0.82), 3);
    const half = 100 / result.views[0].mm_per_pixel / 2;
    expect(reddish(pixel(result, 200, 200))).toBe(true);
    expect(reddish(pixel(result, Math.round(200 + half - 4), 200))).toBe(true);
    expect(reddish(pixel(result, Math.round(200 + half + 4), 200))).toBe(false);
    expect(reddish(pixel(result, 200, Math.round(200 - half + 4)))).toBe(true);
    expect(reddish(pixel(result, 200, Math.round(200 - half - 4)))).toBe(false);
  });

  it('agrees with the app about where each view looks from', () => {
    expect(viewDirections.front).toEqual([0, 0, 1]);
    session.addParts([
      box('center', '#ffffff'),
      box('x', '#ff0000', [30, 0, 0]),
      box('y', '#00ff00', [0, 30, 0]),
      box('z', '#0000ff', [0, 0, 30]),
    ]);
    const all = parts('center', 'x', 'y', 'z');
    const scan = (view: 'front' | 'right' | 'top' | 'back' | 'left' | 'bottom') => {
      const result = renderScene(all, { views: [view], width: 300, grid: false });
      const find = (test: (rgb: number[]) => boolean) => {
        let sumX = 0,
          sumY = 0,
          count = 0;
        for (let y = 40; y < result.height - 40; y++)
          for (let x = 40; x < result.width; x++)
            if (test(pixel(result, x, y))) {
              sumX += x;
              sumY += y;
              count++;
            }
        return count ? [sumX / count, sumY / count] : null;
      };
      const [cx, cy] = [result.width / 2, result.height / 2];
      const sides = (point: number[] | null) =>
        point && [
          Math.abs(point[0] - cx) < 40 ? 0 : Math.sign(point[0] - cx),
          Math.abs(point[1] - cy) < 40 ? 0 : Math.sign(cy - point[1]),
        ];
      return { x: sides(find(reddish)), y: sides(find(greenish)), z: sides(find(bluish)) };
    };
    // Each entry is [screen right, screen up], matching a camera with Y up.
    expect(scan('front').x![0]).toBe(1);
    expect(scan('front').y![1]).toBe(1);
    expect(scan('right').z![0]).toBe(-1);
    expect(scan('back').x![0]).toBe(-1);
    expect(scan('left').z![0]).toBe(1);
    expect(scan('top').x![0]).toBe(1);
    expect(scan('top').z![1]).toBe(-1);
    expect(scan('bottom').x![0]).toBe(1);
  });

  it('draws the nearest surface, whatever order parts come in', () => {
    session.addParts([box('front', '#ff0000', [0, 0, 20]), box('back', '#0000ff', [0, 0, -20])]);
    for (const order of [parts('front', 'back'), parts('back', 'front')]) {
      const result = renderScene(order, { views: ['front'], width: 300, grid: false });
      expect(reddish(pixel(result, 150, 150))).toBe(true);
    }
  });

  it('hides back faces as the app does, so an inside-out mesh shows up', () => {
    session.addParts([
      {
        name: 'sheet',
        color: '#ff0000',
        // Clockwise from the front, so it faces away from a camera at +Z.
        shapes: [{ type: 'mesh', positions: [-5, -5, 0, -5, 5, 0, 5, 0, 0] }],
      },
    ]);
    const render = (view: 'front' | 'back') =>
      renderScene(parts('sheet'), { views: [view], width: 300, grid: false });
    expect(reddish(pixel(render('front'), 150, 150))).toBe(false);
    expect(reddish(pixel(render('back'), 150, 150))).toBe(true);
  });

  it('keeps a mirrored solid facing outward', () => {
    session.addParts([{ ...box('a', '#ff0000'), scale: [-1, 1, 1] }]);
    for (const view of ['front', 'right', 'top', 'iso'] as const) {
      const result = renderScene(parts('a'), { views: [view], width: 300, grid: false });
      expect(reddish(pixel(result, 150, 150))).toBe(true);
    }
  });

  it('uses vertex colors, tinted by the part', () => {
    session.addParts([
      {
        name: 'mixed',
        shapes: [
          { type: 'box', size: [10, 10, 10], position: [-10, 0, 0], color: '#ff0000' },
          { type: 'box', size: [10, 10, 10], position: [10, 0, 0], color: '#0000ff' },
        ],
      },
    ]);
    const result = renderScene(parts('mixed'), { views: ['front'], width: 300, grid: false });
    expect(reddish(pixel(result, 80, 150))).toBe(true);
    expect(bluish(pixel(result, 220, 150))).toBe(true);
  });

  it('applies rotation and mirroring', () => {
    session.addParts([
      {
        name: 'off',
        color: '#ff0000',
        position: [0, 0, 0],
        scale: [-1, 1, 1],
        shapes: [
          { type: 'box', size: [10, 10, 10], position: [20, 0, 0] },
          { type: 'box', size: [1, 1, 1], position: [-20, 0, 0] },
        ],
      },
    ]);
    const result = renderScene(parts('off'), { views: ['front'], width: 300, grid: false });
    // The large end is now on the left of the frame.
    expect(reddish(pixel(result, 40, 150))).toBe(true);
    expect(reddish(pixel(result, 260, 130))).toBe(false);
  });

  it('frames chosen parts while drawing the others', () => {
    session.addParts([box('small', '#ff0000'), box('big', '#0000ff', [300, 0, 0], [50, 50, 50])]);
    const framed = renderScene(parts('small', 'big'), {
      views: ['front'],
      width: 300,
      frame: parts('small'),
      grid: false,
    });
    expect(framed.views[0].mm_per_pixel).toBeCloseTo(10 / (300 * 0.82), 3);
    expect(reddish(pixel(framed, 150, 150))).toBe(true);
  });

  it('highlights parts and grays the rest', () => {
    session.addParts([box('a', '#0000ff', [-10, 0, 0]), box('b', '#0000ff', [10, 0, 0])]);
    const result = renderScene(parts('a', 'b'), {
      views: ['front'],
      width: 300,
      highlight: ['a'],
      grid: false,
    });
    expect(bluish(pixel(result, 220, 150))).toBe(false);
    expect(pixel(result, 80, 150)[0]).toBeGreaterThan(pixel(result, 220, 150)[0] + 40);
  });

  it('lays several views out on one sheet, and honors size options', () => {
    session.addParts([box('a', '#ff0000')]);
    const four = renderScene(parts('a'));
    expect([four.width, four.height, four.views.length]).toEqual([1024, 1024, 4]);
    expect(four.views.map((view) => view.name)).toEqual(['iso', 'front', 'right', 'top']);
    const wide = renderScene(parts('a'), { views: ['front', 'top'], width: 600 });
    expect([wide.width, wide.height]).toEqual([600, 300]);
    const three = renderScene(parts('a'), { views: ['front', 'top', 'right'], width: 600 });
    expect(three.height).toBe(600);
    expect(renderScene(parts('a'), { views: ['front'], width: 320, height: 200 }).height).toBe(200);
  });

  it('renders custom directions, and straight down without a degenerate camera', () => {
    session.addParts([box('a', '#ff0000')]);
    for (const direction of [
      [0, 1, 0],
      [0, -1, 0],
      [1, 1, 1],
    ] as [number, number, number][]) {
      const result = renderScene(parts('a'), { direction, width: 200, grid: false });
      expect(result.views[0].name).toBe('custom');
      expect(reddish(pixel(result, 100, 100))).toBe(true);
    }
  });

  it('renders an empty scene and a very thin part', () => {
    expect(renderScene([], {}).views).toHaveLength(4);
    session.addParts([box('thin', '#ff0000', [0, 0, 0], [100, 0.01, 100])]);
    const result = renderScene(parts('thin'), { views: ['front', 'top'], width: 400 });
    expect(Number.isFinite(result.views[0].mm_per_pixel)).toBe(true);
  });

  it('draws labels without failing on unusual ids', () => {
    session.addParts([{ ...box('a', '#ff0000'), id: 'weird_id-2' }]);
    const plain = renderScene(parts('weird_id-2'), { views: ['front'], width: 400, grid: false });
    const labelled = renderScene(parts('weird_id-2'), {
      views: ['front'],
      width: 400,
      grid: false,
      labels: true,
    });
    expect(Buffer.compare(plain.rgb, labelled.rgb)).not.toBe(0);
  });

  it('draws the ground grid behind geometry, not over it', () => {
    session.addParts([box('a', '#ff0000', [0, 20, 0], [40, 40, 40])]);
    const result = renderScene(parts('a'), { views: ['top'], width: 400 });
    let gridPixels = 0;
    for (let x = 0; x < 400; x++) {
      const [r, g, b] = pixel(result, x, 30);
      if (Math.abs(r - g) < 25 && Math.abs(g - b) < 25 && r > 60) gridPixels++;
    }
    expect(gridPixels).toBeGreaterThan(0);
    expect(reddish(pixel(result, 200, 200))).toBe(true);
  });

  it('encodes a valid PNG', () => {
    const rgb = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9]);
    const png = encodePng(rgb, 2, 2);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(png.buffer);
    expect(view.getUint32(16)).toBe(2);
    expect(view.getUint32(20)).toBe(2);
    expect(String.fromCharCode(...png.subarray(37, 41))).toBe('IDAT');
    const length = view.getUint32(33);
    const raw = unzlibSync(png.subarray(41, 41 + length));
    expect([...raw]).toEqual([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 9, 9, 9]);
    const crc = (bytes: Uint8Array) => {
      let value = 0xffffffff;
      for (const byte of bytes) {
        value ^= byte;
        for (let bit = 0; bit < 8; bit++)
          value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
      }
      return (value ^ 0xffffffff) >>> 0;
    };
    expect(view.getUint32(41 + length)).toBe(crc(png.subarray(37, 41 + length)));
  });
});
