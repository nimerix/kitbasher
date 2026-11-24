import { BufferAttribute, BufferGeometry } from 'three';
import { afterEach, expect, it, vi } from 'vitest';
import { SharedDocument } from '../../mcp/document';
import { geometryBytes, trimHistory } from '../../src/core/history-budget';
import { packArray } from '../../src/core/sculpt-history';
import { useEditor } from '../../src/core/store';
import type { Part, SceneDocument } from '../../src/core/types';

const store = useEditor.getState;
const initial = store();

function surface(): SceneDocument {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(24_576), 3));
  const part: Part = {
    id: 'part',
    name: 'part',
    geometry,
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    color: '#ffffff',
    visible: true,
    locked: false,
    source: 'test',
  };
  return { name: 'Test', joints: [], parts: [part] };
}

function edit(part: Part, stroke: number) {
  const geometry = part.geometry.clone();
  geometry.attributes.position.setX(stroke * 47, stroke);
  return geometry;
}

afterEach(() => {
  vi.restoreAllMocks();
  useEditor.setState(initial);
});

it('restores all 120 sculpt strokes and masks with less storage than 40 full meshes', () => {
  const scene = surface();
  store().setScene(scene);
  store().select('part');
  expect(store().startSculpt()).toBe(true);
  const ids = [scene.parts[0].geometry.uuid];
  for (let i = 1; i <= 120; i++) {
    const part = store().scene.parts[0];
    const geometry = edit(part, i);
    const mask = store().sculpt!.mask?.slice() ?? new Float32Array(8192);
    mask[i] = 0.5;
    expect(
      store().commitSculpt({
        ...part,
        partId: part.id,
        source: part.geometry,
        geometry,
        mask,
        epoch: store().sceneEpoch,
      }),
    ).toBe(true);
    ids.push(geometry.uuid);
  }
  const history = store().past.map((s) => s.parts[0].geometry);
  expect(history).toHaveLength(120);
  expect(geometryBytes(history)).toBeLessThan(40 * geometryBytes([scene.parts[0].geometry]));
  expect(store().sculpt!.past).toHaveLength(120);
  // Force the cold restoration path even on runners that have not collected a retired mesh.
  vi.spyOn(WeakRef.prototype, 'deref').mockReturnValue(undefined);
  function check(i: number) {
    const geometry = store().scene.parts[0].geometry;
    expect(geometry.uuid).toBe(ids[i]);
    expect(geometry.attributes.position.getX(i * 47)).toBe(i);
    expect(geometry.attributes.position.getX((i + 1) * 47)).toBe(0);
    const mask = store().sculpt!.mask;
    if (i === 0) expect(mask).toBeNull();
    else {
      expect(mask![i]).toBe(0.5);
      expect(mask![i + 1]).toBe(0);
    }
  }
  for (let i = 119; i >= 0; i--) {
    store().undo();
    check(i);
  }
  for (let i = 1; i <= 120; i++) {
    store().redo();
    check(i);
  }
  store().setTool('select');
  for (let i = 0; i < 120; i++) store().undo();
  expect(store().scene).toBe(scene);
});

it('preserves a shared author’s 120 strokes within the previous 40-mesh budget', () => {
  const scene = surface();
  const doc = new SharedDocument(40 * geometryBytes([scene.parts[0].geometry]));
  doc.replace(scene);
  const ids = [scene.parts[0].geometry.uuid];
  for (let i = 1; i <= 120; i++) {
    const part = doc.scene.parts[0];
    const geometry = edit(part, i);
    doc.addMesh(geometry.uuid, geometry);
    doc.apply('artist', {
      base: doc.version,
      epoch: doc.epoch,
      checkpoint: true,
      scene: { ...doc.scene, parts: [{ ...part, geometry }] },
      sculpt: { ...part, partId: part.id, source: part.geometry.uuid },
    });
    ids.push(geometry.uuid);
  }
  expect(doc.counts('artist').undo).toBe(120);
  for (let i = 119; i >= 0; i--) {
    expect(doc.undo('artist')?.changed).toBe(true);
    expect(doc.scene.parts[0].geometry.uuid).toBe(ids[i]);
  }
  for (let i = 1; i <= 120; i++) {
    expect(doc.redo('artist')?.changed).toBe(true);
    expect(doc.mesh(ids[i])).toBe(doc.scene.parts[0].geometry);
  }
});

it('restores changed topology and raw attribute bits after buffers are collected', () => {
  const initial = new Uint16Array(4097);
  const longer = new Uint16Array(4111);
  longer.set(initial);
  longer[17] = 9;
  longer[4110] = 73;
  const first = packArray(longer, initial);
  const shorter = longer.slice(0, 4100);
  shorter[3000] = 21;
  const second = packArray(shorter, longer, first);
  const bits = new Uint32Array(8192);
  bits[811] = 0x7fc00005;
  bits[1001] = 0x80000000;
  const floats = packArray(new Float32Array(bits.buffer), new Float32Array(bits.length));
  vi.spyOn(WeakRef.prototype, 'deref').mockReturnValue(undefined);
  expect(first.restore()).toEqual(longer);
  expect(second.restore()).toEqual(shorter);
  expect(new Uint32Array(floats.restore().buffer)).toEqual(bits);
});

it('charges shared backing buffers once, including views with different offsets', () => {
  const geometry = new BufferGeometry();
  const buffer = new ArrayBuffer(4096);
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(buffer, 0, 9), 3));
  geometry.setIndex(new BufferAttribute(new Uint16Array(buffer, 64, 3), 1));
  const scene = surface();
  const views = { ...scene, parts: [{ ...scene.parts[0], geometry }] };
  const keep = [{ ...scene, parts: [] }];
  const fullCost = geometryBytes([scene.parts[0].geometry]) + buffer.byteLength;
  expect(trimHistory([views, scene], [], keep, fullCost).trimmed).toBe(false);
  expect(trimHistory([views, scene], [], keep, fullCost - 1).past).toEqual([scene]);
});
