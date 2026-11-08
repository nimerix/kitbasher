import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BoxGeometry,
  BufferGeometry,
  OrthographicCamera,
  PerspectiveCamera,
  SphereGeometry,
  Vector3,
} from 'three';
import {
  binaryGeometry,
  combineParts,
  deserializeGeometry,
  serializeGeometry,
  uid,
} from '../../src/core/geometry';
import { saveCurrentScene } from '../../src/core/commands';
import { exportStl, importModels } from '../../src/core/files';
import { displayedPosition, explodeFrame, transferView } from '../../src/core/navigation';
import {
  parseScene,
  sceneSubset,
  serializeRecovery,
  serializeScene,
} from '../../src/core/scene-file';
import { useEditor } from '../../src/core/store';
import type { Part, PlaneConstraint, SceneDocument, Vec3 } from '../../src/core/types';

const part = (id: string, position: Vec3 = [0, 0, 0], geometry?: BufferGeometry): Part => ({
  id,
  name: id,
  geometry: geometry ?? new BoxGeometry(10, 10, 10),
  position,
  quaternion: [0, 0, 0, 1],
  scale: [1, 1, 1],
  color: '#aabbcc',
  visible: true,
  locked: false,
  source: 'test',
});

const constraint = (sourceId: string, targetId: string): PlaneConstraint => ({
  id: `${sourceId}-${targetId}`,
  name: 'Mate',
  sourceId,
  targetId,
  sourcePlane: { point: [5, 0, 0], normal: [1, 0, 0] },
  targetPlane: { point: [-5, 0, 0], normal: [-1, 0, 0] },
  kind: 'mate',
  angle: 0,
  offset: 0,
  opposed: true,
  enabled: true,
});

const surface = (partId: string, z = 5) => ({
  partId,
  point: [0, 0, z] as Vec3,
  normal: [0, 0, 1] as Vec3,
});

const open = (parts: Part[], extra: Partial<SceneDocument> = {}) =>
  useEditor.getState().setScene({ name: 'Bench', parts, joints: [], ...extra });

describe('ids', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('generates unique ids on insecure origins without crypto.randomUUID', () => {
    const webCrypto = globalThis.crypto;
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array<ArrayBuffer>) => webCrypto.getRandomValues(bytes),
    });
    const ids = new Set(Array.from({ length: 200 }, () => uid()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('scene files', () => {
  it('restores every Float32 coordinate exactly from compact decimals', () => {
    const geometry = new SphereGeometry(137.123, 24, 24).translate(1234.5678, -0.001, 88.8);
    const restored = deserializeGeometry(
      JSON.parse(JSON.stringify(serializeGeometry(geometry))),
    ).getAttribute('position').array;
    expect(restored).toEqual(geometry.getAttribute('position').array);
    const raw = JSON.stringify(Array.from(geometry.getAttribute('position').array));
    expect(JSON.stringify(serializeGeometry(geometry).positions).length).toBeLessThan(raw.length);
  });

  it('keeps smooth shading through save and reopen', () => {
    const smooth = new SphereGeometry(10, 16, 16).toNonIndexed();
    const before = smooth.getAttribute('normal'),
      after = deserializeGeometry(serializeGeometry(smooth)).getAttribute('normal');
    for (let i = 0; i < before.count; i++)
      expect(
        new Vector3(before.getX(i), before.getY(i), before.getZ(i)).dot(
          new Vector3(after.getX(i), after.getY(i), after.getZ(i)),
        ),
      ).toBeGreaterThan(0.9999);
  });

  it('still computes normals for scenes saved before they were stored', () => {
    const { normals: _normals, ...legacy } = serializeGeometry(new BoxGeometry(2, 2, 2));
    expect(deserializeGeometry(legacy).getAttribute('normal').count).toBe(24);
  });

  it('round trips the typed-array recovery format and its validation', () => {
    const source = part('a', [1, 2, 3]);
    const stored = serializeRecovery({ name: 'Recovered', parts: [source], joints: [] });
    expect(stored.parts[0].geometry.positions).toBeInstanceOf(Float32Array);
    const cloned = structuredClone(stored);
    const restored = parseScene(cloned).parts[0].geometry;
    expect(restored.getAttribute('position').array).toEqual(
      source.geometry.getAttribute('position').array,
    );
    expect(restored.index!.array).toEqual(source.geometry.index!.array);
    cloned.parts[0].geometry.positions[0] = NaN;
    expect(() => parseScene(cloned)).toThrow('invalid vertex positions');
  });

  it('reports a readable error for a part with no mesh data', () => {
    const file = serializeScene({ name: 'Broken', parts: [part('a')], joints: [] });
    delete (file.parts[0] as { geometry?: unknown }).geometry;
    expect(() => parseScene(file)).toThrow('invalid vertex positions');
    const badIndices = serializeScene({ name: 'Broken', parts: [part('a')], joints: [] });
    (badIndices.parts[0].geometry as { indices: unknown }).indices = 7;
    expect(() => parseScene(badIndices)).toThrow('invalid triangle indices');
  });

  it('exports a subset that reopens without dangling relationships', () => {
    const scene: SceneDocument = {
      name: 'Subset',
      parts: [part('a'), part('b'), part('c')],
      joints: [
        {
          id: 'j',
          name: 'Joint',
          parentId: 'b',
          childId: 'c',
          parentAnchor: [0, 0, 0],
          childAnchor: [0, 0, 0],
          restRotation: [0, 0, 0, 1],
          rotationLocks: [false, false, false],
          keepConnected: true,
        },
      ],
      constraints: [constraint('a', 'b'), constraint('c', 'b')],
    };
    const subset = sceneSubset(scene, [scene.parts[1], scene.parts[2]]);
    expect(subset.joints.map((j) => j.id)).toEqual(['j']);
    expect(subset.constraints!.map((c) => c.id)).toEqual(['c-b']);
    expect(() => parseScene(serializeScene(subset))).not.toThrow();
    const lone = sceneSubset(scene, [scene.parts[0]]);
    expect(lone.joints).toEqual([]);
    expect(lone.constraints).toEqual([]);
    expect(() => parseScene(serializeScene(lone))).not.toThrow();
  });

  it('reports a failed save instead of throwing out of the command', () => {
    open([part('a')]);
    const revision = useEditor.getState().revision;
    useEditor.getState().renameScene('Unsaved');
    saveCurrentScene();
    const state = useEditor.getState();
    // Node has no document, which stands in for any failure while writing the file.
    expect(state.toast?.kind).toBe('error');
    expect(state.savedRevision).toBeLessThanOrEqual(revision);
  });

  it('explains when a scene is too large to write as one file', () => {
    open([part('a')]);
    const stringify = vi.spyOn(JSON, 'stringify').mockImplementation(() => {
      throw new RangeError('Invalid string length');
    });
    try {
      saveCurrentScene();
    } finally {
      stringify.mockRestore();
    }
    expect(useEditor.getState().toast?.kind).toBe('error');
    expect(useEditor.getState().toast?.message).toContain('too large');
  });
});

describe('meshes', () => {
  it('skips empty meshes on import so scenes stay reopenable', async () => {
    const name = 'empty'.repeat(30);
    const empty = new File([`solid ${name}\nendsolid ${name}\n`], 'empty.stl');
    await expect(importModels([empty], { units: 'mm', up: 'y', center: false })).rejects.toThrow(
      'No triangle meshes',
    );
  });

  it('names the file when a loader cannot read it', async () => {
    const options = { units: 'mm', up: 'y', center: false } as const;
    await expect(importModels([new File(['x'], 'damaged.stl')], options)).rejects.toThrow(
      'damaged.stl could not be read',
    );
    await expect(importModels([new File(['x'], 'notes.txt')], options)).rejects.toThrow(
      'supported formats',
    );
  });

  it('keeps smooth normals when combining meshes', () => {
    const smooth = new SphereGeometry(10, 16, 16).toNonIndexed();
    const combined = combineParts([part('a', [0, 0, 0], smooth), part('b', [30, 0, 0], smooth)]);
    const normals = combined.getAttribute('normal');
    const expected = smooth.getAttribute('normal');
    for (let i = 0; i < expected.count; i += 37)
      expect(normals.getY(i)).toBeCloseTo(expected.getY(i), 5);
  });

  it('writes outward STL facets for mirrored parts', () => {
    const mirrored = { ...part('m'), scale: [-1, 1, 1] as Vec3 };
    const view = new DataView(exportStl([mirrored]));
    expect(view.getUint32(80, true)).toBe(12);
    for (let i = 0; i < 12; i++) {
      const offset = 84 + i * 50;
      const value = (at: number) => view.getFloat32(offset + at, true);
      const normal = new Vector3(value(0), value(4), value(8));
      const centroid = new Vector3(
        value(12) + value(24) + value(36),
        value(16) + value(28) + value(40),
        value(20) + value(32) + value(44),
      ).divideScalar(3);
      expect(normal.dot(centroid)).toBeGreaterThan(0);
    }
  });

  it('shares live buffers with workers and recovery instead of copying', () => {
    const geometry = new BoxGeometry(1, 1, 1);
    const data = binaryGeometry(geometry);
    expect(data.positions).toBe(geometry.getAttribute('position').array);
    expect(data.indices).toBe(geometry.index!.array);
  });
});

describe('camera views', () => {
  it('carries direction, pivot, and apparent size between projections', () => {
    const perspective = new PerspectiveCamera(35, 1.5, 0.1, 5000);
    const orthographic = new OrthographicCamera(-600, 600, 400, -400, 0.1, 5000);
    const target = new Vector3(5, 40, -3),
      orthographicTarget = new Vector3();
    perspective.position.set(120, 90, 200);
    perspective.lookAt(target);
    perspective.updateMatrixWorld();
    const direction = perspective.position.clone().sub(target).normalize();
    const height =
      2 * perspective.position.distanceTo(target) * Math.tan(((35 / 2) * Math.PI) / 180);

    transferView(perspective, orthographic, target, orthographicTarget);
    expect(orthographicTarget.toArray()).toEqual(target.toArray());
    expect(
      orthographic.position.clone().sub(target).normalize().distanceTo(direction),
    ).toBeLessThan(1e-9);
    expect((orthographic.top - orthographic.bottom) / orthographic.zoom).toBeCloseTo(height, 6);

    const back = new PerspectiveCamera(35, 1.5, 0.1, 5000);
    const backTarget = new Vector3();
    transferView(orthographic, back, orthographicTarget, backTarget);
    expect(back.position.distanceTo(perspective.position)).toBeLessThan(1e-6);
    expect(backTarget.toArray()).toEqual(target.toArray());
  });
});

describe('exploded view', () => {
  it('spreads parts from the assembly center wherever the assembly is', () => {
    const offset = 5000;
    const parts = [part('left', [offset - 100, 0, 0]), part('right', [offset + 100, 0, 0])];
    const frame = explodeFrame(parts);
    expect(frame.center.x).toBeCloseTo(offset, 6);
    const left = displayedPosition(parts[0], 100, frame),
      right = displayedPosition(parts[1], 100, frame);
    expect(left[0]).toBeLessThan(parts[0].position[0]);
    expect(right[0]).toBeGreaterThan(parts[1].position[0]);
    expect(right[0] - parts[1].position[0]).toBeCloseTo(frame.reach, 6);
  });

  it('follows visible geometry for scans with distant local origins', () => {
    const parts = [
      part('a', [-1000, 0, 0], new BoxGeometry(10, 10, 10).translate(900, 0, 0)),
      part('b', [-1000, 0, 0], new BoxGeometry(10, 10, 10).translate(1100, 0, 0)),
    ];
    const frame = explodeFrame(parts);
    expect(displayedPosition(parts[0], 50, frame)[0]).toBeLessThan(-1000);
    expect(displayedPosition(parts[1], 50, frame)[0]).toBeGreaterThan(-1000);
  });

  it('never moves parts while the view is not exploded', () => {
    const source = part('a', [1, 2, 3]);
    expect(displayedPosition(source, 0, explodeFrame([source]))).toBe(source.position);
  });
});

describe('editor state', () => {
  beforeEach(() => open([part('a', [-20, 0, 0]), part('b', [20, 0, 0])]));

  const paintMoving = () => {
    const state = useEditor.getState();
    state.select('a');
    state.setTool('align');
    useEditor.getState().setOperation({ mode: 'surface' });
    expect(useEditor.getState().paintSurface(surface('a'), 8, false, true)).toBe(true);
    useEditor.getState().endPaintStroke();
    return useEditor.getState().operation.surfacePairs[0].source!.faces.length;
  };

  it('keeps painted patches when the active tool is selected again', () => {
    const faces = paintMoving();
    expect(faces).toBeGreaterThan(0);
    useEditor.getState().setTool('align');
    useEditor.getState().setOperation({ mode: 'surface' });
    expect(useEditor.getState().operation.surfacePairs[0].source!.faces).toHaveLength(faces);
    expect(useEditor.getState().paintHistory).toHaveLength(1);
  });

  it('still restarts when the method or a part really changes', () => {
    paintMoving();
    useEditor.getState().setOperation({ targetId: 'b' });
    expect(useEditor.getState().operation.surfacePairs[0].source).toBeNull();
    paintMoving();
    useEditor.getState().setOperation({ mode: 'point' });
    expect(useEditor.getState().operation.surfacePairs).toEqual([]);
    useEditor.getState().setTool('select');
    expect(useEditor.getState().operation.pairs).toEqual([]);
  });

  it('keeps the brush on its patch after undoing a stroke', () => {
    paintMoving();
    const active = useEditor.getState().operation.activeSurface;
    useEditor.getState().undoPaintStroke();
    expect(useEditor.getState().operation.activeSurface).toEqual(active);
    expect(useEditor.getState().paintSurface(surface('a'), 8, false, true)).toBe(true);
  });

  it('does not paint patches that the exploded view would hide', () => {
    paintMoving();
    useEditor.getState().setView({ explode: 40 });
    expect(useEditor.getState().paintSurface(surface('a'), 4, false, true)).toBe(false);
    expect(useEditor.getState().toast?.message).toContain('exploded view');
    useEditor.getState().setView({ explode: 0 });
  });

  it('rejects reference planes as moving parts and as joint targets', () => {
    const state = useEditor.getState();
    state.setTool('align');
    useEditor.getState().pick(surface('plane-xy'));
    expect(useEditor.getState().operation.pending).toBeNull();
    expect(useEditor.getState().operation.sourceId).toBeNull();
    useEditor.getState().pick(surface('a'));
    useEditor.getState().pick(surface('plane-xy'));
    expect(useEditor.getState().operation.pairs).toHaveLength(1);

    useEditor.getState().setTool('select');
    useEditor.getState().setTool('joint');
    useEditor.getState().pick(surface('a'));
    useEditor.getState().pick(surface('plane-xy'));
    expect(useEditor.getState().operation.pairs).toHaveLength(0);
    expect(useEditor.getState().operation.pending).not.toBeNull();
    expect(useEditor.getState().toast?.message).toContain('Joints connect two parts');
  });

  it('clears picks and measurements that reference removed parts', () => {
    const state = useEditor.getState();
    state.select('a');
    state.setTool('align');
    useEditor.getState().pick(surface('a'));
    useEditor.getState().select('a');
    useEditor.getState().deleteSelected();
    expect(useEditor.getState().operation.sourceId).toBeNull();
    expect(useEditor.getState().operation.pending).toBeNull();
    expect(useEditor.getState().tool).toBe('align');

    open([part('a'), part('b')]);
    useEditor.getState().setTool('measure');
    useEditor.getState().pick(surface('a'));
    useEditor.getState().select('a');
    useEditor.getState().deleteSelected();
    expect(useEditor.getState().measurement).toEqual([]);
  });

  it('clears measurement markers on undo, redo, and opening a scene', () => {
    useEditor.getState().renameScene('Renamed');
    useEditor.getState().setTool('measure');
    useEditor.getState().pick(surface('a'));
    useEditor.getState().undo();
    expect(useEditor.getState().measurement).toEqual([]);
    useEditor.getState().setTool('measure');
    useEditor.getState().pick(surface('a'));
    useEditor.getState().redo();
    expect(useEditor.getState().measurement).toEqual([]);
    useEditor.getState().setTool('measure');
    useEditor.getState().pick(surface('a'));
    open([part('a')]);
    expect(useEditor.getState().measurement).toEqual([]);
  });

  it('adds no history for edits that change nothing', () => {
    const state = useEditor.getState();
    state.renameScene('Bench');
    state.renameScene('  Bench  ');
    state.patchParts(['a'], { name: 'a' });
    state.patchParts(['a', 'b'], { visible: true, locked: false });
    state.patchParts([], { visible: false });
    expect(useEditor.getState().past).toHaveLength(0);
    expect(useEditor.getState().revision).toBe(state.revision);
    state.patchParts(['a'], { name: 'Renamed' });
    expect(useEditor.getState().past).toHaveLength(1);
  });

  it('groups continuous part edits into one undo step', () => {
    const state = useEditor.getState();
    state.patchParts(['a'], { color: '#111111' }, true);
    state.patchParts(['a'], { color: '#222222' }, false);
    state.patchParts(['a'], { color: '#333333' }, false);
    expect(useEditor.getState().past).toHaveLength(1);
    useEditor.getState().undo();
    expect(useEditor.getState().scene.parts[0].color).toBe('#aabbcc');
  });
});

describe('geometry lifetime', () => {
  const watched = (geometry: BufferGeometry) => {
    const disposed = vi.fn();
    geometry.addEventListener('dispose', disposed);
    return disposed;
  };

  it('keeps geometry that undo can restore and releases it when opening another scene', () => {
    const removed = part('removed');
    const disposed = watched(removed.geometry);
    open([removed, part('kept')]);
    useEditor.getState().select('removed');
    useEditor.getState().deleteSelected();
    expect(disposed).not.toHaveBeenCalled();
    useEditor.getState().undo();
    expect(useEditor.getState().scene.parts).toHaveLength(2);
    expect(disposed).not.toHaveBeenCalled();
    open([part('other')]);
    expect(disposed).toHaveBeenCalledTimes(1);
  });

  it('keeps geometry held by the clipboard until it is replaced', () => {
    const copied = part('copied');
    const disposed = watched(copied.geometry);
    open([copied]);
    useEditor.getState().select('copied');
    useEditor.getState().copySelected();
    open([part('other')]);
    expect(disposed).not.toHaveBeenCalled();
    useEditor.getState().pasteClipboard();
    expect(useEditor.getState().scene.parts.at(-1)!.geometry).toBe(copied.geometry);
    useEditor.getState().select('other');
    useEditor.getState().copySelected();
    open([part('another')]);
    expect(disposed).toHaveBeenCalledTimes(1);
  });

  it('releases geometry that falls out of the undo limit', () => {
    const dropped = part('dropped');
    const disposed = watched(dropped.geometry);
    open([dropped]);
    useEditor.getState().select('dropped');
    useEditor.getState().deleteSelected();
    for (let i = 0; i < 39; i++) useEditor.getState().renameScene(`Name ${i}`);
    expect(disposed).not.toHaveBeenCalled();
    useEditor.getState().renameScene('One more');
    expect(disposed).toHaveBeenCalledTimes(1);
  });
});
