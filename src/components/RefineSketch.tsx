import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useThree } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import {
  BufferAttribute,
  BufferGeometry,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Object3D,
  Points,
  PointsMaterial,
  Vector3,
} from 'three';
import type { EdgeInput } from '../core/refine-edge';
import {
  nearestOnSurface,
  planeCoordinates,
  planePoint,
  type SketchPlane,
} from '../core/refine-sketch';
import { chosenRefinePoint, useEditor, type RefineSession } from '../core/store';
import { ManagedTransformControls } from './ManagedTransformControls';
import { constraintLabels, type GuideConstraint } from '../core/refine-constraints';
import { constraintGlyphs } from './RefinePointMenu';
import { pointAccent } from './WarpStroke';

const uColor = '#e5484d';
const vColor = '#46a758';
const gridColor = '#a4aab2';
/** Grid lines across the square each way. */
const gridLines = 8;

/**
 * The square of `plane` round a guide's points, with margin, as (u, v) bounds; a guide of one point
 * takes a square of 2 mm.
 */
function squareOf(plane: SketchPlane, input: EdgeInput) {
  const uv = input.segments.flatMap((s) =>
    s.points.map((p) => planeCoordinates(plane, p.position)),
  );
  const [u0, u1] = [Math.min(...uv.map((p) => p[0])), Math.max(...uv.map((p) => p[0]))];
  const [v0, v1] = [Math.min(...uv.map((p) => p[1])), Math.max(...uv.map((p) => p[1]))];
  const size = Math.max(u1 - u0, v1 - v0, 1) * 1.3;
  const [cu, cv] = [(u0 + u1) / 2, (v0 + v1) / 2];
  return { u0: cu - size / 2, u1: cu + size / 2, v0: cv - size / 2, v1: cv + size / 2, cu, cv };
}

/** A faint grid square of a selected guide's plane round its points, with its u and v axes. */
function PlaneGrid({ plane, input }: { plane: SketchPlane; input: EdgeInput }) {
  const invalidate = useThree((s) => s.invalidate);
  const shape = useMemo(() => {
    const { u0, u1, v0, v1, cu, cv } = squareOf(plane, input);
    const grid: number[] = [];
    for (let k = 0; k <= gridLines; k++) {
      const u = u0 + ((u1 - u0) * k) / gridLines,
        v = v0 + ((v1 - v0) * k) / gridLines;
      grid.push(...planePoint(plane, u, v0), ...planePoint(plane, u, v1));
      grid.push(...planePoint(plane, u0, v), ...planePoint(plane, u1, v));
    }
    const line = (points: number[], color: string, opacity: number) => {
      const geometry = new BufferGeometry().setAttribute(
        'position',
        new BufferAttribute(Float32Array.from(points), 3),
      );
      const material = new LineBasicMaterial({
        color,
        transparent: true,
        opacity,
        depthTest: false,
      });
      const segments = new LineSegments(geometry, material);
      segments.renderOrder = 5;
      segments.raycast = () => {};
      return segments;
    };
    const reach = (u1 - u0) / 2;
    return [
      line(grid, gridColor, 0.25),
      line([...planePoint(plane, cu, cv), ...planePoint(plane, cu + reach, cv)], uColor, 0.9),
      line([...planePoint(plane, cu, cv), ...planePoint(plane, cu, cv + reach)], vColor, 0.9),
    ];
  }, [plane, input]);
  useEffect(() => {
    invalidate();
    return () =>
      shape.forEach((line) => {
        line.geometry.dispose();
        (line.material as LineBasicMaterial).dispose();
      });
  }, [shape, invalidate]);
  return (
    <>
      {shape.map((line, i) => (
        <primitive key={i} object={line} />
      ))}
    </>
  );
}

/** Where a constraint's icon sits: beside its first segment's middle, or its first point. */
function anchorOf(input: EdgeInput, constraint: GuideConstraint): number[] | null {
  if (constraint.kind === 'align') {
    const { segment, index } = constraint.points[0];
    return input.segments[segment]?.points[index]?.position ?? null;
  }
  const points = input.segments[constraint.segments[0]]?.points;
  if (!points?.length) return null;
  if (points.length % 2) return points[points.length >> 1].position;
  const [a, b] = [points[points.length / 2 - 1].position, points[points.length / 2].position];
  return [0, 1, 2].map((k) => (a[k] + b[k]) / 2);
}

/**
 * A small icon beside each constraint of a selected guide, and each fixed point, as a sketch shows
 * them; a right-click on one opens its menu, to delete it.
 */
function ConstraintIcons({ feature, input }: { feature: string; input: EdgeInput }) {
  const groups = new Map<string, { at: number[]; items: GuideConstraint[] }>();
  for (const constraint of input.constraints ?? []) {
    const at = anchorOf(input, constraint);
    if (!at) continue;
    const key = at.join(' ');
    const group = groups.get(key) ?? { at, items: [] };
    group.items.push(constraint);
    groups.set(key, group);
  }
  const fixed = input.segments.flatMap((s, segment) =>
    s.points.flatMap((p, index) =>
      p.lock?.kind === 'fixed' ? [{ at: p.position, segment, index }] : [],
    ),
  );
  const open = (event: React.MouseEvent, menu: object) => {
    event.preventDefault();
    event.stopPropagation();
    useEditor.getState().openContextMenu({ x: event.clientX, y: event.clientY, ...menu });
  };
  return (
    <>
      {[...groups.values()].map(({ at, items }) => (
        <Html key={at.join(' ')} position={at as [number, number, number]} zIndexRange={[20, 0]}>
          <div className="refine-constraint-icons">
            {items.map((c) => (
              <span
                key={c.id}
                className="refine-constraint-icon"
                role="img"
                aria-label={`${constraintLabels[c.kind]} constraint`}
                title={`${constraintLabels[c.kind]}. Right-click to delete.`}
                onContextMenu={(event) => open(event, { refineConstraint: { feature, id: c.id } })}
              >
                {constraintGlyphs[c.kind]}
              </span>
            ))}
          </div>
        </Html>
      ))}
      {fixed.map(({ at, segment, index }) => (
        <Html
          key={`fixed ${at.join(' ')}`}
          position={at as [number, number, number]}
          zIndexRange={[20, 0]}
        >
          <div className="refine-constraint-icons">
            <span
              className="refine-constraint-icon"
              role="img"
              aria-label="Fixed point"
              title="Fixed. Right-click for the point menu, to unlock it."
              onContextMenu={(event) => open(event, { refinePoint: { feature, segment, index } })}
            >
              ⚓
            </span>
          </div>
        </Html>
      ))}
    </>
  );
}

/** The points picked so far for a new plane or a line lock. */
function Picked({ points }: { points: number[][] }) {
  const shape = useMemo(() => {
    const geometry = new BufferGeometry().setAttribute(
      'position',
      new BufferAttribute(Float32Array.from(points.flat()), 3),
    );
    const material = new PointsMaterial({
      color: pointAccent,
      size: 9,
      sizeAttenuation: false,
      depthTest: false,
    });
    const dots = new Points(geometry, material);
    dots.renderOrder = 9;
    dots.raycast = () => {};
    return dots;
  }, [points]);
  useEffect(
    () => () => {
      shape.geometry.dispose();
      (shape.material as PointsMaterial).dispose();
    },
    [shape],
  );
  return <primitive object={shape} />;
}

/** Each selected guide's plane, and the picks under way. */
export function RefineSketch({ refine, onPress }: { refine: RefineSession; onPress: () => void }) {
  const planes = refine.features.flatMap((f) =>
    f.state === 'pending' &&
    f.feature.type === 'edge' &&
    f.feature.input.plane &&
    refine.selected.includes(f.id)
      ? [{ id: f.id, input: f.feature.input, plane: f.feature.input.plane }]
      : [],
  );
  return (
    <>
      {planes.map(({ id, input, plane }) => (
        <PlaneGrid key={id} plane={plane} input={input} />
      ))}
      {planes.map(({ id, input }) => (
        <ConstraintIcons key={id} feature={id} input={input} />
      ))}
      {refine.picking?.points.length ? <Picked points={refine.picking.points} /> : null}
      <PointWidget refine={refine} onPress={onPress} />
    </>
  );
}

/**
 * The move widget on the chosen point: arrows along the world axes for a free point, along the
 * plane's u and v with its square for a point of a guide on a plane, along the line for a point
 * locked to one, none for a fixed point. One drag is one undo step; Escape puts the point back.
 */
function PointWidget({ refine, onPress }: { refine: RefineSession; onPress: () => void }) {
  const chosen = chosenRefinePoint(refine);
  const feature = chosen && refine.features.find((f) => f.id === chosen.feature);
  const input = feature?.feature.type === 'edge' ? feature.feature.input : null;
  const point = chosen && input?.segments[chosen.segment]?.points[chosen.index];
  if (!chosen || !input || !point || point.lock?.kind === 'fixed' || refine.picking) return null;
  return (
    <PointWidgetFor
      target={chosen}
      position={point.position}
      triangle={point.triangle}
      plane={input.plane ?? null}
      line={point.lock?.kind === 'line' ? point.lock.direction : null}
      onPress={onPress}
    />
  );
}

function PointWidgetFor({
  target,
  position,
  triangle,
  plane,
  line,
  onPress,
}: {
  target: { feature: string; segment: number; index: number };
  position: number[];
  triangle: number;
  plane: SketchPlane | null;
  line: number[] | null;
  onPress: () => void;
}) {
  const proxy = useMemo(() => new Object3D(), []);
  const drag = useRef<{ began: boolean; triangle: number } | null>(null);
  const [version, setVersion] = useState(0);
  const getRoot = useThree((s) => s.get),
    invalidate = useThree((s) => s.invalidate);
  // The widget's frame: x along u and y along v on a plane, x along a line, else the world's.
  const quaternion = useMemo(() => {
    const frame = new Matrix4();
    if (line) {
      const x = new Vector3(...line).normalize();
      const helper = Math.abs(x.x) < 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
      const y = new Vector3().crossVectors(x, helper).normalize();
      frame.makeBasis(x, y, new Vector3().crossVectors(x, y));
    } else if (plane)
      frame.makeBasis(
        new Vector3(...plane.u),
        new Vector3(...plane.v),
        new Vector3(...plane.normal),
      );
    return new Object3D().quaternion.setFromRotationMatrix(frame).clone();
  }, [plane, line]);
  const finish = useCallback(() => {
    if (!drag.current) return;
    drag.current = null;
    useEditor.getState().endRefineDrag();
    const controls = getRoot().controls;
    if (controls && 'enabled' in controls) controls.enabled = true;
    setVersion((v) => v + 1);
    invalidate();
  }, [getRoot, invalidate]);
  useEffect(() => {
    // Escape during a drag puts the point back where the drag found it.
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !drag.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      useEditor.getState().cancelRefineDrag();
      finish();
    };
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', finish);
    return () => {
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', finish);
    };
  }, [finish]);
  useLayoutEffect(() => {
    if (drag.current) return;
    proxy.position.fromArray(position);
    proxy.quaternion.copy(quaternion);
    proxy.updateMatrixWorld(true);
    invalidate();
  }, [position, quaternion, proxy, version, invalidate]);
  return (
    <>
      <primitive object={proxy} />
      <ManagedTransformControls
        key={version}
        object={proxy}
        mode="translate"
        space={plane || line ? 'local' : 'world'}
        size={0.6}
        showY={!line}
        showZ={!plane && !line}
        onFinishDrag={finish}
        onMouseDown={() => {
          onPress();
          useEditor.getState().beginRefineDrag();
          drag.current = { began: false, triangle };
        }}
        onObjectChange={() => {
          const current = drag.current;
          const model = useEditor.getState().refine?.model;
          if (!current || !model) return;
          const at = proxy.position.toArray();
          const near = nearestOnSurface(model.mesh, model.topology, {
            triangle: current.triangle,
            position: at,
          });
          useEditor
            .getState()
            .moveRefinePoint(
              target.feature,
              target.segment,
              target.index,
              { triangle: near.triangle, position: at },
              !current.began,
            );
          current.began = true;
          current.triangle = near.triangle;
        }}
      />
    </>
  );
}
