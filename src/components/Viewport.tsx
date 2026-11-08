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
  ContactShadows,
  Edges,
  GizmoHelper,
  GizmoViewcube,
  Grid,
  Html,
  Line,
  OrthographicCamera,
  PerspectiveCamera,
  TransformControls,
} from '@react-three/drei';
import { DoubleSide, Group, Mesh, Object3D, Quaternion, Vector3 } from 'three';
import {
  ChevronDown,
  Focus,
  Grid2X2,
  Layers3,
  Maximize,
  ScanLine,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { acceleratedRaycast, computeBoundsTree } from 'three-mesh-bvh';
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
import { measureDistance, useEditor } from '../core/store';
import { PrecisionDrag } from '../core/precision';
import { isJointConnected, translationIsPinned } from '../core/constraints';
import { referencePlanes, resolvePart } from '../core/references';
import type { Part, SurfacePoint } from '../core/types';
import { IconButton, useDismiss } from './ui';
import { CameraNavigation, CameraRig } from './CameraNavigation';
import { PaintCursor, SurfacePaintOverlay } from './SurfacePainter';
import { displayedPosition, explodeFrame } from '../core/navigation';
import type { ExplodeFrame } from '../core/navigation';
import { useInspection } from '../hooks/useInspection';
import type { InspectionState } from '../hooks/useInspection';
import { InspectionToggle, InspectionControls, InspectionOverlay } from './InterferenceInspection';

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

function PartMesh({ part, frame }: { part: Part; frame?: ExplodeFrame }) {
  const selected = useEditor((s) => s.selected.includes(part.id));
  const inspection = useEditor((s) => s.view.inspection);
  const tool = useEditor((s) => s.tool),
    wireframe = useEditor((s) => s.view.wireframe),
    explode = useEditor((s) => s.view.explode),
    navigationMode = useEditor((s) => (s.temporaryOrbit ? 'orbit' : s.navigationMode));
  const group = useRef<Group>(null);
  const [brushHit, setBrushHit] = useState<SurfacePoint | null>(null);
  const toSurface = (event: ThreeEvent<PointerEvent | MouseEvent>): SurfacePoint => ({
    partId: part.id,
    point: (event.object as Mesh).worldToLocal(event.point.clone()).toArray(),
    normal: event.face?.normal.toArray() ?? [0, 1, 0],
  });
  useEffect(() => {
    if (triangleCount(part.geometry) > 30000 && !part.geometry.boundsTree) {
      computeBoundsTree.call(part.geometry, { indirect: true, maxLeafSize: 10 });
    }
  }, [part.geometry]);
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
        visible={part.visible}
      >
        <mesh
          name={`part:${part.id}`}
          geometry={part.geometry}
          // Raycasting ignores Object3D.visible, so a hidden part would still catch clicks.
          raycast={part.visible ? acceleratedRaycast : noRaycast}
          dispose={null}
          castShadow
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
              : useEditor.getState().pivotPicking || ['align', 'joint', 'measure'].includes(tool)
                ? 'crosshair'
                : 'pointer';
          }}
          onPointerOut={() => {
            setBrushHit(null);
            document.body.style.cursor = 'auto';
          }}
        >
          <meshStandardMaterial
            key={inspection.enabled ? 'inspection' : 'solid'}
            color={inspection.enabled ? '#a4aab4' : part.color}
            transparent={inspection.enabled}
            opacity={inspection.enabled ? (inspection.context ? 0.12 : 0) : 1}
            depthWrite={!inspection.enabled}
            roughness={0.64}
            metalness={0.2}
            vertexColors={!inspection.enabled && !!part.geometry.getAttribute('color')}
            wireframe={!inspection.enabled && wireframe}
            emissive={selected && !inspection.enabled ? '#c77c39' : '#000000'}
            emissiveIntensity={selected ? 0.12 : 0}
          />
          {selected &&
          !inspection.enabled &&
          !wireframe &&
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
    navigationMode = useEditor((s) => (s.temporaryOrbit ? 'orbit' : s.navigationMode)),
    pivotPicking = useEditor((s) => s.pivotPicking);
  const proxy = useMemo(() => new Object3D(), []),
    dragging = useRef(false);
  const [dragVersion, setDragVersion] = useState(0);
  const [controlVersion, setControlVersion] = useState(0);
  const start = useRef<{ motion: PrecisionDrag; parts: Part[]; checkpointed: boolean } | null>(
    null,
  );
  const invalidate = useThree((s) => s.invalidate);
  const getRoot = useThree((s) => s.get);
  const finishDrag = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
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
  const movable = parts.filter((p) => selected.includes(p.id) && p.visible && !p.locked);
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
          const before = useEditor.getState().scene;
          useEditor
            .getState()
            .transformMany(patches, !start.current.checkpointed, tool === 'translate');
          if (useEditor.getState().scene !== before) start.current.checkpointed = true;
        }}
      />
    </>
  );
}

function Marker({ point, color, label }: { point: SurfacePoint; color: string; label?: string }) {
  const part = useEditor((s) => resolvePart(s.scene, point.partId));
  if (!part) return null;
  const position = worldPoint(part, point);
  return (
    <group position={position}>
      <mesh renderOrder={10}>
        <sphereGeometry args={[0.9, 16, 12]} />
        <meshBasicMaterial color={color} depthTest={false} />
      </mesh>
      {label ? (
        <Html position={[0, 3, 0]} center style={{ pointerEvents: 'none' }}>
          <span className="surface-pick-label" style={{ color }}>
            {label}
          </span>
        </Html>
      ) : null}
    </group>
  );
}

function AssemblyAnnotations() {
  const scene = useEditor((s) => s.scene),
    op = useEditor((s) => s.operation),
    showJoints = useEditor((s) => s.view.joints),
    explode = useEditor((s) => s.view.explode),
    measurement = useEditor((s) => s.measurement);
  if (explode) return null;
  return (
    <>
      {scene.parts
        .filter(
          (part) => part.visible && part.pivot && useEditor.getState().selected.includes(part.id),
        )
        .map((part) => (
          <group key={`pivot-${part.id}`} position={partPivot(part)}>
            <mesh raycast={() => {}} renderOrder={15}>
              <sphereGeometry args={[0.55, 12, 8]} />
              <meshBasicMaterial color="#c9dcf8" depthTest={false} />
            </mesh>
            <mesh raycast={() => {}} renderOrder={15}>
              <torusGeometry args={[1.6, 0.09, 8, 32]} />
              <meshBasicMaterial color="#c9dcf8" depthTest={false} />
            </mesh>
            <Html position={[0, 3, 0]} center style={{ pointerEvents: 'none' }}>
              <span className="surface-pick-label pivot-label">Pivot</span>
            </Html>
          </group>
        ))}
      {op.pairs.map((pair, i) => {
        const source = resolvePart(scene, pair.source.partId),
          target = resolvePart(scene, pair.target.partId);
        return (
          <group key={i}>
            <Marker point={pair.source} color="#eda763" label={`S${i + 1}`} />
            <Marker point={pair.target} color="#9ccec6" label={`T${i + 1}`} />
            {source && target ? (
              <Line
                points={[worldPoint(source, pair.source), worldPoint(target, pair.target)]}
                color="#dda165"
                dashed
                dashSize={1.2}
                gapSize={0.7}
                lineWidth={1.2}
              />
            ) : null}
          </group>
        );
      })}
      {op.pending ? <Marker point={op.pending} color="#eda763" label="source" /> : null}
      {measurement.map((point, i) => (
        <Marker key={i} point={point} color="#a2cec4" />
      ))}
      {measurement.length === 2
        ? (() => {
            const a = resolvePart(scene, measurement[0].partId),
              b = resolvePart(scene, measurement[1].partId);
            return a && b ? (
              <Line
                points={[worldPoint(a, measurement[0]), worldPoint(b, measurement[1])]}
                color="#a2cec4"
                lineWidth={1.5}
              />
            ) : null;
          })()
        : null}
      {showJoints
        ? scene.joints.filter(isJointConnected).map((joint) => {
            const parent = scene.parts.find((p) => p.id === joint.parentId);
            if (!parent?.visible) return null;
            const position = vec(joint.parentAnchor).applyMatrix4(partMatrix(parent));
            return (
              <group key={joint.id} position={position}>
                <mesh rotation={[Math.PI / 2, 0, 0]} renderOrder={9}>
                  <torusGeometry args={[2, 0.3, 8, 24]} />
                  <meshBasicMaterial color="#9ac4bb" depthTest={false} />
                </mesh>
                <mesh>
                  <sphereGeometry args={[0.65, 10, 8]} />
                  <meshBasicMaterial color="#9ac4bb" depthTest={false} />
                </mesh>
              </group>
            );
          })
        : null}
    </>
  );
}

function Scene({ inspection }: { inspection: InspectionState }) {
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
  const exploding = view.explode > 0;
  const frame = useMemo(() => (exploding ? explodeFrame(parts) : undefined), [exploding, parts]);
  return (
    <>
      <color attach="background" args={['#272a2f']} />
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
      <ambientLight intensity={1.0} />
      <hemisphereLight args={['#e6e9ef', '#8b8073', 1.25]} />
      <directionalLight
        position={[90, 150, 90]}
        intensity={2.5}
        color="#fff1dc"
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-110}
        shadow-camera-right={110}
        shadow-camera-top={140}
        shadow-camera-bottom={-100}
        shadow-bias={-0.0004}
      />
      <directionalLight position={[-90, 80, -90]} intensity={2.2} color="#d5e5f4" />
      <directionalLight position={[-90, 40, 90]} intensity={0.6} color="#ddd0b8" />
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
      <ContactShadows
        position={[0, -0.1, 0]}
        opacity={0.48}
        scale={300}
        blur={2.5}
        far={160}
        resolution={256}
        frames={1}
      />
      {parts.map((part) => (
        <PartMesh key={part.id} part={part} frame={frame} />
      ))}
      {referencePlanes
        .filter((p) => view.planes.includes(p.id) || operation.targetId === p.id)
        .map((plane) => (
          <mesh
            key={plane.id}
            geometry={plane.geometry}
            onClick={(event) => {
              if (
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
      <TransformGizmo />
      <AssemblyAnnotations />
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
  );
}

export function Viewport() {
  const inspection = useInspection();
  const view = useEditor((s) => s.view),
    tool = useEditor((s) => s.tool),
    selected = useEditor((s) => s.selected),
    parts = useEditor((s) => s.scene.parts),
    op = useEditor((s) => s.operation),
    measurement = useEditor((s) => s.measurement),
    navigationMode = useEditor((s) => (s.temporaryOrbit ? 'orbit' : s.navigationMode)),
    pivotPicking = useEditor((s) => s.pivotPicking);
  const setView = useEditor((s) => s.setView),
    focus = useEditor((s) => s.focus);
  const [viewMenu, setViewMenu] = useState(false);
  const viewSelector = useRef<HTMLDivElement>(null);
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
                Toggle projection <kbd>5</kbd>
              </button>
            </div>
          ) : null}
        </div>
        <InspectionToggle inspection={inspection} />
        <span className="viewport-shading">
          Solid <span /> Studio
        </span>
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
            <Scene inspection={inspection} />
          </Canvas>
        </Suspense>
      </ViewportBoundary>
      <InspectionControls inspection={inspection} />
      <div className="canvas-label" hidden={view.inspection.enabled}>
        <span className="canvas-label-line" />
        <span>ASSEMBLY SPACE</span>
        <span className="canvas-label-units">mm</span>
      </div>
      {pivotPicking ? (
        <div className="pick-prompt">
          <span>Click a spot on a model to set its pivot</span>
          <kbd>P</kbd>
          <button onClick={() => useEditor.getState().setPivotPicking(false)}>Cancel</button>
        </div>
      ) : !navigationMode && tool === 'align' && op.mode === 'surface' ? (
        <div className="pick-prompt paint-prompt">
          <span>
            {op.activeSurface
              ? `Paint the ${op.activeSurface.side === 'source' ? 'moving' : 'target'} patch · pair ${op.surfacePairs.findIndex((pair) => pair.id === op.activeSurface!.pairId) + 1}`
              : 'Choose a patch to paint, add a pair, or fit'}
          </span>
          <small>Middle / Space: orbit · Right: pan</small>
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
          <small>Middle / Space: orbit</small>
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
      {view.explode > 0 ? (
        <div className="exploded-notice">
          Exploded view <button onClick={() => setView({ explode: 0 })}>Reset</button>
        </div>
      ) : null}
      <CameraNavigation />
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
          <IconButton label="Focus selection (F)" onClick={() => focus()}>
            <Focus size={17} />
          </IconButton>
          <IconButton label="Frame all (Home)" onClick={() => focus(undefined, true)}>
            <Maximize size={16} />
          </IconButton>
        </div>
      </div>
    </main>
  );
}
