import { afterEach, describe, expect, it, vi } from 'vitest';
import { BufferGeometry, type Intersection, Mesh, Raycaster, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { pickRaycast } from '../../src/core/bvh';
import { triangleCount } from '../../src/core/geometry';
import { useEditor } from '../../src/core/store';
import { boxPart, editor, ready, session, setup, surfacePoint } from '../helpers/refine-session';
import { softBox } from '../helpers/soft-edges';

afterEach(() => {
  editor().cancelRefine();
  useEditor.setState({ tool: 'select' });
});

/** Rays down onto the top face and in onto the front face, over a grid across the box. */
function rays() {
  const list: Raycaster[] = [];
  for (let x = -1.8; x <= 1.8; x += 0.3)
    for (let t = -0.8; t <= 0.8; t += 0.4) {
      list.push(new Raycaster(new Vector3(x, 3, t), new Vector3(0, -1, 0)));
      list.push(new Raycaster(new Vector3(x, t * 1.5, 3), new Vector3(0, 0, -1)));
    }
  return list;
}

/**
 * Every ray picks the same triangle at the same point with the picking the viewport uses (the
 * preview's own tree, kept by the store) as by testing every triangle of the preview.
 */
function expectPickingMatches(preview: BufferGeometry) {
  const plain = new BufferGeometry();
  plain.setAttribute('position', preview.getAttribute('position'));
  plain.setIndex(preview.index);
  const viewport = new Mesh(preview),
    everyTriangle = new Mesh(plain);
  let compared = 0;
  for (const ray of rays()) {
    ray.firstHitOnly = true;
    const picked: Intersection[] = [],
      exact: Intersection[] = [];
    pickRaycast.call(viewport, ray, picked);
    Mesh.prototype.raycast.call(everyTriangle, ray, exact);
    exact.sort((a, b) => a.distance - b.distance);
    expect(picked.length > 0).toBe(exact.length > 0);
    if (!exact.length) continue;
    expect(picked[0].faceIndex).toBe(exact[0].faceIndex);
    expect(picked[0].point.distanceTo(exact[0].point)).toBeLessThan(1e-9);
    compared++;
  }
  expect(compared).toBeGreaterThan(50);
}

const crest = (x: number) => surfacePoint([x, 1.5 - 0.0879, 1 - 0.0879]);
const top = (x: number, z = 0) => surfacePoint([x, 1.5, z]);

describe('picking a Refine preview', () => {
  it('stays right after a dab, an accepted cut and its undo', async () => {
    // Between the sizes indexed synchronously and in a worker, so the preview is given a tree.
    const geometry = softBox([2, 1.5, 1], 0.3, { step: 0.04 });
    geometry.boundsTree = new MeshBVH(geometry, { indirect: true });
    setup([boxPart({ geometry })], ['box']);
    await ready();
    expect(session().preview!.boundsTree).toBeDefined();

    // A dab moves the top face under the rays before the stroke ends.
    editor().setRefineMode('brush');
    editor().setRefineBrush({ kind: 'flatten', strength: 1 });
    editor().setRefineBrushRadius(0.6);
    editor().beginRefineStroke(top(-0.6, 0.2));
    editor().moveRefineStroke(top(0.4, -0.2));
    expectPickingMatches(session().preview!);
    editor().endRefineStroke();
    expectPickingMatches(session().preview!);

    // An accepted edge cuts the mesh, so the preview is new with more triangles.
    editor().setRefineMode('edge');
    const before = triangleCount(session().preview!);
    editor().addRefinePoint(crest(-1.6));
    editor().addRefinePoint(crest(1.6));
    editor().acceptRefine();
    const cut = session().preview!;
    expect(triangleCount(cut)).toBeGreaterThan(before);
    expectPickingMatches(cut);
    await vi.waitFor(() => expect(cut.boundsTree).toBeDefined());
    expectPickingMatches(cut);

    // Undo brings back the triangles from before the cut.
    editor().undoRefine();
    expect(triangleCount(session().preview!)).toBe(before);
    expectPickingMatches(session().preview!);
  });
});
