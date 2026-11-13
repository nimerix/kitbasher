import { describe, expect, it } from 'vitest';
import { BoxGeometry, Euler, Matrix4, PlaneGeometry, Quaternion, Vector3 } from 'three';
import { strFromU8, unzipSync } from 'fflate';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import {
  alignmentTransform,
  combineParts,
  deserializeGeometry,
  partMatrix,
  partPivot,
  poseAtPivot,
  rigidAlignment,
  sceneBounds,
  serializeGeometry,
  transformFromMatrix,
  worldNormal,
  worldPoint,
} from '../../src/core/geometry';
import {
  anchorError,
  constrainPart,
  transformAssembly,
  validateJoint,
} from '../../src/core/constraints';
import { parseScene } from '../../src/core/scene-file';
import { serializeScene } from '../helpers/legacy-scene';
import { export3mf, exportStl, importModels } from '../../src/core/files';
import { solveAlignment } from '../../src/core/alignment';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { Mesh } from 'three';
import { assertClosed } from '../../src/core/merge';
import { useEditor } from '../../src/core/store';
import type { AssemblyOperation, Joint, Part, SceneDocument } from '../../src/core/types';

function part(id = 'a'): Part {
  return {
    id,
    name: id,
    geometry: new BoxGeometry(10, 20, 30),
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    color: '#d9ae84',
    visible: true,
    locked: false,
    source: 'test',
  };
}
function joint(parentId = 'a', childId = 'b'): Joint {
  return {
    id: `${parentId}-${childId}`,
    name: 'Hinge',
    parentId,
    childId,
    parentAnchor: [5, 0, 0],
    childAnchor: [-5, 0, 0],
    restRotation: [0, 0, 0, 1],
    rotationLocks: [true, false, true],
    keepConnected: true,
  };
}
function operation(mode: AssemblyOperation['mode'] = 'point'): AssemblyOperation {
  return {
    mode,
    surfacePairs: [],
    activeSurface: null,
    sourceId: 'a',
    targetId: 'b',
    pairs: [
      {
        source: { partId: 'a', point: [2, 3, 4], normal: [0, 1, 0] },
        target: { partId: 'b', point: [4, 0, 3], normal: [0, 1, 0] },
      },
    ],
    pending: null,
    flipNormal: true,
    offset: 0,
    rotationLocks: [true, false, true],
    keepConnected: true,
  };
}
const close = (a: Vector3, b: Vector3) => expect(a.distanceTo(b)).toBeLessThan(1e-6);

describe('rigid surface registration', () => {
  it('recovers a 3D rotation and translation from 4 point pairs', () => {
    const source = [
      new Vector3(0, 0, 0),
      new Vector3(20, 0, 0),
      new Vector3(2, 15, 0),
      new Vector3(0, 4, 10),
    ];
    const expected = new Matrix4()
      .makeRotationFromEuler(new Euler(0.3, -0.8, 0.5))
      .setPosition(15, -4, 30);
    const target = source.map((p) => p.clone().applyMatrix4(expected));
    const { matrix, rms } = rigidAlignment(source, target);
    source.forEach((p, i) => close(p.clone().applyMatrix4(matrix), target[i]));
    expect(rms).toBeLessThan(1e-7);
    expect(matrix.determinant()).toBeCloseTo(1);
  });
  it('supports coplanar, non-collinear 3-point alignment', () => {
    const source = [new Vector3(0, 0, 0), new Vector3(1, 0, 0), new Vector3(0, 1, 0)];
    const target = source.map((p) =>
      p
        .clone()
        .applyAxisAngle(new Vector3(1, 0, 0), 1)
        .add(new Vector3(2, 3, 4)),
    );
    expect(rigidAlignment(source, target).rms).toBeLessThan(1e-6);
  });
  it('rejects collinear and underspecified point sets', () => {
    const points = [new Vector3(), new Vector3(1, 0, 0), new Vector3(2, 0, 0)];
    expect(() => rigidAlignment(points, points)).toThrow('one line');
    expect(() => rigidAlignment(points.slice(0, 2), points.slice(0, 2))).toThrow('three');
  });
  it('never mirrors geometry for a reflected point set', () => {
    const source = [
      new Vector3(),
      new Vector3(1, 0, 0),
      new Vector3(0, 1, 0),
      new Vector3(0, 0, 1),
    ];
    expect(
      rigidAlignment(
        source,
        source.map((p) => p.clone().multiply(new Vector3(-1, 1, 1))),
      ).matrix.determinant(),
    ).toBeCloseTo(1);
  });
  it('point to point preserves rotation and seats the exact picked points', () => {
    const a = part(),
      b = { ...part('b'), position: [20, 5, -4] as [number, number, number] },
      op = operation();
    const result = transformFromMatrix(
      a,
      alignmentTransform(a, b, op).matrix.multiply(partMatrix(a)),
    );
    close(worldPoint(result, op.pairs[0].source), worldPoint(b, op.pairs[0].target));
    expect(result.quaternion).toEqual(a.quaternion);
  });
  it('point to plane changes only the normal component', () => {
    const a = part(),
      b = { ...part('b'), position: [20, 5, -4] as [number, number, number] },
      op = operation('point-plane');
    const result = transformFromMatrix(
      a,
      alignmentTransform(a, b, op).matrix.multiply(partMatrix(a)),
    );
    const source = worldPoint(result, op.pairs[0].source),
      target = worldPoint(b, op.pairs[0].target);
    expect(source.y).toBeCloseTo(target.y);
    expect(result.position[0]).toBe(0);
    expect(result.position[2]).toBe(0);
  });
  it('plane alignment respects opposing normals and surface offset', () => {
    const a = part(),
      b = { ...part('b'), position: [20, 5, -4] as [number, number, number] },
      op = operation('plane');
    op.offset = 2;
    const result = transformFromMatrix(
      a,
      alignmentTransform(a, b, op).matrix.multiply(partMatrix(a)),
    );
    close(worldNormal(result, op.pairs[0].source), new Vector3(0, -1, 0));
    close(
      worldPoint(result, op.pairs[0].source),
      worldPoint(b, op.pairs[0].target).add(new Vector3(0, 2, 0)),
    );
  });
});

describe('anchored joint constraints', () => {
  it('locks chosen rotation axes while keeping anchors coincident', () => {
    const parent = part(),
      child = { ...part('b'), position: [10, 0, 0] as [number, number, number] },
      j = joint();
    const requested = {
      ...child,
      position: [40, 50, 60] as [number, number, number],
      quaternion: new Quaternion().setFromEuler(new Euler(0.3, 0.6, 0.8)).toArray(),
    };
    const result = constrainPart(requested, parent, j),
      rotation = new Euler().setFromQuaternion(new Quaternion(...result.quaternion));
    expect(rotation.x).toBeCloseTo(0);
    expect(rotation.y).toBeCloseTo(0.6);
    expect(rotation.z).toBeCloseTo(0);
    expect(anchorError([parent, result], j)).toBeLessThan(1e-6);
  });
  it('propagates parent rotation, translation, and scale through descendants', () => {
    const a = part(),
      b = { ...part('b'), position: [10, 0, 0] as [number, number, number] },
      c = { ...part('c'), position: [20, 0, 0] as [number, number, number] };
    const ab = joint(),
      bc = joint('b', 'c'),
      requested = {
        ...a,
        position: [5, 4, 3] as [number, number, number],
        quaternion: new Quaternion().setFromEuler(new Euler(0, 0, Math.PI / 2)).toArray(),
        scale: [2, 2, 2] as [number, number, number],
      };
    const result = transformAssembly([a, b, c], [ab, bc], 'a', requested);
    close(new Vector3(...result[2].position), new Vector3(5, 44, 3));
    expect(anchorError(result, ab)).toBeLessThan(1e-6);
    expect(anchorError(result, bc)).toBeLessThan(1e-6);
  });
  it('forbids cycles, duplicate parents, and self connections', () => {
    expect(() => validateJoint([joint()], 'b', 'a')).toThrow('circular');
    expect(() => validateJoint([joint()], 'c', 'b')).toThrow('already');
    expect(() => validateJoint([], 'a', 'a')).toThrow('different');
  });
  it('does not move a directly locked part', () => {
    const a = { ...part(), locked: true };
    expect(transformAssembly([a], [], 'a', { ...a, position: [100, 0, 0] })[0].position).toEqual([
      0, 0, 0,
    ]);
  });
  it('captures the current pose when a free axis is locked', () => {
    const parent = part(),
      child = constrainPart(
        { ...part('b'), quaternion: new Quaternion().setFromEuler(new Euler(0, 0.7, 0)).toArray() },
        parent,
        joint(),
      );
    useEditor.getState().setScene({ name: 'test', parts: [parent, child], joints: [joint()] });
    useEditor.getState().updateJoint('a-b', { rotationLocks: [true, true, true] });
    const result = useEditor.getState().scene.parts[1];
    expect(
      new Quaternion(...result.quaternion).angleTo(new Quaternion(...child.quaternion)),
    ).toBeLessThan(1e-7);
    close(new Vector3(...result.position), new Vector3(...child.position));
  });
});

describe('durable scene and mesh operations', () => {
  it('round trips geometry, placement, material, and all joint data', () => {
    const scene: SceneDocument = {
      name: 'Test & model',
      parts: [part(), { ...part('b'), position: [10, 0, 0] }],
      joints: [joint()],
    };
    const restored = parseScene(JSON.parse(JSON.stringify(serializeScene(scene))));
    expect(restored.name).toBe(scene.name);
    expect(restored.joints).toEqual(scene.joints);
    expect(serializeGeometry(restored.parts[0].geometry)).toEqual(
      serializeGeometry(scene.parts[0].geometry),
    );
    expect(restored.parts[1].position).toEqual([10, 0, 0]);
  });
  it('rejects invalid scene geometry, transforms, joint graphs, and formats', () => {
    const file = serializeScene({ name: 'test', parts: [part(), part('b')], joints: [] });
    expect(() => parseScene({ ...file, version: 2 })).toThrow('supported');
    expect(() => parseScene({ ...file, parts: [{ ...file.parts[0], scale: [0, 1, 1] }] })).toThrow(
      'invalid part',
    );
    expect(() => parseScene({ ...file, joints: [joint(), joint('b', 'a')] })).toThrow('circular');
    expect(() => deserializeGeometry({ positions: [0, 0, Infinity, 0, 1, 0, 0, 0, 1] })).toThrow(
      'invalid vertex',
    );
    expect(() =>
      deserializeGeometry({ positions: [0, 0, 0, 0, 1, 0, 0, 0, 1], indices: [0, 1, 6] }),
    ).toThrow('invalid triangle');
  });
  it('combines geometry without losing world-space placement', () => {
    const a = part(),
      b = { ...part('b'), position: [30, 10, 0] as [number, number, number] };
    const result = combineParts([a, b]);
    result.computeBoundingBox();
    const expected = sceneBounds([a, b]);
    close(result.boundingBox!.min, expected.min);
    close(result.boundingBox!.max, expected.max);
    expect(result.index!.count).toBe(72);
    expect(result.getAttribute('position').count).toBe(48);
  });
  it('rejects open Boolean input and accepts a closed box', () => {
    expect(() => assertClosed(part())).not.toThrow();
    expect(() => assertClosed({ ...part(), geometry: new PlaneGeometry() })).toThrow(
      'open or non-manifold',
    );
  });
  it('exports a multipart 3MF archive with independent object resources', () => {
    const scene: SceneDocument = { name: 'A & B', parts: [part(), part('b')], joints: [] };
    const archive = unzipSync(export3mf(scene, scene.parts)),
      model = strFromU8(archive['3D/3dmodel.model']);
    expect(model).toContain('A &amp; B');
    expect(model.match(/<object /g)).toHaveLength(2);
    expect(model.match(/<item /g)).toHaveLength(2);
    expect(model).toContain('unit="millimeter"');
    expect(archive['_rels/.rels']).toBeDefined();
  });
  it('exports STL geometry with Z up at millimeter scale', () => {
    const a = { ...part(), position: [0, 50, 0] as [number, number, number] },
      geometry = new STLLoader().parse(exportStl([a]));
    geometry.computeBoundingBox();
    expect(geometry.boundingBox!.min.z).toBeCloseTo(40);
    expect(geometry.boundingBox!.max.z).toBeCloseTo(60);
  });
  it('duplicates and undoes real geometry changes without changing the original', () => {
    const scene: SceneDocument = { name: 'test', parts: [part()], joints: [] };
    useEditor.getState().setScene(scene);
    useEditor.getState().select('a');
    useEditor.getState().duplicateSelected();
    expect(useEditor.getState().scene.parts).toHaveLength(2);
    expect(useEditor.getState().scene.parts[1].position[0]).toBe(12);
    useEditor.getState().undo();
    expect(useEditor.getState().scene.parts).toHaveLength(1);
    useEditor.getState().redo();
    expect(useEditor.getState().scene.parts).toHaveLength(2);
  });
});

describe('multipart placement regressions', () => {
  it('fits every point in a noisy 7-pair registration', () => {
    const source = [
      new Vector3(),
      new Vector3(10, 0, 0),
      new Vector3(0, 10, 0),
      new Vector3(0, 0, 10),
      new Vector3(6, 4, 3),
      new Vector3(-8, 2, 5),
      new Vector3(2, -7, -4),
    ];
    const desired = new Matrix4()
      .makeRotationFromEuler(new Euler(0.4, -0.6, 0.2))
      .setPosition(25, -10, 8);
    const target = source.map((p, i) =>
      p
        .clone()
        .applyMatrix4(desired)
        .add(new Vector3(i > 2 ? 0.8 : -0.1, 0, 0)),
    );
    const full = rigidAlignment(source, target);
    const firstThree = rigidAlignment(source.slice(0, 3), target.slice(0, 3));
    const rms = (matrix: Matrix4) =>
      Math.sqrt(
        source.reduce(
          (sum, p, i) => sum + p.clone().applyMatrix4(matrix).distanceToSquared(target[i]),
          0,
        ) / source.length,
      );
    expect(full.rms).toBeCloseTo(rms(full.matrix), 10);
    expect(full.rms).toBeLessThan(rms(firstThree.matrix));
    expect(full.matrix.determinant()).toBeCloseTo(1);
  });

  it('carries the connected assembly when a child is translated', () => {
    const parent = part(),
      child = { ...part('b'), position: [10, 0, 0] as [number, number, number] };
    const result = transformAssembly(
      [parent, child],
      [joint()],
      child.id,
      { ...child, position: [30, 12, -5] },
      { moveConnected: true },
    );
    close(new Vector3(...result[0].position), new Vector3(20, 12, -5));
    close(new Vector3(...result[1].position), new Vector3(30, 12, -5));
    expect(anchorError(result, joint())).toBeLessThan(1e-8);
  });

  it('pins an active anchor to a fixed parent while allowing hinge rotation and scale', () => {
    const parent = { ...part(), locked: true },
      child = { ...part('b'), position: [10, 0, 0] as [number, number, number] };
    const requested = {
      ...child,
      position: [50, 20, 0] as [number, number, number],
      quaternion: new Quaternion().setFromEuler(new Euler(0.3, 0.7, 0.2)).toArray(),
      scale: [2, 2, 2] as [number, number, number],
    };
    const result = transformAssembly([parent, child], [joint()], child.id, requested, {
      moveConnected: true,
    });
    expect(result[0]).toBe(parent);
    expect(anchorError(result, joint())).toBeLessThan(1e-8);
    expect(new Euler().setFromQuaternion(new Quaternion(...result[1].quaternion)).y).toBeCloseTo(
      0.7,
    );
    expect(result[1].scale).toEqual([2, 2, 2]);
  });

  it('pauses an entire link without discarding its anchors or axis locks', () => {
    const a = part(),
      b = { ...part('b'), position: [10, 0, 0] as [number, number, number] },
      c = { ...part('c'), position: [20, 0, 0] as [number, number, number] };
    const joints = [{ ...joint(), keepConnected: false }, joint('b', 'c')];
    const movedParent = transformAssembly([a, b, c], joints, 'a', { ...a, position: [50, 0, 0] });
    expect(movedParent[1]).toBe(b);
    expect(movedParent[2]).toBe(c);
    const movedChild = transformAssembly(
      [a, b, c],
      joints,
      'b',
      {
        ...b,
        position: [30, 0, 0],
        quaternion: new Quaternion().setFromEuler(new Euler(0.4, 0.2, 0.1)).toArray(),
      },
      { moveConnected: true },
    );
    expect(movedChild[0]).toBe(a);
    expect(movedChild[1].position).toEqual([30, 0, 0]);
    expect(
      new Euler().setFromQuaternion(new Quaternion(...movedChild[1].quaternion)).x,
    ).toBeCloseTo(0.4);
    expect(anchorError(movedChild, joints[1])).toBeLessThan(1e-8);
  });

  it('reseats a paused anchor in its current orientation and supports undo/redo', () => {
    const a = part(),
      b = { ...part('b'), position: [10, 0, 0] as [number, number, number] };
    useEditor.getState().setScene({ name: 'toggle', parts: [a, b], joints: [joint()] });
    useEditor.getState().updateJoint('a-b', { keepConnected: false });
    useEditor.getState().transform('b', {
      position: [40, 0, 0],
      quaternion: new Quaternion().setFromEuler(new Euler(0.2, 0.4, 0.1)).toArray(),
    });
    const freePose = useEditor.getState().scene.parts[1];
    useEditor.getState().updateJoint('a-b', { keepConnected: true });
    let scene = useEditor.getState().scene;
    expect(anchorError(scene.parts, scene.joints[0])).toBeLessThan(1e-8);
    expect(
      new Quaternion(...scene.parts[1].quaternion).angleTo(new Quaternion(...freePose.quaternion)),
    ).toBeLessThan(1e-7);
    useEditor.getState().undo();
    expect(useEditor.getState().scene.joints[0].keepConnected).toBe(false);
    expect(useEditor.getState().scene.parts[1].position).toEqual(freePose.position);
    useEditor.getState().redo();
    scene = useEditor.getState().scene;
    expect(scene.joints[0].keepConnected).toBe(true);
    expect(anchorError(scene.parts, scene.joints[0])).toBeLessThan(1e-8);
  });

  it('aligns an anchored child using 4 pairs without moving the target or breaking its joint', () => {
    const a = part(),
      b = { ...part('b'), position: [10, 0, 0] as [number, number, number] },
      c = { ...part('c'), position: [50, 20, 10] as [number, number, number] };
    const op = { ...operation('multi'), sourceId: 'b', targetId: 'c' };
    op.pairs = [
      [0, 0, 0],
      [10, 0, 0],
      [0, 10, 0],
      [0, 0, 10],
    ].map((point) => ({
      source: { partId: 'b', point: point as [number, number, number], normal: [0, 0, 1] },
      target: { partId: 'c', point: point as [number, number, number], normal: [0, 0, 1] },
    }));
    const scene = { name: 'anchored fit', parts: [a, b, c], joints: [joint()] };
    const result = solveAlignment(scene, op);
    expect(result.parts[2]).toBe(c);
    expect(result.rms).toBeLessThan(1e-8);
    expect(anchorError(result.parts, scene.joints[0])).toBeLessThan(1e-8);
    useEditor.getState().setScene(scene);
    useEditor.getState().setTool('align');
    useEditor.getState().setOperation(op);
    useEditor.getState().setOperation({ pairs: op.pairs });
    useEditor.getState().applyAlignment();
    expect(useEditor.getState().toast?.message).toContain('Aligned 4 pairs');
    expect(anchorError(useEditor.getState().scene.parts, scene.joints[0])).toBeLessThan(1e-8);
    useEditor.getState().undo();
    expect(useEditor.getState().scene.parts[0].position).toEqual(a.position);
  });

  it('reports achieved residual when a fixed anchor prevents exact alignment', () => {
    const a = { ...part(), locked: true },
      b = { ...part('b'), position: [10, 0, 0] as [number, number, number] },
      c = { ...part('c'), position: [80, 0, 0] as [number, number, number] };
    const op = {
      ...operation(),
      sourceId: 'b',
      targetId: 'c',
      pairs: [
        {
          source: {
            partId: 'b',
            point: [0, 0, 0] as [number, number, number],
            normal: [0, 0, 1] as [number, number, number],
          },
          target: {
            partId: 'c',
            point: [0, 0, 0] as [number, number, number],
            normal: [0, 0, 1] as [number, number, number],
          },
        },
      ],
    };
    const result = solveAlignment({ name: 'pinned fit', parts: [a, b, c], joints: [joint()] }, op);
    expect(result.rms).toBeCloseTo(70);
    expect(result.constrained).toBe(true);
    expect(result.parts[0]).toBe(a);
    expect(result.parts[2]).toBe(c);
    expect(anchorError(result.parts, joint())).toBeLessThan(1e-8);
  });

  it('keeps targets stationary when they belong to the same connected assembly', () => {
    const a = part(),
      b = { ...part('b'), position: [10, 0, 0] as [number, number, number] };
    const result = solveAlignment(
      { name: 'same assembly', parts: [a, b], joints: [joint()] },
      {
        ...operation(),
        sourceId: 'b',
        targetId: 'a',
        pairs: [
          {
            source: { partId: 'b', point: [0, 0, 0], normal: [0, 1, 0] },
            target: { partId: 'a', point: [0, 0, 0], normal: [0, 1, 0] },
          },
        ],
      },
    );
    expect(result.parts[0]).toBe(a);
    expect(result.constrained).toBe(true);
    expect(anchorError(result.parts, joint())).toBeLessThan(1e-8);
  });

  it('does not skip selected children across a paused joint', () => {
    const a = part(),
      b = { ...part('b'), position: [10, 0, 0] as [number, number, number] };
    useEditor.getState().setScene({
      name: 'paused selection',
      parts: [a, b],
      joints: [{ ...joint(), keepConnected: false }],
    });
    useEditor.getState().transformMany(
      [
        { id: 'a', patch: { position: [2, 0, 0] } },
        { id: 'b', patch: { position: [12, 0, 0] } },
      ],
      true,
      true,
    );
    expect(useEditor.getState().scene.parts.map((p) => p.position[0])).toEqual([2, 12]);
  });

  it('preserves paused joints and defaults older scenes to connected', () => {
    const scene = {
      name: 'compatibility',
      parts: [part(), part('b')],
      joints: [{ ...joint(), keepConnected: false }],
    };
    const file = serializeScene(scene);
    expect(parseScene(JSON.parse(JSON.stringify(file))).joints[0].keepConnected).toBe(false);
    const legacy = JSON.parse(JSON.stringify(file));
    delete legacy.joints[0].keepConnected;
    expect(parseScene(legacy).joints[0].keepConnected).toBe(true);
    legacy.joints[0].keepConnected = 'yes';
    expect(() => parseScene(legacy)).toThrow('invalid joint');
  });

  it('rebases an offset STL without changing its world placement', async () => {
    const geometry = new BoxGeometry(20, 30, 40).translate(1200, 800, -600);
    const file = new File([new STLExporter().parse(new Mesh(geometry))], 'offset.stl', {
      type: 'model/stl',
    });
    const [imported] = await importModels([file], { units: 'mm', up: 'y', center: false });
    close(imported.geometry.boundingBox!.getCenter(new Vector3()), new Vector3());
    close(sceneBounds([imported]).getCenter(new Vector3()), new Vector3(1200, 800, -600));
    const [centered] = await importModels([file], { units: 'mm', up: 'y', center: true });
    close(new Vector3(...centered.position), new Vector3(0, 15, 0));
    expect(sceneBounds([centered]).min.y).toBeCloseTo(0);
  });
});

it('keeps legacy offset geometry centered during numeric rotation and scale', () => {
  const scan = {
    ...part('offset'),
    geometry: new BoxGeometry(20, 30, 40).translate(1200, 800, -600),
    position: [-1200, -785, 600] as [number, number, number],
  };
  const pivot = partPivot(scan);
  const rotated = poseAtPivot(scan, {
    quaternion: new Quaternion().setFromEuler(new Euler(0.4, 0.2, 0.8)).toArray(),
  });
  close(partPivot(rotated), pivot);
  const scaled = poseAtPivot(rotated, { scale: [1.5, 2, 0.5] });
  close(partPivot(scaled), pivot);
});
