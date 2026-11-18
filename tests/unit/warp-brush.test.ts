import { afterEach, describe, expect, it } from 'vitest';
import { PlaneGeometry, Triangle, Vector3, type BufferGeometry } from 'three';
import { logSliderPosition, logSliderValue } from '../../src/components/ui';
import { fittedSizeRange, partSize, triangleCount } from '../../src/core/geometry';
import { fittedWarpBrushRadius, useEditor, warpBrushRadius } from '../../src/core/store';
import { readFace } from '../../src/core/surfaces';
import type { Part, SurfacePoint } from '../../src/core/types';

function plate(id: string, size = 40, scale: Part['scale'] = [1, 1, 1]): Part {
  return {
    id,
    name: id,
    geometry: new PlaneGeometry(size, size, 32, 32),
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    scale,
    color: '#aabbcc',
    visible: true,
    locked: false,
    source: 'test',
  };
}

function faceAt(geometry: BufferGeometry, x: number, y: number) {
  const triangle = new Triangle(),
    point = new Vector3(x, y, 0),
    closest = new Vector3();
  for (let face = 0; face < triangleCount(geometry); face++) {
    readFace(geometry, face, triangle);
    if (triangle.closestPointToPoint(point, closest).distanceTo(point) < 1e-6) return face;
  }
  throw new Error('No face under the point.');
}

const hit = (partId: string, x: number, y: number): SurfacePoint => ({
  partId,
  point: [x, y, 0],
  normal: [0, 0, 1],
});

const editor = () => useEditor.getState();

function warp(...parts: Part[]) {
  editor().setScene({ name: 'Brush', parts, joints: [] });
  useEditor.setState({ selected: [parts[0].id] });
  editor().setTool('warp');
}

/** Paints one dab at the plate's centre and returns how many faces it covered. */
function dab(part: Part) {
  editor().paintWarpRegion(hit(part.id, 0, 0), faceAt(part.geometry, 0, 0), false, true);
  editor().endPaintStroke();
  return editor().warp!.faces.length;
}

const initial = useEditor.getState();
afterEach(() => {
  editor().cancelWarp();
  useEditor.setState(initial);
});

describe('part size', () => {
  it('is the largest scaled side, whichever way the part is turned', () => {
    const part = { ...plate('a', 32), scale: [1, 2, 1] as Part['scale'] };
    expect(partSize(part)).toBeCloseTo(64);
    const turned: Part = { ...part, quaternion: [0, 0, Math.SQRT1_2, Math.SQRT1_2] };
    expect(partSize(turned)).toBeCloseTo(64);
    expect(partSize({ ...part, scale: [-1, 1, 1] })).toBeCloseTo(32);
  });

  it('fits a 32 mm model from 0.1 mm to a quarter of its size, clamped to 2–100 mm', () => {
    expect(fittedSizeRange(32)).toEqual({ min: 0.1, max: 8 });
    expect(fittedSizeRange(100)).toEqual({ min: 0.1, max: 25 });
    expect(fittedSizeRange(4)).toEqual({ min: 0.1, max: 2 });
    expect(fittedSizeRange(1000)).toEqual({ min: 0.1, max: 100 });
    // Each doubling takes the same travel, so mid-travel is the geometric mean.
    const { min, max } = fittedSizeRange(32);
    expect(Math.sqrt(min * max)).toBeCloseTo(0.89, 2);
  });
});

describe('logarithmic slider', () => {
  it('sets a value at every step that shows that same step', () => {
    for (const { min, max } of [
      { min: 0.1, max: 7.8 },
      { min: 0.1, max: 2 },
      { min: 0.1, max: 100 },
      { min: 0.05, max: 25 },
    ])
      for (const zero of [false, true])
        for (let step = 0; step <= 200; step++) {
          const value = logSliderValue(step, min, max, zero);
          expect(logSliderPosition(value, min, max, zero), `${min}–${max} ${zero} ${step}`).toBe(
            step,
          );
        }
  });

  it('moves one step from either end, and from 0 onto the scale and back', () => {
    const [min, max] = [0.1, 7.8];
    expect(logSliderValue(1, min, max)).toBeGreaterThan(min);
    expect(logSliderPosition(logSliderValue(1, min, max), min, max)).toBe(1);
    expect(logSliderValue(199, min, max)).toBeLessThan(max);
    expect(logSliderPosition(logSliderValue(199, min, max), min, max)).toBe(199);
    expect(logSliderValue(200, min, max)).toBe(max);
    expect(logSliderValue(0, min, max)).toBe(min);
    expect(logSliderPosition(0, min, max, true)).toBe(0);
    expect(logSliderValue(1, min, max, true)).toBe(min);
    expect(logSliderValue(0, min, max, true)).toBe(0);
    expect(logSliderPosition(logSliderValue(2, min, max, true), min, max, true)).toBe(2);
  });
});

describe("Warp's brush", () => {
  it('starts at 3 % of the part size', () => {
    warp(plate('a', 32));
    expect(warpBrushRadius(editor())).toBe(0.96);
    editor().cancelWarp();
    warp(plate('b', 40, [2.5, 1, 1]));
    expect(warpBrushRadius(editor())).toBe(3);
    expect(fittedWarpBrushRadius(plate('c', 1))).toBe(0.05);
  });

  it("is separate from Align's brush both ways", () => {
    warp(plate('a'));
    const align = editor().brushRadius;
    editor().setWarpBrushRadius(5);
    expect(warpBrushRadius(editor())).toBe(5);
    expect(editor().brushRadius).toBe(align);
    editor().setBrush({ radius: 12 });
    expect(warpBrushRadius(editor())).toBe(5);
    expect(editor().brushRadius).toBe(12);
  });

  it('keeps what was set across sessions on the same part in one scene, not on another', () => {
    const a = plate('a'),
      b = plate('b');
    warp(a, b);
    editor().setWarpBrushRadius(2.5);
    editor().cancelWarp();
    editor().setTool('select');
    useEditor.setState({ selected: ['a'] });
    editor().setTool('warp');
    expect(warpBrushRadius(editor())).toBe(2.5);
    editor().cancelWarp();
    editor().setTool('select');
    useEditor.setState({ selected: ['b'] });
    editor().setTool('warp');
    expect(warpBrushRadius(editor())).toBe(fittedWarpBrushRadius(b));
  });

  it("keeps each part's own radius through strokes, Apply, Cancel and switching parts", async () => {
    const a = plate('a'),
      b = plate('b');
    const edit = (part: Part) => {
      editor().cancelWarp();
      editor().setTool('select');
      useEditor.setState({ selected: [part.id] });
      editor().setTool('warp');
      expect(editor().warp!.partId).toBe(part.id);
    };
    warp(a, b);
    editor().setWarpBrushRadius(2.4);
    dab(a);
    editor().undoPaintStroke();
    expect(warpBrushRadius(editor())).toBe(2.4);

    // Apply restarts the session on the warped part.
    dab(a);
    await editor().layWarpGrid();
    editor().addWarpPoint(hit('a', 0, 0), faceAt(a.geometry, 0, 0));
    const [point] = editor().warp!.points;
    editor().moveWarpPoints([{ id: point.id, target: [0, 0, 1] }], 'end');
    expect(editor().applyWarp()).toBe(true);
    expect(editor().warp!.partId).toBe('a');
    expect(warpBrushRadius(editor())).toBe(2.4);

    edit(b);
    expect(warpBrushRadius(editor())).toBe(fittedWarpBrushRadius(b));
    editor().setWarpBrushRadius(4);
    edit(a);
    expect(warpBrushRadius(editor())).toBe(2.4);
    edit(b);
    expect(warpBrushRadius(editor())).toBe(4);
  });

  it('starts empty in a new or opened scene, even for a part that reuses an old id', () => {
    warp(plate('a', 40));
    editor().setWarpBrushRadius(5);
    expect(warpBrushRadius(editor())).toBe(5);
    editor().cancelWarp();
    const small = plate('a', 6);
    warp(small);
    expect(warpBrushRadius(editor())).toBe(fittedWarpBrushRadius(small));
    expect(fittedWarpBrushRadius(small)).toBe(0.18);
  });

  it('reads only radii it was given, never inherited properties', () => {
    for (const id of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const part = plate(id, 32);
      warp(part);
      expect(warpBrushRadius(editor()), id).toBe(0.96);
      editor().setWarpBrushRadius(2);
      expect(warpBrushRadius(editor()), id).toBe(2);
      editor().cancelWarp();
    }
  });

  it("keeps a deleted part's radius while undo can bring it back, and no longer", () => {
    const a = plate('a'),
      b = plate('b');
    warp(a, b);
    editor().setWarpBrushRadius(2.5);
    editor().cancelWarp();
    editor().setTool('select');
    useEditor.setState({ selected: ['a'] });
    editor().deleteSelected();
    expect(editor().warpBrush.get('a')).toBe(2.5);
    editor().undo();
    useEditor.setState({ selected: ['a'] });
    editor().setTool('warp');
    expect(warpBrushRadius(editor())).toBe(2.5);
    editor().cancelWarp();
    editor().setTool('select');
    editor().redo();
    expect(editor().warpBrush.get('a')).toBe(2.5);
    // Once no history holds the part, a later edit lets its radius go.
    useEditor.setState({ past: [], future: [] });
    useEditor.setState({ selected: ['b'] });
    editor().deleteSelected();
    expect(editor().warpBrush.has('a')).toBe(false);
  });

  it('clamps to the numeric field and ignores values that are not numbers', () => {
    warp(plate('a'));
    editor().setWarpBrushRadius(0.01);
    expect(warpBrushRadius(editor())).toBe(0.05);
    editor().setWarpBrushRadius(500);
    expect(warpBrushRadius(editor())).toBe(100);
    editor().setWarpBrushRadius(Number.NaN);
    expect(warpBrushRadius(editor())).toBe(100);
  });

  it('sets how much a dab paints, whatever Align uses', () => {
    const part = plate('a');
    warp(part);
    editor().setBrush({ radius: 20 });
    editor().setWarpBrushRadius(1);
    const small = dab(part);
    editor().undoPaintStroke();
    expect(editor().warp!.faces).toEqual([]);
    editor().setBrush({ radius: 0.1 });
    editor().setWarpBrushRadius(6);
    const large = dab(part);
    // Cells are 1.25 mm, so a 1 mm dab covers a few faces and a 6 mm dab a disc of them.
    expect(small).toBeGreaterThan(0);
    expect(small).toBeLessThan(16);
    expect(large).toBeGreaterThan(small * 10);
  });
});
