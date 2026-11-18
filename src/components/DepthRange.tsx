import { useLayoutEffect } from 'react';
import { useThree } from '@react-three/fiber';
import {
  Box3,
  Frustum,
  Line3,
  Matrix4,
  Vector3,
  type BufferGeometry,
  type Camera,
  type Material,
  type Object3D,
  type PerspectiveCamera,
  type Scene,
  type WebGLRenderer,
} from 'three';

/**
 * How the perspective camera's depth range is fitted to what it sees. The near plane goes as far
 * out as half the nearest visible thing's view depth allows, in powers of two so it changes
 * rarely, and never closer than `near`: depth precision depends on it. The far plane holds the
 * furthest thing with room to spare.
 */
export const depthRange = { near: 0.1, far: 50_000, share: 0.5 };

/** Set on an object's `userData.depthRange`: 'ground' for a plane drawn out to `groundReach`. */
export const groundReach = 450;

const eye = new Vector3(),
  box = new Box3(),
  corner = new Vector3(),
  frustum = new Frustum(),
  matrix = new Matrix4(),
  segment = new Line3(),
  closest = new Vector3();

const shows = (material: Material | Material[]) =>
  Array.isArray(material) ? material.some((m) => m.visible) : material.visible;

/** Nearest and furthest view distances of what the camera sees, from the eye. */
function reach(scene: Scene, camera: PerspectiveCamera) {
  camera.getWorldPosition(eye);
  matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(matrix);
  // Only the four sides: the near and far planes are what is being chosen.
  const sides = frustum.planes.slice(0, 4);
  let nearest = Infinity,
    furthest = 0;
  const take = (low: number, high: number) => {
    nearest = Math.min(nearest, low);
    furthest = Math.max(furthest, high);
  };
  scene.traverseVisible((object: Object3D) => {
    const drawn = object as Object3D & {
      geometry?: BufferGeometry;
      material?: Material | Material[];
      isMesh?: boolean;
      isLine?: boolean;
      isPoints?: boolean;
    };
    if (!(drawn.isMesh || drawn.isLine || drawn.isPoints) || !drawn.geometry || !drawn.material)
      return;
    if (!shows(drawn.material)) return;
    if (object.userData.depthRange === 'ground') {
      const height = Math.abs(eye.y - object.matrixWorld.elements[13]);
      take(height, Math.hypot(height, groundReach));
      return;
    }
    const geometry = drawn.geometry;
    const position = geometry.getAttribute('position');
    // A gizmo's guide line can run far past the camera, so a short line is measured exactly.
    if (drawn.isLine && position && !geometry.index && position.count <= 8) {
      for (let i = 0; i + 1 < position.count; i++) {
        segment.start.fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld);
        segment.end.fromBufferAttribute(position, i + 1).applyMatrix4(object.matrixWorld);
        segment.closestPointToPoint(eye, true, closest);
        take(
          closest.distanceTo(eye),
          Math.max(segment.start.distanceTo(eye), segment.end.distanceTo(eye)),
        );
      }
      return;
    }
    // A box in the world around the object: flat for a flat one, such as a shadow's ground.
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    if (!geometry.boundingBox || geometry.boundingBox.isEmpty()) return;
    box.copy(geometry.boundingBox).applyMatrix4(object.matrixWorld);
    if (![box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z].every(Number.isFinite))
      return take(0, Infinity);
    for (const side of sides) {
      corner.set(
        side.normal.x > 0 ? box.max.x : box.min.x,
        side.normal.y > 0 ? box.max.y : box.min.y,
        side.normal.z > 0 ? box.max.z : box.min.z,
      );
      if (side.distanceToPoint(corner) < 0) return;
    }
    let furthest = 0;
    for (let i = 0; i < 8; i++) {
      corner.set(
        i & 1 ? box.max.x : box.min.x,
        i & 2 ? box.max.y : box.min.y,
        i & 4 ? box.max.z : box.min.z,
      );
      furthest = Math.max(furthest, corner.distanceTo(eye));
    }
    take(box.distanceToPoint(eye), furthest);
  });
  return { nearest, furthest };
}

const step = (value: number, round: (x: number) => number) => 2 ** round(Math.log2(value));

/** Fits a perspective camera's near and far planes to what it sees. Returns whether they moved. */
export function fitDepthRange(scene: Scene, camera: PerspectiveCamera) {
  const { nearest, furthest } = reach(scene, camera);
  let near = depthRange.near,
    far = depthRange.far;
  if (nearest < Infinity) {
    // Within the view, a point's depth along the axis is at least its distance times the cosine
    // of the widest angle off it.
    const p = camera.projectionMatrix.elements;
    const across = (1 + Math.abs(p[8])) / p[0],
      up = (1 + Math.abs(p[9])) / p[5];
    const cosine = 1 / Math.hypot(1, across, up);
    const reach = depthRange.share * cosine * nearest;
    near = reach > depthRange.near ? step(reach, Math.floor) : depthRange.near;
    near = Math.max(depthRange.near, near);
    far = Number.isFinite(furthest)
      ? Math.max(near * 4, step(furthest * 1.1 + 1, Math.ceil))
      : depthRange.far;
  }
  if (camera.near === near && camera.far === far) return false;
  camera.near = near;
  camera.far = far;
  camera.updateProjectionMatrix();
  return true;
}

/**
 * Keeps the viewport's perspective camera's depth range fitted to the scene before each render.
 * A headset session draws with its own cameras and is left alone.
 */
export function DepthRange() {
  const scene = useThree((s) => s.scene),
    get = useThree((s) => s.get);
  useLayoutEffect(() => {
    const previous = scene.onBeforeRender;
    scene.onBeforeRender = function (
      this: Scene,
      renderer: WebGLRenderer,
      drawn: Scene,
      camera: Camera,
      ...rest: unknown[]
    ) {
      (previous as (...args: unknown[]) => void).call(this, renderer, drawn, camera, ...rest);
      const viewport = get().camera;
      if (camera === viewport && (camera as PerspectiveCamera).isPerspectiveCamera)
        if (!renderer.xr.isPresenting) fitDepthRange(drawn, camera as PerspectiveCamera);
    };
    return () => {
      scene.onBeforeRender = previous;
    };
  }, [scene, get]);
  return null;
}
