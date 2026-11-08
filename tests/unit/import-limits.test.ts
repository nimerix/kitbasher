import { afterEach, describe, expect, it, vi } from 'vitest';
import { BufferAttribute, BufferGeometry, Sphere, Vector3 } from 'three';
import { strToU8, zipSync } from 'fflate';
import { export3mf, exportGlb, importModels } from '../../src/core/files';
import { exceedsDrawLimit, maxBufferBytes } from '../../src/core/geometry';
import { blobParts } from '../../src/core/scene-file';
import { useEditor } from '../../src/core/store';
import type { Part, SceneDocument } from '../../src/core/types';

const options = { units: 'mm', up: 'y', center: false } as const;

function oneTriangleStl(faces = 1) {
  const data = new ArrayBuffer(84 + 50);
  const view = new DataView(data);
  view.setUint32(80, faces, true);
  [1000, 0, 0, 1002, 0, 0, 1000, 4, 0].forEach((value, i) =>
    view.setFloat32(84 + 12 + i * 4, value, true),
  );
  return data;
}

const withSize = (file: File, size: number) => {
  Object.defineProperty(file, 'size', { value: size });
  return file;
};

afterEach(() => vi.unstubAllGlobals());

describe('import limits', () => {
  it('refuses a mesh past the GPU buffer limit without allocating it', async () => {
    const faces = 64_000_000;
    const huge = withSize(new File([oneTriangleStl(faces)], 'huge.stl'), 84 + faces * 50);
    await expect(importModels([huge], options)).rejects.toThrow(
      'huge.stl is too large for a browser to draw',
    );
  });

  it('accepts the largest mesh a buffer can hold, up to allocating it', async () => {
    const faces = Math.floor(maxBufferBytes / 36);
    vi.stubGlobal(
      'Float32Array',
      class {
        constructor() {
          throw new RangeError('Array buffer allocation failed');
        }
      },
    );
    const largest = withSize(new File([oneTriangleStl(faces)], 'largest.stl'), 84 + faces * 50);
    await expect(importModels([largest], options)).rejects.toThrow(
      'not enough memory to import largest.stl',
    );
  });

  it('measures every buffer against the draw limit', () => {
    const over = { byteLength: maxBufferBytes + 1 };
    const fine = new BufferGeometry();
    fine.setAttribute('position', new BufferAttribute(new Float32Array(9), 3));
    expect(exceedsDrawLimit(fine)).toBe(false);

    const attribute = { array: over } as unknown as BufferAttribute;
    const large = new BufferGeometry();
    large.attributes.normal = attribute;
    expect(exceedsDrawLimit(large)).toBe(true);
    const index = new BufferGeometry();
    index.index = attribute;
    expect(exceedsDrawLimit(index)).toBe(true);
  });

  it('explains a 3MF past the text limit without inflating it', async () => {
    const zip = zipSync({ '3D/3dmodel.model': strToU8('<model/>') });
    const view = new DataView(zip.buffer);
    let directory = zip.length - 4;
    while (view.getUint32(directory, true) !== 0x02014b50) directory--;
    view.setUint32(directory + 24, 0x7fffffff, true);
    await expect(importModels([new File([zip], 'huge.3mf')], options)).rejects.toThrow(
      'huge.3mf holds 2048 MB of model text',
    );
  });

  it('explains a text glTF past the text limit before reading it', async () => {
    const huge = withSize(new File(['{}'], 'huge.gltf'), 2 ** 30);
    await expect(importModels([huge], options)).rejects.toThrow(
      'huge.gltf is too large for a browser to read as text',
    );
  });

  it('still calls a truly unreadable file damaged', async () => {
    await expect(importModels([new File(['{'], 'bad.gltf')], options)).rejects.toThrow(
      'bad.gltf could not be read',
    );
  });
});

describe('rebasing imported meshes', () => {
  it('rejects coordinates that are not finite, in any axis', async () => {
    for (const vertex of ['nope 0 0', '0 nope 0', '0 0 nope', '1e999 0 0', '0 0 -1e999'])
      await expect(
        importModels([new File([`v ${vertex}\nv 1 0 0\nv 0 1 0\nf 1 2 3\n`], 'bad.obj')], options),
      ).rejects.toThrow('bad.obj contains invalid vertices');
  });

  it('records bounds matching the vertices, so the renderer need not scan them again', async () => {
    const [part] = await importModels([new File([oneTriangleStl()], 'offset.stl')], options);
    const { geometry } = part;
    const box = geometry.boundingBox!.clone();
    const sphere: Sphere = geometry.boundingSphere!.clone();
    expect(part.position).toEqual([1001, 2, 0]);
    expect(box.min.toArray()).toEqual([-1, -2, 0]);
    expect(box.max.toArray()).toEqual([1, 2, 0]);
    expect(sphere.center.toArray()).toEqual([0, 0, 0]);

    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    expect(box.equals(geometry.boundingBox!)).toBe(true);
    expect(sphere.radius).toBeCloseTo(geometry.boundingSphere!.radius);
    expect(
      new Vector3()
        .fromBufferAttribute(geometry.getAttribute('position') as BufferAttribute, 0)
        .toArray(),
    ).toEqual([-1, -2, 0]);
  });

  it('leaves normals untouched', async () => {
    const data = oneTriangleStl();
    new DataView(data).setFloat32(84 + 8, 1, true);
    const [{ geometry }] = await importModels([new File([data], 'normal.stl')], options);
    expect(Array.from(geometry.getAttribute('normal').array).slice(0, 3)).toEqual([0, 0, 1]);
  });
});

const sized = (vertices: number): BufferGeometry => {
  const geometry = new BufferGeometry();
  geometry.attributes.position = {
    count: vertices,
    itemSize: 3,
    array: { BYTES_PER_ELEMENT: 4 },
  } as unknown as BufferAttribute;
  return geometry;
};
const partOf = (geometry: BufferGeometry, id = 'part') =>
  ({
    id,
    name: id,
    geometry,
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    color: '#ffffff',
    visible: true,
    locked: false,
    source: 'test',
  }) as Part;
const scene = (parts: Part[]) =>
  ({ name: 'Scene', parts, joints: [], constraints: [] }) as unknown as SceneDocument;

describe('export limits', () => {
  // 12 bytes per vertex, so this is just past the 2 GiB the exporter can read back.
  const pastGlbLimit = Math.ceil(2 ** 31 / 12);

  it('refuses a GLB the exporter would wait on forever', async () => {
    const parts = [partOf(sized(pastGlbLimit))];
    await expect(exportGlb(scene(parts), parts)).rejects.toThrow('too large to export as GLB');
  });

  it('counts a mesh shared by several parts once, as the exporter writes it', async () => {
    const half = sized(Math.floor(pastGlbLimit / 2) + 1);
    const shared = [partOf(half, 'a'), partOf(half, 'b')];
    const separate = [partOf(half, 'a'), partOf(sized(half.getAttribute('position').count), 'b')];
    await expect(exportGlb(scene(separate), separate)).rejects.toThrow('too large');
    // Reaches the exporter, which then fails on a mesh that is only pretending to be this large.
    await expect(exportGlb(scene(shared), shared)).rejects.not.toThrow('too large');
  });

  it('refuses a 3MF immediately when its text cannot fit', () => {
    const parts = [partOf(sized(30_000_000))];
    expect(() => export3mf(scene(parts), parts)).toThrow(RangeError);
  });

  it('splits downloads into pieces the browser accepts', () => {
    const data = new Uint8Array(130 * 2 ** 20);
    data[64 * 2 ** 20] = 7;
    const parts = blobParts(data);
    expect(parts.map((part) => part.length / 2 ** 20)).toEqual([64, 64, 2]);
    expect(parts[1][0]).toBe(7);
  });
});

describe('contact paint limit', () => {
  it('explains that a dense mesh cannot be painted instead of freezing', () => {
    const notify = vi.fn();
    const pair = { id: 'pair', source: null, target: null };
    const part = partOf(sized(30_000_003));
    useEditor.setState({
      tool: 'align',
      notify,
      scene: scene([part]),
      operation: {
        ...useEditor.getState().operation,
        mode: 'surface',
        sourceId: part.id,
        surfacePairs: [pair],
        activeSurface: { pairId: 'pair', side: 'source' },
      },
    } as never);
    const hit = { partId: part.id, point: [0, 0, 0], normal: [0, 1, 0] } as never;
    expect(useEditor.getState().paintSurface(hit, 0, false, true)).toBe(false);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('too many triangles'), 'info');
  });
});
