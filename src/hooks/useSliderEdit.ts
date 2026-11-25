import { useEffect, useRef, useState, type PointerEvent, type KeyboardEvent } from 'react';

const isSlider = (target: EventTarget | null) =>
  target instanceof HTMLInputElement && target.type === 'range';

/** Keys that change a range input's value. */
const editingKeys = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
]);

/**
 * One slider's edit. Unless `live`, a value is shown while dragged and set once, when let go or
 * changed by key; a blur during a drag waits for the release. A live edit sets each value and
 * remembers, through `begin`, how to put back what it started from. Escape cancels the edit (a
 * live one with one write back) and the rest of that drag is ignored; so is a value whose target
 * is no longer the panel's, and a live drag whose control goes away is put back. A press on a
 * mixed slider starts at `least`, the value it shows.
 */
export function useSliderEdit({
  owned,
  onSet,
  live = false,
  begin,
  mixed = false,
  least = 0,
}: {
  owned: () => boolean;
  onSet: (value: number) => void;
  live?: boolean;
  begin?: () => () => void;
  mixed?: boolean;
  least?: number;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const edit = useRef({
    pending: null as number | null,
    restore: null as (() => void) | null,
    dragging: false,
    cancelled: false,
    /** Whether the drag's pointer is known to be pressed still. */
    held: false,
    /** Removes the drag's window listeners. */
    detach: null as (() => void) | null,
  });
  const latest = useRef({ owned, onSet, live, begin });
  latest.current = { owned, onSet, live, begin };
  const row = useRef<HTMLElement | null>(null);
  const finish = useRef(() => {});
  // Ends a drag's hold on the control, whether it finished or was cancelled.
  const release = () => {
    const current = edit.current;
    current.detach?.();
    current.detach = null;
    current.dragging = false;
    current.cancelled = false;
    current.held = false;
  };
  // Drops the edit, putting a live one back; a drag stays cancelled until its pointer is let go.
  const cancel = useRef(() => {});
  cancel.current = () => {
    const current = edit.current;
    const { restore } = current;
    current.pending = null;
    current.restore = null;
    current.cancelled = true;
    setDraft(null);
    restore?.();
  };
  finish.current = () => {
    const current = edit.current;
    const next = current.pending;
    current.pending = null;
    current.restore = null;
    release();
    setDraft(null);
    if (next !== null && latest.current.owned()) latest.current.onSet(next);
  };
  /**
   * Follows a drag through the window: its release finishes it. A cancelled drag ends when the
   * pointer shows no button pressed, on pointercancel, or when the window regains focus, so a
   * release the window never saw does not leave the control locked.
   */
  const follow = () => {
    const current = edit.current;
    current.detach?.();
    const up = (event: globalThis.PointerEvent) => {
      current.held = false;
      if (!current.dragging) return;
      if (current.cancelled) release();
      else if (event.type === 'pointerup') finish.current();
    };
    const moved = (event: globalThis.PointerEvent) => {
      if (event.buttons === 0) up(event);
    };
    const aborted = () => {
      if (!current.cancelled) cancel.current();
      release();
    };
    const focused = (event: Event) => {
      if (event.target === window && current.cancelled) release();
    };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointermove', moved);
    window.addEventListener('pointercancel', aborted);
    window.addEventListener('focus', focused);
    current.detach = () => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointermove', moved);
      window.removeEventListener('pointercancel', aborted);
      window.removeEventListener('focus', focused);
    };
  };
  useEffect(() => {
    const element = row.current!;
    const current = edit.current;
    // A range input fires a native change when it is let go, by pointer or by key, and when it
    // blurs; a drag ends at the pointer's release instead.
    const changed = (event: Event) => {
      if (isSlider(event.target) && !current.dragging) finish.current();
    };
    const blurred = (event: Event) => {
      if (isSlider(event.target) && !current.dragging) finish.current();
    };
    // The window losing focus mid-drag cancels it: the release may never reach the page.
    const deactivated = (event: Event) => {
      if (event.type === 'blur' && event.target !== window) return;
      if (event.type === 'visibilitychange' && document.visibilityState !== 'hidden') return;
      if (current.dragging && !current.cancelled) cancel.current();
    };
    element.addEventListener('change', changed);
    element.addEventListener('focusout', blurred);
    window.addEventListener('blur', deactivated);
    document.addEventListener('visibilitychange', deactivated);
    return () => {
      element.removeEventListener('change', changed);
      element.removeEventListener('focusout', blurred);
      window.removeEventListener('blur', deactivated);
      document.removeEventListener('visibilitychange', deactivated);
      // A control that goes away, or whose target changed, drops its draft and its drag; a live
      // drag it abandons is put back as it was before the drag began.
      const { restore } = current;
      current.pending = null;
      current.restore = null;
      restore?.();
      current.detach?.();
      current.detach = null;
      current.dragging = false;
    };
  }, []);
  const change = (next: number) => {
    const current = edit.current;
    const { owned, onSet, live, begin } = latest.current;
    if (current.cancelled || !owned()) return;
    if (!live) {
      current.pending = next;
      setDraft(next);
      return;
    }
    current.restore ??= begin?.() ?? null;
    onSet(next);
  };
  return {
    draft,
    hidden: mixed && draft === null,
    change,
    row: (element: HTMLElement | null) => {
      row.current = element;
    },
    onPointerDown: (event: PointerEvent) => {
      if (!isSlider(event.target) || event.button !== 0) return;
      const current = edit.current;
      release();
      current.dragging = true;
      current.held = true;
      follow();
      if (mixed && draft === null) change(least);
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (!isSlider(event.target)) return;
      const current = edit.current;
      if (event.key !== 'Escape') {
        // A key that edits the slider ends a cancelled drag: the user has moved on from it. Any
        // other key does so only once its pointer is no longer known to be pressed.
        if (!current.dragging) current.cancelled = false;
        else if (current.cancelled && (editingKeys.has(event.key) || !current.held)) release();
        return;
      }
      if (current.pending === null && !current.restore) return;
      event.preventDefault();
      cancel.current();
    },
  };
}
