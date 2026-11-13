import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useThree } from '@react-three/fiber';
import { Box3, Data3DTexture, LinearFilter, Matrix4, RedFormat, Vector3 } from 'three';
import type { Intersection, Mesh, Raycaster, WebGLProgramParametersWithUniforms } from 'three';
import { LoaderCircle, ScanEye } from 'lucide-react';
import { pickRaycast } from '../core/bvh';
import { partMatrix } from '../core/geometry';
import {
  isolationLimits,
  nearbyLimit,
  nearbySpec,
  sameField,
  showsNearby,
} from '../core/isolation';
import type { NearbySpec } from '../core/isolation';
import { fieldDistance, fieldLimits } from '../core/proximity';
import { bakeProximityInWorker } from '../core/proximity-job';
import type { ProximityField } from '../core/proximity';
import { useShortcut } from '../core/preferences';
import { useEditor } from '../core/store';
import { NumericInput } from './ui';

/** How the parts around an isolated one are drawn and picked. */
export interface NearbySurfaces {
  /** Cuts a material down to the fragments near the isolated parts. */
  compile: (shader: WebGLProgramParametersWithUniforms) => void;
  /** Whether a world point lies on a surface that is drawn. */
  shows: (point: Vector3) => boolean;
}

interface Baked {
  spec: NearbySpec;
  field: ProximityField;
  texture: Data3DTexture;
}

/**
 * Keeps a distance field around the isolated parts, so the others can be drawn only where they
 * come near. The field rides on the first isolated part: moving parts changes one matrix, and
 * only a new selection, scale, or reach measures it again.
 */
export function useNearbySurfaces() {
  const parts = useEditor((s) => s.scene.parts),
    isolated = useEditor((s) => s.isolated),
    distance = useEditor((s) => s.view.isolation.distance),
    active = useEditor((s) => !!s.isolated && showsNearby(s.view));
  const gl = useThree((s) => s.gl),
    invalidate = useThree((s) => s.invalidate);
  const [baked, setBaked] = useState<Baked | null>(null);
  const pending = useRef<{ spec: NearbySpec; cancel: () => void } | null>(null);
  const live = useRef<{ field: ProximityField; inverse: Matrix4; limit: number } | null>(null);
  const uniforms = useMemo(
    () => ({
      nearbyField: { value: null as Data3DTexture | null },
      nearbyMatrix: { value: new Matrix4() },
      nearbyLimit: { value: 0 },
      nearbyEdge: { value: new Vector3() },
    }),
    [],
  );
  const surfaces = useMemo<NearbySurfaces>(
    () => ({
      compile: (shader) => {
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader =
          `uniform mat4 nearbyMatrix;\nvarying vec3 vNearby;\n${shader.vertexShader}`.replace(
            '#include <project_vertex>',
            '#include <project_vertex>\n\tvNearby = (nearbyMatrix * (modelMatrix * vec4(transformed, 1.0))).xyz;',
          );
        shader.fragmentShader =
          `uniform highp sampler3D nearbyField;\nuniform float nearbyLimit;\nuniform vec3 nearbyEdge;\nvarying vec3 vNearby;\n${shader.fragmentShader}`.replace(
            '#include <clipping_planes_fragment>',
            'if (any(lessThan(vNearby, nearbyEdge)) || any(greaterThan(vNearby, 1.0 - nearbyEdge)) || texture(nearbyField, vNearby).r > nearbyLimit) discard;\n\t#include <clipping_planes_fragment>',
          );
      },
      shows: (point) => {
        const current = live.current;
        if (!current) return false;
        const local = point.clone().applyMatrix4(current.inverse);
        return fieldDistance(current.field, local.x, local.y, local.z) <= current.limit;
      },
    }),
    [uniforms],
  );

  const spec = useMemo(
    () => (active && isolated ? nearbySpec(parts, isolated, distance) : null),
    [active, isolated, parts, distance],
  );
  const usable =
    spec && baked && baked.spec.parts.join('\0') === spec.parts.join('\0') ? baked : null;

  useEffect(() => {
    const stop = () => {
      pending.current?.cancel();
      pending.current = null;
    };
    if (!spec || (usable && sameField(usable.spec, spec))) return stop();
    if (pending.current && sameField(pending.current.spec, spec)) return;
    stop();
    const start = () => {
      const context = gl.getContext() as WebGL2RenderingContext;
      const axis = Math.min(512, context.getParameter(context.MAX_3D_TEXTURE_SIZE) || 256);
      const controller = new AbortController();
      if (pending.current) pending.current.cancel = () => controller.abort();
      void bakeProximityInWorker(
        spec.sources,
        spec.reach,
        { ...fieldLimits, axis },
        controller.signal,
      )
        .then(({ field }) => {
          if (controller.signal.aborted) return;
          pending.current = null;
          if (!field) return;
          const texture = new Data3DTexture(field.data, ...field.size);
          texture.format = RedFormat;
          texture.minFilter = texture.magFilter = LinearFilter;
          texture.needsUpdate = true;
          setBaked({ spec, field, texture });
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          pending.current = null;
          useEditor
            .getState()
            .notify(
              error instanceof Error ? error.message : 'Nearby surfaces could not be prepared.',
              'error',
            );
        });
    };
    if (usable) {
      // A drag that scales or separates the isolated parts changes the field every frame.
      const timer = setTimeout(start, 150);
      pending.current = { spec, cancel: () => clearTimeout(timer) };
    } else {
      pending.current = { spec, cancel: () => {} };
      start();
    }
  }, [spec, usable, gl]);
  useEffect(
    () => () => {
      pending.current?.cancel();
      pending.current = null;
    },
    [],
  );
  useEffect(() => {
    if (!isolated) setBaked(null);
  }, [isolated]);
  useEffect(() => () => baked?.texture.dispose(), [baked]);

  useLayoutEffect(() => {
    if (!usable || !spec) {
      live.current = null;
      return;
    }
    const { field } = usable;
    const [nx, ny, nz] = field.size;
    const inverse = spec.frame.clone().invert();
    const limit = nearbyLimit(distance, usable.spec.reach, field.cell);
    live.current = { field, inverse, limit };
    uniforms.nearbyField.value = usable.texture;
    // World to the field's frame, then to texture coordinates with nodes at texel centers.
    uniforms.nearbyMatrix.value
      .makeScale(1 / (nx * field.cell), 1 / (ny * field.cell), 1 / (nz * field.cell))
      .multiply(
        new Matrix4().makeTranslation(
          field.cell / 2 - field.origin[0],
          field.cell / 2 - field.origin[1],
          field.cell / 2 - field.origin[2],
        ),
      )
      .multiply(inverse);
    uniforms.nearbyLimit.value = limit / field.range;
    uniforms.nearbyEdge.value.set(0.5 / nx, 0.5 / ny, 0.5 / nz);
    invalidate();
  }, [usable, spec, distance, uniforms, invalidate]);

  // Parts wholly beyond the field cannot have a drawn fragment, so they skip the GPU.
  const ids = useMemo(() => {
    if (!usable || !spec) return null;
    const { field } = usable;
    const reach = new Box3(
      new Vector3(...field.origin),
      new Vector3(...field.origin.map((v, i) => v + (field.size[i] - 1) * field.cell)),
    );
    const inverse = spec.frame.clone().invert();
    const box = new Box3();
    const near = new Set<string>();
    for (const part of parts) {
      if (!part.visible || spec.parts.includes(part.id)) continue;
      if (!part.geometry.boundingBox) part.geometry.computeBoundingBox();
      box.copy(part.geometry.boundingBox!).applyMatrix4(inverse.clone().multiply(partMatrix(part)));
      if (box.intersectsBox(reach)) near.add(part.id);
    }
    return near;
  }, [usable, spec, parts]);

  // Tells the rest of the editor what is drawn, so gizmos and markers follow it.
  const detail = usable?.field.cell ?? null;
  useEffect(() => {
    const state = useEditor.getState();
    const shown = ids && [...ids];
    const same =
      shown?.length === state.nearbyParts?.length &&
      (shown ?? []).every((id, i) => id === state.nearbyParts![i]);
    if (!same || detail !== state.nearbyDetail)
      useEditor.setState({ nearbyDetail: detail, nearbyParts: same ? state.nearbyParts : shown });
  }, [ids, detail]);
  useEffect(() => () => useEditor.setState({ nearbyDetail: null, nearbyParts: null }), []);

  return ids ? { ids, surfaces } : null;
}

/** Picks the nearest hit that is drawn, which may lie behind surfaces that were cut away. */
export function nearbyRaycast(shows: NearbySurfaces['shows']) {
  return function (this: Mesh, raycaster: Raycaster, intersects: Intersection[]) {
    const hits: Intersection[] = [];
    const firstHitOnly = raycaster.firstHitOnly;
    raycaster.firstHitOnly = false;
    pickRaycast.call(this, raycaster, hits);
    raycaster.firstHitOnly = firstHitOnly;
    let nearest: Intersection | null = null;
    for (const hit of hits)
      if ((!nearest || hit.distance < nearest.distance) && shows(hit.point)) nearest = hit;
    if (nearest) intersects.push(nearest);
  };
}

export function IsolationNotice() {
  const isolated = useEditor((s) => s.isolated),
    parts = useEditor((s) => s.scene.parts),
    settings = useEditor((s) => s.view.isolation),
    paused = useEditor((s) => s.view.explode > 0 || s.view.inspection.enabled),
    detail = useEditor((s) => s.nearbyDetail);
  const keys = { isolate: useShortcut('isolate'), nearby: useShortcut('isolateNearby') };
  if (!isolated) return null;
  const shown = isolated.flatMap((id) => parts.find((part) => part.id === id) ?? []);
  const names = shown.map((part) => part.name);
  const waiting =
    settings.nearby && !paused && detail === null && shown.some((part) => part.visible);
  return (
    <section className="isolation-notice" aria-label="Isolation">
      <ScanEye size={13} />
      <span className="isolation-name" title={names.join(', ')}>
        {names.length === 1 ? names[0] : `${names.length} parts`}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={settings.nearby}
        className={`isolation-nearby ${settings.nearby ? 'active' : ''} ${paused ? 'paused' : ''}`}
        title={
          paused
            ? 'Nearby surfaces return when the exploded or interference view closes'
            : `Also draw other parts where they come near${keys.nearby ? ` (${keys.nearby})` : ''}`
        }
        onClick={() => useEditor.getState().toggleNearby()}
      >
        <span>Nearby surfaces</span>
        {waiting ? (
          <LoaderCircle size={11} className="spin" />
        ) : (
          <span className={`mini-toggle ${settings.nearby ? 'on' : ''}`} />
        )}
      </button>
      {settings.nearby ? (
        <label
          className="isolation-distance"
          title={`Other parts are drawn where they come within this distance${detail ? `, to about ${Number(detail.toPrecision(2))} mm` : ''}`}
        >
          <NumericInput
            label="Nearby distance in mm"
            value={settings.distance}
            min={isolationLimits.min}
            max={isolationLimits.max}
            step={isolationLimits.step}
            onCommit={(distance) =>
              useEditor.getState().setView({ isolation: { ...settings, distance } })
            }
          />
          <small>mm</small>
        </label>
      ) : null}
      <button
        type="button"
        className="isolation-exit"
        aria-label="Exit isolation"
        onClick={() => useEditor.getState().isolate(null)}
      >
        Exit{keys.isolate ? <kbd>{keys.isolate}</kbd> : null}
      </button>
    </section>
  );
}
