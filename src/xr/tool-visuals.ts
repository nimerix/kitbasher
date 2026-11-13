import {
  BufferGeometry,
  DoubleSide,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  SphereGeometry,
  Vector3,
} from 'three';
import { worldNormal, worldPoint } from '../core/geometry';
import { partDisplay } from '../core/alignment-visibility';
import { useEditor } from '../core/store';
import type { SurfacePoint } from '../core/types';

type Editor = ReturnType<typeof useEditor.getState>;

/** Real scene geometry stays visible in stereo where DOM annotations cannot be shown. */
export class ToolVisuals {
  readonly object = new Group();
  private readonly sphere = new SphereGeometry(1, 12, 8);
  private readonly source = new MeshBasicMaterial({
    color: '#ffb876',
    depthTest: false,
    depthWrite: false,
  });
  private readonly target = new MeshBasicMaterial({
    color: '#8fb8ff',
    depthTest: false,
    depthWrite: false,
  });
  private readonly markers: Mesh[] = [];
  private readonly lines = new LineSegments(
    new BufferGeometry(),
    new LineBasicMaterial({
      color: '#d8dce3',
      transparent: true,
      opacity: 0.7,
      depthTest: false,
      depthWrite: false,
    }),
  );
  private readonly brush = new Mesh(
    new RingGeometry(0.97, 1, 64),
    new MeshBasicMaterial({
      color: '#ffb876',
      side: DoubleSide,
      depthTest: false,
      depthWrite: false,
    }),
  );
  private parts: Editor['scene']['parts'] | null = null;
  private operation: Editor['operation'] | null = null;
  private measurement: Editor['measurement'] | null = null;
  private tool: Editor['tool'] | null = null;
  private isolated: Editor['isolated'] = null;
  private nearby: Editor['nearbyParts'] = null;
  private activeAnchor: string | null = null;

  constructor() {
    this.object.add(this.lines, this.brush);
    this.object.renderOrder = this.lines.renderOrder = this.brush.renderOrder = 25;
    this.brush.visible = false;
  }

  update(state: Editor, roomScale: number, hit?: SurfacePoint) {
    const shown = (id: string) => {
      const part = state.scene.parts.find((part) => part.id === id);
      return part?.visible && partDisplay(state, id) !== 'hidden' ? part : null;
    };
    this.object.visible = !state.view.explode;
    if (
      this.parts !== state.scene.parts ||
      this.operation !== state.operation ||
      this.measurement !== state.measurement ||
      this.tool !== state.tool ||
      this.isolated !== state.isolated ||
      this.nearby !== state.nearbyParts ||
      this.activeAnchor !== state.activeAnchor
    ) {
      this.parts = state.scene.parts;
      this.operation = state.operation;
      this.measurement = state.measurement;
      this.tool = state.tool;
      this.isolated = state.isolated;
      this.nearby = state.nearbyParts;
      this.activeAnchor = state.activeAnchor;
      const points: { position: Vector3; target: boolean }[] = [];
      const edges: Vector3[] = [];
      const add = (point: SurfacePoint, target = false) => {
        const part = shown(point.partId);
        if (!part) return null;
        const position = worldPoint(part, point);
        points.push({ position, target });
        return position;
      };
      if (state.tool === 'align' || state.tool === 'joint') {
        for (const pair of state.operation.pairs) {
          const a = add(pair.source),
            b = add(pair.target, true);
          if (a && b) edges.push(a, b);
        }
        if (state.operation.pending) add(state.operation.pending);
      } else if (state.tool === 'measure') {
        const positions = state.measurement.map((point, i) => add(point, !!i));
        if (positions[0] && positions[1]) edges.push(positions[0], positions[1]);
      } else if (state.tool === 'anchors') {
        for (const part of state.scene.parts) {
          if (!shown(part.id)) continue;
          for (const anchor of part.anchors ?? []) {
            const position = worldPoint(part, {
              partId: part.id,
              point: anchor.point,
              normal: [0, 1, 0],
            });
            const target = new Vector3(...anchor.target);
            points.push({ position, target: false }, { position: target, target: true });
            edges.push(position, target);
          }
        }
      }
      while (this.markers.length < points.length) {
        const marker = new Mesh(this.sphere, this.source);
        marker.renderOrder = 26;
        this.object.add(marker);
        this.markers.push(marker);
      }
      this.markers.forEach((marker, index) => {
        const point = points[index];
        marker.visible = !!point;
        if (point) {
          marker.position.copy(point.position);
          marker.material = point.target ? this.target : this.source;
        }
      });
      // Geometry changes only when picks or their parts change, not once per headset frame.
      this.lines.geometry.dispose();
      this.lines.geometry = new BufferGeometry().setFromPoints(edges);
      this.lines.visible = !!edges.length;
    }
    for (const marker of this.markers) marker.scale.setScalar(roomScale * 0.0025);
    const part = hit && shown(hit.partId);
    this.brush.visible =
      !!part &&
      state.tool === 'align' &&
      state.operation.mode === 'surface' &&
      !!state.operation.activeSurface;
    if (this.brush.visible && hit && part) {
      const normal = worldNormal(part, hit);
      this.brush.position.copy(worldPoint(part, hit)).addScaledVector(normal, 0.0001 * roomScale);
      this.brush.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), normal);
      this.brush.scale.setScalar(state.brushRadius);
      this.brush.material.color.set(state.brushErase ? '#f18c8c' : '#ffb876');
    }
  }

  dispose() {
    this.sphere.dispose();
    this.source.dispose();
    this.target.dispose();
    this.lines.geometry.dispose();
    this.lines.material.dispose();
    this.brush.geometry.dispose();
    this.brush.material.dispose();
  }
}
