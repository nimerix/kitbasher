import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useThree } from '@react-three/fiber';
import type { ThreeEvent } from '@react-three/fiber';
import { ScreenSizer } from '@react-three/drei';
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Object3D,
  type Mesh,
} from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { partMatrix, transformFromMatrix } from '../core/geometry';
import { hiddenByIsolation } from '../core/isolation';
import { PrecisionDrag } from '../core/precision';
import { finishWarpDrag, useEditor, type WarpBaseline, type WarpSession } from '../core/store';
import { patchGeometry } from '../core/surfaces';
import { writtenNodePositions } from '../core/warp-evaluate';
import {
  transformSelection,
  warpMovesFromPatches,
  type WarpTransformSelection,
} from '../core/transform-selection';
import type { Part, Vec3 } from '../core/types';
import { CombinedTransform } from './CombinedTransform';
import { ManagedTransformControls } from './ManagedTransformControls';
import { warpRegionColor } from './SurfacePainter';

const noRaycast: Mesh['raycast'] = () => {};
const pointAccent = '#ed9b54',
  pointIdle = '#e9eaec',
  foldColor = '#f06a6a';
const closedColor = new Color('#7fd18b'),
  openColor = new Color('#f06a6a');

/** The warped surface the part draws instead of its own, once a grid is laid. */
export const shownWarpPreview = (warp: WarpSession | null, partId: string) =>
  warp?.partId === partId && warp.stage !== 'region' ? warp.preview : null;

/**
 * The painted region, the grid, the control points and their gizmo, the seam and folds.
 * `pressed` says whether the pointer gesture under way began on a gizmo handle.
 */
export function WarpOverlay({ onPress, pressed }: { onPress: () => void; pressed: () => boolean }) {
  const warp = useEditor((s) => (s.tool === 'warp' ? s.warp : null));
  const part = useEditor((s) =>
    s.warp ? s.scene.parts.find((p) => p.id === s.warp!.partId) : undefined,
  );
  const hidden = useEditor(
    (s) => s.view.explode > 0 || !!(part && hiddenByIsolation(s.isolated, s.nearbyParts, part.id)),
  );
  const invalidate = useThree((s) => s.invalidate);
  // The solver writes the preview in place, so each session change needs a frame.
  useEffect(() => invalidate(), [warp, invalidate]);
  if (!warp || !part?.visible || hidden) return null;
  const preview = shownWarpPreview(warp, part.id);
  return (
    <>
      {warp.region === 'painted' && warp.faces.length && !preview ? (
        <PartSpace part={part}>
          <FaceOverlay geometry={part.geometry} faces={warp.faces} color={warpRegionColor} />
        </PartSpace>
      ) : null}
      {warp.stage === 'warp' && preview ? (
        <>
          <PartSpace part={part}>
            {warp.folds.length ? <Folds warp={warp} preview={preview} /> : null}
            {warp.seam ? <Seam warp={warp} /> : null}
          </PartSpace>
          <GridLines warp={warp} />
          {warp.points.map((point) => (
            <PointMarker
              key={point.id}
              id={point.id}
              position={point.target ?? point.pin}
              selected={warp.selectedPoints.includes(point.id)}
              pressed={pressed}
            />
          ))}
          <PointGizmo gizmo={warp.gizmo} onPress={onPress} />
        </>
      ) : null}
    </>
  );
}

function PartSpace({ part, children }: { part: Part; children: ReactNode }) {
  return (
    <group position={part.position} quaternion={part.quaternion} scale={part.scale}>
      {children}
    </group>
  );
}

/** Faces drawn over the part as contact patches are. */
function FaceOverlay({
  geometry: source,
  faces,
  color,
  version,
}: {
  geometry: BufferGeometry;
  faces: ArrayLike<number>;
  color: string;
  version?: unknown;
}) {
  // A preview changes in place, so its version stands in for its positions.
  const geometry = useMemo(
    () => patchGeometry(source, Array.from(faces)),
    [source, faces, version],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh geometry={geometry} raycast={noRaycast} renderOrder={5}>
      <meshBasicMaterial
        color={color}
        side={DoubleSide}
        transparent
        opacity={0.6}
        depthWrite={false}
        polygonOffset
        polygonOffsetFactor={-3}
        polygonOffsetUnits={-3}
      />
    </mesh>
  );
}

/** Region triangles whose normal flipped, drawn on the warped surface. */
function Folds({ warp, preview }: { warp: WarpSession; preview: BufferGeometry }) {
  const faces = useMemo(
    () => Array.from(warp.folds, (triangle) => warp.model!.region.faces[triangle]),
    [warp.folds, warp.model],
  );
  return <FaceOverlay geometry={preview} faces={faces} color={foldColor} version={warp} />;
}

/** Seam vertices, green where closed and red where a gap remains. */
function Seam({ warp }: { warp: WarpSession }) {
  const { model, output, seam } = warp;
  // The first geometry vertex of each welded vertex holds its position.
  const first = useMemo(() => {
    const first = new Int32Array(model!.region.weldedCount).fill(-1);
    model!.region.weldOf.forEach((welded, vertex) => {
      if (welded !== 0xffffffff && first[welded] < 0) first[welded] = vertex;
    });
    return first;
  }, [model]);
  const geometry = useMemo(() => {
    const positions = new Float32Array(seam!.vertices.length * 3),
      colors = new Float32Array(seam!.vertices.length * 3),
      color = new Color();
    seam!.vertices.forEach((welded, i) => {
      positions.set(output!.positions.subarray(first[welded] * 3, first[welded] * 3 + 3), i * 3);
      // A millimetre or more of gap shows full red.
      color.lerpColors(closedColor, openColor, Math.min(1, Math.max(0, seam!.gaps[i])));
      color.toArray(colors, i * 3);
    });
    return new BufferGeometry()
      .setAttribute('position', new BufferAttribute(positions, 3))
      .setAttribute('color', new BufferAttribute(colors, 3));
  }, [seam, output, first]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <points geometry={geometry} raycast={noRaycast} renderOrder={6}>
      <pointsMaterial vertexColors size={4} sizeAttenuation={false} depthWrite={false} />
    </points>
  );
}

/** World position of each grid node, as the grid is drawn. */
const gridNodePositions = (warp: WarpSession) =>
  warp.model!.blend ? writtenNodePositions(warp.model!, warp.state!) : warp.state!.positions;

/**
 * Grid edges are chords between scan vertices, so on a curved surface their middles dip under
 * it. Each edge is drawn nearer the camera by this many times its estimated dip, over the cosine
 * of the angle it is seen at, and never by more than a quarter of its length.
 */
const gridDepthBias = 2;
/**
 * A sharper turn between node normals than half a radian is a crease, which no small bias
 * lifts a chord over. Squared, as |n_a - n_b|².
 */
const maxTurn = (2 * Math.sin(0.25)) ** 2;

/** A grid line material whose edges are pulled toward the camera by `gridDepthBias`. */
function gridMaterial(color: string, linewidth: number, opacity: number) {
  const material = new LineMaterial({
    color,
    linewidth,
    opacity,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  material.uniforms.depthBias = { value: gridDepthBias };
  const end = 'vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );';
  material.vertexShader = material.vertexShader
    .replace(
      'uniform float linewidth;',
      'uniform float linewidth;\nuniform float depthBias;\nattribute vec3 instanceNormal;\nattribute float instanceSag;',
    )
    .replace(
      end,
      `${end}
      bool perspectiveView = projectionMatrix[ 2 ][ 3 ] == - 1.0;
      vec3 toEye = perspectiveView ? normalize( - start.xyz - end.xyz ) : vec3( 0.0, 0.0, 1.0 );
      vec3 normal = normalMatrix * instanceNormal;
      float facing = max( abs( dot( normal, toEye ) ) / max( length( normal ), 1e-6 ), 0.1 );
      float pull = min( depthBias * instanceSag / facing, 0.25 * distance( start.xyz, end.xyz ) );
      if ( perspectiveView ) {
        start.xyz *= max( 0.5, 1.0 - pull / length( start.xyz ) );
        end.xyz *= max( 0.5, 1.0 - pull / length( end.xyz ) );
      } else {
        start.z += pull;
        end.z += pull;
      }`,
    );
  return material;
}

/** Area-weighted unit normal per node, from the grid's own triangles. */
function nodeNormals(nodes: ArrayLike<number>, triangles: Uint32Array, out: Float64Array) {
  out.fill(0);
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t] * 3,
      b = triangles[t + 1] * 3,
      c = triangles[t + 2] * 3;
    const ux = nodes[b] - nodes[a],
      uy = nodes[b + 1] - nodes[a + 1],
      uz = nodes[b + 2] - nodes[a + 2],
      vx = nodes[c] - nodes[a],
      vy = nodes[c + 1] - nodes[a + 1],
      vz = nodes[c + 2] - nodes[a + 2];
    const x = uy * vz - uz * vy,
      y = uz * vx - ux * vz,
      z = ux * vy - uy * vx;
    out[a] += x;
    out[a + 1] += y;
    out[a + 2] += z;
    out[b] += x;
    out[b + 1] += y;
    out[b + 2] += z;
    out[c] += x;
    out[c + 1] += y;
    out[c + 2] += z;
  }
  for (let n = 0; n < out.length; n += 3) {
    const scale =
      1 / (Math.sqrt(out[n] * out[n] + out[n + 1] * out[n + 1] + out[n + 2] * out[n + 2]) || 1);
    out[n] *= scale;
    out[n + 1] *= scale;
    out[n + 2] *= scale;
  }
}

/**
 * Grid edges between the deformed node positions: a dark core over a light casing, so they
 * read over light and dark surfaces alike. Both draw from one endpoint buffer.
 */
function GridLines({ warp }: { warp: WarpSession }) {
  const model = warp.model!;
  const invalidate = useThree((s) => s.invalidate);
  const size = useThree((s) => s.size);
  const grid = useMemo(() => {
    const { edgeStart, edges } = model.grid;
    let count = 0;
    for (let n = 0; n + 1 < edgeStart.length; n++)
      for (let k = edgeStart[n]; k < edgeStart[n + 1]; k++) if (edges[k] > n) count++;
    const pairs = new Uint32Array(count * 2);
    for (let n = 0, e = 0; n + 1 < edgeStart.length; n++)
      for (let k = edgeStart[n]; k < edgeStart[n + 1]; k++)
        if (edges[k] > n) {
          pairs[e++] = n;
          pairs[e++] = edges[k];
        }
    // Per edge: both ends, its normal, and how far its middle dips under the surface.
    const buffer = new InstancedInterleavedBuffer(new Float32Array(count * 10), 10, 1);
    const geometry = new LineSegmentsGeometry();
    geometry.setAttribute('instanceStart', new InterleavedBufferAttribute(buffer, 3, 0));
    geometry.setAttribute('instanceEnd', new InterleavedBufferAttribute(buffer, 3, 3));
    geometry.setAttribute('instanceNormal', new InterleavedBufferAttribute(buffer, 3, 6));
    geometry.setAttribute('instanceSag', new InterleavedBufferAttribute(buffer, 1, 9));
    geometry.instanceCount = count;
    const casing = new LineSegments2(geometry, gridMaterial('#f2f5f4', 4.5, 0.85)),
      core = new LineSegments2(geometry, gridMaterial('#0e1114', 2, 1));
    casing.name = 'warp-grid:casing';
    core.name = 'warp-grid:core';
    casing.renderOrder = 6;
    core.renderOrder = 7;
    for (const line of [casing, core]) {
      line.frustumCulled = false;
      line.raycast = noRaycast;
    }
    return {
      pairs,
      buffer,
      normals: new Float64Array(model.restNodes.length),
      geometry,
      casing,
      core,
    };
  }, [model]);
  useEffect(
    () => () => {
      grid.geometry.dispose();
      grid.casing.material.dispose();
      grid.core.material.dispose();
    },
    [grid],
  );
  useLayoutEffect(() => {
    grid.casing.material.resolution.set(size.width, size.height);
    grid.core.material.resolution.set(size.width, size.height);
    invalidate();
  }, [grid, size, invalidate]);
  useLayoutEffect(() => {
    const nodes = gridNodePositions(warp),
      { pairs, buffer, normals } = grid;
    nodeNormals(nodes, model.grid.triangles, normals);
    const array = buffer.array as Float32Array;
    for (let e = 0; e < pairs.length / 2; e++) {
      const a = pairs[e * 2] * 3,
        b = pairs[e * 2 + 1] * 3,
        o = e * 10;
      for (let i = 0; i < 3; i++) {
        array[o + i] = nodes[a + i];
        array[o + 3 + i] = nodes[b + i];
        array[o + 6 + i] = normals[a + i] + normals[b + i];
      }
      const dx = nodes[b] - nodes[a],
        dy = nodes[b + 1] - nodes[a + 1],
        dz = nodes[b + 2] - nodes[a + 2];
      // Normals that spread apart along the edge mean a convex surface, above the chord there.
      const convex =
        (normals[b] - normals[a]) * dx +
          (normals[b + 1] - normals[a + 1]) * dy +
          (normals[b + 2] - normals[a + 2]) * dz >
        0;
      if (!convex) {
        array[o + 9] = 0;
        continue;
      }
      // An arc of length L whose normals turn by θ dips about L θ / 8 below its chord, and
      // |n_a - n_b| is θ closely enough below the cap.
      const turn =
        2 -
        2 *
          (normals[a] * normals[b] +
            normals[a + 1] * normals[b + 1] +
            normals[a + 2] * normals[b + 2]);
      array[o + 9] = Math.sqrt((dx * dx + dy * dy + dz * dz) * Math.min(turn, maxTurn)) / 8;
    }
    buffer.needsUpdate = true;
    invalidate();
  }, [grid, warp, model, invalidate]);
  return (
    <>
      <primitive object={grid.casing} />
      <primitive object={grid.core} />
    </>
  );
}

/** A control point, sized in pixels. Clicking it selects it, and Shift adds it. */
function PointMarker({
  id,
  position,
  selected,
  pressed,
}: {
  id: string;
  position: Vec3;
  selected: boolean;
  pressed: () => boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const hovering = useRef(false);
  useEffect(
    () => () => {
      if (hovering.current) document.body.style.cursor = 'auto';
    },
    [],
  );
  const color = selected ? pointAccent : hovered ? '#ffffff' : pointIdle;
  return (
    <ScreenSizer position={position}>
      <mesh
        name={`warp-point:${id}`}
        renderOrder={1000}
        onClick={(event: ThreeEvent<MouseEvent>) => {
          event.stopPropagation();
          const state = useEditor.getState();
          // The gizmo centre lies over the marker, and a press there is not a selection click.
          if (
            event.button !== 0 ||
            event.delta > 5 ||
            pressed() ||
            state.navigationMode ||
            state.temporaryOrbit
          )
            return;
          state.selectWarpPoints([id], event.shiftKey || event.metaKey || event.ctrlKey);
        }}
        onPointerOver={(event) => {
          event.stopPropagation();
          hovering.current = true;
          setHovered(true);
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => {
          hovering.current = false;
          setHovered(false);
          document.body.style.cursor = 'auto';
        }}
      >
        <sphereGeometry args={[5, 16, 12]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>
      {/* Seen faintly through the surface when it is behind the part. */}
      <mesh raycast={noRaycast} renderOrder={1000}>
        <sphereGeometry args={[5, 16, 12]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.35}
          depthTest={false}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
    </ScreenSizer>
  );
}

function PointGizmo({ gizmo, onPress }: { gizmo: WarpSession['gizmo']; onPress: () => void }) {
  const scene = useEditor((s) => s.scene),
    selected = useEditor((s) => s.selected),
    view = useEditor((s) => s.view),
    isolated = useEditor((s) => s.isolated),
    nearbyParts = useEditor((s) => s.nearbyParts),
    navigationMode = useEditor((s) => s.navigationMode),
    temporaryOrbit = useEditor((s) => s.temporaryOrbit),
    pivotPicking = useEditor((s) => s.pivotPicking),
    tool = useEditor((s) => s.tool),
    warp = useEditor((s) => s.warp),
    free = useEditor((s) => !!s.freeTransform);
  const selection = useMemo(
    () =>
      transformSelection(
        {
          scene,
          selected,
          view,
          isolated,
          nearbyParts,
          navigationMode,
          temporaryOrbit,
          pivotPicking,
          tool,
          warp,
        },
        gizmo,
      ),
    [
      scene,
      selected,
      view,
      isolated,
      nearbyParts,
      navigationMode,
      temporaryOrbit,
      pivotPicking,
      tool,
      warp,
      gizmo,
    ],
  );
  if (selection.kind !== 'warp' || selection.blocked || free) return null;
  if (gizmo === 'transform') return <CombinedTransform onPress={onPress} />;
  // A single point has no orientation or size to turn or scale.
  if (gizmo !== 'translate' && selection.parts.length < 2) return null;
  return <PointHandle selection={selection} mode={gizmo} onPress={onPress} />;
}

/** Move, rotate or scale handles at the selected points' center. */
function PointHandle({
  selection,
  mode,
  onPress,
}: {
  selection: WarpTransformSelection;
  mode: 'translate' | 'rotate' | 'scale';
  onPress: () => void;
}) {
  const proxy = useMemo(() => new Object3D(), []);
  const start = useRef<{
    baseline: WarpBaseline;
    motion: PrecisionDrag;
    moves: { id: string; target: Vec3 }[];
  } | null>(null);
  const [version, setVersion] = useState(0);
  const getRoot = useThree((s) => s.get),
    invalidate = useThree((s) => s.invalidate);
  const view = useEditor((s) => s.view);
  // Every drag ends in the session, also when it is interrupted, so it is one undo step.
  const finish = useCallback(() => {
    const drag = start.current;
    if (!drag) return;
    start.current = null;
    finishWarpDrag(drag.baseline, drag.moves);
    const controls = getRoot().controls;
    if (controls && 'enabled' in controls) controls.enabled = true;
    setVersion((v) => v + 1);
    invalidate();
  }, [getRoot, invalidate]);
  useEffect(() => {
    window.addEventListener('blur', finish);
    window.addEventListener('pointercancel', finish);
    return () => {
      window.removeEventListener('blur', finish);
      window.removeEventListener('pointercancel', finish);
    };
  }, [finish]);
  useLayoutEffect(() => {
    if (start.current) return;
    proxy.position.copy(selection.pivot);
    proxy.quaternion.identity();
    proxy.scale.set(1, 1, 1);
    proxy.updateMatrixWorld(true);
    invalidate();
  }, [selection, proxy, version, invalidate]);
  return (
    <>
      <primitive object={proxy} />
      <ManagedTransformControls
        key={version}
        object={proxy}
        mode={mode}
        space="world"
        size={0.7}
        translationSnap={view.snap ? view.snapStep : null}
        rotationSnap={view.snap ? (view.rotationSnapStep * Math.PI) / 180 : null}
        scaleSnap={view.snap ? 0.1 : null}
        onFinishDrag={finish}
        onMouseDown={() => {
          onPress();
          const { warp } = useEditor.getState();
          if (!warp?.model) return;
          proxy.updateMatrixWorld(true);
          start.current = {
            baseline: { model: warp.model, points: warp.points, selection },
            motion: new PrecisionDrag(proxy.matrixWorld),
            moves: [],
          };
        }}
        onObjectChange={() => {
          const drag = start.current;
          if (!drag) return;
          proxy.updateMatrixWorld(true);
          const delta = drag.motion.update(
            proxy.matrixWorld,
            useEditor.getState().precision ? 0.1 : 1,
          );
          if (!delta) return;
          const { selection } = drag.baseline;
          const patches = selection.parts.map((point) => ({
            id: point.id,
            patch: transformFromMatrix(point, delta.clone().multiply(partMatrix(point))),
          }));
          const moves = warpMovesFromPatches(selection, patches);
          if (!moves.length) return;
          drag.moves = moves;
          useEditor.getState().moveWarpPoints(moves, 'drag');
        }}
      />
    </>
  );
}
