import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, BufferAttribute, Color } from 'three';
import { unzipSync, strFromU8 } from 'fflate';
import { exportBlenderPackage, export3mf, exportGlb, exportStl } from '../../src/core/files';
import { bakedPartGeometry, combineParts } from '../../src/core/geometry';
import { lightingPresets, presetLighting } from '../../src/core/lighting';
import { mergedPart } from '../../src/core/merge';
import { sceneLighting, useEditor } from '../../src/core/store';
import type { Part, SceneDocument, SceneLighting } from '../../src/core/types';

const original = useEditor.getState();
const state = () => useEditor.getState();
const find = (id: string) => state().scene.parts.find((p) => p.id === id)!;

const painted = () => {
  const geometry = new BoxGeometry(4, 6, 8);
  const count = geometry.getAttribute('position').count;
  geometry.setAttribute(
    'color',
    new BufferAttribute(
      Float32Array.from({ length: count * 3 }, (_, i) => (i % 7) / 7),
      3,
    ),
  );
  return geometry;
};

const part = (id: string, patch: Partial<Part> = {}): Part => ({
  id,
  name: `Part ${id}`,
  geometry: new BoxGeometry(10, 10, 10),
  position: [0, 0, 0],
  quaternion: [0, 0, 0, 1],
  scale: [1, 1, 1],
  color: '#aabbcc',
  visible: true,
  locked: false,
  source: 'test',
  ...patch,
});

const fixture = (): SceneDocument => ({
  name: 'Appearance',
  parts: [part('a'), part('b', { geometry: painted() }), part('c', { position: [30, 0, 0] })],
  joints: [],
  constraints: [],
});

const custom: SceneLighting = {
  ...presetLighting('dramatic'),
  exposure: 1.7,
  lights: [
    ...presetLighting('dramatic').lights,
    {
      id: 'bulb',
      name: 'Bulb',
      kind: 'point',
      color: '#ffcc88',
      intensity: 3,
      position: [10, 40, 10],
      range: 500,
      castShadow: false,
      enabled: true,
      camera: false,
    },
  ],
};

function memoryStorage() {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, String(value)),
    removeItem: (key: string) => void values.delete(key),
  });
  return values;
}

let storage: Map<string, string>;

beforeEach(() => {
  storage = memoryStorage();
  useEditor.setState(original, true);
  state().setScene(fixture());
  useEditor.setState({
    view: { ...original.view, partColors: 'editor' },
    defaultLighting: presetLighting('studio'),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  useEditor.setState(original, true);
});

describe('editor colors in the store', () => {
  it('sets a color on the given parts only, as one undo step that marks the scene modified', () => {
    const before = state().scene;
    const revision = state().revision;
    state().setDisplayColor(['a', 'b'], '#ff0000');
    expect(state().past).toEqual([before]);
    expect(state().past[0]).toBe(before);
    expect(state().revision).toBe(revision + 1);
    expect(state().revision).not.toBe(state().savedRevision);
    expect([find('a').displayColor, find('b').displayColor]).toEqual(['#ff0000', '#ff0000']);
    expect([find('a').color, find('b').color]).toEqual(['#aabbcc', '#aabbcc']);
    expect(find('b').geometry).toBe(before.parts[1].geometry);
    expect(find('c')).toBe(before.parts[2]);
    expect(before.parts.some((p) => 'displayColor' in p)).toBe(false);
  });

  it('records nothing when nothing would change', () => {
    state().setDisplayColor(['a'], '#ff0000');
    const after = state();
    state().setDisplayColor(['a'], '#ff0000');
    state().setDisplayColor(['c'], null);
    state().setDisplayColor(['missing'], '#00ff00');
    state().setDisplayColor([], '#00ff00');
    state().setDisplayColor(['missing', 'c'], null, false);
    expect(state().scene).toBe(after.scene);
    expect(state().past).toBe(after.past);
    expect(state().revision).toBe(after.revision);
  });

  it('treats an empty color as clearing, so it records nothing on parts without one', () => {
    const before = state();
    state().setDisplayColor(['a', 'c'], '');
    expect(state().scene).toBe(before.scene);
    expect(state().past).toHaveLength(0);
    state().setDisplayColor(['a'], '#123456');
    state().setDisplayColor(['a'], '');
    expect('displayColor' in find('a')).toBe(false);
  });

  it('clears by removing the field, and undo and redo restore each step', () => {
    state().setDisplayColor(['a', 'b'], '#ff0000');
    state().setDisplayColor(['a'], null);
    expect('displayColor' in find('a')).toBe(false);
    expect(find('b').displayColor).toBe('#ff0000');
    expect(state().past).toHaveLength(2);
    state().undo();
    expect(find('a').displayColor).toBe('#ff0000');
    state().undo();
    expect(state().scene.parts.some((p) => 'displayColor' in p)).toBe(false);
    state().redo();
    expect([find('a').displayColor, find('b').displayColor]).toEqual(['#ff0000', '#ff0000']);
    state().redo();
    expect('displayColor' in find('a')).toBe(false);
    expect(state().future).toHaveLength(0);
  });

  it('extends the last step for the rest of a drag', () => {
    state().setDisplayColor(['a'], '#111111');
    state().setDisplayColor(['a'], '#222222', false);
    state().setDisplayColor(['a'], '#333333', false);
    expect(find('a').displayColor).toBe('#333333');
    expect(state().past).toHaveLength(1);
    state().undo();
    expect('displayColor' in find('a')).toBe(false);
    state().redo();
    expect(find('a').displayColor).toBe('#333333');
  });

  it('switches from material colors to editor colors when a color is picked', () => {
    const mode = (partColors: 'material' | 'editor' | 'distinct') =>
      useEditor.setState((s) => ({ view: { ...s.view, partColors } }));
    mode('material');
    state().setDisplayColor(['a'], null);
    expect(state().view.partColors).toBe('material');
    state().setDisplayColor(['a'], '#123456');
    expect(state().view.partColors).toBe('editor');
    expect(storage.get('kitbasher.part-colors')).toBe('editor');
    mode('distinct');
    state().setDisplayColor(['b'], '#654321');
    expect(state().view.partColors).toBe('distinct');
    mode('material');
    state().setDisplayColor(['b'], null);
    expect(state().view.partColors).toBe('material');
  });

  it('remembers the part color mode', () => {
    state().setView({ partColors: 'distinct' });
    expect(state().view.partColors).toBe('distinct');
    expect(storage.get('kitbasher.part-colors')).toBe('distinct');
  });
});

describe('scene lighting in the store', () => {
  it('gives the scene its own lighting as one undo step', () => {
    const before = state().scene;
    state().setLighting(custom);
    expect(state().scene.lighting).toEqual(custom);
    expect(state().scene.lighting).not.toBe(custom);
    expect(state().past).toEqual([before]);
    expect(state().scene.parts).toBe(before.parts);
    expect(sceneLighting(state())).toBe(state().scene.lighting);
  });

  it('ignores lighting equal to what the scene has', () => {
    state().setLighting(custom);
    const after = state();
    state().setLighting(structuredClone(custom));
    state().setLighting(JSON.parse(JSON.stringify(custom)), false);
    expect(state().scene).toBe(after.scene);
    expect(state().past).toBe(after.past);
    expect(state().revision).toBe(after.revision);
  });

  it('returns to the default with null, and undo brings the scene’s lighting back', () => {
    const none = state();
    state().setLighting(null);
    expect(state().scene).toBe(none.scene);
    expect(state().past).toHaveLength(0);
    state().setLighting(custom);
    state().setLighting({ ...custom, exposure: 2 });
    state().setLighting(null);
    expect('lighting' in state().scene).toBe(false);
    expect(sceneLighting(state())).toBe(state().defaultLighting);
    state().undo();
    expect(state().scene.lighting).toEqual({ ...custom, exposure: 2 });
    state().undo();
    expect(state().scene.lighting).toEqual(custom);
    state().undo();
    expect('lighting' in state().scene).toBe(false);
    state().redo();
    state().redo();
    state().redo();
    expect('lighting' in state().scene).toBe(false);
  });

  it('extends the last step for the rest of a drag', () => {
    state().setLighting({ ...custom, exposure: 1.1 });
    state().setLighting({ ...custom, exposure: 1.2 }, false);
    state().setLighting({ ...custom, exposure: 1.3 }, false);
    expect(state().past).toHaveLength(1);
    expect(state().scene.lighting!.exposure).toBe(1.3);
    state().undo();
    expect('lighting' in state().scene).toBe(false);
  });

  it('repairs what it is given, filling gaps from the default lighting', () => {
    useEditor.setState({ defaultLighting: presetLighting('soft') });
    state().setLighting({
      ...custom,
      exposure: 99,
      sky: 'blue',
      lights: [...custom.lights, { ...custom.lights[0] }],
    });
    expect(state().scene.lighting).toEqual({
      ...custom,
      exposure: 4,
      sky: lightingPresets.soft.lighting.sky,
    });
  });

  it('changes the default only for scenes without lighting, without editing the scene', () => {
    const before = state();
    state().setDefaultLighting(presetLighting('headlight'));
    expect(state().defaultLighting).toEqual(lightingPresets.headlight.lighting);
    expect(sceneLighting(state())).toEqual(lightingPresets.headlight.lighting);
    expect(JSON.parse(storage.get('kitbasher.lighting')!)).toEqual(
      lightingPresets.headlight.lighting,
    );
    expect(state().scene).toBe(before.scene);
    expect(state().revision).toBe(before.revision);
    expect(state().past).toHaveLength(0);
    state().setLighting(custom);
    state().setDefaultLighting(presetLighting('soft'));
    expect(sceneLighting(state())).toEqual(custom);
    state().setDefaultLighting(null);
    expect(storage.has('kitbasher.lighting')).toBe(false);
    expect(state().defaultLighting).toEqual(lightingPresets.studio.lighting);
    expect(state().scene.lighting).toEqual(custom);
  });

  it('keeps a new default for the session when browser storage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    });
    state().setDefaultLighting(presetLighting('dramatic'));
    expect(state().defaultLighting).toEqual(lightingPresets.dramatic.lighting);
    state().setDefaultLighting({ ...custom, exposure: 50 });
    expect(state().defaultLighting).toEqual({ ...custom, exposure: 4 });
    state().setDefaultLighting(null);
    expect(state().defaultLighting).toEqual(lightingPresets.studio.lighting);
  });

  it('forgets the active light when another scene opens', () => {
    useEditor.setState({ activeLight: 'bulb' });
    state().setScene(fixture());
    expect(state().activeLight).toBeNull();
  });
});

/** Node has no FileReader, which three's GLB exporter reads its own output with. */
class NodeFileReader {
  result: ArrayBuffer | null = null;
  onloadend: (() => void) | null = null;
  readAsArrayBuffer(blob: Blob) {
    void blob.arrayBuffer().then((buffer) => {
      this.result = buffer;
      this.onloadend?.();
    });
  }
}

function glbJson(glb: ArrayBuffer) {
  const view = new DataView(glb);
  expect(view.getUint32(0, true)).toBe(0x46546c67);
  const length = view.getUint32(12, true);
  const text = new TextDecoder().decode(new Uint8Array(glb, 20, length));
  return { text, json: JSON.parse(text) };
}

describe('exports ignore editor colors', () => {
  const exportParts = () => [
    part('red', { color: '#ff0000', displayColor: '#00ff00' }),
    part('shaded', {
      geometry: painted(),
      color: '#808080',
      displayColor: '#0000ff',
      position: [20, 0, 0],
    }),
    part('mirrored', {
      geometry: painted(),
      color: '#123456',
      displayColor: '#fedcba',
      scale: [-1, 1, 2],
      position: [-20, 5, 0],
    }),
    part('plain', { color: '#abcdef', position: [0, 20, 0] }),
  ];
  const stripped = (parts: Part[]) => parts.map(({ displayColor: _, ...rest }) => rest as Part);
  const scene = (parts: Part[]): SceneDocument => ({
    name: 'Export',
    parts,
    joints: [],
    constraints: [],
    lighting: custom,
  });

  beforeEach(() => vi.stubGlobal('FileReader', NodeFileReader));

  it('bakes vertex colors from the material color', () => {
    for (const subject of exportParts()) {
      const baked = bakedPartGeometry(subject);
      const plain = bakedPartGeometry(stripped([subject])[0]);
      const colors = baked.getAttribute('color').array as Float32Array;
      expect(Array.from(colors)).toEqual(Array.from(plain.getAttribute('color').array));
      expect(Array.from(baked.getAttribute('position').array)).toEqual(
        Array.from(plain.getAttribute('position').array),
      );
      const tint = new Color(subject.color);
      const source = subject.geometry.toNonIndexed().getAttribute('color');
      const count = baked.getAttribute('position').count;
      for (let i = 0; i < count; i += 5) {
        // Mirrored parts swap two corners of every triangle, so compare where the color came from.
        const from = subject.scale[0] < 0 && i % 3 ? (i % 3 === 1 ? i + 1 : i - 1) : i;
        expect(colors[i * 3]).toBeCloseTo((source?.getX(from) ?? 1) * tint.r, 6);
        expect(colors[i * 3 + 1]).toBeCloseTo((source?.getY(from) ?? 1) * tint.g, 6);
        expect(colors[i * 3 + 2]).toBeCloseTo((source?.getZ(from) ?? 1) * tint.b, 6);
      }
    }
  });

  it('combines meshes with material colors', () => {
    const parts = exportParts();
    const combined = combineParts(parts);
    const plain = combineParts(stripped(parts));
    for (const name of ['position', 'normal', 'color'])
      expect(Array.from(combined.getAttribute(name).array)).toEqual(
        Array.from(plain.getAttribute(name).array),
      );
    const colors = combined.getAttribute('color');
    // The red part comes first: its editor color is green, its vertices stay red.
    for (let faceVertex = 0; faceVertex < 36; faceVertex++) {
      const i = combined.index!.getX(faceVertex);
      expect([colors.getX(i), colors.getY(i), colors.getZ(i)]).toEqual([1, 0, 0]);
    }
  });

  it('writes the same STL and 3MF with or without editor colors', () => {
    const parts = exportParts();
    expect(new Uint8Array(exportStl(parts))).toEqual(new Uint8Array(exportStl(stripped(parts))));
    const model = (data: Uint8Array) => strFromU8(unzipSync(data)['3D/3dmodel.model']);
    const withColors = model(export3mf(scene(parts), parts));
    expect(withColors).toBe(model(export3mf(scene(stripped(parts)), stripped(parts))));
    expect(withColors).not.toMatch(/00ff00|0000ff|fedcba|displayColor|lighting/i);
  });

  it('writes GLB materials from the material color, and leaves out editor-only data', async () => {
    const parts = exportParts();
    const glb = await exportGlb(scene(parts), parts);
    const plainScene = { ...scene(stripped(parts)) };
    delete plainScene.lighting;
    expect(new Uint8Array(glb)).toEqual(
      new Uint8Array(await exportGlb(plainScene, stripped(parts))),
    );
    const { text, json } = glbJson(glb);
    expect(text).not.toMatch(/displayColor|lighting|bulb/i);
    for (const subject of parts) {
      const node = json.nodes.find((n: { name: string }) => n.name === subject.name);
      const primitive = json.meshes[node.mesh].primitives[0];
      const factor = json.materials[primitive.material].pbrMetallicRoughness.baseColorFactor;
      const expected = new Color(subject.color);
      expect(factor[0]).toBeCloseTo(expected.r, 6);
      expect(factor[1]).toBeCloseTo(expected.g, 6);
      expect(factor[2]).toBeCloseTo(expected.b, 6);
      expect('COLOR_0' in primitive.attributes).toBe(
        subject.id !== 'red' && subject.id !== 'plain',
      );
    }
  });

  it('packages the same GLB for Blender', async () => {
    const parts = exportParts();
    const files = unzipSync(await exportBlenderPackage(scene(parts), parts));
    const plainScene = { ...scene(stripped(parts)) };
    delete plainScene.lighting;
    expect(files['assembly.glb']).toEqual(
      new Uint8Array(await exportGlb(plainScene, stripped(parts))),
    );
    expect(strFromU8(files['import_assembly.py'])).not.toMatch(/displayColor|lighting/);
  });

  it('merges into a part that keeps material colors and has no editor color', async () => {
    const parts = exportParts();
    const merged = mergedPart(combineParts(parts), 'Merged', 'Combined');
    expect('displayColor' in merged).toBe(false);
    expect(merged.color).toBe('#ffffff');
    const plain = combineParts(stripped(parts));
    expect(Array.from(merged.geometry.getAttribute('color').array)).toEqual(
      Array.from(plain.getAttribute('color').array),
    );
  });
});
