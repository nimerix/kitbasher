import { BufferAttribute, BufferGeometry } from 'three';
import type { Part, SceneDocument } from './types';

type NumericArray = BufferAttribute['array'];
type Slice = { offset: number; bytes: Uint8Array };

/** A standalone snapshot. Each patch refers directly to a full array, so evicting an
 * older stroke never breaks restoration or leaves a chain of retired strokes alive. */
export class PackedArray<T extends NumericArray> {
  private live: WeakRef<T>;
  constructor(
    readonly base: T,
    readonly length: number,
    readonly slices: Slice[],
    value: T,
  ) {
    this.live = new WeakRef(value);
  }

  restore(): T {
    const live = this.live.deref();
    if (live) return live;
    if (!this.slices.length && this.length === this.base.length) return this.base;
    const Type = this.base.constructor as new (length: number) => T;
    const value = new Type(this.length);
    value.set(this.base.subarray(0, this.length));
    const bytes = new Uint8Array(value.buffer);
    for (const slice of this.slices) bytes.set(slice.bytes, slice.offset);
    this.live = new WeakRef(value);
    return value;
  }
}

function words(array: NumericArray) {
  return new Uint32Array(array.buffer, array.byteOffset, Math.floor(array.byteLength / 4));
}

/** Compare aligned words, preserving signed zeros, NaN payloads and integer attributes. */
export function packArray<T extends NumericArray>(
  value: T,
  previous?: T,
  snapshot?: PackedArray<T>,
): PackedArray<T> {
  if (snapshot && value === previous) return snapshot;
  const full = () => new PackedArray(value, value.length, [], value);
  if (
    !previous ||
    previous === value ||
    previous.constructor !== value.constructor ||
    previous.byteOffset % 4 ||
    value.byteOffset % 4 ||
    value.byteLength < 1024
  )
    return full();

  const base = snapshot?.base ?? previous;
  if (base.byteLength > value.byteLength * 2) return full();
  const before = words(previous);
  const after = words(value);
  const data = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  const slices: Slice[] = [];
  const changed: number[] = [];
  let priorIndex = 0;
  let changedBytes = 0;
  for (let offset = 0; offset < data.length; offset += 2048) {
    const end = Math.min(offset + 2048, data.length);
    const prior = snapshot?.slices[priorIndex];
    const inherited = prior?.offset === offset ? prior : undefined;
    if (inherited) priorIndex++;
    let different = end > previous.byteLength || end % 4 !== 0;
    if (!different) {
      for (let i = offset / 4; i < end / 4; i++) {
        if (before[i] === after[i]) continue;
        different = true;
        break;
      }
    }
    if (different) {
      changedBytes += end - offset;
      if (changedBytes > data.length / 3) return full();
      // Defer copying until we know a dense edit will not need a full checkpoint.
      changed.push(slices.length);
      slices.push({ offset, bytes: data.subarray(offset, end) });
    } else if (inherited) {
      slices.push(
        inherited.bytes.length <= end - offset
          ? inherited
          : { offset, bytes: inherited.bytes.slice(0, end - offset) },
      );
    }
  }
  for (const index of changed) slices[index].bytes = slices[index].bytes.slice();
  return new PackedArray(base, value.length, slices, value);
}

const archived = new WeakMap<BufferGeometry, SculptGeometrySnapshot>();
export const sculptFaceLimits = new WeakMap<BufferGeometry, number>();

/** Mesh identity and render metadata survive eviction of the live mesh and its picking tree. */
export class SculptGeometrySnapshot {
  readonly uuid: string;
  readonly arrays: NumericArray[] = [];
  private live: WeakRef<BufferGeometry>;
  private readonly attributes = new Map<
    string | null,
    Pick<BufferAttribute, 'itemSize' | 'normalized' | 'name' | 'usage' | 'gpuType'> & {
      data: PackedArray<NumericArray>;
    }
  >();
  private readonly template = new BufferGeometry();
  private readonly faceLimit?: number;

  constructor(source: BufferGeometry, geometry: BufferGeometry, faceLimit?: number) {
    this.uuid = geometry.uuid;
    this.faceLimit = faceLimit;
    this.live = new WeakRef(geometry);
    this.template.name = geometry.name;
    this.template.userData = geometry.userData;
    this.template.groups = geometry.groups;
    this.template.drawRange = { ...geometry.drawRange };
    this.template.boundingBox = geometry.boundingBox;
    this.template.boundingSphere = geometry.boundingSphere;
    const prior = archived.get(source);
    const save = (name: string | null, attribute: BufferAttribute, previous?: NumericArray) => {
      const data = packArray(attribute.array, previous, prior?.attributes.get(name)?.data);
      this.attributes.set(name, {
        data,
        itemSize: attribute.itemSize,
        normalized: attribute.normalized,
        name: attribute.name,
        usage: attribute.usage,
        gpuType: attribute.gpuType,
      });
      this.arrays.push(data.base);
      for (const slice of data.slices) this.arrays.push(slice.bytes);
    };
    for (const [name, attribute] of Object.entries(geometry.attributes))
      save(name, attribute as BufferAttribute, source.getAttribute(name)?.array);
    if (geometry.index) save(null, geometry.index, source.index?.array);
  }

  restore() {
    const live = this.live.deref();
    if (live) return live;
    const geometry = this.template.clone();
    geometry.uuid = this.uuid;
    for (const [name, { data, itemSize, normalized, name: label, usage, gpuType }] of this
      .attributes) {
      const attribute = new BufferAttribute(data.restore(), itemSize, normalized);
      attribute.name = label;
      attribute.setUsage(usage);
      attribute.gpuType = gpuType;
      if (name !== null) geometry.setAttribute(name, attribute);
      else geometry.setIndex(attribute);
    }
    if (this.faceLimit !== undefined) sculptFaceLimits.set(geometry, this.faceLimit);
    archived.set(geometry, this);
    this.live = new WeakRef(geometry);
    return geometry;
  }
}

export function rememberSculptGeometry(source: BufferGeometry, geometry: BufferGeometry) {
  if (
    archived.has(geometry) ||
    geometry.constructor !== BufferGeometry ||
    geometry.indirect ||
    Object.keys(geometry.morphAttributes).length ||
    !Object.values(geometry.attributes).some((attribute) => attribute.array.byteLength >= 1024) ||
    [...Object.values(geometry.attributes), geometry.index].some(
      (a) => a && a.constructor !== BufferAttribute,
    )
  )
    return;
  archived.set(
    geometry,
    new SculptGeometrySnapshot(source, geometry, sculptFaceLimits.get(geometry)),
  );
}

export type HistoryGeometry = BufferGeometry | SculptGeometrySnapshot;
export const archiveGeometry = (geometry: HistoryGeometry) =>
  geometry instanceof SculptGeometrySnapshot ? geometry : (archived.get(geometry) ?? geometry);
export const restoreGeometry = (geometry: HistoryGeometry) =>
  geometry instanceof SculptGeometrySnapshot ? geometry.restore() : geometry;

type HistoryPart = Omit<Part, 'geometry'> & { geometry: HistoryGeometry };
export type HistoryScene = Omit<SceneDocument, 'parts'> & { parts: HistoryPart[] };

export function archiveScene(scene: SceneDocument): HistoryScene {
  if (!scene.parts.some((p) => archived.has(p.geometry))) return scene;
  return {
    ...scene,
    parts: scene.parts.map((part) => {
      const geometry = archived.get(part.geometry);
      return geometry ? { ...part, geometry } : part;
    }),
  };
}

export function restoreScene(scene: HistoryScene): SceneDocument {
  if (!scene.parts.some((p) => p.geometry instanceof SculptGeometrySnapshot))
    return scene as SceneDocument;
  return {
    ...scene,
    parts: scene.parts.map((part) =>
      part.geometry instanceof SculptGeometrySnapshot
        ? { ...part, geometry: part.geometry.restore() }
        : (part as Part),
    ),
  };
}
