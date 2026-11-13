import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import type { ThreeEvent } from '@react-three/fiber';
import {
  CanvasTexture,
  DoubleSide,
  Group,
  Quaternion,
  SRGBColorSpace,
  Vector2,
  Vector3,
} from 'three';
import { CombinedTransformDrag } from '../core/combined-transform';
import type { TransformHandle } from '../core/combined-transform';
import type { TransformPatch } from '../core/free-transform';
import { translationIsPinned } from '../core/constraints';
import { transformSelection } from '../core/transform-selection';
import { useEditor } from '../core/store';
import { usePreferences } from '../core/preferences';

const colors = ['#ed8883', '#9bc78b', '#88b4ef'];
const axes = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
const noRaycast = () => {};
type Capture = {
  setPointerCapture: (id: number) => void;
  releasePointerCapture: (id: number) => void;
};

function AxisLabel({ axis, letter, color }: { axis: Vector3; letter: string; color: string }) {
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const context = canvas.getContext('2d')!;
    context.font = '600 84px sans-serif';
    context.fillStyle = color;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(letter, 64, 64);
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    return texture;
  }, [letter, color]);
  useEffect(() => () => texture.dispose(), [texture]);
  return (
    <sprite
      position={axis.clone().multiplyScalar(1.15)}
      scale={[0.17, 0.17, 1]}
      renderOrder={1005}
      raycast={noRaycast}
    >
      <spriteMaterial
        map={texture}
        transparent
        depthTest={false}
        depthWrite={false}
        toneMapped={false}
      />
    </sprite>
  );
}

export function CombinedTransform({ onPress }: { onPress: () => void }) {
  const scene = useEditor((s) => s.scene),
    selected = useEditor((s) => s.selected),
    view = useEditor((s) => s.view),
    isolated = useEditor((s) => s.isolated),
    nearbyParts = useEditor((s) => s.nearbyParts),
    navigationMode = useEditor((s) => s.navigationMode),
    temporaryOrbit = useEditor((s) => s.temporaryOrbit),
    pivotPicking = useEditor((s) => s.pivotPicking),
    free = useEditor((s) => !!s.freeTransform);
  const scaling = usePreferences((s) => s.transform.scaling);
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
        },
        'transform',
      ),
    [scene, selected, view, isolated, nearbyParts, navigationMode, temporaryOrbit, pivotPicking],
  );
  const pinned = useMemo(
    () => selection.parts.some((part) => translationIsPinned(scene.parts, scene.joints, part.id)),
    [selection, scene],
  );
  const root = useRef<Group>(null),
    worldSize = useRef(1);
  const { camera, size, invalidate, get, setEvents } = useThree();
  const [hover, setHover] = useState('');
  const [version, setVersion] = useState(0);
  const drag = useRef<{
    motion: CombinedTransformDrag;
    mode: TransformHandle['mode'];
    checkpointed: boolean;
    baseline: typeof scene.parts;
    patches: TransformPatch[];
    capture: Capture;
    pointerId: number;
    orientation: Quaternion;
    pivot: Vector3;
  } | null>(null);

  const apply = useCallback(
    (patches: TransformPatch[], settle: boolean) => {
      const current = drag.current;
      if (!current) return;
      const state = useEditor.getState();
      state.transformMany(
        patches,
        !current.checkpointed,
        current.mode === 'translate',
        settle,
        undefined,
        settle ? current.baseline : undefined,
      );
      if (useEditor.getState().scene !== state.scene) current.checkpointed = true;
      invalidate();
    },
    [invalidate],
  );
  const finish = useCallback(() => {
    const current = drag.current;
    if (!current) return;
    if (current.patches.length && useEditor.getState().view.clip.enabled)
      apply(current.patches, true);
    drag.current = null;
    try {
      current.capture.releasePointerCapture(current.pointerId);
    } catch {
      /* The OS may already have cancelled capture. */
    }
    const controls = get().controls;
    if (controls && 'enabled' in controls) controls.enabled = true;
    setHover('');
    setVersion((value) => value + 1);
    invalidate();
  }, [apply, get, invalidate]);

  useEffect(() => {
    window.addEventListener('blur', finish);
    window.addEventListener('pointercancel', finish);
    return () => {
      window.removeEventListener('blur', finish);
      window.removeEventListener('pointercancel', finish);
      finish();
    };
  }, [finish]);
  const unavailable = !!selection.blocked || free;
  useEffect(() => {
    if (unavailable) finish();
  }, [unavailable, finish]);
  useEffect(() => {
    if (!scaling && drag.current?.mode === 'scale') finish();
  }, [scaling, finish]);

  // Handles draw over the model, and their pointer hits must take the same precedence.
  useEffect(() => {
    const previous = get().events.filter;
    setEvents({
      filter: (hits, state) => {
        const filtered = (previous ? previous(hits, state) : hits).filter((hit) => {
          if (!hit.object.userData.transformHandle) return true;
          // Raycasting includes invisible parents. Edge-on rings and planes must not catch a drag.
          let object = hit.object;
          while (object.parent) {
            if (!object.visible) return false;
            object = object.parent;
          }
          return object.visible;
        });
        const inScene = (hit: (typeof filtered)[number]) => {
          let ancestor = hit.object;
          while (ancestor.parent) ancestor = ancestor.parent;
          return ancestor === state.scene;
        };
        return [
          ...filtered.filter((hit) => !inScene(hit)),
          ...filtered
            .filter((hit) => hit.object.userData.transformHandle)
            .sort((a, b) => b.object.renderOrder - a.object.renderOrder || a.distance - b.distance),
          ...filtered.filter((hit) => inScene(hit) && !hit.object.userData.transformHandle),
        ];
      },
    });
    return () => setEvents({ filter: previous });
  }, [get, setEvents]);

  useLayoutEffect(() => {
    if (!root.current) return;
    root.current.position.copy(
      drag.current && drag.current.mode !== 'translate' ? drag.current.pivot : selection.pivot,
    );
    root.current.quaternion.copy(drag.current?.orientation ?? selection.orientation);
    invalidate();
  }, [selection, version, invalidate]);
  useFrame(() => {
    if (!root.current) return;
    const projected = root.current.position.clone().project(camera);
    const right = projected.clone();
    right.x += 2 / size.width;
    worldSize.current = right.unproject(camera).distanceTo(root.current.position) * 96;
    root.current.scale.setScalar(worldSize.current);
    // Keep uniform scale clear of the free-move center in every camera orientation.
    root.current
      .getObjectByName('transform:scale:uniform')
      ?.position.copy(
        new Vector3(-0.45, -0.45, 0)
          .applyQuaternion(camera.quaternion)
          .applyQuaternion(root.current.quaternion.clone().invert()),
      );
    const eye = camera.getWorldDirection(new Vector3()).negate();
    root.current.traverse((child) => {
      const normal = child.userData.planeNormal as number | undefined;
      if (normal !== undefined)
        child.visible =
          Math.abs(axes[normal].clone().applyQuaternion(root.current!.quaternion).dot(eye)) > 0.08;
    });
  });

  const pointer = (event: ThreeEvent<PointerEvent>) => {
    const rect = get().gl.domElement.getBoundingClientRect();
    return new Vector2(event.clientX - rect.left, event.clientY - rect.top);
  };
  const handlers = (id: string, handle: TransformHandle) => ({
    name: `transform:${id}`,
    userData: { transformHandle: handle },
    onPointerOver: (event: ThreeEvent<PointerEvent>) => {
      event.stopPropagation();
      setHover(id);
    },
    onPointerOut: () => {
      if (!drag.current) setHover('');
    },
    onPointerDown: (event: ThreeEvent<PointerEvent>) => {
      if (event.button !== 0 || unavailable || drag.current) return;
      event.stopPropagation();
      onPress();
      const state = useEditor.getState();
      if (handle.mode === 'scale' && !usePreferences.getState().transform.scaling) return;
      if (handle.mode === 'translate' && pinned) return;
      if (handle.mode === 'rotate' && handle.axis !== null && selection.locks?.[handle.axis])
        return;
      const capture = event.target as unknown as Capture;
      drag.current = {
        motion: new CombinedTransformDrag(
          selection.parts,
          selection.pivot,
          selection.orientation,
          handle,
          camera,
          size.width,
          size.height,
          pointer(event),
          worldSize.current,
        ),
        mode: handle.mode,
        checkpointed: false,
        baseline: state.scene.parts,
        patches: [],
        capture,
        pointerId: event.pointerId,
        orientation: selection.orientation.clone(),
        pivot: selection.pivot.clone(),
      };
      const controls = get().controls;
      if (controls && 'enabled' in controls) controls.enabled = false;
      capture.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event: ThreeEvent<PointerEvent>) => {
      event.stopPropagation();
      const current = drag.current;
      if (!current) return;
      if (current.mode === 'scale' && !usePreferences.getState().transform.scaling) {
        finish();
        return;
      }
      const state = useEditor.getState();
      const snap = state.view.snap
        ? { move: state.view.snapStep, rotate: state.view.rotationSnapStep, scale: 0.1 }
        : null;
      const patches = current.motion.update(pointer(event), state.precision, snap);
      if (patches.some(({ patch }) => patch.scale?.some((value) => Math.abs(value) < 0.001)))
        return;
      current.patches = patches;
      apply(patches, false);
    },
    onPointerUp: (event: ThreeEvent<PointerEvent>) => {
      event.stopPropagation();
      finish();
    },
    onClick: (event: ThreeEvent<MouseEvent>) => event.stopPropagation(),
  });
  const material = (id: string, color: string) => (
    <meshBasicMaterial
      color={hover === id ? '#fff1ae' : color}
      depthTest={false}
      depthWrite={false}
      side={DoubleSide}
    />
  );
  if (unavailable) return null;
  return (
    <group ref={root} name="combined-transform">
      {axes.map((axis, i) => {
        const index = i as 0 | 1 | 2,
          letter = ['X', 'Y', 'Z'][i];
        const arrow = `move:${letter}`,
          ring = `rotate:${letter}`,
          cube = `scale:${letter}`;
        return (
          <group key={i}>
            {!pinned ? (
              <group quaternion={new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), axis)}>
                <mesh
                  {...handlers(arrow, { mode: 'translate', axis: index })}
                  position={[0, 0.53, 0]}
                  renderOrder={1002}
                >
                  <cylinderGeometry args={[0.045, 0.045, 0.9, 10]} />
                  <meshBasicMaterial transparent opacity={0} depthWrite={false} />
                </mesh>
                <mesh raycast={noRaycast} position={[0, 0.44, 0]} renderOrder={1002}>
                  <cylinderGeometry args={[0.012, 0.012, 0.84, 8]} />
                  {material(arrow, colors[i])}
                </mesh>
                <mesh
                  {...handlers(arrow, { mode: 'translate', axis: index })}
                  position={[0, 0.96, 0]}
                  renderOrder={1003}
                >
                  <coneGeometry args={[0.065, 0.2, 16]} />
                  {material(arrow, colors[i])}
                </mesh>
              </group>
            ) : null}
            {!selection.locks?.[i] ? (
              <group
                userData={{ planeNormal: i }}
                quaternion={new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), axis)}
              >
                <mesh {...handlers(ring, { mode: 'rotate', axis: index })} renderOrder={1001}>
                  <torusGeometry args={[0.78, 0.045, 8, 80]} />
                  <meshBasicMaterial transparent opacity={0} depthWrite={false} side={DoubleSide} />
                </mesh>
                <mesh raycast={noRaycast} renderOrder={1001}>
                  <torusGeometry args={[0.78, hover === ring ? 0.018 : 0.011, 8, 80]} />
                  {material(ring, colors[i])}
                </mesh>
              </group>
            ) : null}
            {scaling ? (
              <mesh
                {...handlers(cube, { mode: 'scale', axis: index })}
                position={axis.clone().multiplyScalar(0.58)}
                renderOrder={1004}
              >
                <boxGeometry args={[0.13, 0.13, 0.13]} />
                {material(cube, colors[i])}
              </mesh>
            ) : null}
            <AxisLabel axis={axis} letter={letter} color={colors[i]} />
          </group>
        );
      })}
      {!pinned ? (
        <>
          <mesh {...handlers('move:free', { mode: 'translate', axis: null })} renderOrder={1005}>
            <sphereGeometry args={[0.06, 12, 12]} />
            {material('move:free', '#e2e4e8')}
          </mesh>
          {axes.map((normal, i) => (
            <mesh
              key={i}
              {...handlers(`plane:${i}`, { mode: 'translate', axis: null, plane: i as 0 | 1 | 2 })}
              userData={{ transformHandle: true, planeNormal: i }}
              position={new Vector3(i === 0 ? 0 : 0.22, i === 1 ? 0 : 0.22, i === 2 ? 0 : 0.22)}
              quaternion={new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), normal)}
              renderOrder={1000}
            >
              <planeGeometry args={[0.18, 0.18]} />
              <meshBasicMaterial
                color={hover === `plane:${i}` ? '#fff1ae' : colors[i]}
                transparent
                opacity={0.35}
                depthTest={false}
                depthWrite={false}
                side={DoubleSide}
              />
            </mesh>
          ))}
        </>
      ) : null}
      {scaling ? (
        <mesh
          {...handlers('scale:uniform', { mode: 'scale', axis: null })}
          position={[-0.4, -0.4, -0.4]}
          renderOrder={1004}
        >
          <boxGeometry args={[0.13, 0.13, 0.13]} />
          {material('scale:uniform', '#e2e4e8')}
        </mesh>
      ) : null}
    </group>
  );
}
