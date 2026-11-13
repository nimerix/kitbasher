import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import { Check, MousePointer2, X } from 'lucide-react';
import { FreeTransformMotion } from '../core/free-transform';
import { matchKeyAction } from '../core/keybindings';
import { usePreferences } from '../core/preferences';
import { transformSelection } from '../core/transform-selection';
import { useEditor } from '../core/store';

/** Own the entire confirm click so it never also selects a part or starts camera orbit. */
export function FreeTransformController() {
  const { camera, gl, invalidate } = useThree();
  const baseline = useEditor((s) => s.freeTransform?.baseline);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const suppress = useRef<number | null>(null);
  const update = useRef<((event?: PointerEvent) => void) | null>(null);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (update.current) update.current(event);
      pointer.current = { x: event.clientX, y: event.clientY };
    };
    const swallow = (event: Event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const down = (event: PointerEvent) => {
      suppress.current = null;
      const session = useEditor.getState().freeTransform;
      if (!session) return;
      if (event.target instanceof Element && event.target.closest('[data-free-transform-control]'))
        return;
      if (event.target !== gl.domElement) {
        useEditor.getState().finishFreeTransform(false);
        return;
      }
      swallow(event);
      suppress.current = event.button;
      if (event.button === 0 || event.button === 2)
        useEditor.getState().finishFreeTransform(event.button === 0);
    };
    const end = (event: MouseEvent) => {
      if (
        (event.type === 'contextmenu' && useEditor.getState().freeTransform) ||
        event.button === suppress.current
      )
        swallow(event);
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', end, true);
    window.addEventListener('click', end, true);
    window.addEventListener('auxclick', end, true);
    window.addEventListener('contextmenu', end, true);
    return () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', end, true);
      window.removeEventListener('click', end, true);
      window.removeEventListener('auxclick', end, true);
      window.removeEventListener('contextmenu', end, true);
    };
  }, [gl.domElement]);

  useEffect(() => {
    const start = useEditor.getState();
    const session = start.freeTransform;
    if (!session || !baseline) return;
    const selection = transformSelection(start, session.mode);
    const rect = gl.domElement.getBoundingClientRect();
    const motion = new FreeTransformMotion(camera, selection.pivot, rect.width, rect.height);
    let previous = pointer.current;
    const inside = (point: { x: number; y: number }) =>
      point.x >= rect.left &&
      point.x <= rect.right &&
      point.y >= rect.top &&
      point.y <= rect.bottom;
    if (previous && !inside(previous)) previous = null;
    // Shift invokes the default shortcut. It only becomes a fine modifier after release.
    let fine = false;
    const apply = () => {
      const state = useEditor.getState(),
        current = state.freeTransform;
      if (current?.baseline !== baseline) return;
      const step = session.mode === 'translate' ? state.view.snapStep : state.view.rotationSnapStep;
      state.previewFreeTransform(
        motion.patches(
          selection.parts,
          selection.pivot,
          selection.orientation,
          session.mode,
          current.axis,
          state.view.snap ? step : null,
        ),
      );
      invalidate();
    };
    update.current = (event) => {
      if (!event) return;
      const current = { x: event.clientX, y: event.clientY };
      if (previous && inside(previous) && inside(current)) {
        motion.move(current.x - previous.x, current.y - previous.y, fine);
        apply();
      }
      previous = current;
    };
    const key = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const state = useEditor.getState(),
        current = state.freeTransform;
      if (current?.baseline !== baseline) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === 'Shift') {
        fine = true;
        return;
      }
      if (event.repeat) return;
      const action = matchKeyAction(event, usePreferences.getState().keybindings, [
        'cancel',
        'apply',
      ]);
      if (event.key === 'Escape' || action === 'cancel') state.finishFreeTransform(false);
      else if (event.key === 'Enter' || action === 'apply') state.finishFreeTransform(true);
      else if (!event.metaKey && !event.ctrlKey && !event.altKey) {
        const axis = (['x', 'y', 'z'] as const).indexOf(event.key.toLowerCase() as 'x' | 'y' | 'z');
        if (axis < 0) return;
        if (session.mode === 'rotate' && selection.locks?.[axis]) {
          state.notify('That joint axis is locked. Free it in Connections first.', 'info');
          return;
        }
        useEditor.setState({
          freeTransform: { ...current, axis: current.axis === axis ? null : (axis as 0 | 1 | 2) },
        });
        apply();
      }
    };
    const up = (event: KeyboardEvent) => {
      if (event.key === 'Shift') fine = false;
    };
    const cancel = () => useEditor.getState().finishFreeTransform(false);
    const visibility = () => {
      if (document.hidden) cancel();
    };
    window.addEventListener('keydown', key, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', cancel);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('resize', cancel);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      update.current = null;
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('resize', cancel);
      document.removeEventListener('visibilitychange', visibility);
      if (useEditor.getState().freeTransform?.baseline === baseline) cancel();
      invalidate();
    };
  }, [baseline, camera, gl.domElement, invalidate]);
  return null;
}

export function FreeTransformPrompt() {
  const session = useEditor((s) => s.freeTransform);
  const selected = useEditor((s) => s.selected);
  const view = useEditor((s) => s.view);
  if (!session) return null;
  const selection = transformSelection(
    { ...useEditor.getState(), scene: session.baseline, selected, view },
    session.mode,
  );
  return (
    <div className="free-transform-prompt" data-free-transform-control>
      <div role="status">
        <MousePointer2 size={15} aria-hidden="true" />
        <strong>{session.mode === 'translate' ? 'Free move' : 'Free rotation'}</strong>
        <span>
          {session.axis === null
            ? session.mode === 'translate'
              ? 'View plane'
              : 'Trackball'
            : `${selection.axes} ${['X', 'Y', 'Z'][session.axis]} axis`}
        </span>
      </div>
      <p>Move the pointer · X / Y / Z: axis · Shift: fine</p>
      <div className="free-transform-actions">
        <button onClick={() => useEditor.getState().finishFreeTransform(true)}>
          <Check size={13} aria-hidden="true" /> Confirm <kbd>Enter / click</kbd>
        </button>
        <button onClick={() => useEditor.getState().finishFreeTransform(false)}>
          <X size={13} aria-hidden="true" /> Cancel <kbd>Esc / right-click</kbd>
        </button>
      </div>
    </div>
  );
}
