import { describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  Euler,
  OrthographicCamera,
  PerspectiveCamera,
  Quaternion,
  Vector3,
} from 'three';
import {
  displayedPosition,
  selectionOrbitCenter,
  setOrbitCenter,
  stepCamera,
} from '../../src/core/navigation';
import type { Part } from '../../src/core/types';

function scan(id: string, position: Part['position']): Part {
  const geometry = new BoxGeometry(10, 20, 30);
  geometry.translate(140, -80, 50);
  return {
    id,
    name: id,
    geometry,
    position,
    quaternion: new Quaternion().setFromEuler(new Euler(0, Math.PI / 2, 0)).toArray(),
    scale: [2, 1, 3],
    color: '#fff',
    visible: true,
    locked: false,
    source: 'scan',
  };
}

const close = (a: Vector3, b: Vector3) => expect(a.distanceTo(b)).toBeLessThan(1e-7);

describe('camera navigation', () => {
  it('uses visible transformed scan bounds for one or several selected parts', () => {
    const a = scan('a', [20, 50, 10]);
    const b = scan('b', [-40, 0, 20]);
    const hidden = { ...scan('hidden', [5000, 5000, 5000]), visible: false };
    const centerA = new Vector3(140, -80, 50)
      .multiply(new Vector3(...a.scale))
      .applyQuaternion(new Quaternion(...a.quaternion))
      .add(new Vector3(...a.position));
    const centerB = new Vector3(140, -80, 50)
      .multiply(new Vector3(...b.scale))
      .applyQuaternion(new Quaternion(...b.quaternion))
      .add(new Vector3(...b.position));
    close(selectionOrbitCenter([a, b, hidden], ['a', 'hidden'])!, centerA);
    close(
      selectionOrbitCenter([a, b, hidden], ['a', 'b', 'hidden'])!,
      centerA.clone().add(centerB).multiplyScalar(0.5),
    );
    expect(selectionOrbitCenter([a, hidden], ['missing', 'hidden'])).toBeNull();
    close(
      selectionOrbitCenter([a], ['a'], 60)!,
      centerA.add(new Vector3(...displayedPosition(a, 60)).sub(new Vector3(...a.position))),
    );
  });

  for (const projection of ['perspective', 'orthographic'] as const) {
    const createCamera = () =>
      projection === 'perspective'
        ? new PerspectiveCamera(35, 1.5, 0.1, 5000)
        : new OrthographicCamera(-120, 120, 80, -80, 0.1, 5000);
    it(`centers the ${projection} pivot without changing zoom, distance, or direction`, () => {
      const camera = createCamera();
      const target = new Vector3(0, 30, 0);
      camera.position.set(110, 100, 220);
      camera.zoom = 2.5;
      camera.lookAt(target);
      const rotation = camera.quaternion.clone();
      const distance = camera.position.distanceTo(target);
      const selection = new Vector3(250, -15, 80);
      setOrbitCenter(camera, target, selection);
      close(target, selection);
      expect(camera.position.distanceTo(target)).toBeCloseTo(distance, 8);
      expect(camera.quaternion.angleTo(rotation)).toBeLessThan(1e-7);
      expect(camera.zoom).toBe(2.5);
      const screen = target.clone().project(camera);
      expect(screen.x).toBeCloseTo(0, 8);
      expect(screen.y).toBeCloseTo(0, 8);
    });

    it(`orbits the ${projection} view around its pivot without moving that pivot`, () => {
      const camera = createCamera();
      const target = new Vector3(100, 50, -75);
      camera.position.copy(target).add(new Vector3(120, 100, 240));
      camera.lookAt(target);
      const before = camera.position.clone();
      const distance = camera.position.distanceTo(target);
      stepCamera(camera, target, { mode: 'orbit', direction: 'right' });
      expect(camera.position.distanceTo(before)).toBeGreaterThan(10);
      expect(camera.position.distanceTo(target)).toBeCloseTo(distance, 8);
      close(target, new Vector3(100, 50, -75));
      const projected = target.clone().project(camera);
      expect(projected.x).toBeCloseTo(0, 8);
      expect(projected.y).toBeCloseTo(0, 8);
      for (let i = 0; i < 40; i++) stepCamera(camera, target, { mode: 'orbit', direction: 'up' });
      expect(camera.position.toArray().every(Number.isFinite)).toBe(true);
      expect(camera.position.distanceTo(target)).toBeCloseTo(distance, 7);
    });

    it(`preserves a panned ${projection} view while orbiting a separate selected pivot`, () => {
      const camera = createCamera();
      const target = new Vector3(70, 90, -30);
      const pivot = new Vector3(5, 40, 10);
      camera.position.set(200, 150, 300);
      camera.lookAt(target);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();
      const projected = pivot.clone().project(camera);
      const distance = camera.position.distanceTo(pivot);
      const offset = target.distanceTo(pivot);
      const zoom = camera.zoom;
      for (const direction of ['right', 'up', 'left', 'down'] as const) {
        stepCamera(camera, target, { mode: 'orbit', direction }, pivot);
        close(pivot.clone().project(camera), projected);
        expect(camera.position.distanceTo(pivot)).toBeCloseTo(distance, 7);
        expect(target.distanceTo(pivot)).toBeCloseTo(offset, 7);
        expect(camera.zoom).toBe(zoom);
      }
    });

    it(`pans the ${projection} camera and pivot together without rotating or zooming`, () => {
      const camera = createCamera();
      const target = new Vector3(0, 30, 0);
      camera.position.set(110, 100, 220);
      camera.lookAt(target);
      const before = camera.position.clone();
      const pivotBefore = target.clone();
      const rotation = camera.quaternion.clone();
      const zoom = camera.zoom;
      stepCamera(camera, target, { mode: 'pan', direction: 'right' });
      close(camera.position.clone().sub(before), target.clone().sub(pivotBefore));
      expect(target.distanceTo(pivotBefore)).toBeGreaterThan(1);
      expect(camera.quaternion.angleTo(rotation)).toBeLessThan(1e-7);
      expect(camera.zoom).toBe(zoom);
    });
  }
});
