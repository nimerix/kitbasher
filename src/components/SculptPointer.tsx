import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Matrix3,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Raycaster,
  RingGeometry,
  ShaderMaterial,
  Vector2,
  Vector3,
  type Intersection,
} from 'three';
import { acceleratedRaycast } from 'three-mesh-bvh';
import { clearSculptIncidence, SculptMesh, type SculptDab } from '../core/sculpt-mesh';
import { triangleCount } from '../core/geometry';
import { workerIndexTriangles } from '../core/spatial-index';
import { useEditor } from '../core/store';
import type { Part, SculptureSettings } from '../core/types';
import { partMeshes } from '../xr/part-meshes';
import { boundsEntry } from './RefinePointer';

type Sample = Pick<
  PointerEvent,
  | 'clientX'
  | 'clientY'
  | 'pressure'
  | 'pointerType'
  | 'tiltX'
  | 'tiltY'
  | 'twist'
  | 'shiftKey'
  | 'altKey'
>;
type Hit = Pick<SculptDab, 'point' | 'normal' | 'face'>;

const maxQueuedDabs = 8;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function interpolate(a: Sample, b: Sample, t: number): Sample {
  return {
    pointerType: b.pointerType,
    shiftKey: b.shiftKey,
    altKey: b.altKey,
    clientX: lerp(a.clientX, b.clientX, t),
    clientY: lerp(a.clientY, b.clientY, t),
    pressure: lerp(a.pressure, b.pressure, t),
    tiltX: lerp(a.tiltX, b.tiltX, t),
    tiltY: lerp(a.tiltY, b.tiltY, t),
    twist: (a.twist + (((b.twist - a.twist + 540) % 360) - 180) * t + 360) % 360,
  };
}

const visible = (mesh: Mesh) => {
  for (let object = mesh.parent; object; object = object.parent) if (!object.visible) return false;
  return mesh.visible;
};

function pressure(sample: Sample, settings: SculptureSettings) {
  return sample.pointerType === 'pen' ? sample.pressure ** settings.pressureCurve : 1;
}

function footprint(s: SculptureSettings, sample: Sample) {
  const pen = sample.pointerType === 'pen';
  const tilt = s.tilt && pen && (sample.tiltX || sample.tiltY);
  const angle =
    (s.rotation + (s.twist && pen ? sample.twist : 0)) * (Math.PI / 180) +
    (tilt ? Math.atan2(-sample.tiltY, sample.tiltX) : 0);
  return angle;
}

function hitFrom(intersection: Intersection, mesh: Mesh): Hit | null {
  if (!intersection.face || intersection.faceIndex == null) return null;
  return {
    point: intersection.point,
    normal: intersection.face.normal
      .clone()
      .applyNormalMatrix(new Matrix3().getNormalMatrix(mesh.matrixWorld)),
    face: intersection.faceIndex,
  };
}

interface Stroke {
  id: number;
  target: Part;
  mask: Float32Array | null;
  epoch: number;
  revision: number;
  own: Mesh;
  before: BufferGeometry;
  draft: SculptMesh;
  settings: SculptureSettings;
  controls: { enabled: boolean } | null;
  controlsEnabled: boolean;
  brush: SculptDab['brush'];
  eraser: boolean;
  last: Sample;
  latest: Sample;
  pending: Sample[];
  changed: boolean;
  spacing: number;
  first: Hit;
  grabPoint: Vector3;
  grabMirror: Hit | null;
  applied: Sample | null;
}

export function SculptPointer() {
  const get = useThree((s) => s.get);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    const { events, gl, scene } = get();
    const canvas = events.connected instanceof HTMLElement ? events.connected : gl.domElement;
    const ray = new Raycaster();
    ray.firstHitOnly = true;
    const ndc = new Vector2();
    const direction = new Vector3();
    const right = new Vector3();
    const cursorShape = new RingGeometry(0.975, 1, 56);
    const cursorPaint = new MeshBasicMaterial({
      color: '#ffd195',
      side: DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      depthWrite: false,
    });
    const cursors = [new Mesh(cursorShape, cursorPaint), new Mesh(cursorShape, cursorPaint)];
    const maskPaint = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      vertexShader: `
        attribute float sculptMask;
        varying float protection;
        void main() {
          protection = sculptMask;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying float protection;
        void main() { gl_FragColor = vec4(0.02, 0.05, 0.09, protection * 0.75); }
      `,
    });
    const overlay = new Mesh<BufferGeometry, ShaderMaterial>(undefined, maskPaint);
    const emptyOverlay = overlay.geometry;
    overlay.matrixAutoUpdate = false;
    overlay.frustumCulled = false;
    overlay.renderOrder = 1;
    overlay.visible = false;
    const mirrorMaterial = new MeshBasicMaterial({ side: DoubleSide });
    const mirrorMesh = new Mesh<BufferGeometry, MeshBasicMaterial>(undefined, mirrorMaterial);
    const emptyMirror = mirrorMesh.geometry;
    mirrorMesh.matrixAutoUpdate = false;
    let idleOverlay: BufferGeometry | null = null;
    let idleSource: BufferGeometry | null = null;
    let idleWeights: Float32Array | null = null;
    let stroke: Stroke | null = null;
    let warm: {
      source: BufferGeometry;
      mask: Float32Array | null;
      matrix: Matrix4;
      draft: SculptMesh;
    } | null = null;
    let warmTimer = 0;
    const discardWarm = () => {
      warm?.draft.geometry.dispose();
      warm = null;
    };
    const preparationTarget = () => {
      const state = useEditor.getState();
      const sculpt = state.sculpt;
      if (!sculpt || state.view.explode || stroke) return null;
      const own = partMeshes.get(sculpt.partId);
      const part = state.scene.parts.find((p) => p.id === sculpt.partId);
      if (!own || !part || part.locked || !visible(own)) return null;
      own.updateWorldMatrix(true, false);
      return { source: part.geometry, mask: sculpt.mask, matrix: own.matrixWorld };
    };
    const prepare = () => {
      if (warmTimer || stroke) return;
      warmTimer = window.setTimeout(() => {
        warmTimer = 0;
        const target = preparationTarget();
        if (!target) return discardWarm();
        const { source, mask, matrix } = target;
        if (warm?.source === source && warm.mask === mask && warm.matrix.equals(matrix)) return;
        discardWarm();
        const draft = new SculptMesh(source, matrix, mask ?? undefined);
        draft.prepare();
        warm = { source, mask, matrix: matrix.clone(), draft };
      }, 60);
    };
    let frame = 0;
    let hover: Sample | null = null;
    let suppressClick = false;
    let clickTimer = 0;
    const hideCursor = () => cursors.forEach((cursor) => (cursor.visible = false));
    hideCursor();
    scene.add(...cursors, overlay);

    const setRay = (sample: Sample) => {
      const rect = canvas.getBoundingClientRect();
      ndc.set(
        ((sample.clientX - rect.left) / rect.width) * 2 - 1,
        1 - ((sample.clientY - rect.top) / rect.height) * 2,
      );
      ray.setFromCamera(ndc, get().camera);
    };
    const intersect = (mesh: Mesh): Intersection[] => {
      if (stroke?.own !== mesh) return ray.intersectObject(mesh, false);
      const hits: Intersection[] = [];
      stroke.draft.raycast(ray, mesh, hits);
      return hits;
    };
    const pick = (sample: Sample, own: Mesh, exactOcclusion = false): Hit | null => {
      setRay(sample);
      const hit = intersect(own)[0];
      if (!hit || !visible(own)) return null;
      for (const mesh of partMeshes.values()) {
        if (mesh === own || !visible(mesh)) continue;
        const geometry = mesh.geometry;
        if (geometry.boundsTree || triangleCount(geometry) <= workerIndexTriangles) {
          const other = intersect(mesh)[0];
          if (other && other.distance <= hit.distance) return null;
          continue;
        }
        const entry = boundsEntry(ray.ray, mesh);
        if (entry === null || entry > hit.distance) continue;
        // Exact fallback is reserved for stroke samples near a mesh whose index is unavailable.
        if (!exactOcclusion) return null;
        const hits: Intersection[] = [];
        ray.far = hit.distance;
        try {
          Mesh.prototype.raycast.call(mesh, ray, hits);
        } finally {
          ray.far = Infinity;
        }
        if (hits.length) return null;
      }
      return hitFrom(hit, own);
    };
    const mirror = (hit: Hit, own: Mesh, radius: number): Hit | null => {
      const inverse = new Matrix4().copy(own.matrixWorld).invert();
      const local = hit.point.clone().applyMatrix4(inverse);
      if (Math.abs(local.x) < 1e-7) return null;
      local.x = -local.x;
      const point = local.applyMatrix4(own.matrixWorld);
      const direction = hit.normal
        .clone()
        .applyNormalMatrix(new Matrix3().getNormalMatrix(inverse));
      direction.x = -direction.x;
      direction.applyNormalMatrix(new Matrix3().getNormalMatrix(own.matrixWorld));
      const range = radius * 0.2;
      mirrorMesh.geometry = own.geometry;
      if (!stroke) {
        const part = useEditor.getState().scene.parts.find((p) => partMeshes.get(p.id) === own);
        if (part) mirrorMesh.geometry = part.geometry;
      }
      mirrorMesh.matrixWorld.copy(own.matrixWorld);
      ray.set(point.clone().addScaledVector(direction, range), direction.clone().negate());
      ray.far = range * 2;
      const hits: Intersection[] = [];
      ray.firstHitOnly = false;
      if (stroke) stroke.draft.raycast(ray, mirrorMesh, hits);
      else if (
        mirrorMesh.geometry.boundsTree ||
        (mirrorMesh.geometry.index?.count ?? mirrorMesh.geometry.getAttribute('position').count) <
          150_000
      )
        acceleratedRaycast.call(mirrorMesh, ray, hits);
      ray.firstHitOnly = true;
      ray.far = Infinity;
      const closest = hits.reduce<Intersection | undefined>(
        (best, entry) =>
          !best || entry.point.distanceToSquared(point) < best.point.distanceToSquared(point)
            ? entry
            : best,
        undefined,
      );
      return closest ? hitFrom(closest, own) : null;
    };
    const tangentAt = (hit: Hit, angle: number) => {
      get().camera.matrixWorld.extractBasis(right, new Vector3(), new Vector3());
      const tangent = right.clone().addScaledVector(hit.normal, -right.dot(hit.normal));
      if (tangent.lengthSq() < 1e-8)
        tangent.crossVectors(
          hit.normal,
          Math.abs(hit.normal.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0),
        );
      return tangent.normalize().applyAxisAngle(hit.normal, angle);
    };
    const reflect = (vector: Vector3, own: Mesh) => {
      const local = vector
        .clone()
        .applyMatrix3(new Matrix3().setFromMatrix4(own.matrixWorld.clone().invert()));
      local.x = -local.x;
      return local.applyMatrix3(new Matrix3().setFromMatrix4(own.matrixWorld));
    };
    const reflectedTangent = (tangent: Vector3, hit: Hit, own: Mesh) => {
      const reflected = reflect(tangent, own);
      reflected.addScaledVector(hit.normal, -reflected.dot(hit.normal));
      return reflected.lengthSq() > 1e-8 ? reflected.normalize() : tangentAt(hit, 0);
    };
    const show = (
      i: number,
      hit: Hit | null,
      radius: number,
      aspect: number,
      tangent?: Vector3,
    ) => {
      const cursor = cursors[i];
      cursor.visible = !!hit && !!tangent && radius > 0;
      if (!hit || !tangent) return;
      cursor.position.copy(hit.point).addScaledVector(hit.normal, radius * 0.006);
      cursor.quaternion.setFromRotationMatrix(
        new Matrix4().makeBasis(
          tangent,
          new Vector3().crossVectors(hit.normal, tangent),
          hit.normal,
        ),
      );
      cursor.scale.set(radius, radius * aspect, radius);
    };
    const displayMask = () => {
      const state = useEditor.getState();
      const sculpt = state.sculpt;
      const own = sculpt && partMeshes.get(sculpt.partId);
      overlay.visible = false;
      if (
        !sculpt ||
        !own ||
        !sculpt.settings.maskVisible ||
        (!sculpt.mask && stroke?.brush !== 'mask') ||
        !visible(own)
      )
        return;
      const source = state.scene.parts.find((part) => part.id === sculpt.partId)?.geometry;
      if (!source) return;
      if (stroke?.draft.geometry.hasAttribute('sculptMask'))
        overlay.geometry = stroke.draft.geometry;
      else if (sculpt.mask) {
        if (idleSource !== source || idleWeights !== sculpt.mask || !idleOverlay) {
          idleOverlay?.dispose();
          idleSource = source;
          idleWeights = sculpt.mask;
          idleOverlay = new BufferGeometry();
          idleOverlay.setAttribute('position', source.getAttribute('position'));
          idleOverlay.setIndex(source.index);
          idleOverlay.setAttribute('sculptMask', new BufferAttribute(sculpt.mask, 1));
        }
        overlay.geometry = idleOverlay;
      } else return;
      overlay.matrix.copy(own.matrixWorld);
      overlay.matrixWorldNeedsUpdate = true;
      overlay.visible = true;
    };
    const refresh = () => {
      const state = useEditor.getState();
      const sculpt = state.sculpt;
      const own = sculpt && partMeshes.get(sculpt.partId);
      if (
        !hover ||
        !sculpt ||
        !own ||
        state.navigationMode ||
        state.temporaryOrbit ||
        state.view.explode
      ) {
        hideCursor();
      } else {
        const settings = stroke?.settings ?? sculpt.settings;
        const radius =
          settings.radius *
          (settings.pressureRadius && stroke ? Math.max(0.08, pressure(hover, settings)) : 1);
        const hit = pick(hover, own);
        const aspect = settings.brush === 'draw' ? settings.aspect : 1;
        const angle = footprint(settings, hover);
        const tangent = hit ? tangentAt(hit, angle) : undefined;
        const twin = hit && settings.symmetry ? mirror(hit, own, radius) : null;
        show(0, hit, radius, aspect, tangent);
        show(
          1,
          twin,
          radius,
          aspect,
          twin && tangent ? reflectedTangent(tangent, twin, own) : undefined,
        );
      }
      displayMask();
      invalidate();
    };
    const detach = (accept: boolean) => {
      const active = stroke;
      if (!active) return;
      stroke = null;
      if (active.controls) active.controls.enabled = active.controlsEnabled;
      if (canvas.hasPointerCapture(active.id)) canvas.releasePointerCapture(active.id);
      if (active.own.geometry === active.draft.geometry) active.own.geometry = active.before;
      overlay.visible = false;
      if (overlay.geometry === active.draft.geometry) overlay.geometry = emptyOverlay;
      if (accept && active.changed) {
        const geometry = active.draft.finish();
        const grew =
          geometry &&
          geometry.getAttribute('position').count !==
            active.target.geometry.getAttribute('position').count;
        const mask =
          active.brush === 'mask' || (grew && active.mask) ? active.draft.getMask() : active.mask;
        const { id: partId, geometry: source, position, quaternion, scale } = active.target;
        if (
          !useEditor.getState().commitSculpt({
            partId,
            source,
            epoch: active.epoch,
            revision: active.revision,
            position,
            quaternion,
            scale,
            geometry,
            mask: mask?.some((value) => value > 0) ? mask : null,
          })
        )
          geometry?.dispose();
      }
      if (accept && active.draft.detailLimited)
        useEditor
          .getState()
          .notify(
            'Sculpt detail reached its limit. You can keep brushing at this density.',
            'info',
          );
      active.draft.geometry.dispose();
      prepare();
      refresh();
    };
    const apply = (active: Stroke, sample: Sample) => {
      const s = active.settings;
      const brush =
        sample.shiftKey && !active.eraser && active.brush !== 'mask' ? 'smooth' : active.brush;
      const hit = brush === 'grab' ? active.first : pick(sample, active.own, true);
      if (!hit) return;
      const p = pressure(sample, s);
      const strength = s.strength * (s.pressureStrength ? p : 1);
      if (!(strength > 0)) return;
      const radius = s.radius * (s.pressureRadius ? Math.max(0.08, p) : 1);
      let angle = footprint(s, sample);
      if (brush === 'crease' && active.applied) {
        const dx = sample.clientX - active.applied.clientX;
        const dy = active.applied.clientY - sample.clientY;
        if (dx || dy) angle = Math.atan2(dy, dx);
      }
      active.applied = sample;
      const tangent = tangentAt(hit, angle);
      const twin =
        brush === 'grab' ? active.grabMirror : s.symmetry ? mirror(hit, active.own, radius) : null;
      let grab: Vector3 | undefined;
      let mirroredGrab: Vector3 | undefined;
      if (active.brush === 'grab') {
        setRay(sample);
        get().camera.getWorldDirection(direction);
        const projection = active.first.point.clone().sub(ray.ray.origin).dot(direction);
        const point = ray.ray.at(projection / ray.ray.direction.dot(direction), new Vector3());
        grab = point.clone().sub(active.grabPoint);
        active.grabPoint.copy(point);
        if (twin) mirroredGrab = reflect(grab, active.own);
      }
      active.changed =
        active.draft.dab({
          ...hit,
          radius,
          strength,
          detail: s.detail,
          minEdge: s.minEdge,
          brush,
          falloff: s.falloff,
          inverted: active.eraser || sample.altKey,
          pinch: s.pinch,
          softenMask: brush === 'mask' && sample.shiftKey,
          grab,
          tangent,
          aspect: brush === 'draw' ? s.aspect : 1,
          mirror: twin
            ? { ...twin, tangent: reflectedTangent(tangent, twin, active.own), grab: mirroredGrab }
            : undefined,
        }) || active.changed;
    };
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const active = stroke;
        if (active) {
          const until = performance.now() + 6;
          do {
            const sample = active.pending.shift();
            if (sample) apply(active, sample);
          } while (active.pending.length && performance.now() < until);
          if (active.pending.length) schedule();
        }
        refresh();
      });
    };
    const queue = (active: Stroke, sample: Sample) => {
      active.pending.push(sample);
      if (active.pending.length > maxQueuedDabs * 2) {
        // Keep both endpoints and evenly thin old dabs when input outruns rendering.
        const pending = active.pending;
        active.pending = Array.from(
          { length: maxQueuedDabs },
          (_, i) => pending[Math.round((i * (pending.length - 1)) / (maxQueuedDabs - 1))],
        );
      }
    };
    const enqueue = (active: Stroke, incoming: Sample, final = false) => {
      const sample = final
        ? incoming
        : interpolate(active.last, incoming, 1 - active.settings.stabilization * 0.85);
      const distance = Math.hypot(
        sample.clientX - active.last.clientX,
        sample.clientY - active.last.clientY,
      );
      const scale = active.settings.pressureRadius
        ? Math.max(0.08, pressure(sample, active.settings))
        : 1;
      const spacing = Math.max(0.5, active.spacing * scale);
      const steps = Math.min(32, Math.floor(distance / spacing));
      if (steps) {
        const interval = Math.max(spacing, distance / 32);
        for (let i = 1; i <= steps; i++)
          queue(active, interpolate(active.last, sample, (interval * i) / distance));
        active.last = active.pending.at(-1)!;
        if (!final || distance - interval * steps <= 0.1) return;
        queue(active, sample);
      } else if (
        final
          ? distance > 0.1
          : distance < 0.1 && Math.abs(sample.pressure - active.last.pressure) > 0.015
      ) {
        queue(active, sample);
      } else return;
      active.last = sample;
    };
    const down = (event: PointerEvent) => {
      const state = useEditor.getState();
      const sculpt = state.sculpt;
      if (stroke) {
        event.stopImmediatePropagation();
        return;
      }
      if (
        !sculpt ||
        sculpt.pending ||
        !event.isPrimary ||
        (event.button !== 0 && !(event.pointerType === 'pen' && event.button === 5)) ||
        event.pointerType === 'touch' ||
        state.navigationMode ||
        state.temporaryOrbit ||
        state.pivotPicking ||
        state.view.explode ||
        state.freeTransform ||
        event.ctrlKey ||
        event.metaKey
      )
        return;
      const target = state.scene.parts.find((part) => part.id === sculpt.partId);
      const own = target && partMeshes.get(target.id);
      if (!target || !own || target.locked || !visible(own)) return;
      const hit = pick(event, own, true);
      if (!hit) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        /* Synthetic pointer events lack native capture. */
      }
      const controls = get().controls as { enabled: boolean } | null;
      const settings = sculpt.settings;
      const camera = get().camera;
      const projected = hit.point.clone().project(camera);
      const radial = tangentAt(hit, 0)
        .multiplyScalar(settings.radius)
        .add(hit.point)
        .project(camera);
      const rect = canvas.getBoundingClientRect();
      const radiusPixels =
        Math.hypot((radial.x - projected.x) * rect.width, (radial.y - projected.y) * rect.height) /
        2;
      const cached =
        warm?.source === target.geometry &&
        warm.mask === sculpt.mask &&
        warm.matrix.equals(own.matrixWorld)
          ? warm.draft
          : null;
      if (cached) warm = null;
      else discardWarm();
      const draft =
        cached ?? new SculptMesh(target.geometry, own.matrixWorld, sculpt.mask ?? undefined);
      const eraser = event.button === 5;
      const brush = settings.brush === 'mask' ? 'mask' : eraser ? 'draw' : settings.brush;
      stroke = {
        id: event.pointerId,
        target,
        mask: sculpt.mask,
        epoch: state.sceneEpoch,
        revision: sculpt.revision,
        own,
        before: own.geometry,
        draft,
        controls,
        controlsEnabled: controls?.enabled ?? false,
        settings,
        brush,
        eraser,
        first: hit,
        grabPoint: hit.point.clone(),
        grabMirror:
          brush === 'grab' && settings.symmetry ? mirror(hit, own, settings.radius) : null,
        applied: null,
        last: event,
        latest: event,
        pending: [event],
        changed: false,
        spacing: Math.max(0.75, radiusPixels * settings.spacing),
      };
      if (controls) controls.enabled = false;
      own.geometry = draft.geometry;
      hover = event;
      schedule();
    };
    const move = (event: PointerEvent) => {
      if (stroke) {
        if (event.pointerId !== stroke.id) return;
        event.stopImmediatePropagation();
        const events = event.getCoalescedEvents?.() ?? [];
        stroke.latest = events.at(-1) ?? event;
        for (const sample of events.length ? events : [event]) enqueue(stroke, sample);
      } else if (!canvas.contains(event.target as Node) || event.pointerType === 'touch') return;
      hover = event;
      schedule();
    };
    const release = (event: PointerEvent) => {
      if (!stroke || event.pointerId !== stroke.id) return;
      event.stopImmediatePropagation();
      const { pressure, pointerType, tiltX, tiltY, twist } = stroke.latest;
      enqueue(
        stroke,
        {
          clientX: event.clientX,
          clientY: event.clientY,
          pressure,
          pointerType,
          tiltX,
          tiltY,
          twist,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
        },
        true,
      );
      suppressClick = true;
      window.clearTimeout(clickTimer);
      clickTimer = window.setTimeout(() => (suppressClick = false), 300);
      for (const sample of stroke.pending) apply(stroke, sample);
      detach(true);
    };
    const cancel = (event: PointerEvent) => {
      if (stroke?.id === event.pointerId) detach(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !stroke) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      detach(false);
    };
    const blur = () => {
      hover = null;
      detach(false);
      refresh();
    };
    const leave = () => {
      if (!stroke) {
        hover = null;
        schedule();
      }
    };
    const click = (event: MouseEvent) => {
      if (!suppressClick) return;
      suppressClick = false;
      event.stopImmediatePropagation();
    };
    const unsubscribe = useEditor.subscribe((state) => {
      if (
        stroke &&
        (state.sculpt?.partId !== stroke.target.id ||
          state.sculpt.revision !== stroke.revision ||
          state.sceneEpoch !== stroke.epoch ||
          state.navigationMode ||
          state.temporaryOrbit ||
          state.view.explode ||
          state.scene.parts.find((part) => part.id === stroke?.target.id) !== stroke.target)
      )
        detach(false);
      prepare();
      schedule();
    });
    prepare();
    canvas.addEventListener('pointerdown', down, true);
    canvas.addEventListener('lostpointercapture', cancel);
    canvas.addEventListener('pointerleave', leave);
    canvas.addEventListener('click', click, true);
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', cancel, true);
    window.addEventListener('keydown', escape, true);
    window.addEventListener('blur', blur);
    return () => {
      unsubscribe();
      canvas.removeEventListener('pointerdown', down, true);
      canvas.removeEventListener('lostpointercapture', cancel);
      canvas.removeEventListener('pointerleave', leave);
      canvas.removeEventListener('click', click, true);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('blur', blur);
      cancelAnimationFrame(frame);
      window.clearTimeout(clickTimer);
      hover = null;
      detach(false);
      window.clearTimeout(warmTimer);
      discardWarm();
      clearSculptIncidence();
      scene.remove(...cursors, overlay);
      cursorShape.dispose();
      cursorPaint.dispose();
      idleOverlay?.dispose();
      emptyOverlay.dispose();
      emptyMirror.dispose();
      maskPaint.dispose();
      mirrorMaterial.dispose();
    };
  }, [get, invalidate]);
  return null;
}
