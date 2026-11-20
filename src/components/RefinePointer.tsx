import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import type { ThreeEvent } from '@react-three/fiber';
import { Raycaster, Vector2, Vector3, type Camera, type Intersection, type Mesh } from 'three';
import { brushingRefine, useEditor, type RefineSession } from '../core/store';
import type { GuidePoint } from '../core/refine-band';
import { partMeshes } from '../xr/part-meshes';

/** Screen pixels between the spots a brush stroke is sampled at, whatever the pointer's speed. */
const strokeStep = 2;
/** A press within this many pixels of a guide handle takes the handle. */
export const handlePick = 8;
/** A click within this many pixels of a proposal's drawn curve selects it in Detect mode. */
export const proposalPick = 6;
/** A handle press that travels this many pixels is a drag. */
const dragStart = 3;

/** A drawn proposal curve, world space, written by the overlay that draws it. */
export interface DrawnCurve {
  points: Float32Array;
  centre: Vector3;
  radius: number;
}
/** The curve each pending edge is drawn with, by feature id, for picking proposals on screen. */
export const refineCurves = new Map<string, DrawnCurve>();

/** A guide point shown as a handle: where it is in its feature's segments. */
export interface RefineHandle {
  feature: string;
  segment: number;
  index: number;
  point: GuidePoint;
  /** The first point of its path. */
  first: boolean;
}

/** Pending edges whose points the overlay draws as handles: hand guides and every selected edge. */
export function refineHandles(refine: Pick<RefineSession, 'features' | 'selected'>) {
  const handles: RefineHandle[] = [];
  for (const f of refine.features) {
    if (f.state !== 'pending' || f.feature.type !== 'edge') continue;
    if (f.origin !== 'hand' && !refine.selected.includes(f.id)) continue;
    const seen = new Set<GuidePoint>();
    f.feature.input.segments.forEach((segment, s) =>
      segment.points.forEach((point, index) => {
        // A point two segments share is one handle.
        if (seen.has(point)) return;
        seen.add(point);
        handles.push({ feature: f.id, segment: s, index, point, first: s === 0 && index === 0 });
      }),
    );
  }
  return handles;
}

interface Stroke {
  kind: 'stroke';
  pointer: number;
  partId: string;
  x: number;
  y: number;
  controls: { enabled: boolean } | null;
}
interface HandleDrag {
  kind: 'handle';
  pointer: number;
  partId: string;
  handle: RefineHandle;
  /** The point it now stands at, as last given to the store. */
  current: GuidePoint;
  x: number;
  y: number;
  moved: boolean;
  /** Set once the store has been given this drag's first move. */
  began?: boolean;
  controls: { enabled: boolean } | null;
}
type Gesture = Stroke | HandleDrag;

let gesture: Gesture | null = null;
let starter: ((event: ThreeEvent<PointerEvent>, partId: string) => boolean) | null = null;
// The click that ends a gesture follows its pointer up; it must not add or select anything.
let swallowing = false;
// A press in Detect mode near a proposal: the click that follows selects it instead of painting.
let pressedProposal: string | null = null;

/** Starts a brush stroke or a guide-point drag from a pointer-down on the part. True when it took the event. */
export const beginRefinePointer = (event: ThreeEvent<PointerEvent>, partId: string) =>
  starter?.(event, partId) ?? false;

/** Whether the click under way ends a Refine gesture rather than picks. */
export const endingRefinePointer = () => swallowing;

/** Whether the press under way lies on a proposal, which the click that follows will select. */
export const pressingRefineProposal = () => pressedProposal !== null;

const blocked = (state: ReturnType<typeof useEditor.getState>) =>
  !!state.navigationMode ||
  state.temporaryOrbit ||
  state.pivotPicking ||
  !!state.freeTransform ||
  state.view.explode > 0;

/** Squared pixel distance from (x, y) to the segment between two screen points. */
function segmentDistance(x: number, y: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax,
    dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / length)) : 0;
  const ex = ax + t * dx - x,
    ey = ay + t * dy - y;
  return ex * ex + ey * ey;
}

/**
 * Owns a Refine gesture from press to release: a brush stroke sampled every few pixels along the
 * pointer's path, or a guide handle dragged over the surface. Escape, pointer cancel, lost capture,
 * window blur and camera navigation discard it. Also selects proposals clicked in Detect mode and
 * shows a pointer cursor over a handle or a proposal.
 */
export function RefinePointerController({ pressed }: { pressed: () => boolean }) {
  const get = useThree((s) => s.get);
  useEffect(() => {
    const raycaster = new Raycaster();
    raycaster.firstHitOnly = true;
    const ndc = new Vector2(),
      projected = new Vector3();
    const canvas = () => {
      const { events, gl } = get();
      return events.connected instanceof HTMLElement ? events.connected : gl.domElement;
    };

    /** The spot under a client position on the part, or null off it or behind another part. */
    const hitAt = (partId: string, x: number, y: number): GuidePoint | null => {
      const own = partMeshes.get(partId);
      if (!own) return null;
      const rect = canvas().getBoundingClientRect();
      ndc.set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, get().camera);
      let nearest: Intersection | null = null;
      for (const mesh of partMeshes.values()) {
        const hits = raycaster.intersectObject(mesh, false);
        if (hits.length && (!nearest || hits[0].distance < nearest.distance)) nearest = hits[0];
      }
      if (!nearest || nearest.object !== own || nearest.faceIndex == null) return null;
      return { triangle: nearest.faceIndex, position: nearest.point.toArray() };
    };

    /** Client position of a world point, or null behind the camera. */
    const toScreen = (camera: Camera, rect: DOMRect, x: number, y: number, z: number) => {
      projected.set(x, y, z).project(camera);
      if (projected.z > 1) return null;
      return [
        rect.left + ((projected.x + 1) / 2) * rect.width,
        rect.top + ((1 - projected.y) / 2) * rect.height,
      ] as const;
    };

    /** The handle within reach of a client position, nearest first, among the selected guides'. */
    const handleAt = (refine: RefineSession, x: number, y: number, selectedOnly: boolean) => {
      const { camera } = get();
      const rect = canvas().getBoundingClientRect();
      let best: RefineHandle | null = null,
        nearest = handlePick * handlePick;
      for (const handle of refineHandles(refine)) {
        if (selectedOnly && !refine.selected.includes(handle.feature)) continue;
        const spot = toScreen(camera, rect, ...handle.point.position);
        if (!spot) continue;
        const d = (spot[0] - x) ** 2 + (spot[1] - y) ** 2;
        if (d <= nearest) [best, nearest] = [handle, d];
      }
      return best;
    };

    /** The pending edge whose drawn curve passes within reach of a client position. */
    const proposalAt = (refine: RefineSession, x: number, y: number) => {
      const { camera } = get();
      const rect = canvas().getBoundingClientRect();
      const pending = new Set(
        refine.features.filter((f) => f.state === 'pending').map((f) => f.id),
      );
      let best: string | null = null,
        nearest = proposalPick * proposalPick;
      const right = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion),
        rimPoint = new Vector3();
      for (const [id, curve] of refineCurves) {
        if (!pending.has(id)) continue;
        // Curves whose bounding sphere lies well away on screen are skipped unprojected.
        const middle = toScreen(camera, rect, curve.centre.x, curve.centre.y, curve.centre.z);
        if (middle) {
          rimPoint.copy(curve.centre).addScaledVector(right, curve.radius);
          const rim = toScreen(camera, rect, rimPoint.x, rimPoint.y, rimPoint.z);
          const reach = rim
            ? Math.hypot(rim[0] - middle[0], rim[1] - middle[1]) * 2 + proposalPick
            : Infinity;
          if (Math.hypot(middle[0] - x, middle[1] - y) > reach) continue;
        }
        const { points } = curve;
        let previous: readonly [number, number] | null = null;
        for (let i = 0; i < points.length; i += 3) {
          const spot = toScreen(camera, rect, points[i], points[i + 1], points[i + 2]);
          if (spot && previous) {
            const d = segmentDistance(x, y, previous[0], previous[1], spot[0], spot[1]);
            if (d <= nearest) [best, nearest] = [id, d];
          } else if (spot && points.length === 3) {
            const d = (spot[0] - x) ** 2 + (spot[1] - y) ** 2;
            if (d <= nearest) [best, nearest] = [id, d];
          }
          previous = spot;
        }
      }
      return best;
    };

    const sampleStroke = (d: Stroke, x: number, y: number) => {
      const dx = x - d.x,
        dy = y - d.y;
      const length = Math.hypot(dx, dy);
      const steps = Math.floor(length / strokeStep);
      if (!steps) return;
      const state = useEditor.getState();
      for (let i = 1; i <= steps; i++) {
        const t = (i * strokeStep) / length;
        const point = hitAt(d.partId, d.x + dx * t, d.y + dy * t);
        if (point) state.moveRefineStroke(point);
      }
      d.x += (dx * steps * strokeStep) / length;
      d.y += (dy * steps * strokeStep) / length;
    };

    const dragHandle = (d: HandleDrag, x: number, y: number) => {
      if (!d.moved && Math.hypot(x - d.x, y - d.y) < dragStart) return;
      d.moved = true;
      const point = hitAt(d.partId, x, y);
      if (!point) return;
      const { handle } = d;
      // The first move of a drag starts its own undo step.
      useEditor
        .getState()
        .moveRefinePoint(handle.feature, handle.segment, handle.index, point, !d.began);
      d.began = true;
      d.current = point;
    };

    let unsubscribe: (() => void) | null = null;
    const end = () => {
      const d = gesture;
      if (!d) return null;
      gesture = null;
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('blur', discard);
      window.removeEventListener('keydown', key, true);
      canvas().removeEventListener('lostpointercapture', lost);
      try {
        canvas().releasePointerCapture(d.pointer);
      } catch {
        // Already released.
      }
      if (d.controls) d.controls.enabled = true;
      unsubscribe?.();
      unsubscribe = null;
      return d;
    };
    /** Ends the gesture leaving the session as it was before it. */
    const discard = () => {
      const d = end();
      if (!d) return;
      const state = useEditor.getState();
      if (d.kind === 'handle') {
        // A drag that moved the point puts the session back as it found it, history included.
        if (d.began) state.cancelRefineDrag();
        return;
      }
      state.cancelRefineStroke();
    };

    const move = (event: PointerEvent) => {
      const d = gesture;
      if (!d || event.pointerId !== d.pointer) return;
      if (pressed()) return discard();
      if (d.kind === 'handle') return dragHandle(d, event.clientX, event.clientY);
      const events = event.getCoalescedEvents?.() ?? [];
      for (const e of events.length ? events : [event]) sampleStroke(d, e.clientX, e.clientY);
    };
    const up = (event: PointerEvent) => {
      const d = gesture;
      if (!d || event.pointerId !== d.pointer) return;
      swallowing = true;
      setTimeout(() => (swallowing = false));
      if (pressed()) return discard();
      if (d.kind === 'handle') dragHandle(d, event.clientX, event.clientY);
      else sampleStroke(d, event.clientX, event.clientY);
      end();
      const state = useEditor.getState();
      if (d.kind === 'stroke') return state.endRefineStroke();
      // A click on the open path's first handle closes it.
      if (!d.moved && d.handle.first) state.addRefinePoint(d.handle.point, true);
    };
    const cancel = (event: PointerEvent) => {
      if (gesture && event.pointerId === gesture.pointer) discard();
    };
    const lost = (event: PointerEvent) => {
      if (gesture && event.pointerId === gesture.pointer) discard();
    };
    const key = (event: KeyboardEvent) => {
      if (!gesture || event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      discard();
    };

    const own = (d: Gesture, pointer: number) => {
      // The camera's controls see a press on the part after it; the gesture owns it instead.
      const controls = get().controls as { enabled: boolean } | null;
      d.controls = controls?.enabled ? controls : null;
      if (d.controls) d.controls.enabled = false;
      gesture = d;
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerup', up, true);
      window.addEventListener('pointercancel', cancel, true);
      window.addEventListener('blur', discard);
      window.addEventListener('keydown', key, true);
      const element = canvas();
      element.addEventListener('lostpointercapture', lost);
      try {
        element.setPointerCapture(pointer);
      } catch {
        // A pointer that is not active cannot be captured; window listeners still follow it.
      }
      const session = useEditor.getState().refine?.id;
      // Anything that takes the pointer or the session away ends the gesture.
      unsubscribe = useEditor.subscribe((s) => {
        if (
          gesture === d &&
          (s.tool !== 'refine' ||
            s.refine?.id !== session ||
            s.refine?.stage !== 'ready' ||
            (d.kind === 'stroke' && !brushingRefine(s)) ||
            blocked(s))
        )
          discard();
      });
    };

    starter = (event, partId) => {
      const state = useEditor.getState(),
        refine = state.refine;
      if (
        gesture ||
        !brushingRefine(state) ||
        refine?.stage !== 'ready' ||
        refine.partId !== partId ||
        event.faceIndex == null ||
        event.button !== 0 ||
        event.shiftKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        blocked(state) ||
        pressed()
      )
        return false;
      const { clientX: x, clientY: y } = event.nativeEvent;
      // A press on another part in front reaches this one too; it starts nothing.
      const first = hitAt(partId, x, y);
      if (!first) return false;
      own(
        { kind: 'stroke', pointer: event.pointerId, partId, x, y, controls: null },
        event.pointerId,
      );
      state.beginRefineStroke(first);
      return true;
    };

    let pressX: [number, number] = [0, 0];
    // A handle near the part's outline may lie off it, so handles are taken before the part sees
    // the press, and before the camera does.
    const down = (event: PointerEvent) => {
      pressedProposal = null;
      const state = useEditor.getState(),
        refine = state.refine;
      if (
        gesture ||
        state.tool !== 'refine' ||
        refine?.stage !== 'ready' ||
        (refine.mode !== 'edge' && refine.mode !== 'detect') ||
        event.button !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        blocked(state) ||
        !canvas().contains(event.target as Node)
      )
        return;
      const handle = event.shiftKey ? null : handleAt(refine, event.clientX, event.clientY, true);
      if (handle) {
        event.stopImmediatePropagation();
        own(
          {
            kind: 'handle',
            pointer: event.pointerId,
            partId: refine.partId,
            handle,
            current: handle.point,
            x: event.clientX,
            y: event.clientY,
            moved: false,
            controls: null,
          },
          event.pointerId,
        );
        return;
      }
      if (refine.mode === 'detect')
        pressedProposal = proposalAt(refine, event.clientX, event.clientY);
      if (pressedProposal) pressX = [event.clientX, event.clientY];
    };
    const click = (event: MouseEvent) => {
      if (swallowing && canvas().contains(event.target as Node)) {
        event.stopImmediatePropagation();
        return;
      }
      const id = pressedProposal;
      pressedProposal = null;
      if (!id || Math.hypot(event.clientX - pressX[0], event.clientY - pressX[1]) > 5) return;
      const state = useEditor.getState(),
        refine = state.refine;
      if (!refine || state.tool !== 'refine') return;
      event.stopImmediatePropagation();
      const selected = refine.selected;
      state.selectRefine(
        event.shiftKey
          ? selected.includes(id)
            ? selected.filter((s) => s !== id)
            : [...selected, id]
          : [id],
      );
    };

    // A pointer cursor over a handle, or over a proposal in Detect mode.
    let pointing = false,
      before = '';
    const hover = (event: PointerEvent) => {
      const state = useEditor.getState(),
        refine = state.refine;
      let over = false;
      if (
        !gesture &&
        state.tool === 'refine' &&
        refine?.stage === 'ready' &&
        !blocked(state) &&
        canvas().contains(event.target as Node)
      ) {
        if (refine.mode === 'edge' || refine.mode === 'detect')
          over = !!handleAt(refine, event.clientX, event.clientY, true);
        if (!over && refine.mode === 'detect')
          over = !!proposalAt(refine, event.clientX, event.clientY);
      }
      if (over && !pointing) {
        before = document.body.style.cursor;
        document.body.style.cursor = 'pointer';
      } else if (!over && pointing && document.body.style.cursor === 'pointer')
        document.body.style.cursor = before;
      pointing = over;
    };

    window.addEventListener('pointerdown', down, true);
    window.addEventListener('click', click, true);
    window.addEventListener('pointermove', hover);
    return () => {
      discard();
      starter = null;
      pressedProposal = null;
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('click', click, true);
      window.removeEventListener('pointermove', hover);
      if (pointing && document.body.style.cursor === 'pointer') document.body.style.cursor = before;
    };
  }, [get, pressed]);
  return null;
}

/** For a Mesh drawing a Refine preview: picks the preview itself, with the tree the store keeps on it. */
export function previewRaycast(pick: Mesh['raycast']): Mesh['raycast'] {
  return function (this: Mesh, ...args: Parameters<Mesh['raycast']>) {
    if (useEditor.getState().freeTransform) return;
    pick.apply(this, args);
  };
}
