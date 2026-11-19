import { afterEach, describe, expect, it } from 'vitest';
import {
  BufferAttribute,
  BufferGeometry,
  LatheGeometry,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  Triangle,
  Vector2,
  Vector3,
} from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { triangleCount } from '../../src/core/geometry';
import { useEditor } from '../../src/core/store';
import { readFace } from '../../src/core/surfaces';
import type { Part } from '../../src/core/types';
import { scanLike } from '../helpers/scan-like';
import { writtenNodePositions } from '../../src/core/warp-evaluate';
import { buildWarpModel, type WarpModel } from '../../src/core/warp-model';
import {
  traceWarpGridPathNow,
  warpGridChords,
  warpGridDrawnEdges,
  WarpGridDrawing,
  warpGridPathLimits,
  warpGridSegments,
  writeWarpGridPath,
  type WarpGridPath,
} from '../../src/core/warp-grid-path';

function model(geometry: BufferGeometry, density: number, matrix = new Matrix4()) {
  const position = geometry.getAttribute('position');
  return buildWarpModel({
    positions: new Float32Array(position.array),
    index: geometry.index ? new Uint32Array(geometry.index.array) : null,
    normals: null,
    matrix: matrix.elements.slice(),
    faces: null,
    density,
  });
}

/** Local node positions at rest. */
function restLocal(model: WarpModel) {
  const local = new Float32Array(model.restNodes.length);
  const inverse = new Matrix4().fromArray(model.inverse),
    point = new Vector3();
  for (let i = 0; i < local.length; i += 3)
    point.fromArray(model.restNodes, i).applyMatrix4(inverse).toArray(local, i);
  return local;
}

function segments(model: WarpModel, path: WarpGridPath) {
  const out = new Float32Array(warpGridSegments(path) * 6);
  writeWarpGridPath(path, restLocal(model), model.positions, null, out);
  return out;
}

/** The furthest any segment's middle lies from the surface, over its edge's length. */
function worstDip(geometry: BufferGeometry, model: WarpModel, path: WarpGridPath) {
  const bvh = new MeshBVH(geometry);
  const out = segments(model, path);
  const middle = new Vector3();
  let worst = 0,
    s = 0;
  for (let e = 0; e < path.length.length; e++) {
    // Lengths are world; these tests' matrices scale by at most 2.
    const edge = path.length[e];
    for (let k = path.start[e]; k <= path.start[e + 1]; k++, s++) {
      middle.set(
        (out[s * 6] + out[s * 6 + 3]) / 2,
        (out[s * 6 + 1] + out[s * 6 + 4]) / 2,
        (out[s * 6 + 2] + out[s * 6 + 5]) / 2,
      );
      const hit = bvh.closestPointToPoint(middle)!;
      worst = Math.max(worst, hit.distance / edge);
    }
  }
  return worst;
}

const sphere = () => new SphereGeometry(15, 96, 64);

describe('grid paths', () => {
  it('lay every edge of a curved part on its surface', async () => {
    const geometry = sphere();
    for (const density of [0, 3, 6]) {
      const m = await model(geometry, density);
      const path = traceWarpGridPathNow(m);
      expect(path.failed, `density ${density}`).toBe(0);
      expect(path.from.length).toBeGreaterThan(0);
      // A chord between nodes dips by up to an eighth of a radian's turn; a traced edge by the
      // tolerance its kept points allow.
      expect(worstDip(geometry, m, path), `density ${density}`).toBeLessThan(
        warpGridPathLimits.tolerance * 1.01,
      );
      const chords = segments(m, { ...path, start: new Uint32Array(path.start.length) });
      expect(chords.every(Number.isFinite)).toBe(true);
    }
  });

  it('keep evenly spaced points on a flat part, where no bend needs them', async () => {
    // Fine enough that each grid edge crosses several mesh edges.
    const m = await model(new PlaneGeometry(30, 30, 120, 120), 3);
    const path = traceWarpGridPathNow(m);
    expect(path.failed).toBe(0);
    // Every edge that spans several mesh edges keeps at least three points, spread so that no
    // piece of the line spans half the edge: it can follow the surface once it bends. Along the
    // border, where the grid keeps every vertex, edges are single mesh edges.
    let long = 0;
    for (let e = 0; e < path.length.length; e++) {
      if (path.length[e] < 1) continue;
      long++;
      expect(path.start[e + 1] - path.start[e]).toBeGreaterThanOrEqual(3);
      const along = [0, ...path.along.subarray(path.start[e], path.start[e + 1]), 1];
      for (let k = 1; k < along.length; k++) expect(along[k] - along[k - 1]).toBeLessThan(0.5);
    }
    expect(long).toBeGreaterThan(path.length.length / 2);
  });

  it('stay on their own side of a thin shell', async () => {
    const radius = 15;
    const arc = (r: number) =>
      Array.from({ length: 41 }, (_, i) => {
        const a = (i / 40) * (Math.PI / 2);
        return new Vector2(r * Math.cos(a), r * Math.sin(a));
      });
    const outer = arc(radius),
      inner = arc(radius - 0.8).reverse();
    const geometry = new LatheGeometry([...outer, ...inner, outer[0]], 96);
    for (const density of [0, 3]) {
      const m = await model(geometry, density);
      const path = traceWarpGridPathNow(m);
      const out = segments(m, path);
      // The flat face along the rim joins the two sheets: a point on it is on neither.
      const sheet = (x: number, y: number, z: number) =>
        y < 1e-4 ? 'rim' : Math.hypot(x, y, z) > radius - 0.4 ? 'outer' : 'inner';
      let s = 0,
        checked = 0;
      for (let e = 0; e < path.length.length; e++) {
        const count = path.start[e + 1] - path.start[e] + 1;
        const first = sheet(out[s * 6], out[s * 6 + 1], out[s * 6 + 2]),
          last = sheet(
            out[(s + count) * 6 - 3],
            out[(s + count) * 6 - 2],
            out[(s + count) * 6 - 1],
          );
        if (first === last && first !== 'rim')
          for (let k = 0; k < count; k++, checked++)
            expect(sheet(out[(s + k) * 6 + 3], out[(s + k) * 6 + 4], out[(s + k) * 6 + 5])).toMatch(
              new RegExp(`^(${first}|rim)$`),
            );
        s += count;
      }
      expect(checked).toBeGreaterThan(100);
    }
  });

  it('are the same under a mirrored, turned, unevenly scaled part', async () => {
    const geometry = sphere();
    const matrix = new Matrix4().compose(
      new Vector3(3, 15, -2),
      new Quaternion().setFromAxisAngle(new Vector3(1, 2, 0.5).normalize(), 0.8),
      new Vector3(-1, 2, 0.6),
    );
    const m = await model(geometry, 3, matrix);
    const path = traceWarpGridPathNow(m);
    expect(path.failed).toBe(0);
    expect(segments(m, path).every(Number.isFinite)).toBe(true);
    expect(worstDip(geometry, m, path)).toBeLessThan(warpGridPathLimits.tolerance * 2);
  });

  it('keep to their limits per edge and in all', async () => {
    const m = await model(sphere(), 0);
    const loose = traceWarpGridPathNow(m);
    const limits = { ...warpGridPathLimits, perEdge: 3, total: 200 };
    const path = traceWarpGridPathNow(m, limits);
    expect(loose.from.length).toBeGreaterThan(200);
    expect(path.from.length).toBeLessThanOrEqual(200);
    for (let e = 0; e < path.length.length; e++)
      expect(path.start[e + 1] - path.start[e]).toBeLessThanOrEqual(3);
  });

  it('carry a drag of their nodes to the points between them', async () => {
    const m = await model(sphere(), 3);
    const path = traceWarpGridPathNow(m);
    const local = restLocal(m);
    const shift = new Float32Array(local.length);
    let e = 0;
    while (path.start[e + 1] === path.start[e]) e++;
    const a = path.ends[e * 2],
      b = path.ends[e * 2 + 1];
    shift[a * 3 + 1] = 2;
    shift[b * 3 + 1] = 4;
    const still = new Float32Array(warpGridSegments(path) * 6),
      moved = new Float32Array(still.length);
    writeWarpGridPath(path, local, m.positions, null, still);
    writeWarpGridPath(path, local, m.positions, shift, moved);
    // Segments before this edge: one per edge and one per point.
    const before = e + path.start[e];
    for (let k = path.start[e]; k < path.start[e + 1]; k++) {
      const o = (before + k - path.start[e]) * 6 + 4;
      expect(moved[o] - still[o]).toBeCloseTo(2 + 2 * path.along[k], 5);
    }
  });
});

/**
 * The grid's edges and the drawn ones, by node pair, with each node inside the outline's drawn
 * lines to it and grid edges to it. `rim` says which nodes are on the outline.
 */
function linesToOutline(m: WarpModel, rim: (n: number) => boolean) {
  const { edgeStart, edges } = m.grid;
  const nodeCount = edgeStart.length - 1;
  const { ends } = warpGridDrawnEdges(m);
  const drawn = new Set<number>();
  for (let e = 0; e < ends.length; e += 2)
    drawn.add(Math.min(ends[e], ends[e + 1]) * nodeCount + Math.max(ends[e], ends[e + 1]));
  const inside: { node: number; lines: number[]; edges: number }[] = [];
  let gridEdges = 0;
  for (let n = 0; n < nodeCount; n++) {
    const node = { node: n, lines: [] as number[], edges: 0 };
    for (let k = edgeStart[n]; k < edgeStart[n + 1]; k++) {
      const m = edges[k];
      if (m > n) gridEdges++;
      if (rim(n) || !rim(m)) continue;
      node.edges++;
      if (drawn.has(Math.min(n, m) * nodeCount + Math.max(n, m))) node.lines.push(m);
    }
    if (!rim(n)) inside.push(node);
  }
  return { drawn, nodeCount, inside, gridEdges };
}

/** The most lines a node inside may draw to the outline. */
const handful = 4;

describe('drawn grid edges', () => {
  it('join each node inside to the outline by a few lines spread around it, never a fan', async () => {
    // The 80 by 80 plate at the coarsest density: every border vertex is a node, and few are not.
    const m = await model(new PlaneGeometry(40, 40, 80, 80), 0);
    const p = m.restNodes;
    const onBorder = (n: number) =>
      Math.abs(Math.abs(p[n * 3]) - 20) < 1e-6 || Math.abs(Math.abs(p[n * 3 + 1]) - 20) < 1e-6;
    const { drawn, nodeCount, inside } = linesToOutline(m, onBorder);
    expect(inside.length).toBeGreaterThan(0);
    expect(Math.max(...inside.map((node) => node.edges))).toBeGreaterThan(50);
    for (const { node, lines, edges } of inside) {
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.length).toBeLessThanOrEqual(Math.min(edges, handful));
      // Every two lines from the node turn apart by 30° or more.
      const angles = lines.map((m) =>
        Math.atan2(p[m * 3 + 1] - p[node * 3 + 1], p[m * 3] - p[node * 3]),
      );
      for (let i = 0; i < angles.length; i++)
        for (let j = i + 1; j < angles.length; j++) {
          const turn = Math.abs(angles[i] - angles[j]) % (2 * Math.PI);
          expect(Math.min(turn, 2 * Math.PI - turn)).toBeGreaterThanOrEqual(Math.PI / 6);
        }
    }
    // The border is drawn whole, and nothing crosses the inside from one border node to another.
    const side = (n: number) =>
      Math.abs(Math.abs(p[n * 3]) - 20) < 1e-6
        ? `x${Math.sign(p[n * 3])}`
        : `y${Math.sign(p[n * 3 + 1])}`;
    let along = 0;
    for (const key of drawn) {
      const a = Math.floor(key / nodeCount),
        b = key % nodeCount;
      if (!onBorder(a) || !onBorder(b)) continue;
      along++;
      const corner = (n: number) =>
        Math.abs(Math.abs(p[n * 3]) - 20) < 1e-6 && Math.abs(Math.abs(p[n * 3 + 1]) - 20) < 1e-6;
      if (!corner(a) && !corner(b)) expect(side(a)).toBe(side(b));
    }
    expect(along).toBe(320);
  });

  it("draw a painted region's fixed border as its outline and every edge between free nodes", async () => {
    const geometry = new PlaneGeometry(40, 40, 80, 80);
    const centres = new Vector3();
    const faces: number[] = [];
    const index = geometry.index!,
      position = geometry.getAttribute('position');
    for (let f = 0; f < index.count / 3; f++) {
      centres.set(0, 0, 0);
      for (let k = 0; k < 3; k++)
        centres.add(new Vector3().fromBufferAttribute(position, index.getX(f * 3 + k)));
      if (centres.divideScalar(3).length() < 8) faces.push(f);
    }
    const m = await buildWarpModel({
      positions: new Float32Array(position.array),
      index: new Uint32Array(index.array),
      normals: null,
      matrix: new Matrix4().elements.slice(),
      faces,
      density: 0,
    });
    const fixed = (n: number) => m.grid.fixed[n] === 1;
    expect(m.grid.fixed.reduce((a, b) => a + b, 0)).toBeGreaterThan(100);
    const { drawn, nodeCount, inside } = linesToOutline(m, fixed);
    for (const { lines } of inside) expect(lines.length).toBeLessThanOrEqual(handful);
    const { edgeStart, edges } = m.grid;
    let rimEdges = 0;
    for (let n = 0; n < nodeCount; n++)
      for (let k = edgeStart[n]; k < edgeStart[n + 1]; k++) {
        const o = edges[k];
        if (o <= n) continue;
        if (!fixed(n) && !fixed(o)) expect(drawn.has(n * nodeCount + o)).toBe(true);
        if (fixed(n) && fixed(o) && drawn.has(n * nodeCount + o)) rimEdges++;
      }
    // The outline closes: one edge per fixed node around the disc.
    expect(rimEdges).toBe(m.grid.fixed.reduce((a, b) => a + b, 0));
  });

  it('draw every edge of a grid without an outline', async () => {
    const m = await model(sphere(), 3);
    const { drawn, gridEdges } = linesToOutline(m, () => false);
    expect(drawn.size).toBe(gridEdges);
  });
});

/** The furthest any drawn segment strays from a surface, sampled along each segment. */
function worstGap(surface: BufferGeometry, drawn: Float32Array) {
  const bvh = new MeshBVH(surface);
  const point = new Vector3();
  let worst = 0;
  for (let s = 0; s < drawn.length / 6; s++)
    for (const f of [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]) {
      point.set(
        drawn[s * 6] + f * (drawn[s * 6 + 3] - drawn[s * 6]),
        drawn[s * 6 + 1] + f * (drawn[s * 6 + 4] - drawn[s * 6 + 1]),
        drawn[s * 6 + 2] + f * (drawn[s * 6 + 5] - drawn[s * 6 + 2]),
      );
      worst = Math.max(worst, bvh.closestPointToPoint(point)!.distance);
    }
  return worst;
}

describe('grid paths on a scan-like part', () => {
  it('follow the surface, along mesh edges where a walk fails, never across empty space', async () => {
    const geometry = scanLike();
    for (const density of [0, 3]) {
      const m = await buildWarpModel({
        positions: new Float32Array(geometry.getAttribute('position').array),
        index: null,
        normals: new Float32Array(geometry.getAttribute('normal').array),
        matrix: new Matrix4().elements.slice(),
        faces: null,
        density,
      });
      const path = traceWarpGridPathNow(m);
      const edges = warpGridChords(m).length.length;
      // Some walks fail on this part, as on real scans, and each finds its way along mesh edges.
      // At density 0 the evenly spaced grid's chords fail 100 of 378 walks, where the
      // simplifier's failed 95 of 391, and one of its edges runs 26 mm over curved relief.
      expect(path.failed, `density ${density}`).toBeGreaterThan(0);
      expect(path.failed / edges, `density ${density}`).toBeLessThan(density ? 0.25 : 0.3);
      expect(path.rerouted).toBe(path.failed);
      expect(path.length.length).toBe(edges);
      expect(worstGap(geometry, segments(m, path)), `density ${density}`).toBeLessThan(
        density ? 0.05 : 0.06,
      );
    }
  });
});

const editor = () => useEditor.getState();
const initial = useEditor.getState();

/** A 40 mm plate warped over its whole surface, with points held at four corners. */
async function heldPlate(segments = 64, density?: number) {
  const geometry = new PlaneGeometry(40, 40, segments, segments);
  const part: Part = {
    id: 'plate',
    name: 'Plate',
    geometry,
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    color: '#aabbcc',
    visible: true,
    locked: false,
    source: 'test',
  };
  editor().setScene({ name: 'Plate', parts: [part], joints: [] });
  useEditor.setState({ selected: ['plate'] });
  editor().setTool('warp');
  editor().setWarpRegion('whole');
  editor().setWarpOptions({ autoPoints: false });
  if (density !== undefined) await editor().setWarpDensity(density);
  await editor().layWarpGrid();
  const faceAt = (x: number, y: number) => {
    const triangle = new Triangle(),
      point = new Vector3(x, y, 0),
      closest = new Vector3();
    for (let face = 0; face < triangleCount(geometry); face++) {
      readFace(geometry, face, triangle);
      if (triangle.closestPointToPoint(point, closest).distanceTo(point) < 1e-6) return face;
    }
    throw new Error('No face under the point.');
  };
  for (const [x, y] of [
    [-15, -15],
    [15, -15],
    [-15, 15],
    [15, 15],
    [0.3, 0.2],
  ])
    editor().addWarpPoint({ partId: 'plate', point: [x, y, 0], normal: [0, 0, 1] }, faceAt(x, y));
  return editor().warp!.points.at(-1)!.id;
}

/** The written surface as a mesh, and local node positions as the grid draws them. */
function written() {
  const { model, state, output } = editor().warp!;
  const surface = new BufferGeometry();
  surface.setAttribute('position', new BufferAttribute(output!.positions.slice(), 3));
  surface.setIndex(new BufferAttribute(model!.index!, 1));
  const world = writtenNodePositions(model!, state!);
  const inverse = new Matrix4().fromArray(model!.inverse),
    point = new Vector3();
  const nodes = new Float32Array(world.length);
  for (let i = 0; i < world.length; i += 3)
    point.fromArray(world, i).applyMatrix4(inverse).toArray(nodes, i);
  return { surface, nodes, positions: output!.positions.slice(), normals: output!.normals };
}

describe('the drawn grid', () => {
  afterEach(() => {
    editor().cancelWarp();
    useEditor.setState(initial);
  });

  it('stays on a flat plate once its middle is pulled 2 mm', async () => {
    // Coarse, where most grid edges cross a mesh edge or two, and fine.
    for (const segments of [16, 64]) {
      const id = await heldPlate(segments);
      const model = editor().warp!.model!;
      const path = traceWarpGridPathNow(model);
      expect(path.failed).toBe(0);
      editor().moveWarpPoints([{ id, target: [0.3, 0.2, 2] }], 'end');
      const after = written();
      const drawing = new WarpGridDrawing(path, model.restNodes.length / 3);
      drawing.update(after.nodes, after.positions, after.normals, 1);
      expect(worstGap(after.surface, drawing.drawn()), `${segments}`).toBeLessThan(0.02);
      editor().cancelWarp();
    }
  });

  it('chooses its points again on a plate bent between held points, at every density', async () => {
    // Fine enough that a coarse grid's edges cross dozens of mesh edges between nodes.
    for (const density of [0, 1, 2, 3, 4, 5, 6]) {
      const id = await heldPlate(80, density);
      const model = editor().warp!.model!;
      const path = traceWarpGridPathNow(model);
      expect(path.failed).toBe(0);
      editor().moveWarpPoints([{ id, target: [0.3, 0.2, 2] }], 'end');
      const after = written();
      // The surface under the pulled point rose with it.
      let lifted = 0;
      for (let v = 0; v < after.positions.length; v += 3)
        if (Math.hypot(after.positions[v] - 0.3, after.positions[v + 1] - 0.2) < 0.5)
          lifted = Math.max(lifted, after.positions[v + 2]);
      expect(lifted, `density ${density}`).toBeGreaterThan(1.8);
      const drawing = new WarpGridDrawing(path, model.restNodes.length / 3);
      drawing.update(after.nodes, after.positions, after.normals, 1);
      drawing.refine(after.positions, after.normals);
      expect(drawing.refined).toBe(1);
      expect(drawing.segments).toBeLessThanOrEqual(drawing.capacity);
      const gap = worstGap(after.surface, drawing.drawn());
      expect(gap, `density ${density}`).toBeLessThan(0.1);
      editor().cancelWarp();
    }
  });

  it('follows a plate bent between held points at once, before choosing its points again', async () => {
    // The surface is first written as the pull is released: the points the trace chose on the
    // flat plate must already follow it, at every density.
    for (const density of [0, 1, 2, 3, 4, 5, 6]) {
      const id = await heldPlate(80, density);
      const model = editor().warp!.model!;
      const path = traceWarpGridPathNow(model);
      editor().moveWarpPoints([{ id, target: [0.3, 0.2, 2] }], 'end');
      const after = written();
      const drawing = new WarpGridDrawing(path, model.restNodes.length / 3);
      drawing.update(after.nodes, after.positions, after.normals, 1);
      expect(drawing.adopted).toBe(0);
      expect(worstGap(after.surface, drawing.drawn()), `density ${density}`).toBeLessThan(0.1);
      editor().cancelWarp();
    }
  });

  it('measures how far its line strays from the surface written, which choosing again cures', async () => {
    // Few points per edge, so the coarse grid's long edges cut across the bend.
    const limits = { ...warpGridPathLimits, perEdge: 3 };
    const id = await heldPlate(80, 0);
    const model = editor().warp!.model!;
    const path = traceWarpGridPathNow(model, limits);
    editor().moveWarpPoints([{ id, target: [0.3, 0.2, 2] }], 'end');
    const after = written();
    const drawing = new WarpGridDrawing(path, model.restNodes.length / 3, null, limits);
    drawing.update(after.nodes, after.positions, after.normals, 1);
    const stray = (() => {
      const job = drawing.straying(after.positions);
      for (;;) {
        const step = job.next();
        if (step.done) return step.value;
      }
    })();
    // The furthest point the trace found off the line bounds how far its segments lie off the
    // surface, which runs straight between those points.
    const gap = worstGap(after.surface, drawing.drawn());
    expect(gap).toBeGreaterThan(0.3);
    expect(stray).toBeGreaterThan(0.9 * gap);
    drawing.refine(after.positions, after.normals, limits);
    expect(drawing.adopted).toBe(1);
    expect(worstGap(after.surface, drawing.drawn())).toBeLessThan(0.1);
  });

  it('starts a trace finished part way through a large drag from the surface last written', async () => {
    const id = await heldPlate();
    const model = editor().warp!.model!;
    const nodeCount = model.restNodes.length / 3;
    const rest = written();
    // Chords are drawn while the trace runs; then a drag moves the grid alone, as on a region too
    // large to write each frame, so the surface stays at rest.
    const chords = new WarpGridDrawing(warpGridChords(model), nodeCount);
    chords.update(rest.nodes, rest.positions, rest.normals, 1);
    editor().moveWarpPoints([{ id, target: [0.3, 0.2, 2] }], 'end');
    const dragged = written();
    chords.update(dragged.nodes, rest.positions, rest.normals, 1);
    // The trace finishes before the pointer is released.
    const path = traceWarpGridPathNow(model);
    const traced = new WarpGridDrawing(path, nodeCount);
    traced.update(dragged.nodes, rest.positions, rest.normals, 1);
    const during = traced.drawn();
    // On release the surface is written.
    traced.update(dragged.nodes, dragged.positions, dragged.normals, 2);
    const after = traced.drawn();

    // The nodes on top of the bump, and how far the points between them moved with them.
    const rise = (n: number) => Math.abs(dragged.nodes[n * 3 + 2] - rest.nodes[n * 3 + 2]);
    let moved = 0;
    for (let n = 0; n < nodeCount; n++) moved = Math.max(moved, rise(n));
    expect(moved).toBeGreaterThan(1.5);
    const top = (n: number) => rise(n) > 0.5 * moved;
    let checked = 0,
      jump = 0;
    for (let e = 0, s = 0; e < path.length.length; e++) {
      const near = top(path.ends[e * 2]) && top(path.ends[e * 2 + 1]);
      for (let k = path.start[e]; k <= path.start[e + 1]; k++, s++) {
        if (!near) continue;
        jump = Math.max(jump, Math.abs(after[s * 6 + 2] - during[s * 6 + 2]));
        if (k < path.start[e + 1]) {
          // A point between nodes rose with them during the drag.
          expect(during[s * 6 + 5]).toBeGreaterThan(0.25 * moved);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(4);
    // Nothing jumps by more than a fraction of the move when the surface catches up.
    expect(jump).toBeLessThan(0.25 * moved);
  });
});
