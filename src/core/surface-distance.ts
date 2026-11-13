import { BufferAttribute, BufferGeometry, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { ProximitySource } from './proximity';
import shader from './surface-distance.wgsl?raw';

/** Own a position-only copy in one frame; no source index or attributes are reordered. */
function distanceMesh(sources: ProximitySource[]) {
  const vertices = sources.reduce((n, s) => n + s.geometry.attributes.position.count, 0);
  const count = sources.reduce(
    (n, s) => n + (s.geometry.index?.count ?? s.geometry.attributes.position.count),
    0,
  );
  if ((vertices * 3 + count) * 4 > 256 * 1024 * 1024)
    throw new Error('Distance mesh exceeds the memory budget.');
  const positions = new Float32Array(vertices * 3),
    indices = new Uint32Array(count);
  let v = 0,
    t = 0;
  const point = new Vector3();
  for (const { geometry, matrix } of sources) {
    const position = geometry.attributes.position;
    for (let i = 0; i < position.count; i++)
      point
        .fromBufferAttribute(position, i)
        .applyMatrix4(matrix)
        .toArray(positions, (v + i) * 3);
    const length = geometry.index?.count ?? position.count;
    for (let i = 0; i < length; i++) indices[t + i] = v + (geometry.index?.getX(i) ?? i);
    v += position.count;
    t += length;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  // setIndex accepts an attribute to preserve the Uint32Array without another copy.
  geometry.setIndex(new BufferAttribute(indices, 1));
  return geometry;
}

/** Public traversal API, independent of the library's private packed-node representation. */
export function packDistanceTree(tree: MeshBVH) {
  const rows: { bounds: Float32Array; skip: number; offset: number; count: number }[] = [];
  const stack: { index: number; depth: number }[] = [];
  tree.traverse((depth, leaf, bounds, offset, count) => {
    while (stack.length && stack[stack.length - 1].depth >= depth)
      rows[stack.pop()!.index].skip = rows.length;
    stack.push({ index: rows.length, depth });
    rows.push({
      bounds: bounds.slice(),
      skip: 0,
      offset: leaf ? offset : 0,
      count: leaf ? count! : 0,
    });
  });
  while (stack.length) rows[stack.pop()!.index].skip = rows.length;
  const buffer = new ArrayBuffer(rows.length * 48),
    floats = new Float32Array(buffer),
    words = new Uint32Array(buffer);
  rows.forEach((row, i) => {
    floats.set(row.bounds.subarray(0, 3), i * 12);
    words[i * 12 + 3] = row.skip;
    floats.set(row.bounds.subarray(3, 6), i * 12 + 4);
    words[i * 12 + 7] = row.offset;
    words[i * 12 + 8] = row.count;
  });
  return buffer;
}

/** Clamped nearest-surface distances. A failed or software-only adapter returns null for CPU fallback. */
export async function gpuSurfaceDistances(
  sources: ProximitySource[],
  points: Float32Array,
  range: number,
  allowSoftware = false,
): Promise<Float32Array | null> {
  if (
    !globalThis.navigator?.gpu ||
    !points.length ||
    points.length % 3 ||
    !Number.isFinite(range) ||
    range <= 0
  )
    return null;
  let device: GPUDevice | undefined, geometry: BufferGeometry | undefined;
  const buffers: GPUBuffer[] = [];
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter || (adapter.info.isFallbackAdapter && !allowSoftware)) return null;
    device = await adapter.requestDevice();
    device.pushErrorScope('out-of-memory');
    device.pushErrorScope('validation');
    geometry = distanceMesh(sources);
    if (!geometry.index?.count) return null;
    const tree = new MeshBVH(geometry, { targetLeafSize: 8, maxDepth: 40, indirect: false });
    const packed = packDistanceTree(tree);
    const positions = geometry.attributes.position.array as Float32Array;
    const indices = geometry.index!.array as Uint32Array;
    const create = (size: number, usage: GPUBufferUsageFlags) => {
      if (
        size > device!.limits.maxBufferSize ||
        (usage & GPUBufferUsage.STORAGE && size > device!.limits.maxStorageBufferBindingSize)
      )
        throw new Error('Distance buffers exceed this GPU limit.');
      const buffer = device!.createBuffer({ size: Math.max(4, size), usage });
      buffers.push(buffer);
      return buffer;
    };
    const upload = (data: ArrayBuffer | Float32Array | Uint32Array) => {
      const buffer = create(data.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      device!.queue.writeBuffer(buffer, 0, data as GPUAllowSharedBufferSource);
      return buffer;
    };
    const nodes = upload(packed),
      position = upload(positions),
      index = upload(indices);
    const batch = Math.min(
      65_536,
      device.limits.maxComputeWorkgroupsPerDimension * 64,
      points.length / 3,
    );
    const queries = create(batch * 12, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    const output = create(batch * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const readback = create(batch * 4, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    const params = create(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: shader }), entryPoint: 'main' },
    });
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [nodes, position, index, queries, output, params].map((buffer, binding) => ({
        binding,
        resource: { buffer },
      })),
    });
    const result = new Float32Array(points.length / 3);
    for (let start = 0; start < result.length; start += batch) {
      const count = Math.min(batch, result.length - start);
      const settings = new ArrayBuffer(16);
      new Uint32Array(settings).set([count, packed.byteLength / 48]);
      new Float32Array(settings)[2] = range;
      device.queue.writeBuffer(params, 0, settings);
      device.queue.writeBuffer(queries, 0, points.subarray(start * 3, (start + count) * 3));
      const encoder = device.createCommandEncoder(),
        pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(count / 64));
      pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, count * 4);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ, 0, count * 4);
      result.set(new Float32Array(readback.getMappedRange(0, count * 4)), start);
      readback.unmap();
    }
    const validation = await device.popErrorScope(),
      memory = await device.popErrorScope();
    if (validation || memory || result.some((value) => !Number.isFinite(value))) return null;
    return result;
  } catch {
    return null;
  } finally {
    for (const buffer of buffers) buffer.destroy();
    device?.destroy();
    geometry?.dispose();
  }
}

/** Reusable batch query API; CPU fallback measures the same triangles and never changes geometry. */
export async function surfaceDistances(
  sources: ProximitySource[],
  points: Float32Array,
  range: number,
  options: { gpu?: boolean; allowSoftware?: boolean } = {},
) {
  if (
    points.length % 3 ||
    !Number.isFinite(range) ||
    range <= 0 ||
    points.some((v) => !Number.isFinite(v))
  )
    throw new Error('Distance queries need finite points and a positive range.');
  const accelerated =
    options.gpu === false
      ? null
      : await gpuSurfaceDistances(sources, points, range, options.allowSoftware);
  if (accelerated) return { distances: accelerated, backend: 'webgpu' as const };
  const geometry = distanceMesh(sources);
  try {
    const result = new Float32Array(points.length / 3).fill(range);
    if (geometry.index?.count) {
      const tree = new MeshBVH(geometry, { targetLeafSize: 8 });
      const point = new Vector3();
      for (let i = 0; i < result.length; i++)
        result[i] = Math.min(
          range,
          tree.closestPointToPoint(point.fromArray(points, i * 3), undefined, 0, range)?.distance ??
            range,
        );
    }
    return { distances: result, backend: 'cpu' as const };
  } finally {
    geometry.dispose();
  }
}
