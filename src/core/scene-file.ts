import type { BufferGeometry } from 'three';
import { binaryGeometry, deserializeGeometry } from './geometry';
import { validateJoint } from './constraints';
import { hexColor } from './appearance';
import { sanitizeLighting } from './lighting';
import { meshCodecs, packedMesh, unpackMesh, validatePacked } from './mesh-pack';
import { validatePlaneConstraints } from './plane-constraints';
import type {
  BinaryGeometry,
  BinarySceneHeader,
  GeometryLayout,
  GeometrySection,
  Joint,
  PackedLayout,
  Part,
  PlaneConstraint,
  RawSceneHeader,
  SceneDocument,
  SceneFile,
} from './types';

// Layout and rationale: docs/scene-format.md
const fileVersion = 3;
// Autosave and shared sessions pass meshes as version 2 sections, which take no time to encode.
const sectionVersion = 2;
// How long packing may hold the page before it gives way to drawing and input.
const packingSliceMs = 50;
const fileMagic = new Uint8Array([0x4b, 0x49, 0x54, 0x42, 0x41, 0x53, 0x48, 0x1a]);
const prefixLength = 24;
const sectionAlignment = 4;
// Chrome rejects a Blob part over 2 GiB and cannot read that much in one call.
const blobChunkBytes = 64 * 2 ** 20;
const unreadable = 'This file could not be read as a Kitbasher scene.';
const incomplete =
  'This scene file is incomplete or damaged. It may not have finished downloading.';

export const sceneMetadata = (scene: SceneDocument) =>
  ({
    format: 'kitbasher',
    version: sectionVersion,
    units: 'mm',
    name: scene.name,
    joints: scene.joints,
    constraints: scene.constraints ?? [],
    ...(scene.lighting ? { lighting: scene.lighting } : {}),
  }) as const;

export function blobParts(values: ArrayBufferView) {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  for (let done = 0; done < values.byteLength; done += blobChunkBytes)
    parts.push(
      new Uint8Array(
        values.buffer as ArrayBuffer,
        values.byteOffset + done,
        Math.min(blobChunkBytes, values.byteLength - done),
      ),
    );
  return parts;
}

/** Queues a mesh's buffers as Blob parts, so no single allocation holds the whole scene. */
export function appendGeometry(geometry: BufferGeometry, body: BlobPart[], start: number) {
  const data = binaryGeometry(geometry);
  let end = start;
  const append = (values: ArrayBufferView): GeometrySection => {
    const section = { offset: end, length: values.byteLength };
    body.push(...blobParts(values));
    end += values.byteLength;
    const padding = (sectionAlignment - (end % sectionAlignment)) % sectionAlignment;
    if (padding) {
      body.push(new Uint8Array(padding));
      end += padding;
    }
    return section;
  };
  const layout: GeometryLayout = {
    vertices: data.positions.length / 3,
    positions: append(data.positions),
  };
  if (data.normals) layout.normals = append(data.normals);
  if (data.colors) layout.colors = append(data.colors);
  if (data.indices) {
    // glTF can supply 8-bit indices, which the file format does not store.
    const indices =
      data.indices instanceof Uint16Array || data.indices instanceof Uint32Array
        ? data.indices
        : Uint32Array.from(data.indices);
    layout.indices = {
      ...append(indices),
      type: indices instanceof Uint16Array ? 'u16' : 'u32',
    };
  }
  return { layout, end };
}

export async function sceneFileBlob(scene: SceneDocument): Promise<Blob> {
  await meshCodecs();
  let paused = performance.now();
  const pause = async () => {
    if (performance.now() - paused < packingSliceMs) return;
    await new Promise((resolve) => setTimeout(resolve));
    paused = performance.now();
  };
  const body: BlobPart[] = [];
  const indexes = new Map<BufferGeometry, number>();
  const geometries: PackedLayout[] = [];
  const parts: BinarySceneHeader['parts'] = [];
  let bodyLength = 0;
  for (const part of scene.parts) {
    // Copies share one mesh in memory, and they stay shared in the file.
    let index = indexes.get(part.geometry);
    if (index === undefined) {
      const mesh = await packedMesh(part.geometry, pause);
      index = geometries.push({ offset: bodyLength, ...mesh.layout }) - 1;
      indexes.set(part.geometry, index);
      for (const block of mesh.data) body.push(...blobParts(block));
      bodyLength += mesh.layout.length;
    }
    parts.push({ ...part, geometry: index });
  }
  const header: BinarySceneHeader = {
    ...sceneMetadata(scene),
    version: fileVersion,
    parts,
    geometries,
    bodyLength,
  };
  const encoded = new TextEncoder().encode(JSON.stringify(header));
  // Padded to four bytes as in version 2, with spaces, which JSON allows after a value.
  const headerLength =
    prefixLength +
    encoded.length +
    ((sectionAlignment - (encoded.length % sectionAlignment)) % sectionAlignment);
  const headerBytes = new Uint8Array(headerLength).fill(0x20);
  headerBytes.set(fileMagic);
  const prefix = new DataView(headerBytes.buffer);
  prefix.setUint32(8, fileVersion, true);
  prefix.setUint32(12, 0, true);
  prefix.setBigUint64(16, BigInt(headerLength - prefixLength), true);
  headerBytes.set(encoded, prefixLength);
  return new Blob([headerBytes, ...body], { type: 'application/octet-stream' });
}

/**
 * A browser that cannot hold a Blob, such as a private window past its memory limit, still
 * creates it and only fails on use. Download and IndexedDB can then accept it silently.
 */
export async function assertReadable(blob: Blob) {
  await blob.slice(Math.max(0, blob.size - 1)).arrayBuffer();
}

/** Rejects layouts that could overlap or read past the data, then returns where they end. */
export function validateLayout(value: unknown, start: number, end: number) {
  const layout = value as GeometryLayout;
  const invalid = () => new Error('The scene contains invalid mesh data.');
  if (!layout || !Number.isSafeInteger(layout.vertices) || layout.vertices < 3) throw invalid();
  let cursor = start;
  const section = (entry: GeometrySection, length?: number) => {
    if (
      !entry ||
      !Number.isSafeInteger(entry.offset) ||
      !Number.isSafeInteger(entry.length) ||
      entry.offset < cursor ||
      entry.length < 0 ||
      entry.offset + entry.length > end ||
      (length !== undefined && entry.length !== length)
    )
      throw invalid();
    cursor = entry.offset + entry.length;
  };
  section(layout.positions, layout.vertices * 12);
  if (layout.normals) section(layout.normals, layout.vertices * 12);
  if (layout.colors) section(layout.colors, layout.vertices * 12);
  if (layout.indices) {
    const width = layout.indices.type === 'u16' ? 2 : layout.indices.type === 'u32' ? 4 : 0;
    section(layout.indices);
    if (!width || layout.indices.length % width) throw invalid();
  }
  return cursor;
}

/** Chrome fails to read 2.2 GiB in one call, and can read any size in pieces. */
export async function readBytes(
  source: Blob,
  start = 0,
  length = source.size,
  onBytes?: (length: number) => void,
) {
  const data = new Uint8Array(length);
  for (let done = 0; done < length; done += blobChunkBytes) {
    const end = Math.min(done + blobChunkBytes, length);
    data.set(new Uint8Array(await source.slice(start + done, start + end).arrayBuffer()), done);
    onBytes?.(end - done);
  }
  return data.buffer;
}

export async function readGeometry(
  source: Blob,
  layout: GeometryLayout,
  base = 0,
  onBytes?: (length: number) => void,
) {
  const bytes = ({ offset, length }: GeometrySection) =>
    readBytes(source, base + offset, length, onBytes);
  const data: BinaryGeometry = { positions: new Float32Array(await bytes(layout.positions)) };
  if (layout.normals) data.normals = new Float32Array(await bytes(layout.normals));
  if (layout.colors) data.colors = new Float32Array(await bytes(layout.colors));
  if (layout.indices) {
    const buffer = await bytes(layout.indices);
    data.indices =
      layout.indices.type === 'u16' ? new Uint16Array(buffer) : new Uint32Array(buffer);
  }
  return deserializeGeometry(data);
}

/** Opens scene files of every version: packed, uncompressed sections, and JSON. */
export async function readSceneFile(
  file: Blob,
  onProgress?: (fraction: number) => void,
): Promise<SceneDocument> {
  const prefix = await file.slice(0, prefixLength).arrayBuffer();
  const prefixBytes = new Uint8Array(prefix);
  if (!fileMagic.every((byte, i) => prefixBytes[i] === byte)) {
    let data: unknown;
    try {
      data = JSON.parse(await file.text());
    } catch {
      throw new Error(unreadable);
    }
    return parseScene(data);
  }
  if (file.size < prefixLength) throw new Error(incomplete);
  const view = new DataView(prefix);
  const version = view.getUint32(8, true);
  if (version > fileVersion)
    throw new Error('This scene was saved by a newer version of Kitbasher.');
  if (version !== fileVersion && version !== sectionVersion) throw new Error(unreadable);
  const bodyStart = prefixLength + Number(view.getBigUint64(16, true));
  if (bodyStart > file.size) throw new Error(incomplete);
  let header: BinarySceneHeader | RawSceneHeader;
  try {
    header = JSON.parse(
      new TextDecoder().decode(await file.slice(prefixLength, bodyStart).arrayBuffer()),
    );
  } catch {
    throw new Error(unreadable);
  }
  if (!header || !Number.isSafeInteger(header.bodyLength) || !Array.isArray(header.geometries))
    throw new Error(unreadable);
  if (bodyStart + header.bodyLength !== file.size) throw new Error(incomplete);
  // The version in the prefix decides how the meshes are read, whatever the header claims.
  const packed = version === fileVersion;
  // Every layout is checked before any mesh memory is read.
  const validate = packed ? validatePacked : validateLayout;
  let cursor = 0;
  for (const layout of header.geometries) cursor = validate(layout, cursor, header.bodyLength);
  let read = 0;
  const progress = (length: number) => {
    read += length;
    onProgress?.(header.bodyLength ? read / header.bodyLength : 1);
  };
  const geometries: BufferGeometry[] = [];
  if (packed) {
    await meshCodecs();
    for (const layout of header.geometries as PackedLayout[])
      geometries.push(
        await unpackMesh(layout, (start, length) =>
          readBytes(file, bodyStart + layout.offset + start, length, progress),
        ),
      );
  } else
    for (const layout of header.geometries as GeometryLayout[])
      geometries.push(await readGeometry(file, layout, bodyStart, progress));
  return parseSceneDocument(header, version, (reference) => {
    const geometry = Number.isInteger(reference) ? geometries[reference as number] : undefined;
    if (!geometry) throw new Error('The scene contains invalid part data.');
    return geometry;
  });
}

/** Relationships to excluded parts would make the resulting scene file invalid. */
export function sceneSubset(scene: SceneDocument, parts: Part[]): SceneDocument {
  const ids = new Set(parts.map((part) => part.id));
  return {
    ...scene,
    parts,
    joints: scene.joints.filter((j) => ids.has(j.parentId) && ids.has(j.childId)),
    constraints: scene.constraints?.filter((c) => ids.has(c.sourceId) && ids.has(c.targetId)),
  };
}

function finiteTuple(value: unknown, size: number): value is number[] {
  return Array.isArray(value) && value.length === size && value.every(Number.isFinite);
}

/** Parses the JSON scene document written by earlier versions. */
export function parseScene(value: unknown): SceneDocument {
  return parseSceneDocument(value, 1, (geometry) =>
    deserializeGeometry(geometry as SceneFile['parts'][number]['geometry']),
  );
}

export function parseSceneDocument(
  value: unknown,
  version: number,
  geometryOf: (reference: unknown) => BufferGeometry,
): SceneDocument {
  const data = value as SceneFile;
  if (
    !data ||
    data.format !== 'kitbasher' ||
    data.version !== version ||
    data.units !== 'mm' ||
    !Array.isArray(data.parts) ||
    !Array.isArray(data.joints) ||
    typeof data.name !== 'string'
  ) {
    throw new Error('This is not a supported Kitbasher scene.');
  }
  const ids = new Set<string>();
  const parts = data.parts.map((p) => {
    if (
      !p ||
      typeof p.id !== 'string' ||
      ids.has(p.id) ||
      typeof p.name !== 'string' ||
      !finiteTuple(p.position, 3) ||
      !finiteTuple(p.quaternion, 4) ||
      !finiteTuple(p.scale, 3) ||
      (p.pivot !== undefined && !finiteTuple(p.pivot, 3)) ||
      p.scale.some((n) => Math.abs(n) < 1e-6) ||
      Math.abs(Math.hypot(...p.quaternion) - 1) > 0.01 ||
      typeof p.color !== 'string' ||
      !/^#[\da-f]{6}$/i.test(p.color) ||
      typeof p.visible !== 'boolean' ||
      typeof p.locked !== 'boolean'
    ) {
      throw new Error('The scene contains invalid part data.');
    }
    if (p.anchors !== undefined) {
      const anchorIds = new Set<string>();
      if (!Array.isArray(p.anchors)) throw new Error('The scene contains invalid fit anchors.');
      for (const anchor of p.anchors) {
        if (
          !anchor ||
          typeof anchor.id !== 'string' ||
          anchorIds.has(anchor.id) ||
          !finiteTuple(anchor.point, 3) ||
          !finiteTuple(anchor.target, 3)
        )
          throw new Error('The scene contains invalid fit anchors.');
        anchorIds.add(anchor.id);
      }
    }
    if (p.pins !== undefined) {
      const pinIds = new Set<string>();
      if (!Array.isArray(p.pins)) throw new Error('The scene contains invalid pins.');
      for (const pin of p.pins) {
        if (
          !pin ||
          typeof pin.id !== 'string' ||
          !pin.id ||
          pinIds.has(pin.id) ||
          !finiteTuple(pin.point, 3) ||
          !finiteTuple(pin.target, 3) ||
          (pin.kind !== 'hard' && pin.kind !== 'soft') ||
          !Number.isFinite(pin.priority) ||
          pin.priority < 0 ||
          pin.priority > 100
        )
          throw new Error('The scene contains invalid pins.');
        pinIds.add(pin.id);
      }
    }
    ids.add(p.id);
    const { displayColor, ...rest } = p;
    return {
      ...rest,
      // Editor-only, so a bad value is dropped rather than refusing the scene.
      ...(typeof displayColor === 'string' && hexColor.test(displayColor) ? { displayColor } : {}),
      source: typeof p.source === 'string' ? p.source : 'Scene',
      geometry: geometryOf(p.geometry),
    };
  });
  const jointIds = new Set<string>(),
    joints: Joint[] = [];
  for (const j of data.joints) {
    if (
      !j ||
      typeof j.id !== 'string' ||
      jointIds.has(j.id) ||
      typeof j.name !== 'string' ||
      !ids.has(j.parentId) ||
      !ids.has(j.childId) ||
      !finiteTuple(j.parentAnchor, 3) ||
      !finiteTuple(j.childAnchor, 3) ||
      !finiteTuple(j.restRotation, 4) ||
      Math.abs(Math.hypot(...j.restRotation) - 1) > 0.01 ||
      !Array.isArray(j.rotationLocks) ||
      j.rotationLocks.length !== 3 ||
      !j.rotationLocks.every((b) => typeof b === 'boolean') ||
      (j.keepConnected !== undefined && typeof j.keepConnected !== 'boolean')
    ) {
      throw new Error('The scene contains an invalid joint.');
    }
    validateJoint(joints, j.parentId, j.childId);
    joints.push({ ...j, keepConnected: j.keepConnected ?? true });
    jointIds.add(j.id);
  }
  if (data.constraints !== undefined && !Array.isArray(data.constraints))
    throw new Error('The scene contains invalid plane constraints.');
  const constraints: PlaneConstraint[] = [],
    constraintIds = new Set<string>();
  for (const constraint of data.constraints ?? []) {
    const planeValid = (frame: unknown) => {
      const plane = frame as PlaneConstraint['sourcePlane'];
      return (
        plane &&
        finiteTuple(plane.point, 3) &&
        finiteTuple(plane.normal, 3) &&
        Math.abs(Math.hypot(...plane.normal) - 1) < 0.01
      );
    };
    if (
      !constraint ||
      typeof constraint.id !== 'string' ||
      constraintIds.has(constraint.id) ||
      typeof constraint.name !== 'string' ||
      typeof constraint.enabled !== 'boolean' ||
      typeof constraint.opposed !== 'boolean' ||
      !planeValid(constraint.sourcePlane) ||
      !planeValid(constraint.targetPlane)
    )
      throw new Error('The scene contains an invalid plane constraint.');
    constraints.push(constraint);
    constraintIds.add(constraint.id);
  }
  const scene: SceneDocument = {
    name: data.name,
    parts,
    joints,
    constraints,
    ...(data.lighting && typeof data.lighting === 'object' && !Array.isArray(data.lighting)
      ? { lighting: sanitizeLighting(data.lighting) }
      : {}),
  };
  validatePlaneConstraints(scene);
  return scene;
}
