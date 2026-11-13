import { BufferAttribute, BufferGeometry } from 'three';
import { MeshoptDecoder } from 'meshoptimizer/decoder';
import { MeshoptEncoder } from 'meshoptimizer/encoder';
import { binaryGeometry, maxBufferBytes } from './geometry';
import type { BinaryGeometry, PackedAttribute, PackedBlock, PackedLayout } from './types';

// Layout and rationale: docs/scene-format.md

/** A packed mesh before it has a place in a file. */
export interface PackedMesh {
  layout: Omit<PackedLayout, 'offset'>;
  data: Uint8Array[];
}

type Pause = () => Promise<void>;

const valuesPerBlock = 2 ** 20;
const indicesPerBlock = 3 * 2 ** 20;
const maxVertices = Math.floor(maxBufferBytes / 12);
// Unit vectors this close are under 0.06 degrees apart, too little to change how a surface is lit.
const normalDrift = 1e-3;
// The next level packs at two thirds of the speed for half a percent less.
const vertexCodecLevel = 1;
// Enough values for 1024 triangles of a mesh without an index.
const normalSample = 9 * 2 ** 10;

const invalid = () => new Error('The scene contains invalid mesh data.');

export async function meshCodecs() {
  if (!MeshoptEncoder.supported || !MeshoptDecoder.supported)
    throw new Error('Scene files need WebAssembly, which this browser does not provide.');
  await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
}

/** Bit patterns, so that values compare exactly, including -0 against 0. */
const bits = (values: Float32Array) =>
  new Uint32Array(values.buffer, values.byteOffset, values.length);

/** Which distinct position each of the first `count` vertices uses, if no more than `limit`. */
function search(values: Uint32Array, count: number, limit: number) {
  // At least twice the entries it can hold, so a free slot always turns up quickly.
  let capacity = 4;
  while (capacity < limit * 2) capacity *= 2;
  const table = new Int32Array(capacity).fill(-1);
  let distinct = new Uint32Array(Math.min(limit, 2 ** 16) * 3);
  const map = new Uint32Array(count);
  let found = 0;
  for (let i = 0; i < count; i++) {
    const x = values[i * 3],
      y = values[i * 3 + 1],
      z = values[i * 3 + 2];
    let hash = Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca6b) ^ Math.imul(z, 0xc2b2ae35);
    hash ^= hash >>> 15;
    hash = Math.imul(hash, 0x2c1b3c6d);
    hash ^= hash >>> 12;
    for (let slot = hash & (capacity - 1); ; slot = (slot + 1) & (capacity - 1)) {
      const entry = table[slot];
      if (entry < 0) {
        if (found === limit) return undefined;
        if (found * 3 === distinct.length) {
          const grown = new Uint32Array(Math.min(limit * 3, distinct.length * 2));
          grown.set(distinct);
          distinct = grown;
        }
        table[slot] = found;
        distinct[found * 3] = x;
        distinct[found * 3 + 1] = y;
        distinct[found * 3 + 2] = z;
        map[i] = found++;
        break;
      }
      if (
        distinct[entry * 3] === x &&
        distinct[entry * 3 + 1] === y &&
        distinct[entry * 3 + 2] === z
      ) {
        map[i] = entry;
        break;
      }
    }
  }
  return { distinct: distinct.subarray(0, found * 3), map };
}

/** The distinct positions and which one each vertex uses, when that at least halves them. */
function weld(values: Uint32Array, indexed: boolean) {
  const count = values.length / 3;
  // A mesh with an index has usually shared its vertices already. Its first vertices show
  // whether it has, before a search of all of them is paid for.
  const sample = 2 ** 16;
  if (indexed && count > sample && !search(values, sample, sample * 0.75)) return undefined;
  return search(values, count, Math.floor(count / 2));
}

/** One value per triangle, when the three corners of every triangle agree. */
function perFace(values: Uint32Array) {
  const faces = values.length / 9;
  const result = new Uint32Array(faces * 3);
  for (let face = 0; face < faces; face++) {
    const at = face * 9;
    const x = values[at],
      y = values[at + 1],
      z = values[at + 2];
    if (
      values[at + 3] !== x ||
      values[at + 6] !== x ||
      values[at + 4] !== y ||
      values[at + 7] !== y ||
      values[at + 5] !== z ||
      values[at + 8] !== z
    )
      return undefined;
    result[face * 3] = x;
    result[face * 3 + 1] = y;
    result[face * 3 + 2] = z;
  }
  return result;
}

function perMesh(values: Uint32Array) {
  for (let i = 3; i < values.length; i += 3)
    if (values[i] !== values[0] || values[i + 1] !== values[1] || values[i + 2] !== values[2])
      return undefined;
  return values.subarray(0, 3);
}

/**
 * The normals a mesh saved without any is given. These are the ones three.js computes, to the
 * last bit, but its own pass over a dense mesh with an index holds the page for seconds.
 */
function computedNormals(
  positions: Float32Array,
  indices?: ArrayLike<number>,
  limit = positions.length,
) {
  // With a lower `limit`, only the vertices before it are computed, from every triangle on them.
  const normals = new Float32Array(limit);
  if (!indices) {
    // Every triangle stands alone, so each gets its own normal on all three corners.
    for (let at = 0; at < limit; at += 9) {
      const ax = positions[at] - positions[at + 3],
        ay = positions[at + 1] - positions[at + 4],
        az = positions[at + 2] - positions[at + 5];
      const cx = positions[at + 6] - positions[at + 3],
        cy = positions[at + 7] - positions[at + 4],
        cz = positions[at + 8] - positions[at + 5];
      const x = Math.fround(cy * az - cz * ay),
        y = Math.fround(cz * ax - cx * az),
        z = Math.fround(cx * ay - cy * ax);
      const scale = 1 / (Math.sqrt(x * x + y * y + z * z) || 1);
      normals[at] = normals[at + 3] = normals[at + 6] = x * scale;
      normals[at + 1] = normals[at + 4] = normals[at + 7] = y * scale;
      normals[at + 2] = normals[at + 5] = normals[at + 8] = z * scale;
    }
    return normals;
  }
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3,
      b = indices[i + 1] * 3,
      c = indices[i + 2] * 3;
    const hasA = a < limit,
      hasB = b < limit,
      hasC = c < limit;
    if (!hasA && !hasB && !hasC) continue;
    const ax = positions[a] - positions[b],
      ay = positions[a + 1] - positions[b + 1],
      az = positions[a + 2] - positions[b + 2];
    const cx = positions[c] - positions[b],
      cy = positions[c + 1] - positions[b + 1],
      cz = positions[c + 2] - positions[b + 2];
    const x = cy * az - cz * ay,
      y = cz * ax - cx * az,
      z = cx * ay - cy * ax;
    // Every sum is taken before any is stored, so a triangle naming a vertex twice adds once.
    const bx = hasB ? normals[b] + x : 0,
      by = hasB ? normals[b + 1] + y : 0,
      bz = hasB ? normals[b + 2] + z : 0;
    const sx = hasC ? normals[c] + x : 0,
      sy = hasC ? normals[c + 1] + y : 0,
      sz = hasC ? normals[c + 2] + z : 0;
    if (hasA) {
      normals[a] += x;
      normals[a + 1] += y;
      normals[a + 2] += z;
    }
    if (hasB) {
      normals[b] = bx;
      normals[b + 1] = by;
      normals[b + 2] = bz;
    }
    if (hasC) {
      normals[c] = sx;
      normals[c + 1] = sy;
      normals[c + 2] = sz;
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const x = normals[i],
      y = normals[i + 1],
      z = normals[i + 2];
    const scale = 1 / (Math.sqrt(x * x + y * y + z * z) || 1);
    normals[i] = x * scale;
    normals[i + 1] = y * scale;
    normals[i + 2] = z * scale;
  }
  return normals;
}

/** Whether a mesh saved without its normals would be lit the same once they are computed. */
function normalsFollowTriangles({ positions, indices, normals }: BinaryGeometry) {
  const stored = normals!;
  const matches = (limit: number) => {
    let computed: Float32Array;
    try {
      computed = computedNormals(positions, indices, limit);
    } catch {
      // Too large to hold a second set of normals, so the mesh keeps the ones it has.
      return false;
    }
    for (let i = 0; i < limit; i += 3) {
      const x = computed[i],
        y = computed[i + 1],
        z = computed[i + 2];
      // A triangle without area is never drawn, so its normal cannot show.
      if (x === 0 && y === 0 && z === 0) continue;
      const distance = (stored[i] - x) ** 2 + (stored[i + 1] - y) ** 2 + (stored[i + 2] - z) ** 2;
      if (!(distance <= normalDrift ** 2)) return false;
    }
    return true;
  };
  // Normals made another way differ almost everywhere, so the first triangles usually settle it.
  return (stored.length <= normalSample || matches(normalSample)) && matches(stored.length);
}

/** The blocks of values written as they are in memory, `width` bytes each. */
function plainBlocks(values: ArrayBufferView, width: number, perBlock: number, data: Uint8Array[]) {
  data.push(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
  const blocks: PackedBlock[] = [];
  for (let left = values.byteLength / width; left > 0; left -= perBlock)
    blocks.push([Math.min(left, perBlock), Math.min(left, perBlock) * width]);
  return blocks;
}

/**
 * Values kept once for many vertices are compressed. Values that every vertex has for itself,
 * and the triangles' indices, are written as they are: compressing those too would make the file
 * smaller still, but a mesh with nothing repeated would then save and open more slowly than it
 * did before it was packed.
 */
async function packValues(values: Uint32Array, shared: boolean, data: Uint8Array[], pause: Pause) {
  if (!shared) return plainBlocks(values, 12, valuesPerBlock, data);
  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  const blocks: PackedBlock[] = [];
  for (let start = 0; start < values.length / 3; start += valuesPerBlock) {
    const count = Math.min(valuesPerBlock, values.length / 3 - start);
    const block = MeshoptEncoder.encodeVertexBufferLevel(
      bytes.subarray(start * 12, (start + count) * 12),
      count,
      12,
      vertexCodecLevel,
      1,
    );
    data.push(block);
    blocks.push([count, block.length]);
    await pause();
  }
  return blocks;
}

/** Which distinct position each vertex uses, compressed: neighbors mostly name neighbors. */
async function packMap(map: Uint32Array, data: Uint8Array[], pause: Pause) {
  const bytes = new Uint8Array(map.buffer, map.byteOffset, map.byteLength);
  const blocks: PackedBlock[] = [];
  for (let start = 0; start < map.length; start += indicesPerBlock) {
    const count = Math.min(indicesPerBlock, map.length - start);
    const block = MeshoptEncoder.encodeIndexSequence(
      bytes.subarray(start * 4, (start + count) * 4),
      count,
      4,
    );
    data.push(block);
    blocks.push([count, block.length]);
    await pause();
  }
  return blocks;
}

async function packAttribute(
  values: Uint32Array,
  faces: boolean,
  data: Uint8Array[],
  pause: Pause,
): Promise<PackedAttribute> {
  const mesh = perMesh(values);
  if (mesh) return { per: 'mesh', blocks: await packValues(mesh, true, data, pause) };
  const face = faces ? perFace(values) : undefined;
  await pause();
  return face
    ? { per: 'face', blocks: await packValues(face, true, data, pause) }
    : { per: 'vertex', blocks: await packValues(values, false, data, pause) };
}

async function pack(geometry: BufferGeometry, pause: Pause): Promise<PackedMesh> {
  const mesh = binaryGeometry(geometry);
  const vertices = mesh.positions.length / 3;
  const faces = !mesh.indices && vertices % 3 === 0;
  const data: Uint8Array[] = [];
  let welded: ReturnType<typeof weld>;
  try {
    welded = weld(bits(mesh.positions), !!mesh.indices);
  } catch {
    // Too large to search for repeats, so every position is written.
  }
  await pause();
  const positions: PackedLayout['positions'] = {
    blocks: await packValues(welded?.distinct ?? bits(mesh.positions), !!welded, data, pause),
  };
  if (welded) positions.map = await packMap(welded.map, data, pause);
  const layout: PackedMesh['layout'] = { length: 0, vertices, positions };
  if (mesh.normals) {
    const computed = normalsFollowTriangles(mesh);
    await pause();
    if (!computed) layout.normals = await packAttribute(bits(mesh.normals), faces, data, pause);
  }
  if (mesh.colors) layout.colors = await packAttribute(bits(mesh.colors), faces, data, pause);
  if (mesh.indices) {
    // glTF can supply 8-bit indices, which the file format does not store.
    const indices =
      mesh.indices instanceof Uint16Array || mesh.indices instanceof Uint32Array
        ? mesh.indices
        : Uint32Array.from(mesh.indices);
    layout.indices = {
      type: indices instanceof Uint16Array ? 'u16' : 'u32',
      blocks: plainBlocks(indices, indices.BYTES_PER_ELEMENT, indicesPerBlock, data),
    };
  }
  layout.length = data.reduce((sum, block) => sum + block.length, 0);
  return { layout, data };
}

const packed = new WeakMap<BufferGeometry, Promise<PackedMesh>>();

/**
 * Meshes never change once they are in a scene, so each is packed once, however many saves ask
 * for it. `pause` is called between steps and waits when the page is due a turn. Needs
 * `meshCodecs`.
 */
export function packedMesh(geometry: BufferGeometry, pause: Pause) {
  let mesh = packed.get(geometry);
  if (!mesh) {
    mesh = pack(geometry, pause);
    packed.set(geometry, mesh);
    // A failed attempt is not kept, so the next save tries again.
    mesh.catch(() => packed.delete(geometry));
  }
  return mesh;
}

/** `width` is the size of each value in a block that is not compressed. */
function blockTotals(value: unknown, limit: number, width?: number) {
  if (!Array.isArray(value) || !value.length) throw invalid();
  let count = 0,
    bytes = 0;
  for (const block of value) {
    if (!Array.isArray(block) || block.length !== 2) throw invalid();
    if (
      !Number.isSafeInteger(block[0]) ||
      !Number.isSafeInteger(block[1]) ||
      block[0] < 1 ||
      block[0] > limit ||
      block[1] < 1 ||
      (width !== undefined && block[1] !== block[0] * width)
    )
      throw invalid();
    count += block[0];
    bytes += block[1];
  }
  return { count, bytes };
}

/** Rejects layouts that overlap, read past the data, or unpack to more than a mesh may hold. */
export function validatePacked(value: unknown, start: number, end: number) {
  const layout = value as PackedLayout;
  if (
    !layout ||
    !Number.isSafeInteger(layout.vertices) ||
    layout.vertices < 3 ||
    layout.vertices > maxVertices ||
    !Number.isSafeInteger(layout.offset) ||
    !Number.isSafeInteger(layout.length) ||
    layout.offset < start ||
    layout.length < 0 ||
    layout.offset + layout.length > end ||
    !layout.positions
  )
    throw invalid();
  const { vertices, indices } = layout;
  let bytes = 0;
  const count = (blocks: unknown, limit: number, width?: number) => {
    const totals = blockTotals(blocks, limit, width);
    bytes += totals.bytes;
    return totals.count;
  };
  const values = (blocks: unknown, shared: boolean) =>
    count(blocks, valuesPerBlock, shared ? undefined : 12);
  const distinct = values(layout.positions.blocks, !!layout.positions.map);
  if (
    layout.positions.map
      ? distinct > vertices || count(layout.positions.map, indicesPerBlock) !== vertices
      : distinct !== vertices
  )
    throw invalid();
  for (const attribute of [layout.normals, layout.colors]) {
    if (!attribute) continue;
    const expected = { vertex: vertices, face: indices ? NaN : vertices / 3, mesh: 1 }[
      attribute.per
    ];
    if (values(attribute.blocks, attribute.per !== 'vertex') !== expected) throw invalid();
  }
  if (indices) {
    const width =
      indices.type === 'u32' ? 4 : indices.type === 'u16' && vertices <= 65536 ? 2 : NaN;
    if (count(indices.blocks, indicesPerBlock, width) % 3) throw invalid();
  } else if (vertices % 3) throw invalid();
  if (bytes !== layout.length) throw invalid();
  return layout.offset + layout.length;
}

function assertFinite(values: Float32Array, name: string) {
  // Zero times a finite value is zero, so a single value that is not leaves the sum as NaN.
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i] * 0;
  if (sum !== 0) throw new Error(`The mesh has invalid vertex ${name}s.`);
}

/**
 * Rebuilds the mesh a validated layout describes. `read` returns bytes of that mesh, which are
 * asked for in order and once each. Needs `meshCodecs`.
 */
export async function unpackMesh(
  layout: PackedLayout,
  read: (start: number, length: number) => Promise<ArrayBuffer>,
) {
  const { vertices } = layout;
  const data: Uint8Array[] = [];
  let at = 0;
  const take = async (blocks: PackedBlock[]) => {
    const length = blocks.reduce((sum, [, bytes]) => sum + bytes, 0);
    const buffer = await read(at, length);
    at += length;
    data.push(new Uint8Array(buffer));
    return buffer;
  };
  const decode = async <T extends Float32Array | Uint32Array>(
    blocks: PackedBlock[],
    target: T,
    size: number,
    codec: 'decodeVertexBuffer' | 'decodeIndexSequence',
  ) => {
    const source = new Uint8Array(await take(blocks));
    const bytes = new Uint8Array(target.buffer);
    let done = 0,
      from = 0;
    for (const [count, length] of blocks) {
      try {
        MeshoptDecoder[codec](
          bytes.subarray(done * size, (done + count) * size),
          count,
          size,
          source.subarray(from, from + length),
        );
      } catch {
        throw invalid();
      }
      done += count;
      from += length;
    }
    return target;
  };
  const total = (blocks: PackedBlock[]) => blocks.reduce((sum, [count]) => sum + count, 0);
  const values = async (blocks: PackedBlock[], shared: boolean, name: string) => {
    // Values written as they are in memory are read straight into place.
    const result = shared
      ? await decode(blocks, new Float32Array(total(blocks) * 3), 12, 'decodeVertexBuffer')
      : new Float32Array(await take(blocks));
    // Checked before they are repeated, so each value is checked once.
    assertFinite(result, name);
    return result;
  };
  const attribute = async (packedAttribute: PackedAttribute, name: string) => {
    const stored = await values(packedAttribute.blocks, packedAttribute.per !== 'vertex', name);
    if (packedAttribute.per === 'vertex') return stored;
    const repeat = packedAttribute.per === 'face' ? 3 : vertices;
    const result = new Float32Array(vertices * 3);
    for (let i = 0, to = 0; i < stored.length; i += 3)
      for (let n = 0; n < repeat; n++) {
        result[to++] = stored[i];
        result[to++] = stored[i + 1];
        result[to++] = stored[i + 2];
      }
    return result;
  };

  const distinct = await values(layout.positions.blocks, !!layout.positions.map, 'position');
  let positions = distinct;
  if (layout.positions.map) {
    const map = await decode(
      layout.positions.map,
      new Uint32Array(vertices),
      4,
      'decodeIndexSequence',
    );
    const limit = distinct.length / 3;
    positions = new Float32Array(vertices * 3);
    for (let i = 0; i < vertices; i++) {
      const from = map[i];
      if (from >= limit) throw invalid();
      positions[i * 3] = distinct[from * 3];
      positions[i * 3 + 1] = distinct[from * 3 + 1];
      positions[i * 3 + 2] = distinct[from * 3 + 2];
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  const normals = layout.normals && (await attribute(layout.normals, 'normal'));
  if (layout.colors)
    geometry.setAttribute('color', new BufferAttribute(await attribute(layout.colors, 'color'), 3));
  let indices: Uint16Array | Uint32Array | undefined;
  if (layout.indices) {
    const buffer = await take(layout.indices.blocks);
    indices = layout.indices.type === 'u16' ? new Uint16Array(buffer) : new Uint32Array(buffer);
    for (let i = 0; i < indices.length; i++)
      if (indices[i] >= vertices) throw new Error('The mesh has invalid triangle indices.');
    geometry.setIndex(new BufferAttribute(indices, 1));
  }
  geometry.setAttribute(
    'normal',
    new BufferAttribute(normals ?? computedNormals(positions, indices), 3),
  );
  // Repeats do not move the bounds, so the distinct positions are enough to find them.
  const bounds = new BufferGeometry().setAttribute('position', new BufferAttribute(distinct, 3));
  bounds.computeBoundingSphere();
  geometry.boundingSphere = bounds.boundingSphere;
  // Saving an opened scene writes these bytes again instead of packing the mesh a second time.
  const { offset, ...placeless } = layout;
  packed.set(geometry, Promise.resolve({ layout: placeless, data }));
  return geometry;
}
