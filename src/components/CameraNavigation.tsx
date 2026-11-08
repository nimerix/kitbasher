import { useCallback, useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { MOUSE, TOUCH, Vector3 } from 'three';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Crosshair, Hand, Orbit, X } from 'lucide-react';
import { sceneBounds } from '../core/geometry';
import { selectionOrbitCenter, setOrbitCenter, stepCamera } from '../core/navigation';
import type { CameraDirection, CameraStep } from '../core/navigation';
import { useEditor } from '../core/store';
import { IconButton } from './ui';

const cameraStepEvent = 'kitbasher:camera-step';
const initialOrbitTarget: [number, number, number] = [0, 54, 0];

export function CameraRig() {
  const controls = useRef<OrbitControlsImpl>(null);
  const focusRequest = useEditor((state) => state.focusRequest);
  const projection = useEditor((state) => state.view.projection);
  const pivotRequest = useEditor((state) => state.pivotRequest);
  const navigationMode = useEditor((state) => state.navigationMode);
  const pivotPicking = useEditor((state) => state.pivotPicking);
  const surfacePainting = useEditor(
    (state) =>
      state.tool === 'align' &&
      state.operation.mode === 'surface' &&
      !state.navigationMode &&
      !state.pivotPicking,
  );
  const { camera, gl, invalidate, size } = useThree();
  const connected = useThree((state) => state.events.connected);
  const handledPivot = useRef(0);

  const settle = useCallback(() => {
    const orbit = controls.current;
    if (!orbit) return;
    const damping = orbit.enableDamping;
    orbit.enableDamping = false;
    orbit.update();
    orbit.enableDamping = damping;
  }, []);

  const centerSelection = useCallback(() => {
    const orbit = controls.current;
    if (!orbit?.enabled) return;
    const state = useEditor.getState();
    const center = selectionOrbitCenter(state.scene.parts, state.selected, state.view.explode);
    if (!center) return;
    settle();
    setOrbitCenter(camera, orbit.target, center);
    orbit.update();
    invalidate();
  }, [camera, invalidate, settle]);

  useEffect(() => {
    const state = useEditor.getState();
    const selected = state.scene.parts.filter((part) => state.selected.includes(part.id));
    const bounds = sceneBounds(focusRequest.all || !selected.length ? state.scene.parts : selected);
    const center = bounds.getCenter(new Vector3());
    const radius = Math.max(bounds.getSize(new Vector3()).length() / 2, 8);
    const aspect = size.width / size.height;
    const distance =
      ((radius / Math.sin((35 * Math.PI) / 360)) * 1.12) / Math.min(Math.sqrt(aspect), 1);
    const direction = new Vector3();
    const directions = {
      front: [0, 0, 1],
      back: [0, 0, -1],
      right: [1, 0, 0],
      left: [-1, 0, 0],
      top: [0, 1, 0.001],
      bottom: [0, -1, 0.001],
      iso: [1, 0.65, 1.3],
    };
    settle();
    if (focusRequest.view) direction.fromArray(directions[focusRequest.view]);
    else direction.copy(camera.position).sub(controls.current?.target ?? center);
    if (direction.length() < 0.01) direction.set(1, 0.65, 1.3);
    camera.position.copy(center).add(direction.normalize().multiplyScalar(distance));
    camera.up.set(0, 1, 0);
    camera.lookAt(center);
    if ('isOrthographicCamera' in camera) {
      camera.zoom = Math.min(size.height, size.width / Math.sqrt(aspect)) / (radius * 2.45);
      camera.updateProjectionMatrix();
    }
    controls.current?.target.copy(center);
    controls.current?.update();
    invalidate();
  }, [focusRequest, projection, camera, size.width, size.height, invalidate, settle]);

  useEffect(() => settle(), [navigationMode, pivotPicking, surfacePainting, settle]);

  useEffect(() => {
    if (pivotRequest !== handledPivot.current) {
      handledPivot.current = pivotRequest;
      centerSelection();
    }
  }, [pivotRequest, centerSelection]);

  useEffect(() => {
    const zoom = (event: Event) => {
      const detail = (event as CustomEvent<number>).detail;
      settle();
      if ('isOrthographicCamera' in camera) {
        camera.zoom *= detail;
        camera.updateProjectionMatrix();
      } else if (controls.current) {
        camera.position
          .sub(controls.current.target)
          .multiplyScalar(1 / detail)
          .add(controls.current.target);
      }
      controls.current?.update();
      invalidate();
    };
    const step = (event: Event) => {
      const orbit = controls.current;
      if (!orbit?.enabled) return;
      const detail = (event as CustomEvent<CameraStep>).detail;
      if (detail.mode === 'orbit') {
        const state = useEditor.getState();
        if (
          state.view.orbitSelection ||
          state.scene.parts.some((part) => state.selected.includes(part.id) && part.pivot)
        )
          centerSelection();
      }
      settle();
      stepCamera(camera, orbit.target, detail);
      orbit.update();
      invalidate();
    };
    // Set the pivot only after a real orbit drag begins. Click selection and
    // transform handles keep their original hit positions, and pan stays free.
    let gesture: { id: number; x: number; y: number; orbit: boolean; prepared: boolean } | null =
      null;
    const down = (event: PointerEvent) => {
      if (!event.isPrimary) {
        gesture = null;
        return;
      }
      const panMode = useEditor.getState().navigationMode === 'pan';
      const modified = event.shiftKey || event.ctrlKey || event.metaKey;
      const orbit =
        event.pointerType === 'touch'
          ? !panMode
          : event.button === 0
            ? panMode
              ? modified
              : !modified
            : event.button === 2 && modified;
      gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, orbit, prepared: false };
    };
    const move = (event: PointerEvent) => {
      if (!gesture || gesture.id !== event.pointerId || !gesture.orbit || gesture.prepared) return;
      if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) <= 5) return;
      gesture.prepared = true;
      const state = useEditor.getState();
      if (state.tool === 'align' && state.operation.mode === 'surface' && !state.navigationMode)
        return;
      if (
        controls.current?.enabled &&
        (state.view.orbitSelection ||
          state.scene.parts.some((part) => state.selected.includes(part.id) && part.pivot))
      )
        centerSelection();
    };
    const up = () => {
      gesture = null;
    };
    const canvas = connected instanceof HTMLElement ? connected : gl.domElement;
    canvas.addEventListener('pointerdown', down, true);
    canvas.addEventListener('pointermove', move, true);
    canvas.addEventListener('pointerup', up, true);
    canvas.addEventListener('pointercancel', up, true);
    window.addEventListener('kitbasher:zoom', zoom);
    window.addEventListener(cameraStepEvent, step);
    return () => {
      canvas.removeEventListener('pointerdown', down, true);
      canvas.removeEventListener('pointermove', move, true);
      canvas.removeEventListener('pointerup', up, true);
      canvas.removeEventListener('pointercancel', up, true);
      window.removeEventListener('kitbasher:zoom', zoom);
      window.removeEventListener(cameraStepEvent, step);
    };
  }, [camera, connected, gl.domElement, invalidate, centerSelection, settle]);

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableRotate={!surfacePainting}
      enableDamping
      dampingFactor={0.12}
      minDistance={1}
      maxDistance={20000}
      target={initialOrbitTarget}
      screenSpacePanning
      mouseButtons={{
        LEFT: navigationMode === 'pan' ? MOUSE.PAN : MOUSE.ROTATE,
        MIDDLE: MOUSE.DOLLY,
        RIGHT: MOUSE.PAN,
      }}
      touches={{ ONE: navigationMode === 'pan' ? TOUCH.PAN : TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN }}
    />
  );
}

export function CameraNavigation() {
  const mode = useEditor((state) => state.navigationMode);
  const pivotPicking = useEditor((state) => state.pivotPicking);
  const customPivot = useEditor(
    (state) => state.scene.parts.find((part) => part.id === state.selected[0])?.pivot,
  );
  const orbitSelection = useEditor((state) => state.view.orbitSelection);
  const canCenter = useEditor((state) =>
    state.scene.parts.some((part) => part.visible && state.selected.includes(part.id)),
  );
  const step = (direction: CameraDirection) =>
    window.dispatchEvent(
      new CustomEvent<CameraStep>(cameraStepEvent, {
        detail: { mode: mode ?? 'orbit', direction },
      }),
    );
  return (
    <section
      className={`camera-navigation ${mode ? 'is-expanded' : ''}`}
      aria-label="Camera navigation"
    >
      <div className="camera-navigation-heading">
        <span>Camera</span>
        {mode ? (
          <IconButton
            label="Exit camera tool (Esc)"
            onClick={() => useEditor.getState().setNavigationMode(null)}
          >
            <X size={12} />
          </IconButton>
        ) : null}
      </div>
      <div className="camera-mode-buttons">
        <button
          className={mode === 'orbit' ? 'active' : ''}
          aria-label="Orbit tool (O)"
          aria-pressed={mode === 'orbit'}
          onClick={() => useEditor.getState().setNavigationMode(mode === 'orbit' ? null : 'orbit')}
        >
          <Orbit size={15} />
          Orbit<kbd>O</kbd>
        </button>
        <button
          className={mode === 'pan' ? 'active' : ''}
          aria-label="Pan tool (H)"
          aria-pressed={mode === 'pan'}
          onClick={() => useEditor.getState().setNavigationMode(mode === 'pan' ? null : 'pan')}
        >
          <Hand size={14} />
          Pan<kbd>H</kbd>
        </button>
      </div>
      {mode ? (
        <>
          <div
            className="camera-direction-pad"
            role="group"
            aria-label={mode === 'pan' ? 'Pan camera controls' : 'Orbit camera controls'}
          >
            <IconButton label={`${mode === 'pan' ? 'Pan' : 'Orbit'} up`} onClick={() => step('up')}>
              <ArrowUp size={16} />
            </IconButton>
            <IconButton
              label={`${mode === 'pan' ? 'Pan' : 'Orbit'} left`}
              onClick={() => step('left')}
            >
              <ArrowLeft size={16} />
            </IconButton>
            <IconButton
              label="Center orbit on selection (.)"
              disabled={!canCenter}
              onClick={() => useEditor.getState().centerOrbit()}
            >
              <Crosshair size={16} />
            </IconButton>
            <IconButton
              label={`${mode === 'pan' ? 'Pan' : 'Orbit'} right`}
              onClick={() => step('right')}
            >
              <ArrowRight size={16} />
            </IconButton>
            <IconButton
              label={`${mode === 'pan' ? 'Pan' : 'Orbit'} down`}
              onClick={() => step('down')}
            >
              <ArrowDown size={16} />
            </IconButton>
          </div>
          <p className="camera-tool-hint">
            {mode === 'pan' ? 'Drag to move the view' : 'Drag to orbit the view'}
            <span>
              <kbd>.</kbd> Center selection · <kbd>Esc</kbd> Exit
            </span>
          </p>
        </>
      ) : null}
      <button
        className={`camera-pivot-button ${pivotPicking ? 'active' : ''}`}
        aria-pressed={pivotPicking}
        onClick={() => useEditor.getState().setPivotPicking(!pivotPicking)}
      >
        <Crosshair size={13} /> Pick surface pivot <kbd>P</kbd>
      </button>
      {customPivot ? (
        <button
          className="camera-reset-pivot"
          onClick={() => useEditor.getState().clearPartPivot(useEditor.getState().selected[0])}
        >
          Reset custom pivot
        </button>
      ) : null}
      <label className="orbit-selection-setting">
        <span>Orbit selection</span>
        <button
          type="button"
          role="switch"
          aria-label="Orbit around selection by default"
          aria-checked={orbitSelection}
          className={`toggle ${orbitSelection ? 'on' : ''}`}
          title="Use selected parts as the orbit center. Shift + . toggles this preference."
          onClick={() => useEditor.getState().setView({ orbitSelection: !orbitSelection })}
        >
          <span />
        </button>
      </label>
    </section>
  );
}
