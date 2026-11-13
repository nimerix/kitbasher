import { Box3, BufferAttribute, BufferGeometry, Sphere, Vector3 } from 'three';

type Attribute = { array: BufferAttribute['array']; itemSize: number; normalized: boolean };
export interface GeometrySnapshot {
  attributes: Record<string, Attribute>;
  index?: Attribute;
  box?: { min: number[]; max: number[] };
  sphere?: { center: number[]; radius: number };
}

/** Structured cloning copies these buffers once; the live scene retains ownership. */
export function snapshotGeometry(geometry: BufferGeometry): GeometrySnapshot {
  const attributes: GeometrySnapshot['attributes'] = {};
  for (const name of ['position', 'normal', 'color']) {
    const attribute = geometry.getAttribute(name);
    if (!attribute) continue;
    if (attribute instanceof BufferAttribute) {
      attributes[name] = {
        array: attribute.array,
        itemSize: attribute.itemSize,
        normalized: attribute.normalized,
      };
    } else {
      const ArrayType = attribute.array.constructor as {
        new (length: number): BufferAttribute['array'];
      };
      const array = new ArrayType(attribute.count * attribute.itemSize);
      for (let i = 0; i < attribute.count; i++)
        for (let c = 0; c < attribute.itemSize; c++)
          array[i * attribute.itemSize + c] =
            attribute.array[i * attribute.data.stride + attribute.offset + c];
      attributes[name] = { array, itemSize: attribute.itemSize, normalized: attribute.normalized };
    }
  }
  const index = geometry.index;
  return {
    attributes,
    index: index ? { array: index.array, itemSize: 1, normalized: false } : undefined,
    box: geometry.boundingBox
      ? {
          min: geometry.boundingBox.min.toArray(),
          max: geometry.boundingBox.max.toArray(),
        }
      : undefined,
    sphere: geometry.boundingSphere
      ? {
          center: geometry.boundingSphere.center.toArray(),
          radius: geometry.boundingSphere.radius,
        }
      : undefined,
  };
}

/** Only for results from our own workers; imported files still use deserializeGeometry. */
export function restoreGeometry(snapshot: GeometrySnapshot) {
  const geometry = new BufferGeometry();
  for (const [name, attribute] of Object.entries(snapshot.attributes))
    geometry.setAttribute(
      name,
      new BufferAttribute(attribute.array, attribute.itemSize, attribute.normalized),
    );
  if (snapshot.index) geometry.setIndex(new BufferAttribute(snapshot.index.array, 1));
  if (snapshot.box)
    geometry.boundingBox = new Box3(
      new Vector3().fromArray(snapshot.box.min),
      new Vector3().fromArray(snapshot.box.max),
    );
  if (snapshot.sphere)
    geometry.boundingSphere = new Sphere(
      new Vector3().fromArray(snapshot.sphere.center),
      snapshot.sphere.radius,
    );
  return geometry;
}

export function snapshotBuffers(snapshot: GeometrySnapshot) {
  return [
    ...new Set([
      ...Object.values(snapshot.attributes).map((attribute) => attribute.array.buffer),
      ...(snapshot.index ? [snapshot.index.array.buffer] : []),
    ]),
  ] as ArrayBuffer[];
}

const revisions = new WeakMap<BufferGeometry, { stamp: unknown[]; key: string }>();
let revision = 0;
/** Meshes are immutable in the editor; also invalidate for normal Three.js attribute updates. */
export function geometryKey(geometry: BufferGeometry) {
  const stamp = ['position', 'normal', 'color'].map((name) => geometry.getAttribute(name));
  const values: unknown[] = [];
  for (const attribute of [...stamp, geometry.index]) {
    const buffer = attribute && ('data' in attribute ? attribute.data : attribute);
    values.push(
      attribute,
      buffer?.array,
      buffer?.version,
      attribute?.itemSize,
      attribute?.count,
      attribute?.normalized,
      attribute && 'offset' in attribute ? attribute.offset : undefined,
      buffer && 'stride' in buffer ? buffer.stride : undefined,
    );
  }
  const previous = revisions.get(geometry);
  if (previous && values.every((value, i) => value === previous.stamp[i])) return previous.key;
  const key = `${geometry.uuid}:${++revision}`;
  revisions.set(geometry, { stamp: values, key });
  return key;
}
