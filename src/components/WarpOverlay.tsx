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
  Matrix3,
  Matrix4,
  Object3D,
  Vector3,
  type Mesh,
} from 'three';
import { partMatrix, transformFromMatrix } from '../core/geometry';
import { hiddenByIsolation } from '../core/isolation';
import { PrecisionDrag } from '../core/precision';
import { finishWarpDrag, useEditor, type WarpBaseline, type WarpSession } from '../core/store';
import { patchGeometry } from '../core/surfaces';
import {
  transformSelection,
  warpMovesFromPatches,
  type WarpTransformSelection,
} from '../core/transform-selection';
import type { Part, Vec3 } from '../core/types';
import { handleGuides, reachWeights, shownDetail, writtenCentre } from '../core/warp-handles';
import { CombinedTransform } from './CombinedTransform';
import { ManagedTransformControls } from './ManagedTransformControls';
import { warpRegionColor } from './SurfacePainter';
import { gridNodePositions, WarpGrid } from './WarpGrid';
import { surfacePoints } from './surface-points';
import { pointAccent, pointIdle, WarpHandleShapes } from './WarpStroke';

const noRaycast: Mesh['raycast'] = () => {};
const autoIdle = '#a4aab2',
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
          <WarpGrid warp={warp} />
          <WarpHandleShapes warp={warp} part={part} />
          <Reach warp={warp} />
          {warp.points.map((point) => (
            <PointMarker
              key={point.id}
              id={point.id}
              position={writtenCentre(warp.model!, warp.state!, point, shownDetail(warp.output))}
              selected={warp.selectedPoints.includes(point.id)}
              auto={point.auto}
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

/**
 * The geometry vertices of each welded vertex, in order: the first holds its position. Their
 * normals together give the surface's at it, where a scan's unshared corners each hold one face's.
 */
function useWeldedVertices(warp: WarpSession) {
  const { model } = warp;
  return useMemo(() => {
    const { weldOf, weldedCount } = model!.region;
    const start = new Uint32Array(weldedCount + 1);
    for (const welded of weldOf) if (welded !== 0xffffffff) start[welded + 1]++;
    for (let w = 0; w < weldedCount; w++) start[w + 1] += start[w];
    const vertices = new Uint32Array(start[weldedCount]),
      fill = start.slice(0, weldedCount);
    weldOf.forEach((welded, vertex) => {
      if (welded !== 0xffffffff) vertices[fill[welded]++] = vertex;
    });
    const first = (welded: number) => vertices[start[welded]];
    /** The welded vertex's normal into `out`, unnormalised. */
    const normal = (normals: ArrayLike<number>, welded: number, out: Vector3) => {
      out.set(0, 0, 0);
      for (let k = start[welded]; k < start[welded + 1]; k++) {
        const v = vertices[k] * 3;
        out.x += normals[v];
        out.y += normals[v + 1];
        out.z += normals[v + 2];
      }
      return out;
    };
    return { first, normal };
  }, [model]);
}

/** Seam vertices, green where closed and red where a gap remains. */
function Seam({ warp }: { warp: WarpSession }) {
  const { output, seam } = warp;
  const welded = useWeldedVertices(warp);
  const geometry = useMemo(() => {
    const positions = new Float32Array(seam!.vertices.length * 3),
      normals = new Float32Array(seam!.vertices.length * 3),
      colors = new Float32Array(seam!.vertices.length * 3),
      color = new Color(),
      normal = new Vector3();
    seam!.vertices.forEach((vertex, i) => {
      const first = welded.first(vertex) * 3;
      positions.set(output!.positions.subarray(first, first + 3), i * 3);
      if (output!.normals)
        welded
          .normal(output!.normals, vertex, normal)
          .normalize()
          .toArray(normals, i * 3);
      // A millimetre or more of gap shows full red.
      color.lerpColors(closedColor, openColor, Math.min(1, Math.max(0, seam!.gaps[i])));
      color.toArray(colors, i * 3);
    });
    return new BufferGeometry()
      .setAttribute('position', new BufferAttribute(positions, 3))
      .setAttribute('normal', new BufferAttribute(normals, 3))
      .setAttribute('color', new BufferAttribute(colors, 3));
  }, [seam, output, welded]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <points name="warp-seam" geometry={geometry} raycast={noRaycast} renderOrder={8}>
      <pointsMaterial {...surfacePoints} vertexColors size={4} sizeAttenuation={false} />
    </points>
  );
}

/** The reach of each selected handle with guides: what decides which dots show and their colour. */
function reachKey(warp: WarpSession) {
  return warp.points.flatMap((point) =>
    warp.selectedPoints.includes(point.id) && handleGuides(point)
      ? [point.reach, point.radius, point.falloff]
      : [],
  );
}

/**
 * The grid nodes the selected points move, lighter where they carry more of the move, each on a
 * dark dot so it shows on light and dark parts alike. The dots are laid out when the reach
 * changes; moving a point only rewrites their positions.
 */
function Reach({ warp }: { warp: WarpSession }) {
  const invalidate = useThree((s) => s.invalidate);
  const welded = useWeldedVertices(warp);
  const keyRef = useRef<unknown[]>([]);
  const next = reachKey(warp);
  if (next.length !== keyRef.current.length || next.some((value, i) => value !== keyRef.current[i]))
    keyRef.current = next;
  const key = keyRef.current;
  const dots = useMemo(() => {
    const nodes: number[] = [],
      colors: number[] = [];
    const color = new Color(),
      faint = new Color('#6b7178'),
      full = new Color('#ffd9b0');
    for (const point of warp.points) {
      if (!warp.selectedPoints.includes(point.id) || !handleGuides(point)) continue;
      const weights = reachWeights(point);
      point.reach!.node.forEach((n, i) => {
        if (!(weights[i] > 0)) return;
        nodes.push(n);
        color.lerpColors(faint, full, weights[i]).toArray(colors, colors.length);
      });
    }
    if (!nodes.length) return null;
    const geometry = new BufferGeometry()
      .setAttribute('position', new BufferAttribute(new Float32Array(nodes.length * 3), 3))
      .setAttribute('normal', new BufferAttribute(new Float32Array(nodes.length * 3), 3))
      .setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
    return { nodes: Uint32Array.from(nodes), geometry };
    // The key stands for the selected handles' reach and settings.
  }, [key]);
  useEffect(() => () => dots?.geometry.dispose(), [dots]);
  useLayoutEffect(() => {
    if (!dots) return;
    const position = dots.geometry.getAttribute('position') as BufferAttribute;
    const array = position.array as Float32Array;
    // Where the surface was written, which the grid is drawn on too.
    const nodes = gridNodePositions(warp);
    dots.nodes.forEach((n, i) => {
      array[i * 3] = nodes[n * 3];
      array[i * 3 + 1] = nodes[n * 3 + 1];
      array[i * 3 + 2] = nodes[n * 3 + 2];
    });
    position.needsUpdate = true;
    // Each dot's surface normal, in world space as its position is.
    const normal = dots.geometry.getAttribute('normal') as BufferAttribute;
    const model = warp.model!,
      written = warp.output?.normals;
    if (written) {
      const toWorld = new Matrix3().getNormalMatrix(new Matrix4().fromArray(model.matrix));
      const n = new Vector3();
      dots.nodes.forEach((node, i) => {
        welded
          .normal(written, model.grid.nodes[node], n)
          .applyMatrix3(toWorld)
          .normalize()
          .toArray(normal.array, i * 3);
      });
      normal.needsUpdate = true;
    }
    dots.geometry.computeBoundingSphere();
    invalidate();
  }, [dots, welded, warp, invalidate]);
  if (!dots) return null;
  return (
    <>
      <points name="warp-reach:ring" geometry={dots.geometry} raycast={noRaycast} renderOrder={9}>
        <pointsMaterial {...surfacePoints} color="#1b1e22" size={7} sizeAttenuation={false} />
      </points>
      <points name="warp-reach:dot" geometry={dots.geometry} raycast={noRaycast} renderOrder={10}>
        <pointsMaterial {...surfacePoints} vertexColors size={4} sizeAttenuation={false} />
      </points>
    </>
  );
}

/**
 * A control point, sized in pixels; a point placed automatically is smaller and dimmer. Clicking
 * it selects it, and Shift adds it.
 */
/** A control point, sized in pixels. Clicking it selects it, and Shift adds it. */
function PointMarker({
  id,
  position,
  selected,
  auto,
  pressed,
}: {
  id: string;
  position: Vec3;
  selected: boolean;
  auto: boolean;
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
  const color = selected ? pointAccent : hovered ? '#ffffff' : auto ? autoIdle : pointIdle;
  const size = auto && !selected ? 3.5 : 5;
  return (
    <ScreenSizer position={position}>
      <mesh
        name={`warp-point:${id}`}
        renderOrder={1000}
        // A press on a marker selects it, and starts no stroke on the surface behind it.
        onPointerDown={(event: ThreeEvent<PointerEvent>) => event.stopPropagation()}
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
        <sphereGeometry args={[size, 16, 12]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>
      {/* Seen faintly through the surface when it is behind the part. */}
      <mesh raycast={noRaycast} renderOrder={1000}>
        <sphereGeometry args={[size, 16, 12]} />
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
