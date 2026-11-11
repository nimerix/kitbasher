import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { CSSProperties } from 'react';
import { useFrame } from '@react-three/fiber';
import { Box3, Vector3 } from 'three';
import type { Camera } from 'three';
import { partMatrix, partPivot, sceneBounds, vec, worldPoint } from '../core/geometry';
import { isJointConnected } from '../core/constraints';
import { resolvePart } from '../core/references';
import { contactColors, patchCenter } from '../core/surfaces';
import { layoutCallouts } from '../core/callouts';
import { hiddenByIsolation } from '../core/isolation';
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
  /** Corners of the visible model's box in world space, so callouts can clear its outline. */
  bounds?: Vector3[];
  active?: boolean;
  select?: { label: string; disabled: boolean; run: () => void };
}

const boxCorners = (box: Box3) =>
  [0, 1, 2, 3, 4, 5, 6, 7].map(
    (i) =>
      new Vector3(
        i & 1 ? box.max.x : box.min.x,
        i & 2 ? box.max.y : box.min.y,
        i & 4 ? box.max.z : box.min.z,
      ),
  );

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
    isolated = useEditor((s) => s.isolated),
    nearby = useEditor((s) => s.nearbyParts),
    navigating = useEditor((s) => !!s.navigationMode || s.temporaryOrbit || s.pivotPicking);
  return useMemo(() => {
    if (explode) return [];
    const shown = (part?: Part): part is Part =>
      !!part?.visible && !hiddenByIsolation(isolated, nearby, part.id);
    // Callouts clear the whole visible model, not only the part their point is on.
    const model = boxCorners(
      sceneBounds(
        isolated ? scene.parts.filter((part) => isolated.includes(part.id)) : scene.parts,
      ),
    );
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
          bounds: model,
        });
    const pick = (
      id: string,
      point: (typeof op.pairs)[number]['source'],
      color: string,
      label?: string,
    ) => {
      const part = resolvePart(scene, point.partId);
      if (part)
        list.push({
          id,
          kind: 'point',
          position: worldPoint(part, point),
          color,
          label,
          bounds: model,
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
          bounds: model,
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
              bounds: model,
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
  leader?: HTMLElement | null;
}

const projected = new Vector3();

export function AnnotationLayer({ projection }: { projection: ViewProjection }) {
  const annotations = useAnnotations();
  const markers = usePreferences((s) => s.markers);
  const nodes = useRef(new Map<string, Nodes>());
  const node = (id: string, slot: keyof Nodes) => (element: HTMLElement | null) => {
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
      for (const item of labelled) {
        const centered = !hasDot(item.annotation.kind, false);
        const offset = centered
          ? 0
          : markerRadius(item.annotation.kind, markers.size) + 3 + item.height / 2;
        place(item.nodes.label, item.x, item.y - offset, item.visible);
      }
      return;
    }
    const visible = labelled.filter((item) => item.visible);
    const placed = layoutCallouts(
      visible.map((item) => {
        let modelTop: number | null = null;
        for (const corner of item.annotation.bounds ?? []) {
          const screen = toScreen(corner);
          if (screen.visible) modelTop = Math.min(modelTop ?? Infinity, screen.y);
        }
        return {
          x: item.x,
          y: item.y,
          width: item.width,
          height: item.height,
          radius: markerRadius(item.annotation.kind, markers.size),
          modelTop,
        };
      }),
      markers,
      { width, height },
    );
    labelled.forEach((item) => {
      if (!item.visible) {
        place(item.nodes.label, 0, 0, false);
        place(item.nodes.leader, 0, 0, false);
      }
    });
    visible.forEach((item, index) => {
      const { x, y, leader } = placed[index];
      place(item.nodes.label, x, y);
      if (item.nodes.leader) {
        item.nodes.leader.style.height = leader ? `${leader[1] - leader[0]}px` : '0px';
        place(item.nodes.leader, x, leader ? leader[0] : y, !!leader);
      }
    });
  }, [annotations, callout, markers, projection]);

  useLayoutEffect(() => {
    layout();
    return projection.subscribe(layout);
  }, [layout, projection]);

  // Clickable anchor labels sit outside the canvas, so pass the wheel on to keep zooming.
  const root = useRef<HTMLDivElement>(null);
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
      {callout
        ? annotations
            .filter((a) => a.label)
            .map((a) => (
              <span
                key={`${a.id}:leader`}
                ref={node(a.id, 'leader')}
                className="annotation-leader"
                style={{ '--marker-color': a.color } as CSSProperties}
              />
            ))
        : null}
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
              aria-label={a.select.label}
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
              style={{ color: a.color, '--marker-color': a.color } as CSSProperties}
            >
              {a.label}
            </span>
          ),
        )}
    </div>
  );
}
