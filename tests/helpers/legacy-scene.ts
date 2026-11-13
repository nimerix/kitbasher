import type { BufferGeometry } from 'three';
import { serializeGeometry } from '../../src/core/geometry';
import { appendGeometry, sceneMetadata } from '../../src/core/scene-file';
import type {
  GeometryLayout,
  RawSceneHeader,
  SceneDocument,
  SceneFile,
} from '../../src/core/types';

/** Writes the JSON format of earlier versions, which the app can still open. */
export function serializeScene(scene: SceneDocument): SceneFile {
  return {
    format: 'kitbasher',
    version: 1,
    units: 'mm',
    name: scene.name,
    parts: scene.parts.map((part) => ({ ...part, geometry: serializeGeometry(part.geometry) })),
    joints: scene.joints,
    constraints: scene.constraints ?? [],
  };
}

/** A binary scene file: magic, version, header length, the JSON header, then the body. */
export function binarySceneFile(version: number, header: object, body: BlobPart[]) {
  const encoded = new TextEncoder().encode(JSON.stringify(header));
  const prefix = new Uint8Array(24 + encoded.length + ((4 - (encoded.length % 4)) % 4)).fill(0x20);
  prefix.set([0x4b, 0x49, 0x54, 0x42, 0x41, 0x53, 0x48, 0x1a]);
  const view = new DataView(prefix.buffer);
  view.setUint32(8, version, true);
  view.setUint32(12, 0, true);
  view.setBigUint64(16, BigInt(prefix.length - 24), true);
  prefix.set(encoded, 24);
  return new Blob([prefix, ...body]);
}

/** Writes version 2 of the binary format, with every mesh value uncompressed. It still opens. */
export function rawSceneFile(scene: SceneDocument) {
  const body: BlobPart[] = [];
  const indexes = new Map<BufferGeometry, number>();
  const geometries: GeometryLayout[] = [];
  let bodyLength = 0;
  const parts = scene.parts.map((part) => {
    let index = indexes.get(part.geometry);
    if (index === undefined) {
      const { layout, end } = appendGeometry(part.geometry, body, bodyLength);
      index = geometries.push(layout) - 1;
      indexes.set(part.geometry, index);
      bodyLength = end;
    }
    return { ...part, geometry: index };
  });
  const header: RawSceneHeader = { ...sceneMetadata(scene), parts, geometries, bodyLength };
  return binarySceneFile(2, header, body);
}
