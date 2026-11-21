import {
  BoxGeometry,
  BufferAttribute,
  type BufferGeometry,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  Matrix4,
  Quaternion,
  Vector3,
} from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type RefineProposal, detectDefaults, detectFeatures } from '../../src/core/refine-detect';
import { solveEdge } from '../../src/core/refine-edge';
import { buildRefineModelJob, detectRefineJob } from '../../src/core/refine-job';
import * as refineMesh from '../../src/core/refine-mesh';
import { buildRefineMesh, buildTopology } from '../../src/core/refine-mesh';
import {
  buildRefineModel,
  keepSolvable,
  modelFromMesh,
  refineModelInput,
} from '../../src/core/refine-model';
import { modelFrom } from '../helpers/refine';
import { softBox } from '../helpers/soft-edges';

const signal = () => new AbortController().signal;
const bits = (array: Float64Array) =>
  new BigUint64Array(array.buffer, array.byteOffset, array.length);
const options = { triangles: null, ...detectDefaults };
const edgesOf = (found: RefineProposal[]) => found.filter((p) => p.type === 'edge');

const placed = new Matrix4().compose(
  new Vector3(3.1, -0.7, 12.3),
  new Quaternion().setFromAxisAngle(new Vector3(1, 2, 3).normalize(), 0.7),
  new Vector3(1.3, 1.3, 1.3),
);

function float64Box() {
  const geometry = softBox([2, 1.5, 1], 0.3);
  const source = geometry.getAttribute('position').array;
  // Offsets far below the weld tolerance that a float32 cannot hold.
  const wide = Float64Array.from(source, (value, i) => value + ((i % 7) + 1) * 1e-9);
  geometry.setAttribute('position', new BufferAttribute(wide, 3));
  return geometry;
}

function colouredIndexedBox() {
  const geometry = softBox([2, 1.5, 1], 0.3, { indexed: true });
  const count = geometry.getAttribute('position').count;
  const colour = Uint8Array.from({ length: count * 3 }, (_, i) => (i * 37) % 256);
  geometry.setAttribute('color', new BufferAttribute(colour, 3, true));
  return geometry;
}

function expectSameModel(geometry: BufferGeometry, matrix: Matrix4) {
  const direct = modelFrom(buildRefineMesh(geometry, matrix));
  const built = buildRefineModel(refineModelInput(geometry, matrix));
  expect(bits(built.mesh.position)).toEqual(bits(direct.mesh.position));
  expect(built.mesh).toEqual(direct.mesh);
  expect(built.topology).toEqual(direct.topology);
  expect(built.noise).toBe(direct.noise);
  expect(built.step).toBe(direct.step);
}

describe('buildRefineModel', () => {
  it('matches the model built from the geometry, unindexed float32', () => {
    expectSameModel(softBox([2, 1.5, 1], 0.3), placed);
  });

  it('matches the model built from the geometry, indexed with normalized colour', () => {
    const geometry = colouredIndexedBox();
    expect(geometry.index).not.toBeNull();
    expectSameModel(geometry, placed);
  });

  it('matches the model built from the geometry, float64 positions', () => {
    const geometry = float64Box();
    expect(refineModelInput(geometry, placed).positions).toBeInstanceOf(Float64Array);
    expectSameModel(geometry, placed);
  });

  it('keeps a coordinate an accessor decodes past float32 precision', () => {
    class Offset extends InterleavedBufferAttribute {
      override getX(i: number) {
        return super.getX(i) + 1e-9;
      }
    }
    const geometry = new BoxGeometry();
    const source = geometry.getAttribute('position');
    const raw = new Float32Array(source.count * 4);
    for (let i = 0; i < source.count; i++)
      raw.set([0, source.getX(i), source.getY(i), source.getZ(i)], i * 4);
    geometry.setAttribute('position', new Offset(new InterleavedBuffer(raw, 4), 3, 1));
    const direct = modelFrom(buildRefineMesh(geometry, new Matrix4()));
    const packed = buildRefineModel(refineModelInput(geometry, new Matrix4()));
    expect(direct.mesh.position[0]).toBe(0.500000001);
    expect(packed.mesh.position).toEqual(direct.mesh.position);
  });

  it('copies the source arrays', () => {
    const geometry = colouredIndexedBox();
    const input = refineModelInput(geometry, placed);
    expect(input.positions.buffer).not.toBe(geometry.getAttribute('position').array.buffer);
    expect(input.index!.buffer).not.toBe(geometry.index!.array.buffer);
    expect(input.color!.buffer).not.toBe(geometry.getAttribute('color').array.buffer);
  });
});

describe('modelFromMesh', () => {
  it('rebuilds the topology and keeps noise and step', () => {
    const previous = buildRefineModel(refineModelInput(softBox([2, 1.5, 1], 0.3), new Matrix4()));
    const model = modelFromMesh(previous.mesh, { ...previous, noise: 0.25, step: 0.5 });
    expect(model.mesh).toBe(previous.mesh);
    expect(model.topology).toEqual(buildTopology(previous.mesh));
    expect(model.topology).not.toBe(previous.topology);
    expect(model.noise).toBe(0.25);
    expect(model.step).toBe(0.5);
  });
});

describe('buildRefineModelJob', () => {
  afterEach(() => vi.restoreAllMocks());

  it('builds nothing when cancelled before the job starts work', async () => {
    const build = vi.spyOn(refineMesh, 'buildRefineMesh');
    const input = refineModelInput(softBox([2, 1.5, 1], 0.3), new Matrix4());
    const controller = new AbortController();
    const pending = buildRefineModelJob(input, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(build).not.toHaveBeenCalled();
  });

  it('builds the same model in a job as directly', async () => {
    const geometry = softBox([2, 1.5, 1], 0.3);
    const direct = buildRefineModel(refineModelInput(geometry, new Matrix4()));
    const job = await buildRefineModelJob(refineModelInput(geometry, new Matrix4()), signal());
    expect(job.mesh.position).toEqual(direct.mesh.position);
    expect(job).toEqual(direct);
    expect(job.step).toBeCloseTo(0.06, 1);
  });

  it('returns a model of the right array classes', async () => {
    const job = await buildRefineModelJob(refineModelInput(colouredIndexedBox(), placed), signal());
    expect(job.mesh.position).toBeInstanceOf(Float64Array);
    for (const array of [job.mesh.weldOf, job.mesh.corners, ...Object.values(job.topology)])
      expect(array).toBeInstanceOf(Uint32Array);
    expect(job.mesh.color).toBeInstanceOf(Float32Array);
    expect(job.mesh.touched).toBeInstanceOf(Uint8Array);
    expect(job.mesh.crease).toBeInstanceOf(Uint8Array);
  });

  it('returns a model solveEdge can use at once', async () => {
    const geometry = softBox([2, 1.5, 1], 0.3);
    const job = await buildRefineModelJob(refineModelInput(geometry, new Matrix4()), signal());
    const direct = buildRefineModel(refineModelInput(geometry, new Matrix4()));
    const [edge] = edgesOf(detectFeatures(direct.mesh, direct.topology, direct.noise, options));
    if (edge.type !== 'edge') throw new Error('expected an edge');
    const solved = solveEdge(job.mesh, job.topology, edge.input, job.noise)!;
    const expected = solveEdge(direct.mesh, direct.topology, edge.input, direct.noise)!;
    expect(solved).not.toBeNull();
    for (const key of ['width', 'deviation', 'bounds', 'sign', 'ends'] as const)
      expect(solved[key]).toEqual(expected[key]);
  });

  it('does not detach the source geometry', async () => {
    const geometry = softBox([2, 1.5, 1], 0.3);
    await buildRefineModelJob(refineModelInput(geometry, new Matrix4()), signal());
    expect(geometry.getAttribute('position').array.length).toBeGreaterThan(0);
  });

  it('rejects at once when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const job = buildRefineModelJob(
      refineModelInput(softBox([2, 1.5, 1], 0.3), new Matrix4()),
      controller.signal,
    );
    await expect(job).rejects.toThrow('cancelled');
    await expect(job).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('detectRefineJob', () => {
  it('detects through the job and reports progress', async () => {
    const model = buildRefineModel(refineModelInput(softBox([2, 1.5, 1], 0.3), new Matrix4()));
    const position = model.mesh.position.slice();
    const reports: number[] = [];
    const found = await detectRefineJob(model, options, signal(), (f) => reports.push(f));
    const edges = edgesOf(found);
    expect(edges).toHaveLength(12);
    for (const edge of edges)
      if (edge.type === 'edge')
        expect(solveEdge(model.mesh, model.topology, edge.input, model.noise)).not.toBeNull();
    expect(found).toEqual(detectFeatures(model.mesh, model.topology, model.noise, options));
    expect(reports.length).toBeGreaterThan(found.length);
    expect(reports.at(-1)).toBe(1);
    for (let i = 1; i < reports.length; i++)
      expect(reports[i]).toBeGreaterThanOrEqual(reports[i - 1]);
    expect(model.mesh.position).toEqual(position);
  });

  it('rejects at once when already aborted', async () => {
    const model = buildRefineModel(refineModelInput(softBox([2, 1.5, 1], 0.3), new Matrix4()));
    const controller = new AbortController();
    controller.abort();
    const job = detectRefineJob(model, options, controller.signal, () => {});
    await expect(job).rejects.toThrow('cancelled');
    await expect(job).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects when aborted during the job', async () => {
    const model = buildRefineModel(refineModelInput(softBox([2, 1.5, 1], 0.3), new Matrix4()));
    const controller = new AbortController();
    const job = detectRefineJob(model, options, controller.signal, (f) => {
      if (f > 0.75) controller.abort();
    });
    await expect(job).rejects.toThrow('cancelled');
    await expect(job).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('keepSolvable', () => {
  it('drops an edge proposal that cannot be solved and keeps the order', () => {
    const model = buildRefineModel(refineModelInput(softBox([2, 1.5, 1], 0.3), new Matrix4()));
    const found = detectFeatures(model.mesh, model.topology, model.noise, options);
    const edge = found.find((p) => p.type === 'edge')!;
    if (edge.type !== 'edge') throw new Error('expected an edge');
    // A joint more than the segments allow, which solveEdge refuses.
    const broken: RefineProposal = {
      type: 'edge',
      input: { ...edge.input, joints: [...edge.input.joints, 'sharp'] },
    };
    const reports: number[] = [];
    const kept = keepSolvable(model, [found[0], broken, ...found.slice(1)], (f) => reports.push(f));
    expect(kept).toEqual(found);
    expect(kept[0]).toBe(found[0]);
    expect(reports).toHaveLength(found.length + 1);
    expect(reports[0]).toBeCloseTo(0.7 + 0.3 / (found.length + 1), 12);
    expect(reports.at(-1)).toBe(1);
  });

  it('ends its progress at exactly 1', () => {
    const model = buildRefineModel(refineModelInput(new BoxGeometry(), new Matrix4()));
    const region: RefineProposal = {
      type: 'region',
      input: {
        triangles: new Uint32Array([0]),
        treatment: 'flatten',
        shape: 'auto',
        strength: 1,
        keepDetail: true,
        detail: null,
        blend: null,
      },
    };
    const reports: number[] = [];
    keepSolvable(
      model,
      Array.from({ length: 109 }, () => region),
      (fraction) => reports.push(fraction),
    );
    expect(reports.at(-1)).toBe(1);
  });

  it('stops between proposals when aborted', () => {
    const model = buildRefineModel(refineModelInput(softBox([2, 1.5, 1], 0.3), new Matrix4()));
    const found = detectFeatures(model.mesh, model.topology, model.noise, options);
    const controller = new AbortController();
    let reports = 0;
    expect(() =>
      keepSolvable(model, found, () => ++reports === 2 && controller.abort(), controller.signal),
    ).toThrow('cancelled');
    expect(reports).toBe(2);
  });
});
