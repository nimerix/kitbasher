import { describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  SphereGeometry,
} from 'three';
import {
  parseScene,
  readSceneFile,
  sceneFileBlob,
  sceneSubset,
  validateLayout,
} from '../../src/core/scene-file';
import { presetLighting } from '../../src/core/lighting';
import { serializeScene } from '../helpers/legacy-scene';
import type {
  BinarySceneHeader,
  Joint,
  Part,
  PlaneConstraint,
  SceneDocument,
  SceneLighting,
  Vec3,
} from '../../src/core/types';

const part = (
  id: string,
  geometry: BufferGeometry = new BoxGeometry(10, 10, 10),
  position: Vec3 = [0, 0, 0],
): Part => ({
  id,
  name: id,
  geometry,
  position,
  quaternion: [0, 0, 0, 1],
  scale: [1, 1, 1],
  color: '#aabbcc',
  visible: true,
  locked: false,
  source: 'test',
});

const scene = (parts: Part[], extra: Partial<SceneDocument> = {}): SceneDocument => ({
  name: 'Format',
  parts,
  joints: [],
  ...extra,
});

const triangle = () =>
  new BufferGeometry().setAttribute(
    'position',
    new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
  );

async function open(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const headerLength = Number(view.getBigUint64(16, true));
  const header: BinarySceneHeader = JSON.parse(
    new TextDecoder().decode(bytes.subarray(24, 24 + headerLength)),
  );
  return { bytes, view, header, bodyStart: 24 + headerLength };
}

/** Rewrites a saved file's header to simulate a damaged or hostile file. */
async function tampered(
  change: (header: BinarySceneHeader) => void,
  source = sceneFileBlob(scene([part('a')])),
) {
  const { bytes, header, bodyStart } = await open(source);
  change(header);
  const encoded = new TextEncoder().encode(JSON.stringify(header));
  const prefix = bytes.slice(0, 24);
  new DataView(prefix.buffer).setBigUint64(16, BigInt(encoded.length), true);
  return new Blob([prefix, encoded, bytes.subarray(bodyStart)]);
}

describe('binary scene files', () => {
  it('restores meshes exactly along with every part and relationship', async () => {
    const indexed = new SphereGeometry(137.123, 16, 16).translate(1234.5678, -0.001, 88.8);
    const colored = new BoxGeometry(3, 4, 5).toNonIndexed();
    colored.setAttribute(
      'color',
      new BufferAttribute(
        new Float32Array(colored.getAttribute('position').count * 3).fill(0.25),
        3,
      ),
    );
    const joint: Joint = {
      id: 'joint',
      name: 'Neck',
      parentId: 'a',
      childId: 'b',
      parentAnchor: [1, 2, 3],
      childAnchor: [4, 5, 6],
      restRotation: [0, 0, 0, 1],
      rotationLocks: [true, false, true],
      keepConnected: false,
    };
    const constraint: PlaneConstraint = {
      id: 'mate',
      name: 'Mate',
      sourceId: 'b',
      targetId: 'a',
      sourcePlane: { point: [0, 0, 1], normal: [0, 0, 1] },
      targetPlane: { point: [0, 0, -1], normal: [0, 0, -1] },
      kind: 'mate',
      angle: 0,
      offset: 2.5,
      opposed: true,
      enabled: false,
    };
    const original = scene(
      [
        {
          ...part('a', indexed, [1.5, -2.5, 3]),
          name: 'Tête · 頭',
          pivot: [1, 1, 1],
          locked: true,
        },
        { ...part('b', colored), scale: [-2, 1, 0.5], visible: false, color: '#123456' },
      ],
      { name: 'Scène 🤖', joints: [joint], constraints: [constraint] },
    );
    const restored = await readSceneFile(sceneFileBlob(original));
    expect(restored.name).toBe('Scène 🤖');
    expect(restored.joints).toEqual([joint]);
    expect(restored.constraints).toEqual([constraint]);
    original.parts.forEach((source, i) => {
      const { geometry, ...fields } = restored.parts[i];
      const { geometry: sourceGeometry, ...expected } = source;
      expect(fields).toEqual(expected);
      for (const name of ['position', 'normal', 'color'] as const)
        expect(geometry.getAttribute(name)?.array).toEqual(
          sourceGeometry.getAttribute(name)?.array,
        );
      expect(geometry.index?.array).toEqual(sourceGeometry.index?.array);
    });
  });

  it('writes the documented layout with aligned, contiguous sections', async () => {
    const geometry = triangle().setIndex(new BufferAttribute(new Uint16Array([0, 1, 2]), 1));
    const { bytes, view, header, bodyStart } = await open(
      sceneFileBlob(scene([part('a', geometry), part('b', triangle())])),
    );
    expect(new TextDecoder().decode(bytes.subarray(0, 7))).toBe('KITBASH');
    expect(view.getUint32(8, true)).toBe(2);
    expect(bodyStart % 4).toBe(0);
    const [first, second] = header.geometries;
    expect(first.positions).toEqual({ offset: 0, length: 36 });
    // Three 16-bit indices leave two bytes of padding before the next section.
    expect(first.indices).toEqual({ offset: 36, length: 6, type: 'u16' });
    expect(second.positions.offset).toBe(44);
    expect(header.bodyLength).toBe(80);
    expect(bytes.length).toBe(bodyStart + 80);
    expect(header.parts[0].geometry).toBe(0);
  });

  it('stores a shared mesh once and keeps it shared after reopening', async () => {
    const shared = new BoxGeometry(10, 10, 10);
    const single = sceneFileBlob(scene([part('a', shared)]));
    const copies = sceneFileBlob(scene(['a', 'b', 'c', 'd'].map((id) => part(id, shared))));
    expect((await open(copies)).header.geometries).toHaveLength(1);
    expect(copies.size - single.size).toBeLessThan(2000);
    const restored = await readSceneFile(copies);
    expect(new Set(restored.parts.map((p) => p.geometry)).size).toBe(1);
  });

  it('only writes the meshes of the parts it is given', async () => {
    const included = part('a');
    const subset = sceneSubset(scene([included, part('b', new SphereGeometry(5))]), [included]);
    const { header } = await open(sceneFileBlob(subset));
    expect(header.parts.map((p) => p.id)).toEqual(['a']);
    expect(header.geometries).toHaveLength(1);
  });

  it('handles 8-bit indices and interleaved attributes', async () => {
    const buffer = new InterleavedBuffer(new Float32Array([0, 0, 0, 9, 1, 0, 0, 9, 0, 1, 0, 9]), 4);
    const geometry = new BufferGeometry()
      .setAttribute('position', new InterleavedBufferAttribute(buffer, 3, 0))
      .setIndex(new BufferAttribute(new Uint8Array([0, 1, 2]), 1));
    const blob = sceneFileBlob(scene([part('a', geometry)]));
    expect((await open(blob)).header.geometries[0].indices!.type).toBe('u32');
    const restored = (await readSceneFile(blob)).parts[0].geometry;
    expect(Array.from(restored.getAttribute('position').array)).toEqual([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
    ]);
    expect(Array.from(restored.index!.array)).toEqual([0, 1, 2]);
  });

  it('computes normals for meshes saved without them', async () => {
    const restored = await readSceneFile(sceneFileBlob(scene([part('a', triangle())])));
    expect(Array.from(restored.parts[0].geometry.getAttribute('normal').array).slice(0, 3)).toEqual(
      [0, 0, 1],
    );
  });

  it('opens an empty scene', async () => {
    expect((await readSceneFile(sceneFileBlob(scene([])))).parts).toEqual([]);
  });

  it('reports read progress up to completion', async () => {
    const progress: number[] = [];
    await readSceneFile(
      sceneFileBlob(scene([part('a'), part('b', new SphereGeometry(5))])),
      (fraction) => progress.push(fraction),
    );
    expect(progress.length).toBeGreaterThan(3);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    // Padding between sections is not read, so completion can be just under one.
    expect(progress.at(-1)).toBeGreaterThan(0.99);
  });

  it('splits buffers into chunks without changing the data', async () => {
    const vertices = 6_000_000; // 72 MB per attribute, past the 64 MiB chunk size.
    const positions = new Float32Array(vertices * 3),
      normals = new Float32Array(vertices * 3);
    for (let i = 0; i < positions.length; i++) {
      positions[i] = i * 0.001;
      normals[i] = i % 3 === 2 ? 1 : 0;
    }
    const geometry = new BufferGeometry()
      .setAttribute('position', new BufferAttribute(positions, 3))
      .setAttribute('normal', new BufferAttribute(normals, 3));
    const blob = sceneFileBlob(scene([part('a', geometry)]));
    const progress: number[] = [];
    const restored = await readSceneFile(blob, (fraction) => progress.push(fraction));
    const same = (a: ArrayLike<number>, b: ArrayLike<number>) => {
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return a.length === b.length;
    };
    const { geometry: result } = restored.parts[0];
    expect(same(result.getAttribute('position').array, positions)).toBe(true);
    expect(same(result.getAttribute('normal').array, normals)).toBe(true);
    // Each attribute reads in two chunks, so progress moves within a mesh.
    expect(progress).toHaveLength(4);
    expect(progress.at(-1)).toBe(1);
  });

  it('supports offsets beyond 32 bits', () => {
    const vertices = 2 ** 31;
    expect(
      validateLayout(
        { vertices, positions: { offset: 2 ** 33, length: vertices * 12 } },
        2 ** 33,
        2 ** 36,
      ),
    ).toBe(2 ** 33 + vertices * 12);
  });
});

describe('files from earlier versions', () => {
  it('still opens JSON scene files', async () => {
    const source = scene([part('a', new BoxGeometry(2, 2, 2), [4, 5, 6])]);
    const restored = await readSceneFile(new Blob([JSON.stringify(serializeScene(source))]));
    expect(restored.parts[0].position).toEqual([4, 5, 6]);
    expect(restored.parts[0].geometry.getAttribute('position').array).toEqual(
      source.parts[0].geometry.getAttribute('position').array,
    );
  });

  it('rejects files that are not scenes', async () => {
    await expect(readSceneFile(new Blob([]))).rejects.toThrow('could not be read');
    await expect(readSceneFile(new Blob(['not json']))).rejects.toThrow('could not be read');
    await expect(readSceneFile(new Blob(['{"format":"other"}']))).rejects.toThrow(
      'not a supported',
    );
  });
});

describe('damaged scene files', () => {
  const source = () => sceneFileBlob(scene([part('a')]));

  it('reports truncated downloads and extra data', async () => {
    const blob = source();
    for (const cut of [blob.size - 1, Math.floor(blob.size / 2), 100, 24, 12])
      await expect(readSceneFile(blob.slice(0, cut))).rejects.toThrow('incomplete or damaged');
    await expect(readSceneFile(new Blob([blob, new Uint8Array(4)]))).rejects.toThrow(
      'incomplete or damaged',
    );
  });

  it('asks for a newer version of the app for newer files', async () => {
    const { bytes } = await open(source());
    new DataView(bytes.buffer).setUint32(8, 3, true);
    await expect(readSceneFile(new Blob([bytes]))).rejects.toThrow('newer version');
  });

  it('rejects a header that is not JSON', async () => {
    const { bytes } = await open(source());
    bytes[24] = 0x3f;
    await expect(readSceneFile(new Blob([bytes]))).rejects.toThrow('could not be read');
  });

  it.each([
    [
      'a section past the end of the file',
      (h: BinarySceneHeader) => {
        h.geometries[0].normals!.offset = h.bodyLength;
      },
    ],
    [
      'overlapping sections',
      (h: BinarySceneHeader) => {
        h.geometries[0].normals!.offset = 0;
      },
    ],
    [
      'the wrong vector length',
      (h: BinarySceneHeader) => {
        h.geometries[0].normals!.length -= 12;
      },
    ],
    [
      'a fractional vertex count',
      (h: BinarySceneHeader) => {
        h.geometries[0].vertices += 0.5;
      },
    ],
    [
      'too few vertices',
      (h: BinarySceneHeader) => {
        h.geometries[0].vertices = 2;
      },
    ],
    [
      'an unknown index type',
      (h: BinarySceneHeader) => {
        (h.geometries[0].indices as { type: string }).type = 'u64';
      },
    ],
    [
      'a misaligned index section',
      (h: BinarySceneHeader) => {
        h.geometries[0].indices!.length -= 1;
      },
    ],
    [
      'a negative section',
      (h: BinarySceneHeader) => {
        h.geometries[0].indices!.length = -2;
      },
    ],
  ])('rejects %s before reading any mesh', async (_name, change) => {
    await expect(readSceneFile(await tampered(change))).rejects.toThrow('invalid mesh data');
  });

  it('rejects two meshes that read the same bytes', async () => {
    const blob = sceneFileBlob(scene([part('a'), part('b', new BoxGeometry(1, 1, 1))]));
    await expect(
      readSceneFile(
        await tampered((h) => {
          h.geometries[1] = h.geometries[0];
        }, blob),
      ),
    ).rejects.toThrow('invalid mesh data');
  });

  it.each([
    ['a missing mesh', 5],
    ['a fractional mesh', 0.5],
    ['a named mesh', 'constructor'],
  ])('rejects a part that refers to %s', async (_name, reference) => {
    await expect(
      readSceneFile(
        await tampered((h) => {
          (h.parts[0] as { geometry: unknown }).geometry = reference;
        }),
      ),
    ).rejects.toThrow('invalid part');
  });

  it('rejects invalid values inside the mesh data', async () => {
    const { bytes, header, bodyStart } = await open(source());
    const damaged = bytes.slice();
    new DataView(damaged.buffer).setFloat32(
      bodyStart + header.geometries[0].positions.offset,
      NaN,
      true,
    );
    await expect(readSceneFile(new Blob([damaged]))).rejects.toThrow('invalid vertex positions');
    const badIndex = bytes.slice();
    new DataView(badIndex.buffer).setUint16(
      bodyStart + header.geometries[0].indices!.offset,
      65000,
      true,
    );
    await expect(readSceneFile(new Blob([badIndex]))).rejects.toThrow('invalid triangle indices');
  });

  it('applies the same relationship checks as JSON scenes', async () => {
    const blob = await tampered((h) => {
      h.constraints = [
        {
          id: 'x',
          name: 'X',
          sourceId: 'a',
          targetId: 'missing',
          sourcePlane: { point: [0, 0, 0], normal: [0, 0, 1] },
          targetPlane: { point: [0, 0, 0], normal: [0, 0, 1] },
          kind: 'mate',
          angle: 0,
          offset: 0,
          opposed: true,
          enabled: true,
        },
      ];
    });
    await expect(readSceneFile(blob)).rejects.toThrow('existing parts');
  });
});

describe('editor colors and lighting in scene files', () => {
  const lighting: SceneLighting = {
    exposure: 1.85,
    ambient: 0,
    hemisphere: 0.35,
    sky: '#DFE6F0',
    ground: '#6f665c',
    shadows: false,
    lights: [
      {
        id: 'key',
        name: 'Key · 鍵',
        kind: 'directional',
        color: '#ffe6c7',
        intensity: 3.6,
        position: [140.125, -110, 1e-7],
        range: 0,
        castShadow: true,
        enabled: false,
        camera: false,
      },
      {
        id: 'head',
        name: '',
        kind: 'point',
        color: '#ffffff',
        intensity: 0,
        position: [0, 0, 0],
        range: 1234.5,
        castShadow: false,
        enabled: true,
        camera: true,
      },
    ],
  };
  const colored = () =>
    scene(
      [
        { ...part('a'), displayColor: '#FF00aa' },
        part('b'),
        { ...part('c', new BoxGeometry(1, 2, 3)), displayColor: '#010203', color: '#ffffff' },
      ],
      { lighting },
    );

  it('restores editor colors and lighting exactly from a binary file', async () => {
    const original = colored();
    const restored = await readSceneFile(sceneFileBlob(original));
    expect(restored.lighting).toEqual(lighting);
    expect(restored.parts.map((p) => p.displayColor)).toEqual(['#FF00aa', undefined, '#010203']);
    expect('displayColor' in restored.parts[1]).toBe(false);
    expect(restored.parts.map((p) => p.color)).toEqual(['#aabbcc', '#aabbcc', '#ffffff']);
    // Saving what was opened writes the same file.
    expect(new Uint8Array(await sceneFileBlob(restored).arrayBuffer())).toEqual(
      new Uint8Array(await sceneFileBlob(original).arrayBuffer()),
    );
  });

  it('writes no lighting for a scene without its own', async () => {
    const plain = scene([part('a')]);
    const { header } = await open(sceneFileBlob(plain));
    expect('lighting' in header).toBe(false);
    expect('displayColor' in header.parts[0]).toBe(false);
    const restored = await readSceneFile(sceneFileBlob(plain));
    expect('lighting' in restored).toBe(false);
    expect('lighting' in (await readSceneFile(sceneFileBlob(restored)))).toBe(false);
    const { header: lit } = await open(sceneFileBlob(colored()));
    expect(lit.lighting).toEqual(lighting);
    expect(lit.parts[0].displayColor).toBe('#FF00aa');
  });

  it('opens JSON scenes from before editor colors and lighting', async () => {
    const legacy = serializeScene(scene([part('a')]));
    expect(Object.keys(legacy)).not.toContain('lighting');
    const restored = await readSceneFile(new Blob([JSON.stringify(legacy)]));
    expect('lighting' in restored).toBe(false);
    expect('displayColor' in restored.parts[0]).toBe(false);
    const withExtras = { ...serializeScene(colored()), lighting };
    const opened = parseScene(JSON.parse(JSON.stringify(withExtras)));
    expect(opened.lighting).toEqual(lighting);
    expect(opened.parts[0].displayColor).toBe('#FF00aa');
  });

  it.each([
    ['a color name', 'red'],
    ['a short hex color', '#abc'],
    ['a color with alpha', '#aabbccdd'],
    ['a color without #', 'aabbcc'],
    ['a number', 0xaabbcc],
    ['null', null],
    ['an empty string', ''],
    ['an object', { r: 1 }],
  ])('drops an editor color that is %s and keeps the part', async (_name, value) => {
    const blob = await tampered((h) => {
      (h.parts[0] as Record<string, unknown>).displayColor = value;
    });
    const restored = await readSceneFile(blob);
    expect(restored.parts).toHaveLength(1);
    expect('displayColor' in restored.parts[0]).toBe(false);
    expect(restored.parts[0].color).toBe('#aabbcc');
  });

  it.each([
    ['null', null],
    ['false', false],
    ['zero', 0],
    ['a number', 7],
    ['a string', 'studio'],
    ['an empty string', ''],
    ['an array', []],
    ['an array of lights', [lighting.lights[0]]],
  ])('treats lighting that is %s as absent', async (_name, value) => {
    const blob = await tampered((h) => {
      (h as unknown as Record<string, unknown>).lighting = value;
    });
    const restored = await readSceneFile(blob);
    expect('lighting' in restored).toBe(false);
    expect(restored.parts).toHaveLength(1);
  });

  it('repairs partly invalid lighting rather than refusing the scene', async () => {
    const blob = await tampered((h) => {
      (h as unknown as Record<string, unknown>).lighting = {
        ...lighting,
        exposure: 400,
        ambient: 'bright',
        sky: 'blue',
        lights: [
          { ...lighting.lights[0], intensity: -1 },
          { ...lighting.lights[1], id: 'key' },
          { ...lighting.lights[1], id: 'zero', kind: 'directional', position: [0, 0, 0] },
          { id: 'spot', kind: 'spot', position: [1, 2, 3] },
          { ...lighting.lights[1], id: 'bulb', color: 'white', range: -3 },
        ],
      };
    });
    const studio = presetLighting('studio');
    expect((await readSceneFile(blob)).lighting).toEqual({
      ...lighting,
      exposure: 4,
      ambient: studio.ambient,
      sky: studio.sky,
      lights: [
        { ...lighting.lights[0], intensity: 0 },
        { ...lighting.lights[1], id: 'bulb', color: '#ffffff', range: 0 },
      ],
    });
  });

  it('keeps lighting and editor colors in a saved selection', async () => {
    const source = colored();
    const subset = sceneSubset(source, [source.parts[2]]);
    expect(subset.lighting).toBe(lighting);
    const restored = await readSceneFile(sceneFileBlob(subset));
    expect(restored.lighting).toEqual(lighting);
    expect(restored.parts[0].displayColor).toBe('#010203');
  });
});
