import { it } from 'vitest';
import { BufferAttribute, SphereGeometry, Vector3 } from 'three';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useEditor } from '../../src/core/store';
import { deformPoint, evaluateWarp } from '../../src/core/warp-evaluate';
import { solveWarp, warpDragIterations } from '../../src/core/warp-solve';
import type { Part, Vec3 } from '../../src/core/types';

// Run explicitly when profiling; keep wall-clock measurements out of correctness assertions.
it.skipIf(!process.env.KITBASHER_WARP_BENCH)(
  'benchmarks warp drag frames on a 3M-triangle scan',
  async () => {
    // 2 × 1500 × 1000 triangles, unindexed as scans often are.
    const sphere = new SphereGeometry(50, 1500, 1001);
    sphere.deleteAttribute('uv');
    const geometry = sphere.toNonIndexed();
    sphere.dispose();
    const faceCount = geometry.getAttribute('position').count / 3;
    const position = geometry.getAttribute('position').array as Float32Array;
    const centre = new Vector3(50, 0, 0);
    const distances = new Float64Array(faceCount);
    for (let f = 0; f < faceCount; f++) {
      const o = f * 9;
      distances[f] = Math.hypot(
        (position[o] + position[o + 3] + position[o + 6]) / 3 - centre.x,
        (position[o + 1] + position[o + 4] + position[o + 7]) / 3 - centre.y,
        (position[o + 2] + position[o + 5] + position[o + 8]) / 3 - centre.z,
      );
    }
    const order = Uint32Array.from({ length: faceCount }, (_, f) => f).sort(
      (a, b) => distances[a] - distances[b],
    );
    const part: Part = {
      id: 'scan',
      name: 'Scan',
      geometry,
      position: [0, 0, 0],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
      color: '#ffffff',
      visible: true,
      locked: false,
      source: 'benchmark',
    };

    const result: Record<string, unknown> = { triangles: faceCount };
    // Region sizes by painted triangles: about half as many interior welded vertices.
    for (const painted of [17_500, 60_000, 100_000, 140_000, 200_000, 500_000]) {
      const editor = () => useEditor.getState();
      editor().setScene({ name: 'Bench', parts: [part], joints: [] });
      useEditor.setState({ selected: ['scan'] });
      editor().setTool('warp');
      const faces = Array.from(order.subarray(0, painted)).sort((a, b) => a - b);
      useEditor.setState({ warp: { ...editor().warp!, faces } });
      await editor().layWarpGrid();
      const warp = editor().warp!;
      const model = warp.model!;
      const face = order[0];
      const point: Vec3 = [0, 1, 2].map(
        (a) =>
          (position[face * 9 + a] + position[face * 9 + 3 + a] + position[face * 9 + 6 + a]) / 3,
      ) as Vec3;
      // A bare point, as before handles had a radius.
      editor().setWarpPointSettings({ radius: 0 }, 'end');
      editor().addWarpPoint({ partId: 'scan', point, normal: [1, 0, 0] }, face);
      const id = editor().warp!.points[0].id;

      const attributes = () =>
        ['position', 'normal'].map(
          (name) => editor().warp!.preview!.getAttribute(name) as BufferAttribute,
        );
      // What the renderer would send to the GPU for each changed attribute, then forgets.
      const uploaded = (versions: number[]) =>
        attributes().reduce((bytes, attribute, i) => {
          if (attribute.version === versions[i]) return bytes;
          const ranges = attribute.updateRanges;
          const sent = ranges.length
            ? ranges.reduce((sum, range) => sum + range.count, 0) * 4
            : attribute.array.byteLength;
          attribute.clearUpdateRanges();
          return bytes + sent;
        }, 0);

      const frames: number[] = [],
        bytes: number[] = [];
      for (let frame = 0; frame < 40; frame++) {
        const versions = attributes().map((attribute) => attribute.version);
        const target: Vec3 = [point[0] + 0.05 * (frame + 1), point[1], point[2]];
        const start = performance.now();
        editor().moveWarpPoints([{ id, target }], 'drag');
        const ms = performance.now() - start;
        if (frame >= 5) {
          frames.push(ms);
          bytes.push(uploaded(versions));
        } else uploaded(versions);
      }
      const dragged = editor().warp!;
      // How far the point trails the pointer after the last drag frame.
      const trailMm =
        point[0] +
        2 -
        deformPoint(
          model,
          dragged.state!,
          dragged.points[0].samples[0].binding,
          dragged.points[0].samples[0].restWorld,
        )[0];
      const evaluations: number[] = [],
        solves: number[] = [];
      const { state, output } = editor().warp!;
      const constraints = [
        {
          ...editor().warp!.points[0].samples[0].binding,
          rest: editor().warp!.points[0].samples[0].restWorld,
          target: [point[0] + 3, point[1], point[2]] as Vec3,
        },
      ];
      for (let i = 0; i < 20; i++) {
        const copy = { positions: state!.positions.slice(), rotations: state!.rotations.slice() };
        const start = performance.now();
        solveWarp(model.grid, model.restNodes, constraints, copy, warpDragIterations);
        solves.push(performance.now() - start);
      }
      for (let i = 0; i < 20; i++) {
        const start = performance.now();
        // A drag frame's evaluation; the fourth argument skips fold detection where supported.
        (evaluateWarp as (...args: unknown[]) => unknown)(model, state, output, false);
        evaluations.push(performance.now() - start);
      }
      const endStart = performance.now();
      editor().moveWarpPoints([{ id, target: [point[0] + 1, point[1], point[2]] }], 'end');
      const endMs = performance.now() - endStart;
      const median = (values: number[]) =>
        [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
      const p95 = (values: number[]) =>
        [...values].sort((a, b) => a - b)[Math.floor(values.length * 0.95)];
      result[`painted-${painted}`] = {
        interiorVertices: model.region.interiorCount,
        gridNodes: model.grid.nodes.length,
        frameMedianMs: median(frames),
        frameP95Ms: p95(frames),
        trailMm,
        solveMedianMs: median(solves),
        evaluateMedianMs: median(evaluations),
        uploadMBPerFrame: median(bytes) / 1e6,
        endMs,
      };
      console.log(painted, JSON.stringify(result[`painted-${painted}`]));
      editor().cancelWarp();
    }
    const output = join(tmpdir(), 'kitbasher-performance');
    mkdirSync(output, { recursive: true });
    writeFileSync(
      join(output, `warp-${process.env.KITBASHER_WARP_BENCH!.replace(/[^a-z0-9-]/gi, '_')}.json`),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
  },
  600_000,
);

it.skipIf(!process.env.KITBASHER_WARP_BENCH)(
  'benchmarks dragging one wide handle on a 4000-node grid against a bare point',
  async () => {
    const geometry = new SphereGeometry(16, 220, 160);
    geometry.deleteAttribute('uv');
    const part: Part = {
      id: 'scan',
      name: 'Scan',
      geometry,
      position: [0, 0, 0],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
      color: '#ffffff',
      visible: true,
      locked: false,
      source: 'benchmark',
    };
    const position = geometry.getAttribute('position'),
      index = geometry.index!;
    const centreY = (f: number) =>
      (position.getY(index.getX(f * 3)) +
        position.getY(index.getX(f * 3 + 1)) +
        position.getY(index.getX(f * 3 + 2))) /
      3;
    const faces: number[] = [];
    let top = 0;
    for (let f = 0; f < index.count / 3; f++) {
      if (centreY(f) > -4) faces.push(f);
      if (centreY(f) > centreY(top)) top = f;
    }
    const point = [0, 1, 2].map(
      (a) =>
        (position.getComponent(index.getX(top * 3), a) +
          position.getComponent(index.getX(top * 3 + 1), a) +
          position.getComponent(index.getX(top * 3 + 2), a)) /
        3,
    ) as Vec3;
    const result: Record<string, unknown> = {};
    for (const radius of [0, 4, 8]) {
      const editor = () => useEditor.getState();
      editor().setScene({ name: 'Bench', parts: [part], joints: [] });
      useEditor.setState({ selected: ['scan'] });
      editor().setTool('warp');
      useEditor.setState({ warp: { ...editor().warp!, faces, density: 6, densityChosen: true } });
      await editor().layWarpGrid();
      editor().setWarpPointSettings({ radius }, 'end');
      editor().addWarpPoint({ partId: 'scan', point, normal: [0, 1, 0] }, top);
      const handle = editor().warp!.points[0];
      const id = handle.id;
      const frames: number[] = [];
      for (let frame = 0; frame < 60; frame++) {
        const target: Vec3 = [point[0], point[1] + 0.05 * (frame + 1), point[2]];
        const start = performance.now();
        editor().moveWarpPoints([{ id, target }], 'drag');
        if (frame >= 10) frames.push(performance.now() - start);
      }
      const endStart = performance.now();
      editor().moveWarpPoints([{ id, target: [point[0], point[1] + 3, point[2]] }], 'end');
      const endMs = performance.now() - endStart;
      // The first frame of a radius gesture and of a falloff gesture on the moved point.
      editor().selectWarpPoints([id]);
      const timed = (settings: { radius?: number; falloff?: number }) => {
        const start = performance.now();
        editor().setWarpPointSettings(settings, 'drag');
        const ms = performance.now() - start;
        editor().setWarpPointSettings(settings, 'end');
        return ms;
      };
      const radiusFrameMs = timed({ radius: radius ? radius + 0.5 : 8 });
      const falloffFrameMs = timed({ falloff: 0.7 });
      frames.sort((a, b) => a - b);
      result[`radius-${radius}`] = {
        gridNodes: editor().warp!.model!.grid.nodes.length,
        interiorVertices: editor().warp!.model!.region.interiorCount,
        guidedNodes: handle.reach && handle.reach.activation > 0 ? handle.reach.node.length : 0,
        frameMedianMs: frames[frames.length >> 1],
        frameP95Ms: frames[Math.floor(frames.length * 0.95)],
        endMs,
        radiusFrameMs,
        falloffFrameMs,
      };
      console.log(radius, JSON.stringify(result[`radius-${radius}`]));
      editor().cancelWarp();
    }
    const output = join(tmpdir(), 'kitbasher-performance');
    mkdirSync(output, { recursive: true });
    writeFileSync(
      join(
        output,
        `warp-handle-${process.env.KITBASHER_WARP_BENCH!.replace(/[^a-z0-9-]/gi, '_')}.json`,
      ),
      JSON.stringify(result, null, 2),
    );
  },
  600_000,
);
