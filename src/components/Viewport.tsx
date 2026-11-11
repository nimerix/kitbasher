import {
  Component,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ComponentProps, ErrorInfo, ReactNode } from 'react';
import type { TransformControls as TransformControlsImpl } from 'three-stdlib';
import { Canvas, useThree } from '@react-three/fiber';
import type { ThreeEvent } from '@react-three/fiber';
import {
  Billboard,
  Edges,
  GizmoHelper,
  GizmoViewcube,
  Grid,
  Line,
  OrthographicCamera,
  PerspectiveCamera,
  ScreenSizer,
  TransformControls,
} from '@react-three/drei';
import { DoubleSide, Group, Mesh, Object3D, Quaternion, Vector3 } from 'three';
import {
  ChevronDown,
  Focus,
  Grid2X2,
  Layers3,
  Maximize,
  ScanEye,
  ScanLine,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { pickRaycast, prepareForPicking } from '../core/bvh';
import {
  partMatrix,
  partPivot,
  quat,
  sceneBounds,
  transformFromMatrix,
  triangleCount,
  vec,
  worldPoint,
} from '../core/geometry';
import { measureDistance, sceneLighting, useEditor } from '../core/store';
import { PrecisionDrag } from '../core/precision';
import { isJointConnected, translationIsPinned } from '../core/constraints';
import { referencePlanes, resolvePart } from '../core/references';
import type { Part, SurfacePoint, FitAnchor, SceneDocument, SceneLight } from '../core/types';
import { distinctColors, shownColor } from '../core/appearance';
import { updateLight } from '../core/lighting';
import { useShortcut, withShortcut } from '../core/preferences';
import { AnnotationLayer, ProjectionTracker, ViewProjection } from './Annotations';
import { IconButton, useDismiss } from './ui';
import { CameraNavigation, CameraRig } from './CameraNavigation';
import { PaintCursor, SurfacePaintOverlay } from './SurfacePainter';
import { displayedPosition, explodeFrame } from '../core/navigation';
import type { ExplodeFrame } from '../core/navigation';
import { useInspection } from '../hooks/useInspection';
import type { InspectionState } from '../hooks/useInspection';
import { InspectionToggle, InspectionControls, InspectionOverlay } from './InterferenceInspection';
import { hiddenByIsolation, nextIsolation } from '../core/isolation';
import { IsolationNotice, nearbyRaycast, useNearbySurfaces } from './Isolation';
import type { NearbySurfaces } from './Isolation';
import { SceneLighting, overlayLayer, overlayLayers, useSceneFrame } from './SceneLighting';
import type { SceneFrame } from './SceneLighting';
import { DisplayMenu } from './DisplayMenu';
import { LightingPanel } from './LightingPanel';
import { HeadsetButton, HeadsetView } from './Headset';
import { useXR } from '../core/xr-session';
import { partMeshes } from '../xr/part-meshes';

class ViewportBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Viewport:', error, info.componentStack);
  }
  render() {
    return this.state.error ? (
      <div className="viewport-error">
        <ScanLine size={32} />
        <h2>WebGL could not start</h2>
        <p>Enable hardware acceleration in your browser, then reload. Your saved scene is safe.</p>
        <code>{this.state.error}</code>
      </div>
    ) : (
      this.props.children
    );
  }
}

const noRaycast = () => {};
// A press on a gizmo handle also reaches whatever lies under it, but it is not a selection click.
let gizmoPressed = false;

function PartMesh({
  part,
  frame,
  hidden,
  nearby,
  distinct,
}: {
  part: Part;
  frame?: ExplodeFrame;
  /** Left out of an isolated view. */
  hidden: boolean;
  /** Drawn only where it comes near the isolated parts. */
  nearby?: NearbySurfaces;
  /** Its automatic color when every part is shown in a different one. */
  distinct?: string;
}) {
  const shown = part.visible && !hidden;
  const selected = useEditor((s) => s.selected.includes(part.id));
  const inspection = useEditor((s) => s.view.inspection);
  const partColors = useEditor((s) => s.view.partColors);
  const paint = shownColor(part, partColors, distinct);
  const vertexColors = !inspection.enabled && paint.vertexColors;
  const tool = useEditor((s) => s.tool),
    wireframe = useEditor((s) => s.view.wireframe),
    explode = useEditor((s) => s.view.explode),
    navigationMode = useEditor((s) => (s.temporaryOrbit ? 'orbit' : s.navigationMode));
  const group = useRef<Group>(null);
  const [brushHit, setBrushHit] = useState<SurfacePoint | null>(null);
  const register = useCallback(
    (mesh: Mesh | null) => {
      if (mesh) partMeshes.set(part.id, mesh);
      else partMeshes.delete(part.id);
    },
    [part.id],
  );
  const toSurface = (event: ThreeEvent<PointerEvent | MouseEvent>): SurfacePoint => ({
    partId: part.id,
    point: (event.object as Mesh).worldToLocal(event.point.clone()).toArray(),
    normal: event.face?.normal.toArray() ?? [0, 1, 0],
  });
  useEffect(() => {
    // Hidden parts cannot be picked, so a dense one need not pay for this until shown.
    if (shown) prepareForPicking(part.geometry);
  }, [part.geometry, shown]);
  const raycast = useMemo(() => (nearby ? nearbyRaycast(nearby.shows) : pickRaycast), [nearby]);
  const exploded = useMemo(() => displayedPosition(part, explode, frame), [part, explode, frame]);
  const onClick = (event: ThreeEvent<MouseEvent>) => {
    if (event.button !== 0 || event.delta > 5) return;
    event.stopPropagation();
    if (gizmoPressed) return;
    const state = useEditor.getState();
    if (state.navigationMode || state.temporaryOrbit) return;
    if (state.pivotPicking) {
      state.setPartPivot(toSurface(event));
      return;
    }
    if (state.tool === 'anchors') {
      if (state.anchorPicking) state.addFitAnchor(toSurface(event));
      else state.select(part.id);
      return;
    }
    if (state.tool === 'align' && state.operation.mode === 'surface') return;
    if (['align', 'joint', 'measure'].includes(tool)) {
      if (explode) {
        state.notify('Reset the exploded view before picking surfaces.', 'info');
        return;
      }
      const mesh = event.object as Mesh;
      const point = mesh.worldToLocal(event.point.clone());
      const normal = event.face?.normal?.clone() ?? new Vector3(0, 1, 0);
      state.pick({ partId: part.id, point: point.toArray(), normal: normal.toArray() });
    } else state.select(part.id, event.shiftKey || event.metaKey || event.ctrlKey);
  };
  return (
    <>
      <group
        ref={group}
        position={exploded}
        quaternion={part.quaternion}
        scale={part.scale}
        visible={shown}
      >
        <mesh
          ref={register}
          name={`part:${part.id}`}
          geometry={part.geometry}
          // Raycasting ignores Object3D.visible, so a hidden part would still catch clicks.
          raycast={shown ? raycast : noRaycast}
          dispose={null}
          // The shadow pass would draw the whole part, including what is cut away.
          castShadow={!nearby}
          receiveShadow
          onContextMenu={(event) => {
            event.nativeEvent.preventDefault();
            event.stopPropagation();
            useEditor.getState().openContextMenu({
              x: event.nativeEvent.clientX,
              y: event.nativeEvent.clientY,
              partId: part.id,
              point: toSurface(event),
            });
          }}
          onClick={onClick}
          onPointerDown={(event) => {
            const state = useEditor.getState();
            if (
              event.button !== 0 ||
              event.shiftKey ||
              event.ctrlKey ||
              event.metaKey ||
              event.faceIndex == null
            )
              return;
            if (
              state.tool === 'align' &&
              state.operation.mode === 'surface' &&
              !state.navigationMode &&
              !state.temporaryOrbit &&
              !state.pivotPicking
            ) {
              event.stopPropagation();
              state.paintSurface(toSurface(event), event.faceIndex, event.altKey, true);
            }
          }}
          onPointerMove={(event) => {
            const state = useEditor.getState();
            if (
              state.tool !== 'align' ||
              state.operation.mode !== 'surface' ||
              state.navigationMode ||
              state.temporaryOrbit ||
              state.pivotPicking ||
              event.faceIndex == null
            )
              return;
            event.stopPropagation();
            const point = toSurface(event);
            setBrushHit(point);
            if (state.painting && event.buttons & 1)
              state.paintSurface(point, event.faceIndex, event.altKey);
          }}
          onPointerOver={(e) => {
            e.stopPropagation();
            document.body.style.cursor = navigationMode
              ? 'grab'
              : useEditor.getState().pivotPicking ||
                  ['align', 'joint', 'measure', 'anchors'].includes(tool)
                ? 'crosshair'
                : 'pointer';
          }}
          onPointerOut={() => {
            setBrushHit(null);
            document.body.style.cursor = 'auto';
          }}
        >
          <meshStandardMaterial
            // Three compiles vertex colors into the shader, so toggling them needs a new material.
            key={`${inspection.enabled ? 'inspection' : nearby ? 'nearby' : 'solid'}:${vertexColors}`}
            // Both sides, because the facing surfaces of a cut-away part are seen from behind.
            {...(nearby ? { onBeforeCompile: nearby.compile, side: DoubleSide } : {})}
            color={inspection.enabled ? '#a4aab4' : paint.color}
            transparent={inspection.enabled}
            opacity={inspection.enabled ? (inspection.context ? 0.12 : 0) : 1}
            depthWrite={!inspection.enabled}
            roughness={0.64}
            metalness={0.2}
            vertexColors={vertexColors}
            wireframe={!inspection.enabled && wireframe}
            emissive={selected && !inspection.enabled ? '#c77c39' : '#000000'}
            emissiveIntensity={selected ? 0.12 : 0}
          />
          {selected &&
          !inspection.enabled &&
          !wireframe &&
          !nearby &&
          triangleCount(part.geometry) < 150000 ? (
            <Edges threshold={32} color="#e8aa6d" lineWidth={0.8} />
          ) : null}
        </mesh>
      </group>
      <PaintCursor part={part} hit={brushHit} />
    </>
  );
}

function ManagedTransformControls({
  onFinishDrag,
  ...props
}: ComponentProps<typeof TransformControls> & { onFinishDrag: () => void }) {
  const controls = useRef<TransformControlsImpl>(null);
  const gl = useThree((s) => s.gl);
  const connected = useThree((s) => s.events.connected);
  useEffect(() => {
    const current = controls.current;
    current?.connect(connected instanceof HTMLElement ? connected : gl.domElement);
    return () => {
      // The controls keep document-level pointer listeners while dragging.
      current?.dispose();
      onFinishDrag();
    };
  }, [onFinishDrag, gl.domElement, connected]);
  return <TransformControls ref={controls} {...props} onMouseUp={onFinishDrag} />;
}

function TransformGizmo() {
  const selected = useEditor((s) => s.selected),
    tool = useEditor((s) => s.tool),
    parts = useEditor((s) => s.scene.parts),
    joints = useEditor((s) => s.scene.joints),
    view = useEditor((s) => s.view),
    isolated = useEditor((s) => s.isolated),
    nearbyParts = useEditor((s) => s.nearbyParts),
    navigationMode = useEditor((s) => (s.temporaryOrbit ? 'orbit' : s.navigationMode)),
    pivotPicking = useEditor((s) => s.pivotPicking);
  const proxy = useMemo(() => new Object3D(), []),
    dragging = useRef(false);
  const [dragVersion, setDragVersion] = useState(0);
  const [controlVersion, setControlVersion] = useState(0);
  const start = useRef<{
    motion: PrecisionDrag;
    parts: Part[];
    checkpointed: boolean;
    settle?: () => void;
  } | null>(null);
  const invalidate = useThree((s) => s.invalidate);
  const getRoot = useThree((s) => s.get);
  const finishDrag = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    // A drag keeps each frame short, so finish avoiding other parts now that it has ended.
    start.current?.settle?.();
    start.current = null;
    const cameraControls = getRoot().controls;
    if (cameraControls && 'enabled' in cameraControls) cameraControls.enabled = true;
    setDragVersion((version) => version + 1);
    invalidate();
  }, [getRoot, invalidate]);
  useEffect(() => {
    const cancel = () => {
      if (!dragging.current) return;
      finishDrag();
      setControlVersion((version) => version + 1);
    };
    window.addEventListener('blur', cancel);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('blur', cancel);
      window.removeEventListener('pointercancel', cancel);
    };
  }, [finishDrag]);
  const movable = parts.filter(
    (p) =>
      selected.includes(p.id) &&
      p.visible &&
      !p.locked &&
      !hiddenByIsolation(isolated, nearbyParts, p.id),
  );
  const singleJoint =
    movable.length === 1
      ? joints.find((j) => j.childId === movable[0].id && isJointConnected(j))
      : undefined;
  useLayoutEffect(() => {
    if (dragging.current || !movable.length) return;
    // Use visible geometry, never a scanner's possibly distant object origin.
    // Connected parts rotate and scale around their actual surface anchor.
    const center =
      singleJoint && tool !== 'translate'
        ? vec(singleJoint.childAnchor).applyMatrix4(partMatrix(movable[0]))
        : movable.find((part) => part.id === selected[0])?.pivot
          ? partPivot(movable.find((part) => part.id === selected[0])!)
          : sceneBounds(movable).getCenter(new Vector3());
    proxy.position.copy(center);
    proxy.scale.set(1, 1, 1);
    const jointParent = singleJoint ? parts.find((p) => p.id === singleJoint.parentId) : undefined;
    const jointFrame =
      singleJoint && jointParent
        ? quat(jointParent.quaternion).multiply(quat(singleJoint.restRotation))
        : null;
    proxy.quaternion.copy(
      jointFrame ??
        (view.space === 'local' && movable.length === 1
          ? quat(movable[0].quaternion)
          : new Quaternion()),
    );
    proxy.updateMatrixWorld(true);
    invalidate();
  }, [parts, selected, joints, tool, view.space, proxy, invalidate, movable.length, dragVersion]);
  if (
    navigationMode ||
    pivotPicking ||
    !movable.length ||
    !['translate', 'rotate', 'scale'].includes(tool) ||
    view.explode > 0
  )
    return null;
  if (tool === 'translate' && movable.some((part) => translationIsPinned(parts, joints, part.id)))
    return null;
  const locks = tool === 'rotate' ? singleJoint?.rotationLocks : undefined;
  return (
    <>
      <primitive object={proxy} />
      <ManagedTransformControls
        key={controlVersion}
        onFinishDrag={finishDrag}
        object={proxy}
        mode={tool as 'translate' | 'rotate' | 'scale'}
        space={singleJoint ? 'local' : view.space}
        size={0.85}
        showX={!locks?.[0]}
        showY={!locks?.[1]}
        showZ={!locks?.[2]}
        translationSnap={view.snap ? view.snapStep : null}
        rotationSnap={view.snap ? Math.PI / 12 : null}
        scaleSnap={view.snap ? 0.1 : null}
        onMouseDown={() => {
          gizmoPressed = true;
          dragging.current = true;
          proxy.updateMatrixWorld(true);
          start.current = {
            motion: new PrecisionDrag(proxy.matrixWorld),
            parts: movable,
            checkpointed: false,
          };
        }}
        onObjectChange={() => {
          if (!dragging.current || !start.current) return;
          proxy.updateMatrixWorld(true);
          const delta = start.current.motion.update(
            proxy.matrixWorld,
            useEditor.getState().precision ? 0.1 : 1,
          );
          if (!delta) return;
          const patches = start.current.parts.map((part) => ({
            id: part.id,
            patch: transformFromMatrix(part, delta.clone().multiply(partMatrix(part))),
          }));
          // Mirrored parts legitimately have negative scale components.
          if (patches.some((p) => p.patch.scale?.some((v) => Math.abs(v) < 0.001))) return;
          // The first real change checkpoints the drag, so a press without motion
          // adds no undo step and keeps redo available.
          const drag = start.current;
          const apply = (settle: boolean) => {
            const before = useEditor.getState().scene;
            useEditor
              .getState()
              .transformMany(patches, !drag.checkpointed, tool === 'translate', settle);
            if (useEditor.getState().scene !== before) drag.checkpointed = true;
          };
          apply(false);
          drag.settle = useEditor.getState().view.clip.enabled ? () => apply(true) : undefined;
        }}
      />
    </>
  );
}

function AnchorHandle({ part, anchor }: { part: Part; anchor: FitAnchor }) {
  const proxy = useMemo(() => new Object3D(), []);
  const start = useRef<{
    scene: SceneDocument;
    motion: PrecisionDrag;
    origin: Vector3;
    checkpointed: boolean;
    settle?: () => void;
  } | null>(null);
  const [version, setVersion] = useState(0);
  const getRoot = useThree((s) => s.get),
    invalidate = useThree((s) => s.invalidate);
  const view = useEditor((s) => s.view);
  const finish = useCallback(() => {
    if (!start.current) return;
    start.current.settle?.();
    start.current = null;
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
    proxy.position.fromArray(anchor.target);
    proxy.quaternion.copy(view.space === 'local' ? quat(part.quaternion) : new Quaternion());
    proxy.updateMatrixWorld(true);
    invalidate();
  }, [anchor.target, part.quaternion, view.space, proxy, version, invalidate]);
  return (
    <>
      <primitive object={proxy} />
      <ManagedTransformControls
        key={version}
        object={proxy}
        mode="translate"
        space={view.space}
        size={0.7}
        translationSnap={view.snap ? view.snapStep : null}
        onFinishDrag={finish}
        onMouseDown={() => {
          gizmoPressed = true;
          proxy.updateMatrixWorld(true);
          start.current = {
            scene: useEditor.getState().scene,
            motion: new PrecisionDrag(proxy.matrixWorld),
            origin: proxy.position.clone(),
            checkpointed: false,
          };
        }}
        onObjectChange={() => {
          const drag = start.current;
          if (!drag) return;
          proxy.updateMatrixWorld(true);
          const state = useEditor.getState();
          const delta = drag.motion.update(proxy.matrixWorld, state.precision ? 0.1 : 1);
          if (!delta) return;
          const target = drag.origin.clone().applyMatrix4(delta).toArray();
          const apply = (gesture: 'drag' | 'settle') => {
            const before = useEditor.getState().scene;
            useEditor
              .getState()
              .moveFitAnchor(part.id, anchor.id, target, !drag.checkpointed, drag.scene, gesture);
            if (useEditor.getState().scene !== before) drag.checkpointed = true;
          };
          apply('drag');
          drag.settle = state.view.clip.enabled ? () => apply('settle') : undefined;
        }}
      />
    </>
  );
}

function AnchorOverlay() {
  const tool = useEditor((s) => s.tool),
    parts = useEditor((s) => s.scene.parts);
  const selected = useEditor((s) => s.selected),
    active = useEditor((s) => s.activeAnchor);
  const picking = useEditor((s) => s.anchorPicking),
    explode = useEditor((s) => s.view.explode);
  const navigating = useEditor((s) => !!s.navigationMode || s.temporaryOrbit || s.pivotPicking);
  const part = parts.find((p) => p.id === selected[0]);
  const hidden = useEditor((s) => !!part && hiddenByIsolation(s.isolated, s.nearbyParts, part.id));
  if (tool !== 'anchors' || explode || !part?.visible || hidden) return null;
  const anchors = part.anchors ?? [];
  const current = anchors.find((a) => a.id === active) ?? anchors[0];
  // The markers and their number labels are drawn by the annotation layer.
  return (
    <>
      {anchors.map((anchor) => {
        const actual = vec(anchor.point).applyMatrix4(partMatrix(part));
        const target = vec(anchor.target);
        return actual.distanceToSquared(target) > 1e-12 ? (
          <Line
            key={anchor.id}
            points={[actual, target]}
            color={current?.id === anchor.id ? '#ffbd7a' : '#7ce1d1'}
            lineWidth={1.5}
            depthTest={false}
            raycast={noRaycast}
          />
        ) : null;
      })}
      {current && !part.locked && !picking && !navigating && (
        <AnchorHandle key={`${part.id}:${current.id}`} part={part} anchor={current} />
      )}
    </>
  );
}

const handleAccent = '#ed9b54',
  handleIdle = '#959aa3';

/**
 * Where a world light's handle sits. Only a directional light's direction counts, so its handle
 * rides a sphere just outside the scene, where it stays in view.
 */
function lightHandlePosition(light: SceneLight, frame: SceneFrame, onSphere = true) {
  const position = vec(light.position);
  if (light.kind === 'point') return position;
  return (onSphere ? position.setLength(1.2 * frame.radius) : position).add(frame.center);
}

function LightMarker({
  light,
  position,
  frame,
  active,
}: {
  light: SceneLight;
  position: Vector3;
  frame: SceneFrame;
  active: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const hovering = useRef(false);
  useEffect(
    () => () => {
      if (hovering.current) document.body.style.cursor = 'auto';
    },
    [],
  );
  const opacity = light.enabled ? 1 : 0.35;
  const overlay = {
    transparent: true,
    opacity,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  };
  return (
    <>
      {light.kind === 'directional' ? (
        <Line
          points={[frame.center, position]}
          color={active ? handleAccent : handleIdle}
          lineWidth={1}
          dashed
          dashSize={frame.radius * 0.04}
          gapSize={frame.radius * 0.03}
          transparent
          opacity={0.6 * opacity}
          layers={overlayLayers}
          raycast={noRaycast}
        />
      ) : null}
      {/* Sized in pixels, so handles read the same at any scene scale or zoom. */}
      <ScreenSizer position={position}>
        <Billboard>
          <mesh layers={overlayLayers} renderOrder={1000} raycast={noRaycast}>
            <circleGeometry args={[4.5, 24]} />
            <meshBasicMaterial color={light.color} {...overlay} />
          </mesh>
          <mesh layers={overlayLayers} renderOrder={1000} raycast={noRaycast}>
            <ringGeometry args={[active ? 6.5 : 7, active ? 9.5 : 8.5, 32]} />
            <meshBasicMaterial
              color={active ? handleAccent : hovered ? '#e9eaec' : handleIdle}
              {...overlay}
            />
          </mesh>
          <mesh
            layers={overlayLayers}
            userData={{ lightHandle: true }}
            // Whatever a press on a handle ends on, it never selects or deselects parts.
            onPointerDown={(event) => {
              event.stopPropagation();
              gizmoPressed = true;
            }}
            onContextMenu={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              const state = useEditor.getState();
              if (event.button !== 0 || event.delta > 5) return;
              if (!state.navigationMode && !state.temporaryOrbit) state.setActiveLight(light.id);
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
            <circleGeometry args={[12, 16]} />
            <meshBasicMaterial visible={false} />
          </mesh>
        </Billboard>
      </ScreenSizer>
    </>
  );
}

function LightHandles() {
  const open = useEditor((s) => s.lightingPanel);
  return open ? <LightHandleLayer /> : null;
}

/** Markers for the world lights and a translate gizmo on the active one. */
function LightHandleLayer() {
  const lights = useEditor(sceneLighting).lights.filter((light) => !light.camera),
    active = useEditor((s) => s.activeLight);
  // Other tools have their own gizmos or picks, which a light's gizmo would overlap.
  const movable = useEditor(
    (s) => s.tool === 'select' && !s.navigationMode && !s.temporaryOrbit && !s.pivotPicking,
  );
  const snap = useEditor((s) => (s.view.snap ? s.view.snapStep : null));
  const current = useSceneFrame();
  const camera = useThree((s) => s.camera),
    raycaster = useThree((s) => s.raycaster),
    setEvents = useThree((s) => s.setEvents),
    getRoot = useThree((s) => s.get),
    invalidate = useThree((s) => s.invalidate);
  const proxy = useMemo(() => new Object3D(), []);
  const start = useRef<{
    id: string;
    frame: SceneFrame;
    motion: PrecisionDrag;
    origin: Vector3;
    checkpointed: boolean;
  } | null>(null);
  // Handles keep the scene frame they started with, so a drag never chases its own handle.
  const [drag, setDrag] = useState<{ id: string; frame: SceneFrame; moved: boolean } | null>(null);
  const [version, setVersion] = useState(0);
  const frame = drag?.frame ?? current;
  const selected = lights.find((light) => light.id === active);
  useLayoutEffect(() => {
    camera.layers.enable(overlayLayer);
    raycaster.layers.enable(overlayLayer);
    invalidate();
    return () => {
      camera.layers.disable(overlayLayer);
      raycaster.layers.disable(overlayLayer);
      invalidate();
    };
  }, [camera, raycaster, invalidate]);
  useEffect(() => {
    // Handles draw over the parts, so they also take the click before anything behind them.
    const previous = getRoot().events.filter;
    setEvents({
      filter: (hits, state) => {
        const sorted = previous ? previous(hits, state) : hits;
        const handle = (hit: (typeof sorted)[number]) => !!hit.object.userData.lightHandle;
        if (!sorted.some(handle)) return sorted;
        // Overlays in their own scenes, such as the view cube, still come first.
        const inScene = (hit: (typeof sorted)[number]) => {
          let root = hit.object;
          while (root.parent) root = root.parent;
          return root === state.scene;
        };
        return [
          ...sorted.filter((hit) => !inScene(hit)),
          ...sorted.filter(handle),
          ...sorted.filter((hit) => inScene(hit) && !handle(hit)),
        ];
      },
    });
    return () => setEvents({ filter: previous });
  }, [getRoot, setEvents]);
  const finish = useCallback(() => {
    if (!start.current) return;
    start.current = null;
    setDrag(null);
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
    if (start.current || !selected) return;
    proxy.position.copy(lightHandlePosition(selected, frame));
    proxy.updateMatrixWorld(true);
    invalidate();
  }, [selected, frame, proxy, version, invalidate]);
  return (
    <>
      {lights.map((light) => (
        <LightMarker
          key={light.id}
          light={light}
          // While dragged, a directional handle follows the pointer off its sphere.
          position={lightHandlePosition(light, frame, !(drag?.id === light.id && drag.moved))}
          frame={frame}
          active={light.id === active}
        />
      ))}
      {selected && movable ? (
        <>
          <primitive object={proxy} />
          <ManagedTransformControls
            key={`${selected.id}:${version}`}
            object={proxy}
            mode="translate"
            space="world"
            size={0.7}
            translationSnap={snap}
            onFinishDrag={finish}
            onMouseDown={() => {
              gizmoPressed = true;
              proxy.updateMatrixWorld(true);
              start.current = {
                id: selected.id,
                frame,
                motion: new PrecisionDrag(proxy.matrixWorld),
                origin: proxy.position.clone(),
                checkpointed: false,
              };
              setDrag({ id: selected.id, frame, moved: false });
            }}
            onObjectChange={() => {
              const gesture = start.current;
              if (!gesture) return;
              proxy.updateMatrixWorld(true);
              const state = useEditor.getState();
              const delta = gesture.motion.update(proxy.matrixWorld, state.precision ? 0.1 : 1);
              if (!delta) return;
              const lighting = sceneLighting(state);
              const light = lighting.lights.find((l) => l.id === gesture.id);
              if (!light) return;
              const target = gesture.origin.clone().applyMatrix4(delta);
              if (light.kind === 'directional') {
                target.sub(gesture.frame.center);
                // A directional light needs a direction.
                if (target.length() < gesture.frame.radius * 1e-6) return;
              }
              const before = state.scene;
              // The first real change checkpoints the drag, like part and anchor drags.
              state.setLighting(
                updateLight(lighting, gesture.id, { position: target.toArray() }),
                !gesture.checkpointed,
              );
              if (gesture.checkpointed || useEditor.getState().scene === before) return;
              gesture.checkpointed = true;
              setDrag({ id: gesture.id, frame: gesture.frame, moved: true });
            }}
          />
        </>
      ) : null}
    </>
  );
}

/** Lines between picked points. The points and labels are drawn by the annotation layer. */
function AssemblyAnnotations() {
  const scene = useEditor((s) => s.scene),
    op = useEditor((s) => s.operation),
    explode = useEditor((s) => s.view.explode),
    measurement = useEditor((s) => s.measurement);
  if (explode) return null;
  const measured =
    measurement.length === 2
      ? [resolvePart(scene, measurement[0].partId), resolvePart(scene, measurement[1].partId)]
      : null;
  return (
    <>
      {op.pairs.map((pair, i) => {
        const source = resolvePart(scene, pair.source.partId),
          target = resolvePart(scene, pair.target.partId);
        return source && target ? (
          <Line
            key={i}
            points={[worldPoint(source, pair.source), worldPoint(target, pair.target)]}
            color="#dda165"
            dashed
            dashSize={1.2}
            gapSize={0.7}
            lineWidth={1.2}
            raycast={noRaycast}
          />
        ) : null;
      })}
      {measured?.[0] && measured[1] ? (
        <Line
          points={[
            worldPoint(measured[0], measurement[0]),
            worldPoint(measured[1], measurement[1]),
          ]}
          color="#a2cec4"
          lineWidth={1.5}
          raycast={noRaycast}
        />
      ) : null}
    </>
  );
}

function Scene({
  inspection,
  projection,
}: {
  inspection: InspectionState;
  projection: ViewProjection;
}) {
  useEffect(() => {
    const finish = () => useEditor.getState().endPaintStroke();
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('blur', finish);
    return () => {
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('blur', finish);
    };
  }, []);
  const parts = useEditor((s) => s.scene.parts),
    view = useEditor((s) => s.view),
    operation = useEditor((s) => s.operation),
    tool = useEditor((s) => s.tool);
  const isolated = useEditor((s) => s.isolated);
  const headset = useXR((s) => !!s.session),
    passthrough = useXR((s) => s.passthrough);
  const nearby = useNearbySurfaces();
  const exploding = view.explode > 0;
  const frame = useMemo(() => (exploding ? explodeFrame(parts) : undefined), [exploding, parts]);
  const distinct = useMemo(
    () => (view.partColors === 'distinct' ? distinctColors(parts) : undefined),
    [view.partColors, parts],
  );
  return (
    <>
      {/* A headset that shows the room draws the scene over it, so nothing may fill the view. */}
      {passthrough ? null : <color attach="background" args={['#272a2f']} />}
      <PerspectiveCamera
        makeDefault={view.projection === 'perspective'}
        position={[150, 125, 200]}
        fov={35}
        near={0.1}
        far={50000}
      />
      <OrthographicCamera
        makeDefault={view.projection === 'orthographic'}
        position={[150, 125, 200]}
        zoom={5}
        near={0.1}
        far={50000}
      />
      <CameraRig />
      <SceneLighting />
      {view.grid ? (
        <Grid
          position={[0, -0.07, 0]}
          args={[600, 600]}
          cellSize={10}
          sectionSize={50}
          cellThickness={0.5}
          sectionThickness={0.7}
          cellColor="#42464c"
          sectionColor="#575c61"
          fadeDistance={450}
          fadeStrength={1.5}
          infiniteGrid
        />
      ) : null}
      {parts.map((part) => {
        const outside = !!isolated && !isolated.includes(part.id);
        const surfaces = outside && nearby?.ids.has(part.id) ? nearby.surfaces : undefined;
        return (
          <PartMesh
            key={part.id}
            part={part}
            frame={frame}
            hidden={outside && !surfaces}
            nearby={surfaces}
            distinct={distinct?.get(part.id)}
          />
        );
      })}
      {referencePlanes
        .filter((p) => view.planes.includes(p.id) || operation.targetId === p.id)
        .map((plane) => (
          <mesh
            key={plane.id}
            geometry={plane.geometry}
            onClick={(event) => {
              if (
                gizmoPressed ||
                useEditor.getState().navigationMode ||
                useEditor.getState().temporaryOrbit ||
                (tool === 'align' && useEditor.getState().operation.mode === 'surface') ||
                !['align', 'joint', 'measure'].includes(tool)
              )
                return;
              event.stopPropagation();
              if (event.button !== 0 || event.delta > 5) return;
              useEditor.getState().pick({
                partId: plane.id,
                point: event.point.toArray(),
                normal: event.face?.normal.toArray() ?? [0, 1, 0],
              });
            }}
          >
            <meshBasicMaterial
              color={plane.color}
              transparent
              opacity={operation.targetId === plane.id ? 0.12 : 0.045}
              depthWrite={false}
              side={DoubleSide}
            />
            <Edges color={plane.color} transparent opacity={0.4} />
          </mesh>
        ))}
      <InspectionOverlay inspection={inspection} />
      <SurfacePaintOverlay />
      <HeadsetView />
      {/* Handles and the view cube answer to the mouse, which a headset session does not have. */}
      {headset ? null : (
        <>
          <TransformGizmo />
          <AnchorOverlay />
          <LightHandles />
          <AssemblyAnnotations />
          <ProjectionTracker projection={projection} />
          <GizmoHelper alignment="top-right" margin={[62, 66]}>
            <GizmoViewcube
              font="12px sans-serif"
              color="#373b41"
              textColor="#c4c8ce"
              hoverColor="#d29560"
              strokeColor="#636970"
              faces={['RIGHT', 'LEFT', 'TOP', 'BOTTOM', 'FRONT', 'BACK']}
            />
          </GizmoHelper>
        </>
      )}
    </>
  );
}

export function Viewport() {
  const inspection = useInspection();
  const view = useEditor((s) => s.view),
    tool = useEditor((s) => s.tool),
    selected = useEditor((s) => s.selected),
    isolated = useEditor((s) => s.isolated),
    parts = useEditor((s) => s.scene.parts),
    op = useEditor((s) => s.operation),
    measurement = useEditor((s) => s.measurement),
    navigationMode = useEditor((s) => (s.temporaryOrbit ? 'orbit' : s.navigationMode)),
    pivotPicking = useEditor((s) => s.pivotPicking);
  const setView = useEditor((s) => s.setView),
    focus = useEditor((s) => s.focus);
  const [viewMenu, setViewMenu] = useState(false);
  const viewSelector = useRef<HTMLDivElement>(null);
  const projection = useMemo(() => new ViewProjection(), []);
  const keys = {
    projection: useShortcut('projection'),
    pivot: useShortcut('pivot'),
    hold: useShortcut('holdOrbit'),
    focus: useShortcut('focus'),
    frameAll: useShortcut('frameAll'),
    isolate: useShortcut('isolate'),
  };
  const orbitHint = `Middle${keys.hold ? ` / ${keys.hold}` : ''}: orbit`;
  const closeViewMenu = useCallback(() => setViewMenu(false), []);
  useDismiss(viewSelector, viewMenu, closeViewMenu);
  const picked = op.pairs.length;
  const distance = measurement.length === 2 ? measureDistance() : null;
  return (
    <main
      className={`viewport ${navigationMode ? `is-camera-tool is-${navigationMode}` : pivotPicking || ['align', 'joint', 'measure'].includes(tool) ? 'is-picking' : ''}`}
      aria-label="3D assembly viewport"
      tabIndex={0}
      onPointerDownCapture={() => {
        gizmoPressed = false;
      }}
    >
      <div className="viewport-top">
        <div className="view-selector" ref={viewSelector}>
          <button
            aria-haspopup="true"
            aria-expanded={viewMenu}
            onClick={() => setViewMenu(!viewMenu)}
          >
            <span className="view-dot" />
            {view.projection === 'perspective' ? 'Perspective' : 'Orthographic'}
            <ChevronDown size={12} />
          </button>
          {viewMenu ? (
            <div className="view-menu">
              {(['iso', 'front', 'right', 'top', 'back', 'left'] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => {
                    focus(v, true);
                    setViewMenu(false);
                  }}
                >
                  {v === 'iso' ? 'Isometric' : v[0].toUpperCase() + v.slice(1)}
                </button>
              ))}
              <button
                onClick={() => {
                  setView({
                    projection: view.projection === 'perspective' ? 'orthographic' : 'perspective',
                  });
                  setViewMenu(false);
                }}
              >
                Toggle projection {keys.projection ? <kbd>{keys.projection}</kbd> : null}
              </button>
            </div>
          ) : null}
        </div>
        <InspectionToggle inspection={inspection} />
        <DisplayMenu />
        <HeadsetButton />
      </div>
      <ViewportBoundary>
        <Suspense fallback={<div className="viewport-loading">Preparing the workbench…</div>}>
          <Canvas
            shadows
            dpr={[1, 2]}
            frameloop="demand"
            gl={{ antialias: true, preserveDrawingBuffer: true }}
            onCreated={({ raycaster }) => {
              raycaster.firstHitOnly = true;
            }}
            onPointerMissed={(event) => {
              if (
                event.type === 'click' &&
                event.button === 0 &&
                !gizmoPressed &&
                !useEditor.getState().temporaryOrbit &&
                !useEditor.getState().navigationMode &&
                !useEditor.getState().pivotPicking &&
                tool !== 'align' &&
                tool !== 'joint' &&
                tool !== 'measure'
              )
                useEditor.getState().select(null);
            }}
          >
            <Scene inspection={inspection} projection={projection} />
          </Canvas>
        </Suspense>
      </ViewportBoundary>
      <AnnotationLayer projection={projection} />
      <InspectionControls inspection={inspection} />
      <div className="canvas-label" hidden={view.inspection.enabled}>
        <span className="canvas-label-line" />
        <span>ASSEMBLY SPACE</span>
        <span className="canvas-label-units">mm</span>
      </div>
      {pivotPicking ? (
        <div className="pick-prompt">
          <span>Click a spot on a model to set its pivot</span>
          {keys.pivot ? <kbd>{keys.pivot}</kbd> : null}
          <button onClick={() => useEditor.getState().setPivotPicking(false)}>Cancel</button>
        </div>
      ) : !navigationMode && tool === 'align' && op.mode === 'surface' ? (
        <div className="pick-prompt paint-prompt">
          <span>
            {op.activeSurface
              ? op.surfaceMethod === 'flush'
                ? `Paint across both sides of seam ${op.surfacePairs.findIndex((pair) => pair.id === op.activeSurface!.pairId) + 1} · add seams to protect other connections`
                : `Paint the ${op.activeSurface.side === 'source' ? 'moving' : 'target'} patch · pair ${op.surfacePairs.findIndex((pair) => pair.id === op.activeSurface!.pairId) + 1}`
              : 'Choose a patch to paint, add a pair, or fit'}
          </span>
          <small>{orbitHint} · Right: pan</small>
        </div>
      ) : !navigationMode && ['align', 'joint'].includes(tool) ? (
        <div className="pick-prompt">
          <span className={`pick-step ${!op.pending ? 'current' : ''}`}>1</span>
          <span>
            {op.pending
              ? 'Pick the matching target surface'
              : picked && op.mode !== 'multi'
                ? 'Pair ready — apply in the inspector'
                : op.mode === 'multi'
                  ? `Pick the source for pair ${picked + 1}`
                  : 'Pick a surface on the moving part'}
          </span>
          <small>{orbitHint}</small>
          <span className={`pick-step ${op.pending ? 'current' : ''}`}>2</span>
          {picked ? (
            <span className="pair-count">
              {picked} {picked === 1 ? 'pair' : 'pairs'}
            </span>
          ) : null}
        </div>
      ) : null}
      {!navigationMode && tool === 'measure' ? (
        <div className="pick-prompt">
          {distance !== null ? (
            <>
              <span className="measurement-value">
                {distance.toFixed(3)} <small>mm</small>
              </span>
              <span>Click to measure again</span>
            </>
          ) : (
            <span>Pick {measurement.length ? 'a second' : 'the first'} surface point</span>
          )}
        </div>
      ) : null}
      <div className="viewport-notices">
        {view.explode > 0 ? (
          <div className="exploded-notice">
            Exploded view <button onClick={() => setView({ explode: 0 })}>Reset</button>
          </div>
        ) : null}
        <IsolationNotice />
      </div>
      <CameraNavigation />
      <LightingPanel projection={projection} />
      <div className="viewport-bottom">
        <div className="canvas-selection">
          <span className="selection-dot" />
          {selected.length === 1
            ? parts.find((p) => p.id === selected[0])?.name
            : selected.length
              ? `${selected.length} parts selected`
              : 'No selection'}
          <span className="canvas-selection-detail">
            {selected.length ? 'Selected' : 'Click a part to select'}
          </span>
        </div>
        <div className="viewport-controls">
          <IconButton
            label="Toggle grid"
            active={view.grid}
            onClick={() => setView({ grid: !view.grid })}
          >
            <Grid2X2 size={16} />
          </IconButton>
          <IconButton
            label="Toggle wireframe"
            active={view.wireframe}
            onClick={() => setView({ wireframe: !view.wireframe })}
          >
            <Layers3 size={16} />
          </IconButton>
          <IconButton
            label={withShortcut(
              isolated && !nextIsolation(parts, selected, isolated)
                ? 'Exit isolation'
                : 'Isolate selection',
              keys.isolate,
            )}
            active={!!isolated}
            onClick={() => useEditor.getState().toggleIsolation()}
          >
            <ScanEye size={16} />
          </IconButton>
          <span className="tool-divider" />
          <IconButton
            label="Zoom out"
            onClick={() => window.dispatchEvent(new CustomEvent('kitbasher:zoom', { detail: 0.8 }))}
          >
            <ZoomOut size={16} />
          </IconButton>
          <IconButton
            label="Zoom in"
            onClick={() =>
              window.dispatchEvent(new CustomEvent('kitbasher:zoom', { detail: 1.25 }))
            }
          >
            <ZoomIn size={16} />
          </IconButton>
          <IconButton label={withShortcut('Focus selection', keys.focus)} onClick={() => focus()}>
            <Focus size={17} />
          </IconButton>
          <IconButton
            label={withShortcut('Frame all', keys.frameAll)}
            onClick={() => focus(undefined, true)}
          >
            <Maximize size={16} />
          </IconButton>
        </div>
      </div>
    </main>
  );
}
