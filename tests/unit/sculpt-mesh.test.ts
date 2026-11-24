import {
  BufferAttribute,
  BufferGeometry,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Raycaster,
  Vector3,
  type Intersection,
} from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { describe, expect, it } from 'vitest';
import { SculptMesh, type SculptDab } from '../../src/core/sculpt-mesh';

const identity = new Matrix4();
const dab = (point: Vector3, settings: Partial<SculptDab> = {}): SculptDab => ({
  point,
  normal: new Vector3(0, 0, 1),
  face: 0,
  radius: 0.8,
  strength: 1,
  detail: 0.6,
  minEdge: 0.04,
  brush: 'draw',
  falloff: 'soft',
  ...settings,
});

function mesh(positions: number[], corners?: number[]) {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(Float32Array.from(positions), 3));
  if (corners) geometry.setIndex(corners);
  geometry.computeVertexNormals();
  return geometry;
}

describe('sculpt mesh', () => {
  it('adds detail under a small dab in a coarse face, keeping original positions and winding', () => {
    const source = mesh([-4, -3, 0, 4, -3, 0, 0, 4, 0], [0, 1, 2]);
    const draft = new SculptMesh(source, identity);
    expect(draft.dab(dab(new Vector3(0.3, 0.4, 0)))).toBe(true);
    const output = draft.finish()!;
    const positions = output.getAttribute('position');
    expect(positions.count).toBeGreaterThan(3);
    expect(Array.from(positions.array.slice(0, 9))).toEqual(
      Array.from(source.getAttribute('position').array),
    );
    expect(
      Array.from({ length: positions.count }, (_, vertex) => positions.getZ(vertex)).some(
        (z) => z > 0,
      ),
    ).toBe(true);
    const meshObject = new Mesh(draft.geometry, new MeshBasicMaterial());
    const caster = new Raycaster(new Vector3(0.3, 0.4, 3), new Vector3(0, 0, -1));
    expect(caster.intersectObject(meshObject)[0]?.point.z).toBeGreaterThan(0);
    expect(source.index?.count).toBe(3);
  });

  it('splits both sides of an unindexed color and normal seam at matching positions', () => {
    const source = mesh([-4, 0, 0, 4, 0, 0, 0, 4, 0, 4, 0, 0, -4, 0, 0, 0, -4, 2]);
    source.setAttribute(
      'color',
      new BufferAttribute(
        Float32Array.from([1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        3,
      ),
    );
    const draft = new SculptMesh(source, identity);
    expect(draft.dab(dab(new Vector3(0, 0, 0), { brush: 'mask' }))).toBe(true);
    const output = draft.finish()!;
    const pos = output.getAttribute('position');
    const color = output.getAttribute('color');
    const normal = output.getAttribute('normal');
    const midpoint = [...Array(pos.count).keys()].filter(
      (v) => pos.getX(v) === 0 && pos.getY(v) === 0,
    );
    expect(midpoint).toHaveLength(2);
    expect(color.getX(midpoint[0])).not.toBe(color.getX(midpoint[1]));
    expect(normal.getY(midpoint[0])).not.toBe(normal.getY(midpoint[1]));
    expect(draft.getMask()[midpoint[0]]).toBe(draft.getMask()[midpoint[1]]);
    expect(output.getAttribute('sculptMask')).toBeUndefined();
  });

  it('keeps protection and pending topology unchanged when a sculpt dab has no effect', () => {
    const source = mesh([-4, -3, 0, 4, -3, 0, 0, 4, 0]);
    const draft = new SculptMesh(source, identity, new Float32Array([1, 1, 1]));
    expect(draft.dab(dab(new Vector3(0, 0, 0)))).toBe(false);
    expect(draft.finish()).toBeNull();
    expect(draft.getMask()).toEqual(new Float32Array([1, 1, 1]));
    expect(draft.geometry.drawRange.count).toBe(3);
  });

  it('protects points proportionally and applies overlapping symmetry once in world units', () => {
    const source = mesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]);
    const transform = new Matrix4().makeScale(2, 3, 5).setPosition(4, 8, 1);
    const point = new Vector3(4, 8, 1);
    const settings = { minEdge: 100, mirror: { point, normal: new Vector3(0, 0, 1), face: 0 } };
    const direct = new SculptMesh(source, transform);
    const masked = new SculptMesh(source, transform, new Float32Array([0.5, 0, 0]));
    direct.dab(dab(point, { minEdge: 100 }));
    masked.dab(dab(point, settings));
    expect(masked.finish()!.getAttribute('position').getZ(0)).toBeCloseTo(
      direct.finish()!.getAttribute('position').getZ(0) / 2,
    );
  });

  it('ignores a nearby disconnected shell', () => {
    const source = mesh([
      -2, -2, 0, 2, -2, 0, 0, 2, 0, -2, -2, -0.000001, 2, -2, -0.000001, 0, 2, -0.000001,
    ]);
    const draft = new SculptMesh(source, identity);
    expect(draft.dab(dab(new Vector3(0, 0, 0)))).toBe(true);
    const output = draft.finish()!;
    const corners = output.getIndex()!;
    expect([corners.getX(3), corners.getX(4), corners.getX(5)]).toEqual([3, 4, 5]);
  });

  it.each([false, true])(
    'keeps separate shells independent at a coincident corner (indexed: %s)',
    (indexed) => {
      const source = mesh(
        [0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 0, -2, 0, 0, 0, -2, 0],
        indexed ? [0, 1, 2, 3, 4, 5] : undefined,
      );
      const draft = new SculptMesh(source, identity);
      expect(draft.dab(dab(new Vector3(), { minEdge: 100 }))).toBe(true);
      const positions = draft.finish()!.getAttribute('position');
      expect(positions.getZ(0)).toBeGreaterThan(0);
      expect(positions.getZ(3)).toBe(0);
    },
  );

  it('reuses source ray acceleration and picks live triangle positions after splits', () => {
    const source = mesh([-4, -3, 0, 4, -3, 0, 0, 4, 0], [0, 1, 2]);
    source.boundsTree = new MeshBVH(source, { indirect: true, targetLeafSize: 1 });
    const draft = new SculptMesh(source, identity);
    const point = new Vector3(0.3, 0.4, 0);
    draft.dab(dab(point));
    const object = new Mesh(draft.geometry, new MeshBasicMaterial());
    const caster = new Raycaster(point.clone().setZ(3), new Vector3(0, 0, -1));
    caster.firstHitOnly = true;
    const hits: Intersection[] = [];
    draft.raycast(caster, object, hits);
    expect(hits).toHaveLength(1);
    expect(hits[0].point.z).toBeGreaterThan(0);
    expect(hits[0].faceIndex).toBeLessThan(object.geometry.drawRange.count / 3);
    expect(hits[0].point.z).toBeCloseTo(caster.intersectObject(object)[0].point.z);
  });

  it('refits an immutable committed picking tree after deformation without subdivision', () => {
    const source = mesh([0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 5, 0, 6, 5, 0, 5, 6, 0], [0, 1, 2, 3, 4, 5]);
    source.boundsTree = new MeshBVH(source, { indirect: true, targetLeafSize: 1 });
    const point = new Vector3(0, 0, 0);
    const draft = new SculptMesh(source, identity);
    expect(draft.dab(dab(point, { minEdge: 100 }))).toBe(true);
    const output = draft.finish()!;
    const ray = new Raycaster(new Vector3(0.05, 0.05, 1), new Vector3(0, 0, -1)).ray;
    expect((output.boundsTree as MeshBVH).raycastFirst(ray)?.point.z).toBeGreaterThan(0);
    expect((source.boundsTree as MeshBVH).raycastFirst(ray)?.point.z).toBe(0);
    expect(output.index?.count).toBe(6);
  });

  it('keeps the original grab weights across a long drag and after refinement', () => {
    const source = mesh([-4, -3, 0, 4, -3, 0, 0, 4, 0], [0, 1, 2]);
    const draft = new SculptMesh(source, identity);
    const point = new Vector3(0.3, 0.4, 0);
    const grab = dab(point, { brush: 'grab', grab: new Vector3(1.5, 0, 0) });
    expect(draft.dab(grab)).toBe(true);
    const first = draft.finish()!.getAttribute('position');
    expect(draft.dab(grab)).toBe(true);
    const second = draft.finish()!.getAttribute('position');
    expect(second.count).toBe(first.count);
    expect(second.array).not.toEqual(first.array);
  });

  it('softens, erases, inverts, and clears mask values without committing dense geometry', () => {
    const source = mesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]);
    const draft = new SculptMesh(source, identity, new Float32Array([1, 0, 0]));
    const settings = dab(new Vector3(), { brush: 'mask', minEdge: 100, strength: 0.25 });
    expect(draft.dab({ ...settings, softenMask: true })).toBe(true);
    expect(draft.getMask()).toEqual(new Float32Array([0.75, 0, 0]));
    expect(draft.dab({ ...settings, inverted: true })).toBe(true);
    expect(draft.getMask()).toEqual(new Float32Array([0.5, 0, 0]));
    expect(draft.invertMask()).toBe(true);
    expect(draft.getMask()).toEqual(new Float32Array([0.5, 1, 1]));
    expect(draft.clearMask()).toBe(true);
    expect(draft.getMask()).toEqual(new Float32Array(3));
    expect(draft.finish()).toBeNull();
  });

  it('can refine and sculpt a previously subdivided mask commit', () => {
    const source = mesh([-4, -3, 0, 4, -3, 0, 0, 4, 0], [0, 1, 2]);
    const paint = new SculptMesh(source, identity);
    expect(paint.dab(dab(new Vector3(0.3, 0.4, 0), { brush: 'mask', strength: 0.4 }))).toBe(true);
    const painted = paint.finish()!;
    const next = new SculptMesh(painted, identity, paint.getMask());
    const point = new Vector3(0.3, 0.4, 0);
    const object = new Mesh(next.geometry, new MeshBasicMaterial());
    const caster = new Raycaster(point.clone().setZ(3), new Vector3(0, 0, -1));
    const hit = caster.intersectObject(object)[0];
    expect(next.dab(dab(point, { face: hit.faceIndex!, detail: 1 }))).toBe(true);
    expect(next.finish()!.index!.count).toBeGreaterThanOrEqual(painted.index!.count);
    expect(paint.getMask()).toHaveLength(painted.getAttribute('position').count);
  });

  it('cuts a pinched groove and uses inverted depth for a pinched ridge', () => {
    const source = mesh([0, 0, 0, 0.5, 0, 0, 0, 0.5, 0], [0, 1, 2]);
    const settings = dab(new Vector3(), {
      brush: 'crease',
      pinch: 1,
      tangent: new Vector3(0, 1, 0),
      minEdge: 100,
    });
    const groove = new SculptMesh(source, identity);
    const ridge = new SculptMesh(source, identity);
    expect(groove.dab(settings)).toBe(true);
    expect(ridge.dab({ ...settings, inverted: true })).toBe(true);
    const cut = groove.finish()!.getAttribute('position');
    const raised = ridge.finish()!.getAttribute('position');
    expect(cut.getX(1)).toBeLessThan(0.5);
    expect(raised.getX(1)).toBe(cut.getX(1));
    expect(cut.getZ(0)).toBeLessThan(0);
    expect(raised.getZ(0)).toBe(-cut.getZ(0));
  });

  it('builds clay toward a surface plane and inflates using an individual vertex normal', () => {
    const source = mesh([0, 0, 0, 0.5, 0, 0, 0, 0.5, 0, -0.5, 0, 0.5], [0, 1, 2, 0, 2, 3]);
    const clay = new SculptMesh(source, identity);
    const inflate = new SculptMesh(source, identity);
    const settings = dab(new Vector3(), { minEdge: 100 });
    expect(clay.dab({ ...settings, brush: 'clay' })).toBe(true);
    expect(inflate.dab({ ...settings, brush: 'inflate' })).toBe(true);
    const buildup = clay.finish()!.getAttribute('position');
    const inflated = inflate.finish()!.getAttribute('position');
    expect(buildup.getZ(0)).toBeGreaterThan(0);
    expect(buildup.getX(0)).toBe(0);
    expect(inflated.getX(0)).toBeGreaterThan(0);
    expect(inflated.getZ(0)).toBeGreaterThan(0);
  });

  it('limits refinement work per dab', () => {
    const source = mesh([-20, -20, 0, 20, -20, 0, 0, 20, 0], [0, 1, 2]);
    const draft = new SculptMesh(source, identity);
    const changed = draft.dab(
      dab(new Vector3(), {
        brush: 'mask',
        radius: 5,
        detail: 1,
        minEdge: 0.01,
      }),
    );
    expect(changed).toBe(true);
    expect(draft.geometry.index!.count / 3).toBeLessThanOrEqual(1 + 2 * 192);
  });

  it('keeps the original growth budget across committed strokes', () => {
    const positions: number[] = [];
    const faces: number[] = [];
    for (let i = 0; i < 60; i++) {
      const x = i * 100;
      positions.push(x - 20, -20, 0, x + 20, -20, 0, x, 20, 0);
      faces.push(i * 3, i * 3 + 1, i * 3 + 2);
    }
    let source = mesh(positions, faces);
    let limited = false;
    for (let i = 0; i < 60 && !limited; i++) {
      const draft = new SculptMesh(source, identity);
      draft.dab(
        dab(new Vector3(i * 100, 0, 0), {
          brush: 'mask',
          face: i,
          radius: 5,
          detail: 1,
          minEdge: 0.01,
        }),
      );
      const committed = draft.finish();
      if (committed) source = committed;
      limited = draft.detailLimited;
    }
    expect(limited).toBe(true);
    expect(source.index!.count / 3).toBeLessThanOrEqual(60 + 4096);
  });
});
