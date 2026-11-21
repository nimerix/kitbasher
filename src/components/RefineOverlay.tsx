import { memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  PointsMaterial,
  Points,
  Vector3,
} from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { hiddenByIsolation } from '../core/isolation';
import { drawnCurve, type EdgeCurve } from '../core/refine-curve';
import type { EdgeSegment, EdgeSolve } from '../core/refine-edge';
import type { RefineMesh } from '../core/refine-mesh';
import type { RefineModel } from '../core/refine-model';
import type { RegionSolve } from '../core/refine-region';
import { refineSolved, useEditor, type RefineFeature, type RefineSession } from '../core/store';
import { contactColors } from '../core/surfaces';
import type { Part } from '../core/types';
import { refineCurves, refineHandles, type RefineHandle } from './RefinePointer';
import { warpRegionColor } from './SurfacePainter';
import { surfacePoints } from './surface-points';
import { closedColor, foldColor } from './WarpOverlay';
import { casingColor, liftedLine, pointAccent, pointIdle } from './WarpStroke';

/** Pending regions, in the contact patches' lilac so they read apart from paint. */
const regionColor = contactColors[2];
const acceptedColor = `#${closedColor.getHexString()}`;
const guideIdle = '#a4aab2';
/** Dash and gap of a pending edge, screen pixels at the part. */
const dash = 9,
  gap = 6;

type LineStyle = 'accepted' | 'pending' | 'chosen' | 'guide' | 'guideChosen' | 'detail';
const lineStyles: Record<LineStyle, { color: string; width: number; dashed: boolean }> = {
  accepted: { color: acceptedColor, width: 2.5, dashed: false },
  pending: { color: pointIdle, width: 2.5, dashed: true },
  chosen: { color: pointAccent, width: 2.5, dashed: true },
  guide: { color: guideIdle, width: 1.5, dashed: false },
  guideChosen: { color: pointIdle, width: 1.5, dashed: false },
  detail: { color: pointIdle, width: 1.5, dashed: false },
};
type Materials = Record<LineStyle, { core: LineMaterial; casing: LineMaterial }>;

function lineMaterials(): Materials {
  const entries = Object.entries(lineStyles).map(([style, { color, width, dashed }]) => {
    const core = liftedLine(color, width),
      casing = liftedLine(casingColor, width + 2.5);
    // The core of every segment draws over the casing of its neighbours.
    casing.depthWrite = false;
    for (const material of [core, casing]) material.dashed = dashed;
    return [style, { core, casing }] as const;
  });
  return Object.fromEntries(entries) as Materials;
}

/** Each solved or drawn curve as a polyline, made once per curve. */
const polylines = new WeakMap<object, Float32Array>();
function curvePolyline(curve: EdgeCurve) {
  let line = polylines.get(curve);
  if (!line) {
    const { points, closed } = curve;
    line = new Float32Array(points.length + (closed ? 3 : 0));
    line.set(points);
    if (closed) line.set(points.subarray(0, 3), points.length);
    polylines.set(curve, line);
  }
  return line;
}
/** The guide as drawn through its points, every segment in turn. */
const guideDisplaySegments = 512;
function guidePolyline(segments: EdgeSegment[], step: number) {
  let line = polylines.get(segments);
  if (!line) {
    const parts = segments.map(
      (segment) =>
        drawnCurve(
          segment.kind,
          segment.points.flatMap((p) => p.position),
          step,
          guideDisplaySegments,
        ).points,
    );
    line = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) {
      line.set(part, at);
      at += part.length;
    }
    polylines.set(segments, line);
  }
  return line;
}

/** Line segments between consecutive points of a polyline, or between pairs when `pairs`. */
function segmentPositions(points: Float32Array, pairs: boolean) {
  if (pairs) return points;
  const count = Math.max(0, points.length / 3 - 1);
  const out = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) out.set(points.subarray(i * 3, i * 3 + 6), i * 6);
  return out;
}

/**
 * A polyline on the surface as a dark casing under a coloured core, lifted a pixel toward the eye.
 * Its geometry is made once per polyline; a change of style only swaps materials.
 */
const SurfaceLine = memo(function SurfaceLine({
  points,
  style,
  materials,
  pairs = false,
  pick,
}: {
  points: Float32Array;
  style: LineStyle;
  materials: Materials;
  pairs?: boolean;
  /** The feature this line picks as, in Detect mode. */
  pick?: string;
}) {
  const invalidate = useThree((s) => s.invalidate);
  const shape = useMemo(() => {
    const geometry = new LineSegmentsGeometry().setPositions(segmentPositions(points, pairs));
    const group = new Group();
    const casing = new LineSegments2(geometry),
      core = new LineSegments2(geometry);
    casing.computeLineDistances();
    for (const [line, order] of [
      [casing, 6],
      [core, 7],
    ] as const) {
      line.renderOrder = order;
      line.raycast = () => {};
      group.add(line);
    }
    return { geometry, group, casing, core };
  }, [points, pairs]);
  useEffect(() => () => shape.geometry.dispose(), [shape]);
  useLayoutEffect(() => {
    shape.casing.material = materials[style].casing;
    shape.core.material = materials[style].core;
    invalidate();
  }, [shape, style, materials, invalidate]);
  useEffect(() => {
    if (!pick) return;
    const box = shape.geometry.boundingSphere;
    refineCurves.set(pick, {
      points,
      centre: box?.center.clone() ?? new Vector3(),
      radius: box?.radius ?? Infinity,
    });
    return () => {
      if (refineCurves.get(pick)?.points === points) refineCurves.delete(pick);
    };
  }, [pick, points, shape]);
  return <primitive object={shape.group} />;
});

/** What an edge feature draws: its solved curve and, for a hand or selected guide, its guide. */
// Given only its own feature's data, so a change elsewhere in the session does not draw it again.
const EdgeLines = memo(function EdgeLines({
  feature,
  selected,
  solved,
  step,
  materials,
}: {
  feature: RefineFeature & { feature: { type: 'edge' } };
  selected: boolean;
  solved: EdgeCurve | undefined;
  /** mm between the points a guide is drawn through. */
  step: number;
  materials: Materials;
}) {
  if (feature.state === 'accepted') {
    const cut = feature.cutDisplay;
    if (!cut?.segments.length) return null;
    return (
      <>
        <SurfaceLine points={cut.segments} style="accepted" materials={materials} pairs />
        {cut.breaks.length ? <CutBreaks positions={cut.breaks} /> : null}
      </>
    );
  }
  const guide = guidePolyline(feature.feature.input.segments, step);
  const showGuide = feature.origin === 'hand' || selected;
  const mark = solved ? curvePolyline(solved) : guide;
  return (
    <>
      {showGuide && guide.length > 3 ? (
        <SurfaceLine
          points={guide}
          style={selected ? 'guideChosen' : 'guide'}
          materials={materials}
        />
      ) : null}
      {solved || !showGuide ? (
        <SurfaceLine
          points={mark}
          style={selected ? 'chosen' : 'pending'}
          materials={materials}
          pick={feature.id}
        />
      ) : (
        // An unsolved hand guide still picks by its guide line.
        <PickOnly id={feature.id} points={guide} />
      )}
    </>
  );
});

function CutBreaks({ positions }: { positions: Float32Array }) {
  const dpr = useThree((s) => s.viewport.dpr);
  const normals = useMemo(() => new Float32Array(positions.length), [positions]);
  return (
    <points renderOrder={10} raycast={() => {}}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-normal" args={[normals, 3]} />
      </bufferGeometry>
      <pointsMaterial {...surfacePoints} color={foldColor} size={8 * dpr} sizeAttenuation={false} />
    </points>
  );
}

function PickOnly({ id, points }: { id: string; points: Float32Array }) {
  useEffect(() => {
    const centre = new Vector3(),
      count = points.length / 3;
    for (let i = 0; i < points.length; i += 3)
      centre.add(new Vector3(points[i], points[i + 1], points[i + 2]));
    centre.divideScalar(Math.max(1, count));
    let radius = 0;
    for (let i = 0; i < points.length; i += 3)
      radius = Math.max(
        radius,
        Math.hypot(points[i] - centre.x, points[i + 1] - centre.y, points[i + 2] - centre.z),
      );
    refineCurves.set(id, { points, centre, radius });
    return () => {
      if (refineCurves.get(id)?.points === points) refineCurves.delete(id);
    };
  }, [id, points]);
  return null;
}

/** The welded corner of a triangle corner. */
const welded = (mesh: RefineMesh, t: number, c: number) => mesh.weldOf[mesh.corners[t * 3 + c]];

/** Triangles all of whose corners are marked. */
function markedTriangles(
  mesh: RefineMesh,
  marked: Uint8Array,
  candidates: Iterable<number>,
  out: number[],
) {
  for (const t of candidates)
    if (marked[welded(mesh, t, 0)] && marked[welded(mesh, t, 1)] && marked[welded(mesh, t, 2)])
      out.push(t);
  return out;
}

/** The triangles of a selected pending edge's band: those with every corner in the band. */
function bandTriangles(refine: RefineSession, solves: EdgeSolve[]) {
  const { mesh, topology } = refine.model!;
  const marked = new Uint8Array(mesh.weldedCount);
  const candidates = new Set<number>();
  for (const solve of solves)
    for (const band of solve.bands)
      for (const v of band.vertices) {
        if (v >= mesh.weldedCount) continue;
        marked[v] = 1;
        for (let k = topology.triangleStart[v]; k < topology.triangleStart[v + 1]; k++)
          candidates.add(topology.trianglesOf[k]);
      }
  return markedTriangles(mesh, marked, candidates, []);
}

/** Boundary edges of the kept detail in a selected region, as world segment pairs. */
function detailOutline(refine: RefineSession, triangles: Uint32Array, solve: RegionSolve) {
  const { mesh } = refine.model!;
  const shown = refine.draft ?? mesh;
  const marked = new Uint8Array(mesh.weldedCount);
  solve.vertices.forEach((v, i) => {
    if (solve.detail[i] === 1) marked[v] = 1;
  });
  const kept = markedTriangles(mesh, marked, triangles, []);
  if (!kept.length) return null;
  const count = new Map<number, number>();
  const key = (a: number, b: number) =>
    a < b ? a * mesh.weldedCount + b : b * mesh.weldedCount + a;
  for (const t of kept)
    for (let c = 0; c < 3; c++) {
      const k = key(welded(mesh, t, c), welded(mesh, t, (c + 1) % 3));
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  const pairs: number[] = [];
  const position = shown.position;
  for (const t of kept)
    for (let c = 0; c < 3; c++) {
      const a = welded(mesh, t, c),
        b = welded(mesh, t, (c + 1) % 3);
      if (count.get(key(a, b)) !== 1) continue;
      for (const v of [a, b]) pairs.push(position[v * 3], position[v * 3 + 1], position[v * 3 + 2]);
    }
  return Float32Array.from(pairs);
}

/** The tinted sets, in the order their groups are drawn. */
const tintStyles = [
  { color: regionColor, opacity: 0.3 },
  { color: regionColor, opacity: 0.55 },
  { color: pointAccent, opacity: 0.3 },
  { color: warpRegionColor, opacity: 0.5 },
  { color: foldColor, opacity: 0.75 },
] as const;

/**
 * Every tinted triangle in one geometry drawing the preview's own positions through its own index,
 * so a draft or a brush stroke moves the tints with the surface. The index is written only when a
 * tinted set changes.
 */
function Tints({ refine, part }: { refine: RefineSession; part: Part }) {
  const invalidate = useThree((s) => s.invalidate);
  const preview = refine.preview!;
  const pending = refine.features.filter(
    (f): f is RefineFeature & { feature: { type: 'region' } } =>
      f.state === 'pending' && f.feature.type === 'region',
  );
  const edgeSolves = refine.features.flatMap((f) => {
    if (f.state !== 'pending' || f.feature.type !== 'edge' || !refine.selected.includes(f.id))
      return [];
    const solve = refineSolved(refine, f) as EdgeSolve | null;
    return solve ? [solve] : [];
  });
  // What the index is written from; it is rewritten when any of these changes.
  const keyRef = useRef<unknown[]>([]);
  const next: unknown[] = [
    preview,
    refine.model,
    refine.triangles,
    refine.folds,
    refine.skipped,
    ...pending.flatMap((f) => [f.feature.input.triangles, refine.selected.includes(f.id)]),
    ...edgeSolves,
  ];
  if (next.length !== keyRef.current.length || next.some((v, i) => v !== keyRef.current[i]))
    keyRef.current = next;
  const key = keyRef.current;

  const tint = useMemo(() => {
    const geometry = new BufferGeometry();
    const materials = tintStyles.map(
      ({ color, opacity }) =>
        new MeshBasicMaterial({
          color,
          opacity,
          transparent: true,
          side: DoubleSide,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -3,
          polygonOffsetUnits: -3,
        }),
    );
    const mesh = new Mesh(geometry, materials);
    mesh.renderOrder = 5;
    // Its bounds would be the whole preview's, which is not worth measuring.
    mesh.frustumCulled = false;
    mesh.raycast = () => {};
    return { geometry, materials, mesh };
  }, []);
  useEffect(
    () => () => {
      // The position attribute is the preview's own; disposing it here would drop it from the GPU.
      tint.geometry.deleteAttribute('position');
      tint.geometry.dispose();
      for (const material of tint.materials) material.dispose();
    },
    [tint],
  );

  useLayoutEffect(() => {
    const { geometry } = tint;
    const selected = new Set(refine.selected);
    const sets: ArrayLike<number>[][] = [[], [], [], [refine.triangles], []];
    for (const f of pending) sets[selected.has(f.id) ? 1 : 0].push(f.feature.input.triangles);
    if (edgeSolves.length) sets[2].push(bandTriangles(refine, edgeSolves));
    sets[4].push(refine.folds, refine.skipped);
    const total = sets.reduce((sum, set) => sum + set.reduce((n, t) => n + t.length, 0), 0);
    const triangles = refine.model!.mesh.triangleCount;
    const corners = preview.index?.array;
    let attribute = geometry.index;
    if (!attribute || attribute.array.length < total * 3) {
      // Three keeps a replaced attribute's GPU buffer until its geometry is disposed. The position
      // is the preview's own, so it is set aside first and the dispose frees only the old index.
      if (attribute) {
        geometry.deleteAttribute('position');
        geometry.dispose();
      }
      const size = Math.max(total * 3, (attribute?.array.length ?? 0) * 2, 3 * 1024);
      attribute = new BufferAttribute(new Uint32Array(size), 1);
      geometry.setIndex(attribute);
    }
    const index = attribute.array as Uint32Array;
    geometry.clearGroups();
    let at = 0;
    sets.forEach((set, group) => {
      const start = at;
      for (const list of set)
        for (let i = 0; i < list.length; i++) {
          const t = list[i];
          if (!(t < triangles)) continue;
          const o = t * 3;
          index[at++] = corners ? corners[o] : o;
          index[at++] = corners ? corners[o + 1] : o + 1;
          index[at++] = corners ? corners[o + 2] : o + 2;
        }
      if (at > start) geometry.addGroup(start, at - start, group);
    });
    geometry.setAttribute('position', preview.getAttribute('position'));
    attribute.clearUpdateRanges();
    attribute.addUpdateRange(0, at);
    attribute.needsUpdate = true;
    tint.mesh.visible = at > 0;
    invalidate();
    // The key stands for every set tinted.
  }, [tint, key]);

  return (
    <group position={part.position} quaternion={part.quaternion} scale={part.scale}>
      <primitive object={tint.mesh} />
    </group>
  );
}

/** Guide points as screen-sized dots on dark rings; the path's first point a little larger. */
const Handles = memo(function Handles({
  features,
  selected,
  model,
}: Pick<RefineSession, 'features' | 'selected'> & { model: RefineModel }) {
  const refine = { features, selected, model };
  const invalidate = useThree((s) => s.invalidate);
  // Point sizes are in device pixels; handles keep their size in CSS pixels, as picking measures.
  const dpr = useThree((s) => s.viewport.dpr);
  const handles = refineHandles(refine);
  const keyRef = useRef<unknown[]>([]);
  const next: unknown[] = handles.flatMap((h) => [h.point, refine.selected.includes(h.feature)]);
  if (next.length !== keyRef.current.length || next.some((v, i) => v !== keyRef.current[i]))
    keyRef.current = next;
  const key = keyRef.current;
  const dots = useMemo(() => {
    const mesh = refine.model!.mesh;
    const build = (list: RefineHandle[]) => {
      if (!list.length) return null;
      const positions = new Float32Array(list.length * 3),
        normals = new Float32Array(list.length * 3),
        colors = new Float32Array(list.length * 3);
      const a = new Vector3(),
        b = new Vector3(),
        c = new Vector3(),
        accent = new Color(pointAccent),
        idle = new Color(guideIdle);
      list.forEach((handle, i) => {
        positions.set(handle.point.position, i * 3);
        const t = handle.point.triangle;
        if (t >= 0 && t < mesh.triangleCount) {
          const corner = (k: number, out: Vector3) => {
            const v = welded(mesh, t, k) * 3;
            return out.set(mesh.position[v], mesh.position[v + 1], mesh.position[v + 2]);
          };
          corner(0, a);
          corner(1, b).sub(a);
          corner(2, c).sub(a);
          b.cross(c)
            .multiplyScalar(mesh.flipped ? -1 : 1)
            .toArray(normals, i * 3);
        }
        (refine.selected.includes(handle.feature) ? accent : idle).toArray(colors, i * 3);
      });
      return new BufferGeometry()
        .setAttribute('position', new BufferAttribute(positions, 3))
        .setAttribute('normal', new BufferAttribute(normals, 3))
        .setAttribute('color', new BufferAttribute(colors, 3));
    };
    return {
      rest: build(handles.filter((h) => !h.first)),
      first: build(handles.filter((h) => h.first)),
    };
    // The key stands for the handles' points and selection.
  }, [key, refine.model]);
  useEffect(
    () => () => {
      dots.rest?.dispose();
      dots.first?.dispose();
    },
    [dots],
  );
  const materials = useMemo(() => {
    // Each also seen faintly through the surface, as Warp's markers are, where a draft covers it.
    const faint = { depthTest: false, opacity: 0.35 };
    const ring = (size: number, more = {}) =>
      new PointsMaterial({
        ...surfacePoints,
        color: casingColor,
        size: size * dpr,
        sizeAttenuation: false,
        ...more,
      });
    const dot = (size: number, more = {}) =>
      new PointsMaterial({
        ...surfacePoints,
        vertexColors: true,
        size: size * dpr,
        sizeAttenuation: false,
        ...more,
      });
    const sizes = { rest: [10, 6], first: [13, 9] } as const;
    return Object.fromEntries(
      Object.entries(sizes).map(([key, [outer, inner]]) => [
        key,
        [ring(outer, faint), dot(inner, faint), ring(outer), dot(inner)],
      ]),
    ) as Record<keyof typeof sizes, PointsMaterial[]>;
  }, [dpr]);
  useEffect(
    () => () => Object.values(materials).forEach((list) => list.forEach((m) => m.dispose())),
    [materials],
  );
  useEffect(() => invalidate(), [dots, invalidate]);
  const objects = useMemo(
    () =>
      (['rest', 'first'] as const).flatMap((key) => {
        const geometry = dots[key];
        if (!geometry) return [];
        return materials[key].map((material, i) => {
          const points = new Points(geometry, material);
          points.renderOrder = 9 + i;
          points.raycast = () => {};
          return points;
        });
      }),
    [dots, materials],
  );
  return (
    <>
      {objects.map((object) => (
        <primitive key={object.uuid} object={object} />
      ))}
    </>
  );
});

/**
 * What a Refine session draws over its part: guides and their handles, solved edges (solid once
 * accepted, dashed while pending), the selected edge's band, painted triangles, pending regions
 * with the selected one's kept detail outlined, and triangles an accept folded or could not cut.
 */
export function RefineOverlay() {
  const refine = useEditor((s) =>
    s.tool === 'refine' && s.refine?.stage === 'ready' ? s.refine : null,
  );
  const part = useEditor((s) =>
    s.refine ? s.scene.parts.find((p) => p.id === s.refine!.partId) : undefined,
  );
  const hidden = useEditor(
    (s) => s.view.explode > 0 || !!(part && hiddenByIsolation(s.isolated, s.nearbyParts, part.id)),
  );
  const invalidate = useThree((s) => s.invalidate);
  const materials = useMemo(lineMaterials, []);
  useEffect(
    () => () =>
      Object.values(materials).forEach(({ core, casing }) => (core.dispose(), casing.dispose())),
    [materials],
  );
  // The store writes the preview in place, so each session change needs a frame.
  useEffect(() => invalidate(), [refine, invalidate]);
  // Dashes keep their size on screen at any zoom.
  const centre = useMemo(() => new Vector3(), []);
  useFrame(({ camera, size }) => {
    if (refine?.draftStatus === 'presenting' && refine.preview && part?.visible && !hidden)
      requestAnimationFrame(() => useEditor.getState().presentRefineDraft(refine));
    if (!part) return;
    centre.fromArray(part.position);
    let pixel: number;
    if (camera instanceof PerspectiveCamera)
      pixel =
        (2 * camera.position.distanceTo(centre) * Math.tan((camera.fov * Math.PI) / 360)) /
        size.height;
    else if (camera instanceof OrthographicCamera)
      pixel = (camera.top - camera.bottom) / camera.zoom / size.height;
    else return;
    for (const style of ['pending', 'chosen'] as const)
      for (const material of [materials[style].core, materials[style].casing]) {
        material.dashSize = dash * pixel;
        material.gapSize = gap * pixel;
      }
  });
  if (!refine?.model || !refine.preview || !part?.visible || hidden) return null;
  const outlines = refine.features.flatMap((f) => {
    if (f.state !== 'pending' || f.feature.type !== 'region' || !refine.selected.includes(f.id))
      return [];
    const solve = refineSolved(refine, f) as RegionSolve | null;
    return solve ? [{ id: f.id, input: f.feature.input, solve }] : [];
  });
  return (
    <>
      <Tints refine={refine} part={part} />
      {refine.features.map((f) =>
        f.feature.type === 'edge' ? (
          <EdgeLines
            key={f.id}
            feature={f as RefineFeature & { feature: { type: 'edge' } }}
            selected={refine.selected.includes(f.id)}
            solved={
              f.state === 'pending'
                ? (f.curve ?? (refineSolved(refine, f) as EdgeSolve | null)?.curve)
                : undefined
            }
            step={refine.model!.step * 2}
            materials={materials}
          />
        ) : null,
      )}
      {outlines.map(({ id, input, solve }) => (
        <DetailOutline
          key={id}
          refine={refine}
          triangles={input.triangles}
          solve={solve}
          materials={materials}
        />
      ))}
      <Handles features={refine.features} selected={refine.selected} model={refine.model} />
    </>
  );
}

function DetailOutline({
  refine,
  triangles,
  solve,
  materials,
}: {
  refine: RefineSession;
  triangles: Uint32Array;
  solve: RegionSolve;
  materials: Materials;
}) {
  const points = useMemo(
    () => detailOutline(refine, triangles, solve),
    // The outline follows the region and its solve; the draft only moves what is not kept.
    [triangles, solve, refine.model],
  );
  return points ? <SurfaceLine points={points} style="detail" materials={materials} pairs /> : null;
}
