import { describe, expect, it, vi } from 'vitest';
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  PlaneGeometry,
  SphereGeometry,
} from 'three';
import { MeshoptEncoder } from 'meshoptimizer/encoder';
import { strFromU8, unzipSync } from 'fflate';
import { export3mf, exportStl } from '../../src/core/files';
import { validatePacked } from '../../src/core/mesh-pack';
import {
  parseScene,
  readSceneFile,
  sceneFileBlob,
  sceneSubset,
  validateLayout,
} from '../../src/core/scene-file';
import { presetLighting } from '../../src/core/lighting';
import { binarySceneFile, rawSceneFile, serializeScene } from '../helpers/legacy-scene';
import type {
  BinarySceneHeader,
  Joint,
  Part,
  PlaneConstraint,
  RawSceneHeader,
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

const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const values = (geometry: BufferGeometry, name: string) =>
  geometry.getAttribute(name).array as Float32Array;

const setValues = (geometry: BufferGeometry, name: string, array: Float32Array) =>
  geometry.setAttribute(name, new BufferAttribute(array, 3));

/** A sphere as an STL holds it: separate triangles, each with one normal of its own. */
function scan(segments = 24) {
  const geometry = new SphereGeometry(20, segments, (segments * 2) / 3).toNonIndexed();
  geometry.deleteAttribute('normal');
  geometry.deleteAttribute('uv');
  geometry.computeVertexNormals();
  return geometry;
}

/** The furthest any vector moved, for normals that may be computed again instead of stored. */
function drift(a: ArrayLike<number>, b: ArrayLike<number>) {
  let most = a.length === b.length ? 0 : Infinity;
  for (let i = 0; i < a.length; i += 3)
    most = Math.max(most, Math.hypot(a[i] - b[i], a[i + 1] - b[i + 1], a[i + 2] - b[i + 2]));
  return most;
}

const same = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return a.length === b.length;
};

const total = (blocks: [number, number][]) => blocks.reduce((sum, [count]) => sum + count, 0);

async function open<Header = BinarySceneHeader>(source: Blob | Promise<Blob>) {
  const bytes = new Uint8Array(await (await source).arrayBuffer());
  const view = new DataView(bytes.buffer);
  const headerLength = Number(view.getBigUint64(16, true));
  const header: Header = JSON.parse(
    new TextDecoder().decode(bytes.subarray(24, 24 + headerLength)),
  );
  return { bytes, view, header, bodyStart: 24 + headerLength };
}

/** Rewrites a saved file's header to simulate a damaged or hostile file. */
async function tampered<Header = BinarySceneHeader>(
  change: (header: Header) => void,
  source: Blob | Promise<Blob> = sceneFileBlob(scene([part('a')])),
) {
  const { bytes, view, header, bodyStart } = await open<Header>(source);
  change(header);
  return binarySceneFile(view.getUint32(8, true), header as object, [bytes.subarray(bodyStart)]);
}

const reopened = async (geometry: BufferGeometry) => {
  const blob = await sceneFileBlob(scene([part('a', geometry)]));
  return {
    layout: (await open(blob)).header.geometries[0],
    geometry: (await readSceneFile(blob)).parts[0].geometry,
    size: blob.size,
  };
};

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
    const restored = await readSceneFile(await sceneFileBlob(original));
    expect(restored.name).toBe('Scène 🤖');
    expect(restored.joints).toEqual([joint]);
    expect(restored.constraints).toEqual([constraint]);
    original.parts.forEach((source, i) => {
      const { geometry, ...fields } = restored.parts[i];
      const { geometry: sourceGeometry, ...expected } = source;
      expect(fields).toEqual(expected);
      for (const name of ['position', 'color'] as const)
        expect(geometry.getAttribute(name)?.array).toEqual(
          sourceGeometry.getAttribute(name)?.array,
        );
      expect(geometry.index?.array).toEqual(sourceGeometry.index?.array);
      sourceGeometry.computeBoundingSphere();
      expect(geometry.boundingSphere).toEqual(sourceGeometry.boundingSphere);
      // Normals the triangles already give are computed again, so they match without being stored.
      expect(drift(values(geometry, 'normal'), values(sourceGeometry, 'normal'))).toBeLessThan(
        1e-3,
      );
    });
    // A sphere's normals point away from its center, which its triangles alone do not give.
    expect(values(restored.parts[0].geometry, 'normal')).toEqual(values(indexed, 'normal'));
  });

  it('writes the documented layout, each mesh after the last', async () => {
    const indexed = triangle().setIndex(new BufferAttribute(new Uint16Array([0, 1, 2]), 1));
    const { bytes, view, header, bodyStart } = await open(
      sceneFileBlob(scene([part('a', indexed), part('b', triangle())])),
    );
    expect(new TextDecoder().decode(bytes.subarray(0, 7))).toBe('KITBASH');
    expect(bytes[7]).toBe(0x1a);
    expect(view.getUint32(8, true)).toBe(3);
    expect(header.version).toBe(3);
    expect(bodyStart % 4).toBe(0);
    const [first, second] = header.geometries;
    // Three positions that all differ are written as they are, 12 bytes each.
    expect(first).toEqual({
      offset: 0,
      length: 42,
      vertices: 3,
      positions: { blocks: [[3, 36]] },
      indices: { type: 'u16', blocks: [[3, 6]] },
    });
    expect(second).toEqual({
      offset: 42,
      length: 36,
      vertices: 3,
      positions: { blocks: [[3, 36]] },
    });
    expect(new Uint16Array(bytes.slice(bodyStart + 36, bodyStart + 42).buffer)).toEqual(
      indexed.index!.array,
    );
    expect(new Float32Array(bytes.slice(bodyStart, bodyStart + 36).buffer)).toEqual(
      indexed.getAttribute('position').array,
    );
    expect(header.bodyLength).toBe(first.length + second.length);
    expect(bytes.length).toBe(bodyStart + header.bodyLength);
    expect(header.parts[0].geometry).toBe(0);
  });

  it('stores a shared mesh once and keeps it shared after reopening', async () => {
    const shared = new BoxGeometry(10, 10, 10);
    const single = await sceneFileBlob(scene([part('a', shared)]));
    const copies = await sceneFileBlob(scene(['a', 'b', 'c', 'd'].map((id) => part(id, shared))));
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
    const blob = await sceneFileBlob(scene([part('a', geometry)]));
    expect((await open(blob)).header.geometries[0].indices!.type).toBe('u32');
    const restored = (await readSceneFile(blob)).parts[0].geometry;
    expect(Array.from(restored.getAttribute('position').array)).toEqual([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
    ]);
    expect(Array.from(restored.index!.array)).toEqual([0, 1, 2]);
  });

  it('computes normals for meshes saved without them', async () => {
    const restored = await readSceneFile(await sceneFileBlob(scene([part('a', triangle())])));
    expect(Array.from(restored.parts[0].geometry.getAttribute('normal').array).slice(0, 3)).toEqual(
      [0, 0, 1],
    );
  });

  it('opens an empty scene', async () => {
    expect((await readSceneFile(await sceneFileBlob(scene([])))).parts).toEqual([]);
  });

  it('reports read progress up to completion', async () => {
    const progress: number[] = [];
    await readSceneFile(
      await sceneFileBlob(scene([part('a'), part('b', new SphereGeometry(5))])),
      (fraction) => progress.push(fraction),
    );
    expect(progress.length).toBeGreaterThan(3);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress[0]).toBeGreaterThan(0);
    expect(progress.at(-1)).toBe(1);
  });

  it('splits large meshes into blocks without changing the data', async () => {
    const random = seeded(7);
    const vertices = 3_600_000,
      distinct = 1_500_000;
    const points = new Float32Array(distinct * 3);
    for (let i = 0; i < points.length; i++) points[i] = random() * 200 - 100;
    const positions = new Float32Array(vertices * 3),
      normals = new Float32Array(vertices * 3),
      colors = new Float32Array(vertices * 3);
    for (let i = 0; i < vertices; i++) {
      const from = (i < distinct ? i : Math.floor(random() * distinct)) * 3;
      for (let axis = 0; axis < 3; axis++) positions[i * 3 + axis] = points[from + axis];
    }
    for (let face = 0; face < vertices / 3; face++) {
      const z = random() * 2 - 1,
        angle = random() * Math.PI * 2,
        radius = Math.sqrt(1 - z * z);
      for (let corner = 0; corner < 3; corner++)
        normals.set([radius * Math.cos(angle), radius * Math.sin(angle), z], face * 9 + corner * 3);
    }
    for (let i = 0; i < colors.length; i++) colors[i] = random();
    const geometry = new BufferGeometry();
    setValues(geometry, 'position', positions);
    setValues(geometry, 'normal', normals);
    setValues(geometry, 'color', colors);
    const result = await reopened(geometry);
    expect(result.layout.positions.blocks.map(([count]) => count)).toEqual([
      2 ** 20,
      distinct - 2 ** 20,
    ]);
    expect(result.layout.positions.map!.map(([count]) => count)).toEqual([
      3 * 2 ** 20,
      vertices - 3 * 2 ** 20,
    ]);
    expect(result.layout.normals).toMatchObject({ per: 'face' });
    expect(result.layout.normals!.blocks).toHaveLength(2);
    // Every vertex has a color of its own, so the colors are not compressed.
    expect(result.layout.colors).toEqual({
      per: 'vertex',
      blocks: [2 ** 20, 2 ** 20, 2 ** 20, vertices - 3 * 2 ** 20].map((count) => [
        count,
        count * 12,
      ]),
    });
    expect(same(values(result.geometry, 'position'), positions)).toBe(true);
    expect(same(values(result.geometry, 'normal'), normals)).toBe(true);
    expect(same(values(result.geometry, 'color'), colors)).toBe(true);
  });

  it('supports offsets beyond 32 bits', () => {
    expect(
      validatePacked(
        { offset: 2 ** 33, length: 36, vertices: 3, positions: { blocks: [[3, 36]] } },
        2 ** 33,
        2 ** 36,
      ),
    ).toBe(2 ** 33 + 36);
  });
});

describe('packed meshes', () => {
  it('stores each position once and puts every vertex back in place', async () => {
    const box = new BoxGeometry(3, 4, 5).toNonIndexed();
    const { layout, geometry } = await reopened(box);
    expect(layout.vertices).toBe(36);
    expect(total(layout.positions.blocks)).toBe(8);
    expect(total(layout.positions.map!)).toBe(36);
    expect(geometry.index).toBeNull();
    expect(same(values(geometry, 'position'), values(box, 'position'))).toBe(true);
    // A mesh that shares its vertices already has nothing repeated, so its values are written
    // as they are rather than compressed.
    const smooth = new SphereGeometry(5, 12, 8);
    const sphere = await reopened(smooth);
    const { vertices } = sphere.layout;
    expect(sphere.layout.positions).toEqual({ blocks: [[vertices, vertices * 12]] });
    expect(sphere.layout.normals).toEqual({ per: 'vertex', blocks: [[vertices, vertices * 12]] });
    const corners = smooth.index!.count;
    expect(sphere.layout.indices).toEqual({ type: 'u16', blocks: [[corners, corners * 2]] });
    expect(same(values(sphere.geometry, 'position'), values(smooth, 'position'))).toBe(true);
    expect(same(values(sphere.geometry, 'normal'), values(smooth, 'normal'))).toBe(true);
  });

  it('keeps zero and negative zero apart', async () => {
    const zero = [0, 0, 0],
      negativeX = [-0, 0, 0],
      negativeY = [0, -0, 0];
    const positions = new Float32Array(
      [zero, negativeX, negativeY, zero, negativeX, negativeY, zero, negativeX, [1, 1, 1]].flat(),
    );
    const geometry = new BufferGeometry();
    setValues(geometry, 'position', positions);
    const result = await reopened(geometry);
    expect(total(result.layout.positions.blocks)).toBe(4);
    expect(same(values(result.geometry, 'position'), positions)).toBe(true);
  });

  it('takes a fraction of the space for a scan and leaves its shape untouched', async () => {
    const geometry = scan(96);
    const normals = values(geometry, 'normal');
    // Another program's rounding: its normals are close to the triangles' own, never equal.
    for (let face = 0; face < normals.length; face += 9)
      for (let corner = 0; corner < 9; corner += 3) normals[face + corner] += 2e-4;
    const color = new Float32Array(normals.length);
    for (let i = 0; i < color.length; i += 3) color.set([0.2, 0.4, 0.6], i);
    setValues(geometry, 'color', color);
    const result = await reopened(geometry);
    expect('normals' in result.layout).toBe(false);
    expect(result.layout.colors).toEqual({ per: 'mesh', blocks: [[1, expect.any(Number)]] });
    // Uncompressed, the positions, normals, and colors take 36 bytes for every vertex.
    expect(result.size).toBeLessThan((result.layout.vertices * 36) / 8);
    expect(same(values(result.geometry, 'position'), values(geometry, 'position'))).toBe(true);
    expect(same(values(result.geometry, 'color'), color)).toBe(true);
    const moved = drift(values(result.geometry, 'normal'), normals);
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThan(1e-3);
  });

  it('restores normals computed by three.js to the last bit', async () => {
    const random = seeded(3);
    const positions = new Float32Array(900 * 3);
    for (let i = 0; i < positions.length; i++) positions[i] = (random() - 0.5) * 4000;
    // A triangle without area, and a sliver, where a shortcut would show.
    positions.set([7, 7, 7, 7, 7, 7, 7, 7, 7], 0);
    positions.set([0, 0, 0, 1000, 0, 0, 2000, 1e-4, 0], 9);
    const soup = new BufferGeometry();
    setValues(soup, 'position', positions);
    soup.computeVertexNormals();
    // Past the few thousand vertices that are compared first.
    const indexed = new SphereGeometry(9, 80, 60);
    indexed.computeVertexNormals();
    // Triangles in no order, some naming one vertex twice, and a vertex that none of them use.
    const tangle = new BufferGeometry();
    setValues(tangle, 'position', positions.slice(0, 120 * 3));
    const corners = new Uint16Array(600);
    for (let i = 0; i < corners.length; i++) corners[i] = Math.floor(random() * 119);
    corners.set([5, 5, 9, 9, 40, 9, 7, 3, 3, 8, 8, 8], 0);
    tangle.setIndex(new BufferAttribute(corners, 1));
    tangle.computeVertexNormals();
    for (const geometry of [soup, indexed, tangle]) {
      const result = await reopened(geometry);
      expect('normals' in result.layout).toBe(false);
      expect(same(values(result.geometry, 'normal'), values(geometry, 'normal'))).toBe(true);
    }
  });

  it('stores normals that the triangles do not give, exactly', async () => {
    const flipped = scan();
    values(flipped, 'normal').forEach((value, i, array) => (array[i] = -value));
    const smooth = new SphereGeometry(20, 24, 16).toNonIndexed();
    const wall = new PlaneGeometry(4, 4).toNonIndexed();
    values(wall, 'normal').forEach((_, i, array) => (array[i] = i % 3 === 2 ? -1 : 0));
    const smoothIndexed = new SphereGeometry(20, 24, 16);
    for (const [geometry, per] of [
      [flipped, 'face'],
      [smooth, 'vertex'],
      [wall, 'mesh'],
      [smoothIndexed, 'vertex'],
    ] as const) {
      const result = await reopened(geometry);
      expect(result.layout.normals!.per).toBe(per);
      expect(same(values(result.geometry, 'normal'), values(geometry, 'normal'))).toBe(true);
    }
  });

  it('keeps normals that drift further than rounding would', async () => {
    // One triangle is enough, whether it is among the first compared or the very last.
    for (const last of [false, true]) {
      const geometry = scan(96);
      const normals = values(geometry, 'normal');
      const face = last ? normals.length - 9 : 0;
      for (let corner = face; corner < face + 9; corner += 3) normals[corner] += 2e-3;
      const result = await reopened(geometry);
      expect(result.layout.normals!.per).toBe('face');
      expect(same(values(result.geometry, 'normal'), normals)).toBe(true);
    }
    const smooth = new SphereGeometry(9, 80, 60);
    smooth.computeVertexNormals();
    const normals = values(smooth, 'normal');
    normals[normals.length - 1] += 2e-3;
    const result = await reopened(smooth);
    expect(result.layout.normals!.per).toBe('vertex');
    expect(same(values(result.geometry, 'normal'), normals)).toBe(true);
  });

  it('stores colors once per mesh, per triangle, or per vertex, exactly', async () => {
    const random = seeded(11);
    const colored = (indexed: boolean, per: 'mesh' | 'face' | 'vertex') => {
      const geometry = indexed ? new SphereGeometry(5, 12, 8) : scan();
      const colors = new Float32Array(geometry.getAttribute('position').count * 3);
      const repeat = { mesh: colors.length, face: 9, vertex: 3 }[per];
      for (let i = 0; i < colors.length; i += repeat) {
        const color = [random(), random(), random()];
        for (let at = i; at < i + repeat && at < colors.length; at += 3) colors.set(color, at);
      }
      return setValues(geometry, 'color', colors);
    };
    for (const [indexed, per, stored] of [
      [false, 'mesh', 'mesh'],
      [false, 'face', 'face'],
      [false, 'vertex', 'vertex'],
      [true, 'mesh', 'mesh'],
      // Triangles of an indexed mesh share vertices, so nothing is stored per triangle.
      [true, 'face', 'vertex'],
    ] as const) {
      const geometry = colored(indexed, per);
      const result = await reopened(geometry);
      expect(result.layout.colors!.per).toBe(stored);
      expect(same(values(result.geometry, 'color'), values(geometry, 'color'))).toBe(true);
    }
  });

  it('keeps 16-bit and 32-bit indices as they were', async () => {
    const small = new SphereGeometry(5, 12, 8);
    const wide = small
      .clone()
      .setIndex(new BufferAttribute(new Uint32Array(small.index!.array), 1));
    for (const geometry of [small, wide]) {
      const result = await reopened(geometry);
      expect(result.geometry.index!.array.constructor).toBe(geometry.index!.array.constructor);
      expect(result.geometry.index!.array).toEqual(geometry.index!.array);
    }
  });

  it('exports the same bytes for printing after reopening', async () => {
    const mirrored = scan();
    const normals = values(mirrored, 'normal');
    for (let i = 0; i < normals.length; i += 3) normals[i + 1] -= 3e-4;
    const original = scene([
      part('a', scan(), [10.5, 0, -3]),
      { ...part('b', mirrored), scale: [-1, 1.5, 1], quaternion: [0, 0.6, 0, 0.8] },
      part('c', new SphereGeometry(7, 20, 12)),
      part('d', new BoxGeometry(3, 4, 5)),
    ]);
    const restored = await readSceneFile(await sceneFileBlob(original));
    const { header } = await open(sceneFileBlob(original));
    // The first two meshes are saved without their normals, so this compares recomputed ones.
    expect(header.geometries.map((layout) => 'normals' in layout)).toEqual([
      false,
      false,
      true,
      false,
    ]);
    expect(new Uint8Array(exportStl(restored.parts))).toEqual(
      new Uint8Array(exportStl(original.parts)),
    );
    const model = (document: SceneDocument) =>
      strFromU8(unzipSync(export3mf(document, document.parts))['3D/3dmodel.model']);
    expect(model(restored)).toBe(model(original));
  });

  it('packs each mesh once, and never one that came from a file', async () => {
    const encode = vi.spyOn(MeshoptEncoder, 'encodeVertexBufferLevel');
    try {
      const original = scene([part('a', scan()), part('b', new SphereGeometry(5))]);
      const first = await sceneFileBlob(original);
      const packs = encode.mock.calls.length;
      expect(packs).toBeGreaterThan(0);
      const moved = scene(original.parts.map((p) => ({ ...p, position: [1, 2, 3] })));
      await sceneFileBlob(moved);
      // Two saves at once, as a manual save during an autosave, share the one packing.
      const fresh = scene([part('a', scan()), part('b', new SphereGeometry(5))]);
      encode.mockClear();
      const [one, other] = await Promise.all([sceneFileBlob(fresh), sceneFileBlob(fresh)]);
      expect(encode.mock.calls.length).toBe(packs);
      expect(new Uint8Array(await one.arrayBuffer())).toEqual(
        new Uint8Array(await other.arrayBuffer()),
      );
      encode.mockClear();
      const restored = await readSceneFile(first);
      const second = await sceneFileBlob(restored);
      expect(encode).not.toHaveBeenCalled();
      expect(new Uint8Array(await second.arrayBuffer())).toEqual(
        new Uint8Array(await first.arrayBuffer()),
      );
    } finally {
      encode.mockRestore();
    }
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

  it('still opens uncompressed binary files, and saves them packed', async () => {
    const shared = scan();
    values(shared, 'normal').forEach((value, i, array) => (array[i] = -value));
    const source = scene([
      part('a', shared, [4, 5, 6]),
      part('b', shared),
      part('c', new SphereGeometry(5, 12, 8)),
    ]);
    const old = rawSceneFile(source);
    expect((await open(old)).view.getUint32(8, true)).toBe(2);
    const restored = await readSceneFile(old);
    expect(restored.parts.map((p) => p.position)).toEqual([
      [4, 5, 6],
      [0, 0, 0],
      [0, 0, 0],
    ]);
    expect(restored.parts[0].geometry).toBe(restored.parts[1].geometry);
    source.parts.forEach(({ geometry }, i) => {
      for (const name of ['position', 'normal'] as const)
        expect(same(values(restored.parts[i].geometry, name), values(geometry, name))).toBe(true);
      expect(restored.parts[i].geometry.index?.array).toEqual(geometry.index?.array);
    });
    const saved = await sceneFileBlob(restored);
    expect((await open(saved)).view.getUint32(8, true)).toBe(3);
    expect(saved.size).toBeLessThan(old.size / 2);
  });

  it('reads uncompressed sections in chunks without changing the data', async () => {
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
    const progress: number[] = [];
    const restored = await readSceneFile(rawSceneFile(scene([part('a', geometry)])), (fraction) =>
      progress.push(fraction),
    );
    const { geometry: result } = restored.parts[0];
    expect(same(result.getAttribute('position').array, positions)).toBe(true);
    expect(same(result.getAttribute('normal').array, normals)).toBe(true);
    // Each attribute reads in two chunks, so progress moves within a mesh.
    expect(progress).toHaveLength(4);
    expect(progress.at(-1)).toBe(1);
  });

  it('supports uncompressed offsets beyond 32 bits', () => {
    const vertices = 2 ** 31;
    expect(
      validateLayout(
        { vertices, positions: { offset: 2 ** 33, length: vertices * 12 } },
        2 ** 33,
        2 ** 36,
      ),
    ).toBe(2 ** 33 + vertices * 12);
  });

  it('rejects files that are not scenes', async () => {
    await expect(readSceneFile(new Blob([]))).rejects.toThrow('could not be read');
    await expect(readSceneFile(new Blob(['not json']))).rejects.toThrow('could not be read');
    await expect(readSceneFile(new Blob(['{"format":"other"}']))).rejects.toThrow(
      'not a supported',
    );
  });

  it.each([
    [
      'a section past the end of the file',
      (h: RawSceneHeader) => {
        h.geometries[0].normals!.offset = h.bodyLength;
      },
    ],
    [
      'overlapping sections',
      (h: RawSceneHeader) => {
        h.geometries[0].normals!.offset = 0;
      },
    ],
    [
      'the wrong vector length',
      (h: RawSceneHeader) => {
        h.geometries[0].normals!.length -= 12;
      },
    ],
    [
      'a fractional vertex count',
      (h: RawSceneHeader) => {
        h.geometries[0].vertices += 0.5;
      },
    ],
    [
      'too few vertices',
      (h: RawSceneHeader) => {
        h.geometries[0].vertices = 2;
      },
    ],
    [
      'an unknown index type',
      (h: RawSceneHeader) => {
        (h.geometries[0].indices as { type: string }).type = 'u64';
      },
    ],
    [
      'a misaligned index section',
      (h: RawSceneHeader) => {
        h.geometries[0].indices!.length -= 1;
      },
    ],
    [
      'a negative section',
      (h: RawSceneHeader) => {
        h.geometries[0].indices!.length = -2;
      },
    ],
  ])('rejects an uncompressed file with %s before reading any mesh', async (_name, change) => {
    await expect(
      readSceneFile(await tampered(change, rawSceneFile(scene([part('a')])))),
    ).rejects.toThrow('invalid mesh data');
  });

  it('rejects invalid values inside uncompressed mesh data', async () => {
    const { bytes, header, bodyStart } = await open<RawSceneHeader>(
      rawSceneFile(scene([part('a')])),
    );
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

  it('reads a file by the version in its prefix, not the one its header claims', async () => {
    const claimed = await tampered((h) => {
      (h as { version: number }).version = 2;
    });
    await expect(readSceneFile(claimed)).rejects.toThrow('not a supported');
    const old = await tampered(
      (h: RawSceneHeader) => {
        (h as { version: number }).version = 3;
      },
      rawSceneFile(scene([part('a')])),
    );
    await expect(readSceneFile(old)).rejects.toThrow('not a supported');
  });
});

describe('damaged scene files', () => {
  const source = () => sceneFileBlob(scene([part('a')]));

  it('reports truncated downloads and extra data', async () => {
    const blob = await source();
    for (const cut of [blob.size - 1, Math.floor(blob.size / 2), 100, 24, 12])
      await expect(readSceneFile(blob.slice(0, cut))).rejects.toThrow('incomplete or damaged');
    await expect(readSceneFile(new Blob([blob, new Uint8Array(4)]))).rejects.toThrow(
      'incomplete or damaged',
    );
  });

  it('asks for a newer version of the app for newer files', async () => {
    const { bytes } = await open(source());
    new DataView(bytes.buffer).setUint32(8, 4, true);
    await expect(readSceneFile(new Blob([bytes]))).rejects.toThrow('newer version');
  });

  it('rejects a header that is not JSON', async () => {
    const { bytes } = await open(source());
    bytes[24] = 0x3f;
    await expect(readSceneFile(new Blob([bytes]))).rejects.toThrow('could not be read');
  });

  it.each([
    [
      'a mesh past the end of the file',
      (h: BinarySceneHeader) => {
        h.geometries[0].offset = 1;
      },
    ],
    [
      'blocks that do not add up to the mesh',
      (h: BinarySceneHeader) => {
        h.geometries[0].length -= 1;
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
      'more vertices than its blocks hold',
      (h: BinarySceneHeader) => {
        h.geometries[0].vertices += 3;
      },
    ],
    [
      'more vertices than one mesh can draw',
      (h: BinarySceneHeader) => {
        h.geometries[0].vertices = 2 ** 40;
      },
    ],
    [
      'a block larger than blocks may be',
      (h: BinarySceneHeader) => {
        h.geometries[0].positions.blocks[0][0] = 2 ** 20 + 1;
      },
    ],
    [
      'an empty block',
      (h: BinarySceneHeader) => {
        h.geometries[0].positions.blocks[0][1] = 0;
      },
    ],
    [
      'a negative block',
      (h: BinarySceneHeader) => {
        h.geometries[0].indices!.blocks[0][1] = -2;
      },
    ],
    [
      'no blocks',
      (h: BinarySceneHeader) => {
        h.geometries[0].indices!.blocks = [];
      },
    ],
    [
      'blocks that are not a list',
      (h: BinarySceneHeader) => {
        (h.geometries[0].positions as { blocks: unknown }).blocks = { length: 1 };
      },
    ],
    [
      'no positions',
      (h: BinarySceneHeader) => {
        delete (h.geometries[0] as { positions?: unknown }).positions;
      },
    ],
    [
      'an unknown index type',
      (h: BinarySceneHeader) => {
        (h.geometries[0].indices as { type: string }).type = 'u64';
      },
    ],
    [
      'indices that do not make whole triangles',
      (h: BinarySceneHeader) => {
        h.geometries[0].indices!.blocks[0][0] -= 1;
      },
    ],
    [
      'an unknown way of repeating values',
      (h: BinarySceneHeader) => {
        (h.geometries[0].normals as { per: string }).per = 'constructor';
      },
    ],
    [
      'values per triangle on a mesh with shared vertices',
      (h: BinarySceneHeader) => {
        h.geometries[0].normals!.per = 'face';
      },
    ],
    [
      'one value where every vertex has its own',
      (h: BinarySceneHeader) => {
        h.geometries[0].normals!.per = 'mesh';
      },
    ],
    [
      'uncompressed values that are not 12 bytes each',
      (h: BinarySceneHeader) => {
        h.geometries[0].normals!.blocks[0][1] += 4;
        h.geometries[0].length += 4;
      },
    ],
    [
      'a position map that leaves vertices out',
      (h: BinarySceneHeader) => {
        h.geometries[0].positions.map = [[3, 1]];
      },
    ],
  ])('rejects %s before reading any mesh', async (_name, change) => {
    const read = vi.spyOn(Blob.prototype, 'slice');
    try {
      // A box with its own normals, so every kind of block is present.
      const box = new BoxGeometry(10, 10, 10);
      values(box, 'normal').forEach((value, i, array) => (array[i] = -value));
      const file = await tampered(change, sceneFileBlob(scene([part('a', box)])));
      read.mockClear();
      await expect(readSceneFile(file)).rejects.toThrow('invalid mesh data');
      // The prefix and the header are read, and nothing after them.
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      read.mockRestore();
    }
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

  it('rejects blocks that do not unpack to what the header describes', async () => {
    const { bytes, header, bodyStart } = await open(source());
    const [layout] = header.geometries;
    for (const at of [0, layout.positions.blocks[0][1]]) {
      const damaged = bytes.slice();
      damaged[bodyStart + at] ^= 0xff;
      await expect(readSceneFile(new Blob([damaged]))).rejects.toThrow('invalid mesh data');
    }
    const short = await tampered((h) => {
      h.geometries[0].positions.blocks[0][0] -= 1;
    });
    await expect(readSceneFile(short)).rejects.toThrow('invalid mesh data');
  });

  it('rejects a position map that names a position the file does not hold', async () => {
    const corners = [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    const tetrahedron = setValues(
      new BufferGeometry(),
      'position',
      new Float32Array([0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3].flatMap((corner) => corners[corner])),
    );
    const box = new BoxGeometry(3, 4, 5).toNonIndexed();
    const { bytes, header, bodyStart } = await open(
      sceneFileBlob(scene([part('a', box), part('b', tetrahedron)])),
    );
    const [eight, four] = header.geometries;
    const size = (blocks: [number, number][]) =>
      blocks.reduce((sum, [, length]) => sum + length, 0);
    const mapStart = bodyStart + eight.offset + size(eight.positions.blocks);
    const map = bytes.subarray(mapStart, mapStart + size(eight.positions.map!));
    const positions = bytes.subarray(
      bodyStart + four.offset,
      bodyStart + four.offset + size(four.positions.blocks),
    );
    // Both blocks are sound. Together they send the box's vertices to positions 4 to 7 of 4.
    const crafted = binarySceneFile(
      3,
      {
        ...header,
        parts: [header.parts[0]],
        geometries: [
          {
            offset: 0,
            length: positions.length + map.length,
            vertices: 36,
            positions: { blocks: four.positions.blocks, map: eight.positions.map },
          },
        ],
        bodyLength: positions.length + map.length,
      },
      [positions, map],
    );
    await expect(readSceneFile(crafted)).rejects.toThrow('invalid mesh data');
  });

  it('rejects invalid values inside the mesh data', async () => {
    const broken = triangle();
    values(broken, 'position')[4] = NaN;
    await expect(readSceneFile(await sceneFileBlob(scene([part('a', broken)])))).rejects.toThrow(
      'invalid vertex positions',
    );
    const colors = setValues(triangle(), 'color', new Float32Array(9).fill(Infinity));
    await expect(readSceneFile(await sceneFileBlob(scene([part('a', colors)])))).rejects.toThrow(
      'invalid vertex colors',
    );
    const stray = triangle().setIndex(new BufferAttribute(new Uint16Array([0, 1, 7]), 1));
    await expect(readSceneFile(await sceneFileBlob(scene([part('a', stray)])))).rejects.toThrow(
      'invalid triangle indices',
    );
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
    const restored = await readSceneFile(await sceneFileBlob(original));
    expect(restored.lighting).toEqual(lighting);
    expect(restored.parts.map((p) => p.displayColor)).toEqual(['#FF00aa', undefined, '#010203']);
    expect('displayColor' in restored.parts[1]).toBe(false);
    expect(restored.parts.map((p) => p.color)).toEqual(['#aabbcc', '#aabbcc', '#ffffff']);
    // Saving what was opened writes the same file.
    expect(new Uint8Array(await (await sceneFileBlob(restored)).arrayBuffer())).toEqual(
      new Uint8Array(await (await sceneFileBlob(original)).arrayBuffer()),
    );
  });

  it('writes no lighting for a scene without its own', async () => {
    const plain = scene([part('a')]);
    const { header } = await open(sceneFileBlob(plain));
    expect('lighting' in header).toBe(false);
    expect('displayColor' in header.parts[0]).toBe(false);
    const restored = await readSceneFile(await sceneFileBlob(plain));
    expect('lighting' in restored).toBe(false);
    expect('lighting' in (await readSceneFile(await sceneFileBlob(restored)))).toBe(false);
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
    const restored = await readSceneFile(await sceneFileBlob(subset));
    expect(restored.lighting).toEqual(lighting);
    expect(restored.parts[0].displayColor).toBe('#010203');
  });
});
