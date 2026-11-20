import { describe, expect, it } from 'vitest';
import { Box3, BufferAttribute, Matrix4, Quaternion, Vector3 } from 'three';
import {
  buildRefineMesh,
  cloneRefineMesh,
  foldedTriangles,
  moveVertex,
  vertexNormal,
  writeRefinedGeometry,
} from '../../src/core/refine-mesh';
import {
  changedTriangles,
  changedVertices,
  closed,
  duplicatesAgree,
  extent,
  fanNormalError,
  hasNaN,
  modelOf,
  nearWeldSeam,
  outwardFraction,
  splitEdge,
  tetrahedron,
  wideFan,
} from '../helpers/refine';
import { softBox } from '../helpers/soft-edges';

const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
const degrees = (start: Uint32Array) =>
  Array.from({ length: start.length - 1 }, (_, v) => start[v + 1] - start[v]);

const cases = [
  ['unindexed', {}],
  ['indexed', { indexed: true }],
] as const;
describe.each(cases)('refine mesh, %s', (_, options) => {
  const source = softBox([2, 1.5, 1], 0.3, options);
  const identity = new Matrix4();
  it('writes an untouched mesh back bit for bit', () => {
    const out = writeRefinedGeometry(source, identity, buildRefineMesh(source, identity));
    expect(out.getAttribute('position').array).toEqual(source.getAttribute('position').array);
    expect(out.getAttribute('normal').array).toEqual(source.getAttribute('normal').array);
    expect(!!out.index).toBe(!!source.index);
  });
  it('gives every duplicate of a moved vertex the same bits and leaves the rest alone', () => {
    const mesh = buildRefineMesh(source, identity);
    moveVertex(mesh, 7, mesh.position[21] + 0.1, mesh.position[22], mesh.position[23]);
    const out = writeRefinedGeometry(source, identity, mesh);
    expect(duplicatesAgree(out, mesh)).toBe(true);
    const changed = changedVertices(source, out);
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.every((g) => mesh.weldOf[g] === 7)).toBe(true);
    expect(closed(out)).toBe(true);
  });
});

it('has six neighbours and six triangles around a typical vertex', () => {
  const { topology } = modelOf(softBox([2, 1.5, 1], 0.3));
  expect(median(degrees(topology.neighbourStart))).toBe(6);
  expect(median(degrees(topology.triangleStart))).toBe(6);
});

it('works in world space and returns mesh-local positions', () => {
  const matrix = new Matrix4().compose(
    new Vector3(5, 0, 0),
    new Quaternion(),
    new Vector3(1, 2, -1),
  );
  const smooth = buildRefineMesh(softBox([2, 1.5, 1], 0.3, { ripple: 0, noise: 0 }), matrix);
  expect(extent(smooth.position)).toEqual([4, 6, 2].map((v) => expect.closeTo(v, 1)));

  const source = softBox([2, 1.5, 1], 0.3);
  const mesh = buildRefineMesh(source, matrix);
  expect(mesh.flipped).toBe(true);
  const size = new Box3()
    .setFromBufferAttribute(source.getAttribute('position') as BufferAttribute)
    .getSize(new Vector3());
  expect(extent(mesh.position)).toEqual(
    [size.x, size.y * 2, size.z].map((v) => expect.closeTo(v, 5)),
  );
  expect(outwardFraction(mesh, [5, 0, 0])).toBeGreaterThan(0.99);

  moveVertex(mesh, 7, mesh.position[21] + 0.1, mesh.position[22], mesh.position[23]);
  const out = writeRefinedGeometry(source, matrix, mesh);
  const vertex = mesh.weldOf.indexOf(7);
  const local = new Vector3().fromBufferAttribute(out.getAttribute('position'), vertex);
  const world = new Vector3(mesh.position[21], mesh.position[22], mesh.position[23]);
  expect(local.applyMatrix4(matrix).distanceTo(world)).toBeLessThan(1e-5);
});

it('recomputes outward normals for moved vertices under a mirroring matrix', () => {
  const matrix = new Matrix4().makeScale(1, 1, -1);
  const source = softBox([2, 1.5, 1], 0.3);
  const mesh = buildRefineMesh(source, matrix);
  moveVertex(mesh, 7, mesh.position[21], mesh.position[22], mesh.position[23]);
  const out = writeRefinedGeometry(source, matrix, mesh);
  const vertex = mesh.weldOf.indexOf(7);
  expect(changedVertices(source, out)).toContain(vertex);
  const before = new Vector3().fromBufferAttribute(source.getAttribute('normal'), vertex);
  const after = new Vector3().fromBufferAttribute(out.getAttribute('normal'), vertex);
  expect(after.length()).toBeCloseTo(1, 5);
  expect(after.dot(before)).toBeGreaterThan(0.9);
});

it('reports a triangle folded by pushing a vertex through its neighbours', () => {
  const { mesh, topology } = modelOf(softBox([2, 1.5, 1], 0.3));
  const distance = (v: number) =>
    Math.hypot(mesh.position[v * 3], mesh.position[v * 3 + 1], mesh.position[v * 3 + 2] - 1);
  let vertex = 0;
  for (let v = 1; v < mesh.weldedCount; v++) if (distance(v) < distance(vertex)) vertex = v;
  const before = mesh.position.slice();
  const around = Uint32Array.of(vertex);
  expect(foldedTriangles(mesh, topology, before, around).length).toBe(0);
  const normal = new Float32Array(3);
  vertexNormal(mesh, topology, vertex, normal);
  expect(normal[2]).toBeGreaterThan(0.95);
  // Drag the vertex across the +z face, past the far side of its ring.
  moveVertex(
    mesh,
    vertex,
    before[vertex * 3] + 0.15,
    before[vertex * 3 + 1],
    before[vertex * 3 + 2],
  );
  const folded = foldedTriangles(mesh, topology, before, around);
  const own = topology.trianglesOf.subarray(
    topology.triangleStart[vertex],
    topology.triangleStart[vertex + 1],
  );
  expect(folded.length).toBeGreaterThan(0);
  expect([...folded].every((t) => own.includes(t))).toBe(true);
  expect(mesh.touched[vertex]).toBe(1);
});

it('does not copy topology arrays unless asked', () => {
  const mesh = buildRefineMesh(softBox([2, 1.5, 1], 0.3), new Matrix4());
  expect(cloneRefineMesh(mesh, false).corners).toBe(mesh.corners);
  expect(cloneRefineMesh(mesh, true).corners).not.toBe(mesh.corners);
  expect(cloneRefineMesh(mesh, false).position).not.toBe(mesh.position);
});

describe.each(cases)('crease fans, %s', (_, options) => {
  const source = softBox([2, 1.5, 1], 0.3, options);
  /** Creases a vertex on the +z face and the two most opposite of its neighbours. */
  const creased = () => {
    const { mesh, topology } = modelOf(source);
    const p = (v: number) => new Vector3().fromArray(mesh.position, v * 3);
    let vertex = 0;
    for (let v = 1; v < mesh.weldedCount; v++)
      if (p(v).distanceTo(new Vector3(0, 0, 1)) < p(vertex).distanceTo(new Vector3(0, 0, 1)))
        vertex = v;
    const ring = [
      ...topology.neighbours.subarray(
        topology.neighbourStart[vertex],
        topology.neighbourStart[vertex + 1],
      ),
    ];
    const direction = (w: number) => p(w).sub(p(vertex)).normalize();
    const first = ring[0];
    const opposite = ring.reduce((best, w) =>
      direction(w).dot(direction(first)) < direction(best).dot(direction(first)) ? w : best,
    );
    for (const v of [vertex, first, opposite]) mesh.crease[v] = 1;
    moveVertex(mesh, vertex, ...(p(vertex).toArray() as [number, number, number]));
    return { mesh, vertex };
  };
  it('gives the corners of a crease vertex one normal per fan', () => {
    const { mesh, vertex } = creased();
    const out = writeRefinedGeometry(source, new Matrix4(), mesh);
    const normal = out.getAttribute('normal');
    const normals = new Set<string>();
    for (let i = 0; i < mesh.triangleCount * 3; i++)
      if (mesh.weldOf[mesh.corners[i]] === vertex) {
        const g = out.index ? out.index.getX(i) : i;
        normals.add([normal.getX(g), normal.getY(g), normal.getZ(g)].join());
      }
    expect(normals.size).toBe(2);
    expect(duplicatesAgree(out, mesh)).toBe(true);
    expect(closed(out)).toBe(true);
    const appended = source.index ? 1 : 0;
    expect(out.getAttribute('position').count).toBe(
      source.getAttribute('position').count + appended,
    );
  });
});

it('carries colour in the source array type and normalization', () => {
  const source = softBox([2, 1.5, 1], 0.3, { indexed: true });
  const count = source.getAttribute('position').count;
  const values = Uint8Array.from({ length: count * 4 }, (_, i) => (i * 37) % 256);
  source.setAttribute('color', new BufferAttribute(values, 4, true));
  const mesh = buildRefineMesh(source, new Matrix4());
  moveVertex(mesh, 7, mesh.position[21] + 0.1, mesh.position[22], mesh.position[23]);
  const color = writeRefinedGeometry(source, new Matrix4(), mesh).getAttribute('color');
  expect(color.array).toBeInstanceOf(Uint8Array);
  expect(color.normalized).toBe(true);
  expect(color.itemSize).toBe(4);
  expect(color.array).toEqual(values);
});

describe.each(cases)('closed cuts, %s', (_, options) => {
  const indexed = 'indexed' in options;
  const sources = [
    ['tetrahedron', tetrahedron(indexed)],
    ['soft box', softBox([2, 1.5, 1], 0.3, options)],
  ] as const;
  it.each(sources)('writes a split edge of a %s back valid and closed', (_, source) => {
    const mesh = buildRefineMesh(source, new Matrix4());
    const triangles = mesh.triangleCount;
    const { other } = splitEdge(mesh, 0);
    const out = writeRefinedGeometry(source, new Matrix4(), mesh);
    const box = out.boundingBox!,
      sphere = out.boundingSphere!;
    expect(
      hasNaN(
        out.getAttribute('position').array,
        out.getAttribute('normal').array,
        [...box.min.toArray(), ...box.max.toArray()],
        [...sphere.center.toArray(), sphere.radius],
      ),
    ).toBe(false);
    expect(closed(out)).toBe(true);
    expect((out.index?.count ?? out.getAttribute('position').count) / 3).toBe(triangles + 2);
    expect(changedTriangles(source, out, [0, other])).toEqual([]);
    expect(duplicatesAgree(out, mesh)).toBe(true);
  });
});

describe.each(cases)('near-weld seams, %s', (_, options) => {
  it('writes fan normals that match the faces as written', () => {
    const source = nearWeldSeam('indexed' in options);
    const mesh = buildRefineMesh(source, new Matrix4());
    const centre = mesh.weldOf[0];
    moveVertex(mesh, centre, mesh.position[centre * 3], mesh.position[centre * 3 + 1], 1e-6);
    const out = writeRefinedGeometry(source, new Matrix4(), mesh);
    expect(fanNormalError(out, mesh, centre)).toBeLessThan(0.5);
  });
});

it('copies untouched values in their own storage', () => {
  const source = softBox([2, 1.5, 1], 0.3, { indexed: true });
  const count = source.getAttribute('position').count;
  const position = Float64Array.from(source.getAttribute('position').array, (v) => v + 1e-9);
  source.setAttribute('position', new BufferAttribute(position, 3));
  const colors = Uint32Array.from({ length: count * 3 }, (_, i) => 16777217 + i);
  source.setAttribute('color', new BufferAttribute(colors, 3));
  const mesh = buildRefineMesh(source, new Matrix4());
  moveVertex(mesh, 7, mesh.position[21] + 0.1, mesh.position[22], mesh.position[23]);
  const out = writeRefinedGeometry(source, new Matrix4(), mesh);
  const written = out.getAttribute('position').array;
  expect(written).toBeInstanceOf(Float64Array);
  for (let g = 0; g < count; g++)
    if (mesh.weldOf[g] !== 7)
      for (let axis = 0; axis < 3; axis++)
        expect(written[g * 3 + axis]).toBe(position[g * 3 + axis]);
  const color = out.getAttribute('color').array;
  expect(color).toBeInstanceOf(Uint32Array);
  expect(color).toEqual(colors);
  expect(color[0]).toBe(16777217);
});

it('writes back a touched vertex with 50,000 triangles around it quickly', () => {
  const source = wideFan(50_000);
  const mesh = buildRefineMesh(source, new Matrix4());
  const centre = mesh.weldOf[0];
  moveVertex(mesh, centre, 0, 0, 0.1);
  const start = performance.now();
  const out = writeRefinedGeometry(source, new Matrix4(), mesh);
  expect(performance.now() - start).toBeLessThan(2000);
  expect(out.getAttribute('normal').getZ(0)).toBeGreaterThan(0.99);
});

it('places unmoved vertices at their translated world position', () => {
  const matrix = new Matrix4().compose(
    new Vector3(5.5, -1.25, 0.75),
    new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.3),
    new Vector3(1, 2, -1),
  );
  const source = softBox([2, 1.5, 1], 0.3);
  const mesh = buildRefineMesh(source, matrix);
  const position = source.getAttribute('position');
  for (const g of [0, 100, position.count - 1]) {
    const expected = new Vector3().fromBufferAttribute(position, g).applyMatrix4(matrix);
    const world = new Vector3().fromArray(mesh.position, mesh.weldOf[g] * 3);
    expect(world.distanceTo(expected)).toBeLessThan(1e-5);
  }
});
