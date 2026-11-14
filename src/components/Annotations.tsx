import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { CSSProperties } from 'react';
import { useFrame } from '@react-three/fiber';
import { Vector3 } from 'three';
import type { Camera } from 'three';
import { partMatrix, partPivot, vec, worldPoint } from '../core/geometry';
import { isJointConnected } from '../core/constraints';
import { resolvePart } from '../core/references';
import { contactColors, patchCenter } from '../core/surfaces';
import {
  calloutLeader,
  clampCallout,
  layoutCallouts,
  type CalloutBounds,
  type CalloutOffset,
} from '../core/callouts';
import { partDisplay } from '../core/alignment-visibility';
import { usePreferences } from '../core/preferences';
import { useEditor } from '../core/store';
import type { Part, SurfacePatch } from '../core/types';

/** Shares the canvas camera with DOM overlays outside the canvas, once per rendered frame. */
export class ViewProjection {
  camera: Camera | null = null;
  width = 0;
  height = 0;
  private listeners = new Set<() => void>();
  publish(camera: Camera, width: number, height: number) {
    this.camera = camera;
    this.width = width;
    this.height = height;
    this.listeners.forEach((listener) => listener());
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export function ProjectionTracker({ projection }: { projection: ViewProjection }) {
  // Runs after the controls have moved the camera for this frame.
  useFrame(({ camera, size }) => projection.publish(camera, size.width, size.height));
  return null;
}

type AnnotationKind = 'point' | 'pivot' | 'joint' | 'anchor' | 'anchor-actual' | 'patch';

interface Annotation {
  id: string;
  kind: AnnotationKind;
  position: Vector3;
  color: string;
  label?: string;
  labelClass?: string;
  active?: boolean;
  select?: { label: string; disabled: boolean; run: () => void };
}

// A patch center walks every painted face, so reuse it until the patch or mesh changes.
const patchCenters = new WeakMap<SurfacePatch, { part: Part; center: Vector3 | null }>();
function cachedPatchCenter(part: Part, patch: SurfacePatch) {
  const cached = patchCenters.get(patch);
  if (cached?.part.geometry === part.geometry) return cached.center;
  const center = patchCenter(part, patch);
  patchCenters.set(patch, { part, center });
  return center;
}

/** Every point marker in the viewport: picks, pivots, joints, anchors, and painted patches. */
function useAnnotations(): Annotation[] {
  const scene = useEditor((s) => s.scene),
    op = useEditor((s) => s.operation),
    measurement = useEditor((s) => s.measurement),
    selected = useEditor((s) => s.selected),
    showJoints = useEditor((s) => s.view.joints),
    explode = useEditor((s) => s.view.explode),
    tool = useEditor((s) => s.tool),
    activeAnchor = useEditor((s) => s.activeAnchor),
    activePin = useEditor((s) => s.activePin),
    isolated = useEditor((s) => s.isolated),
    nearby = useEditor((s) => s.nearbyParts),
    navigating = useEditor((s) => !!s.navigationMode || s.temporaryOrbit || s.pivotPicking);
  return useMemo(() => {
    if (explode) return [];
    const display = { tool, operation: op, isolated, nearbyParts: nearby };
    const shown = (part?: Part): part is Part =>
      !!part?.visible && partDisplay(display, part.id) !== 'hidden';
    const list: Annotation[] = [];
    for (const part of scene.parts)
      if (shown(part) && part.pivot && selected.includes(part.id))
        list.push({
          id: `pivot:${part.id}`,
          kind: 'pivot',
          position: partPivot(part),
          color: '#c9dcf8',
          label: 'Pivot',
          labelClass: 'pivot-label',
        });
    const pick = (
      id: string,
      point: (typeof op.pairs)[number]['source'],
      color: string,
      label?: string,
    ) => {
      const part = resolvePart(scene, point.partId);
      if (shown(part))
        list.push({
          id,
          kind: 'point',
          position: worldPoint(part, point),
          color,
          label,
        });
    };
    op.pairs.forEach((pair, i) => {
      pick(`pair:${i}:source`, pair.source, '#eda763', `S${i + 1}`);
      pick(`pair:${i}:target`, pair.target, '#9ccec6', `T${i + 1}`);
    });
    if (op.pending) pick('pending', op.pending, '#eda763', 'source');
    measurement.forEach((point, i) => pick(`measure:${i}`, point, '#a2cec4'));
    if (showJoints)
      for (const joint of scene.joints.filter(isJointConnected)) {
        const parent = scene.parts.find((p) => p.id === joint.parentId);
        if (shown(parent))
          list.push({
            id: `joint:${joint.id}`,
            kind: 'joint',
            position: vec(joint.parentAnchor).applyMatrix4(partMatrix(parent)),
            color: '#9ac4bb',
          });
      }
    for (const part of scene.parts.filter((p) => selected.includes(p.id) && shown(p))) {
      for (const [index, pin] of (part.pins ?? []).entries()) {
        const color = pin.kind === 'hard' ? '#ffbd7a' : '#7ce1d1';
        list.push({
          id: `pin:${part.id}:${pin.id}:actual`,
          kind: 'anchor-actual',
          position: vec(pin.point).applyMatrix4(partMatrix(part)),
          color,
        });
        list.push({
          id: `pin:${part.id}:${pin.id}`,
          kind: 'anchor',
          position: vec(pin.target),
          color,
          label: `${pin.kind === 'hard' ? 'P' : 'S'}${index + 1}`,
          active: activePin === pin.id,

          select: {
            label: `Select ${pin.kind} pin ${index + 1}`,
            disabled: navigating,
            run: () => {
              useEditor.getState().select(part.id);
              useEditor.setState({ activePin: pin.id, pinPicking: null });
            },
          },
        });
      }
    }
    const anchorPart = scene.parts.find((p) => p.id === selected[0]);
    if (tool === 'anchors' && shown(anchorPart)) {
      const anchors = anchorPart.anchors ?? [];
      const current = anchors.find((a) => a.id === activeAnchor) ?? anchors[0];
      anchors.forEach((anchor, index) => {
        const active = current?.id === anchor.id;
        const color = active ? '#ffbd7a' : '#7ce1d1';
        list.push({
          id: `anchor:${anchor.id}:actual`,
          kind: 'anchor-actual',
          position: vec(anchor.point).applyMatrix4(partMatrix(anchorPart)),
          color,
        });
        list.push({
          id: `anchor:${anchor.id}`,
          kind: 'anchor',
          position: vec(anchor.target),
          color,
          label: String(index + 1),
          active,

          select: {
            label: `Select anchor ${index + 1} target`,
            disabled: navigating,
            run: () => useEditor.setState({ activeAnchor: anchor.id, anchorPicking: false }),
          },
        });
      });
    }
    if (tool === 'align' && op.mode === 'surface')
      op.surfacePairs.forEach((pair, index) =>
        (['source', 'target'] as const).forEach((side) => {
          const patch = pair[side];
          const part = scene.parts.find((p) => p.id === patch?.partId);
          if (!patch || !shown(part) || !patch.faces.length) return;
          const center = cachedPatchCenter(part, patch);
          if (center)
            list.push({
              id: `patch:${pair.id}:${side}`,
              kind: 'patch',
              position: center.clone().applyMatrix4(partMatrix(part)),
              color: contactColors[index % contactColors.length],
              label: `${side === 'source' ? 'S' : 'T'}${index + 1}`,
            });
        }),
      );
    return list;
  }, [
    scene,
    op,
    measurement,
    selected,
    showJoints,
    explode,
    tool,
    activeAnchor,
    activePin,
    navigating,
    isolated,
    nearby,
  ]);
}

/** How far each marker reaches from its point, in pixels, so leaders meet its edge. */
function markerRadius(kind: AnnotationKind, size: number) {
  if (kind === 'pivot') return size * 0.9;
  if (kind === 'joint') return size * 1.1;
  if (kind === 'anchor-actual') return size * 0.2;
  return size / 2;
}

/** Anchor targets and painted patches are their own label inline, with no separate dot. */
const hasDot = (kind: AnnotationKind, callout: boolean) =>
  callout || (kind !== 'anchor' && kind !== 'patch');

interface Nodes {
  dot?: HTMLElement | null;
  label?: HTMLElement | null;
  leader?: SVGPolylineElement | null;
  halo?: SVGPolylineElement | null;
}

const projected = new Vector3();

export function AnnotationLayer({ projection }: { projection: ViewProjection }) {
  const annotations = useAnnotations();
  const markers = usePreferences((s) => s.markers);
  const nodes = useRef(new Map<string, Nodes>());
  const root = useRef<HTMLDivElement>(null);
  const offsets = useRef(new Map<string, CalloutOffset>());
  const displayed = useRef(new Map<string, CalloutOffset>());
  const animation = useRef(0);
  const lastDraw = useRef(0);
  const previousLayout = useRef<{
    annotations: Annotation[];
    markers: typeof markers;
    width: number;
    height: number;
    world: number[];
    projection: number[];
    sizes: { width: number; height: number }[];
    obstacles: string;
  } | null>(null);
  const node =
    <K extends keyof Nodes>(id: string, slot: K) =>
    (element: Nodes[K]) => {
      const entry = nodes.current.get(id) ?? {};
      entry[slot] = element;
      nodes.current.set(id, entry);
    };
  const callout = markers.style === 'callout';

  const layout = useCallback(() => {
    const { camera, width, height } = projection;
    if (!camera || !width || !height) return;
    camera.updateMatrixWorld();
    const toScreen = (point: Vector3) => {
      projected.copy(point).project(camera);
      return {
        x: ((projected.x + 1) / 2) * width,
        y: ((1 - projected.y) / 2) * height,
        // Behind the camera or beyond its far plane.
        visible: projected.z > -1 && projected.z < 1,
      };
    };
    const items = annotations.map((annotation) => ({
      annotation,
      nodes: nodes.current.get(annotation.id) ?? {},
      ...toScreen(annotation.position),
    }));
    // Read every label size before writing any position, so the browser lays out once.
    const sizes = items.map(({ nodes }) => ({
      width: nodes.label?.offsetWidth ?? 0,
      height: nodes.label?.offsetHeight ?? 0,
    }));
    // Keep short callouts out of the viewport's controls when local space allows it.
    const obstacles: CalloutBounds[] = [{ left: width - 120, right: width, top: 0, bottom: 126 }];
    const layerRect = root.current?.getBoundingClientRect();
    if (layerRect) {
      root.current?.parentElement
        ?.querySelectorAll<HTMLElement>(
          '.viewport-top, .canvas-label, .viewport-controls, .camera-navigation, .explode-control, .pick-prompt',
        )
        .forEach((element) => {
          const rect = element.getBoundingClientRect();
          if (rect.width && rect.height)
            obstacles.push({
              left: rect.left - layerRect.left,
              right: rect.right - layerRect.left,
              top: rect.top - layerRect.top,
              bottom: rect.bottom - layerRect.top,
            });
        });
    }
    const obstacleKey = JSON.stringify(obstacles);
    // Routing is only needed when the projection, annotations, or measured labels change.
    const previous = previousLayout.current;
    if (
      previous?.annotations === annotations &&
      previous.markers === markers &&
      previous.width === width &&
      previous.height === height &&
      previous.obstacles === obstacleKey &&
      previous.world.every((value, i) => value === camera.matrixWorld.elements[i]) &&
      previous.projection.every((value, i) => value === camera.projectionMatrix.elements[i]) &&
      sizes.every(
        (size, i) =>
          size.width === previous.sizes[i].width && size.height === previous.sizes[i].height,
      )
    )
      return;
    previousLayout.current = {
      annotations,
      markers,
      width,
      height,
      world: camera.matrixWorld.toArray(),
      projection: camera.projectionMatrix.toArray(),
      sizes,
      obstacles: obstacleKey,
    };
    cancelAnimationFrame(animation.current);
    if (previous && previous.markers.leader !== markers.leader) offsets.current.clear();
    const ids = new Set(annotations.map((a) => a.id));
    for (const map of [nodes.current, offsets.current, displayed.current])
      for (const id of map.keys()) if (!ids.has(id)) map.delete(id);
    const place = (element: HTMLElement | null | undefined, x: number, y: number, show = true) => {
      if (!element) return;
      element.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      element.style.visibility = show ? 'visible' : 'hidden';
    };
    items.forEach(({ nodes, x, y, visible }) => place(nodes.dot, x, y, visible));
    const labelled = items
      .map((item, index) => ({ ...item, ...sizes[index] }))
      .filter((item) => item.nodes.label);
    if (!callout) {
      offsets.current.clear();
      displayed.current.clear();
      for (const item of labelled) {
        const centered = !hasDot(item.annotation.kind, false);
        const offset = centered
          ? 0
          : markerRadius(item.annotation.kind, markers.size) + 3 + item.height / 2;
        place(item.nodes.label, item.x, item.y - offset, item.visible);
      }
      return;
    }
    const onScreen = (item: (typeof labelled)[number]) =>
      item.visible && item.x >= 0 && item.x <= width && item.y >= 0 && item.y <= height;
    const visible = labelled.filter(onScreen);
    const calloutItems = visible.map((item) => ({
      id: item.annotation.id,
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
      radius: markerRadius(item.annotation.kind, markers.size),
    }));
    const placed = layoutCallouts(
      calloutItems,
      markers,
      { width, height },
      offsets.current,
      obstacles,
    );
    visible.forEach((item, i) => offsets.current.set(item.annotation.id, placed[i].offset));
    labelled.forEach((item) => {
      if (!onScreen(item)) {
        place(item.nodes.label, 0, 0, false);
        for (const line of [item.nodes.leader, item.nodes.halo])
          if (line) line.style.visibility = 'hidden';
      }
    });
    // Only local collision adjustments ease. Projected points follow the camera exactly,
    // so orbiting never drags a label behind its point. This also settles on demand canvases.
    const draw = (time: number) => {
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const amount = reducedMotion ? 1 : 1 - Math.exp(-Math.min(32, time - lastDraw.current) / 55);
      lastDraw.current = time;
      let moving = false;
      visible.forEach((item, index) => {
        const target = placed[index].offset;
        const current = displayed.current.get(item.annotation.id) ?? target;
        const distance = Math.hypot(target.x - current.x, target.y - current.y);
        const offset =
          distance < 0.25
            ? target
            : {
                x: current.x + (target.x - current.x) * amount,
                y: current.y + (target.y - current.y) * amount,
              };
        moving ||= !reducedMotion && distance >= 0.25;
        const center = clampCallout(
          calloutItems[index],
          { x: item.x + offset.x, y: item.y + offset.y },
          { width, height },
        );
        // Clamp only the drawing. Remembering the clamped position would make the
        // offset drift and keep easing forever against an immovable viewport edge.
        displayed.current.set(item.annotation.id, offset);
        place(item.nodes.label, center.x, center.y);
        const leader = calloutLeader(calloutItems[index], center);
        for (const line of [item.nodes.leader, item.nodes.halo]) {
          if (!line) continue;
          line.setAttribute('points', leader ? leader.map((p) => `${p.x},${p.y}`).join(' ') : '');
          line.style.visibility = leader ? 'visible' : 'hidden';
        }
      });
      if (moving) animation.current = requestAnimationFrame(draw);
    };
    draw(performance.now());
  }, [annotations, callout, markers, projection]);

  useLayoutEffect(() => {
    layout();
    const unsubscribe = projection.subscribe(layout);
    // Fonts and viewport resizes can change label geometry without a camera frame.
    const resize = new ResizeObserver(() => layout());
    if (root.current) resize.observe(root.current);
    for (const entry of nodes.current.values()) if (entry.label) resize.observe(entry.label);
    return () => {
      unsubscribe();
      resize.disconnect();
      cancelAnimationFrame(animation.current);
    };
  }, [layout, projection]);

  // Clickable anchor labels sit outside the canvas, so pass the wheel on to keep zooming.
  useEffect(() => {
    const layer = root.current;
    if (!layer) return;
    const forward = (event: WheelEvent) => {
      const canvas = layer.parentElement?.querySelector('canvas');
      if (!canvas) return;
      event.preventDefault();
      canvas.dispatchEvent(new WheelEvent('wheel', event));
    };
    layer.addEventListener('wheel', forward, { passive: false });
    return () => layer.removeEventListener('wheel', forward);
  }, []);

  return (
    <div
      ref={root}
      className={`annotation-layer ${callout ? 'is-callout' : 'is-inline'}`}
      aria-hidden={annotations.some((a) => a.select) ? undefined : true}
      style={
        {
          '--marker-size': `${markers.size}px`,
          '--marker-label-size': `${markers.labelSize}px`,
        } as CSSProperties
      }
    >
      {callout ? (
        <svg className="annotation-leaders" aria-hidden="true">
          {annotations
            .filter((a) => a.label)
            .map((a) => (
              <g key={`${a.id}:leader`} style={{ '--marker-color': a.color } as CSSProperties}>
                <polyline ref={node(a.id, 'halo')} className="annotation-leader-halo" />
                <polyline ref={node(a.id, 'leader')} className="annotation-leader" />
              </g>
            ))}
        </svg>
      ) : null}
      {annotations
        .filter((a) => hasDot(a.kind, callout))
        .map((a) => (
          <span
            key={`${a.id}:dot`}
            ref={node(a.id, 'dot')}
            className={`annotation-dot is-${a.kind}`}
            style={{ '--marker-color': a.color } as CSSProperties}
          />
        ))}
      {annotations
        .filter((a) => a.label)
        .map((a) =>
          a.select ? (
            <button
              key={`${a.id}:label`}
              ref={node(a.id, 'label')}
              className={`annotation-label anchor-marker ${a.active ? 'active' : ''}`}
              style={{ '--marker-color': a.color } as CSSProperties}
              aria-label={a.select.label}
              aria-pressed={!!a.active}
              disabled={a.select.disabled}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                a.select!.run();
              }}
            >
              {a.label}
            </button>
          ) : (
            <span
              key={`${a.id}:label`}
              ref={node(a.id, 'label')}
              className={`annotation-label surface-pick-label ${a.labelClass ?? ''}`}
              style={{ '--marker-color': a.color } as CSSProperties}
            >
              {a.label}
            </span>
          ),
        )}
    </div>
  );
}
