import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  Layers,
  Mesh,
  MeshDepthMaterial,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  Sphere,
  UniformsUtils,
  Vector3,
  WebGLRenderTarget,
} from 'three';
import type { DirectionalLight, Group, OrthographicCamera, PointLight } from 'three';
import { HorizontalBlurShader } from 'three/addons/shaders/HorizontalBlurShader.js';
import { VerticalBlurShader } from 'three/addons/shaders/VerticalBlurShader.js';
import { sceneBounds, triangleCount, vec } from '../core/geometry';
import { sceneLighting, useEditor } from '../core/store';
import { useXR } from '../core/xr-session';
import { useDisplayPerformance } from '../core/display-performance';
import type { Part, SceneLight } from '../core/types';

export interface SceneFrame {
  center: Vector3;
  radius: number;
}

/** The bounding sphere of the visible parts, which lights aim at and fit their shadows to. */
export function sceneFrame(parts: Part[]): SceneFrame {
  const sphere = sceneBounds(parts).getBoundingSphere(new Sphere());
  return { center: sphere.center, radius: Math.max(sphere.radius, 1e-3) };
}

export function useSceneFrame() {
  const parts = useEditor((s) => s.scene.parts);
  return useMemo(() => sceneFrame(parts), [parts]);
}

/** Editor overlays drawn only by the view camera, so ground shadows leave them out. */
export const overlayLayer = 1;
export const overlayLayers = new Layers();
overlayLayers.set(overlayLayer);

// In scene radii. Directional lights sit inside their shadow camera's depth range, and on the
// sample scene the shadow texels and the 0.2 mm bias match the editor's original fixed rig.
const lightDistance = 3;
const shadowExtent = 1.45;
const shadowNear = 1;
const shadowFar = 5;
const shadowBias = -0.00066;

// A headset draws the scene twice each frame and has a phone's graphics, so past this many
// triangles it goes without the extra pass that shadows need.
const headsetShadowTriangles = 300_000;

const scratch = new Vector3();
const turned = new Quaternion();

function DirectionalSceneLight({
  light,
  frame,
  shadow,
}: {
  light: SceneLight;
  frame: SceneFrame;
  shadow: boolean;
}) {
  const ref = useRef<DirectionalLight>(null);
  const invalidate = useThree((s) => s.invalidate);
  const position = useMemo(
    () =>
      light.camera
        ? undefined
        : vec(light.position)
            .normalize()
            .multiplyScalar(lightDistance * frame.radius)
            .add(frame.center),
    [light.camera, light.position, frame],
  );
  useLayoutEffect(() => {
    const current = ref.current;
    if (!current) return;
    current.target.position.copy(frame.center);
    current.target.updateMatrixWorld();
    const camera = current.shadow.camera;
    camera.left = camera.bottom = -shadowExtent * frame.radius;
    camera.right = camera.top = shadowExtent * frame.radius;
    camera.near = shadowNear * frame.radius;
    camera.far = shadowFar * frame.radius;
    camera.updateProjectionMatrix();
    invalidate();
  }, [frame, invalidate]);
  // A camera-attached light only moves in frames, so any change to it needs one.
  useLayoutEffect(() => {
    invalidate();
  }, [light, invalidate]);
  useFrame(({ camera }) => {
    if (!light.camera || !ref.current) return;
    // In a headset the camera sits in the room, which is itself turned within the scene.
    scratch
      .fromArray(light.position)
      .normalize()
      .applyQuaternion(camera.getWorldQuaternion(turned));
    ref.current.position.copy(frame.center).addScaledVector(scratch, lightDistance * frame.radius);
  });
  return (
    <directionalLight
      ref={ref}
      position={position}
      color={light.color}
      intensity={light.intensity}
      castShadow={shadow}
      shadow-mapSize={[2048, 2048]}
      shadow-bias={shadowBias}
    />
  );
}

function PointSceneLight({ light }: { light: SceneLight }) {
  const ref = useRef<PointLight>(null);
  const invalidate = useThree((s) => s.invalidate);
  useLayoutEffect(() => {
    invalidate();
  }, [light, invalidate]);
  useFrame(({ camera }) => {
    if (!ref.current) return;
    // The shader measures range from the camera, which a headset places in a room of meters.
    ref.current.distance = light.range / camera.getWorldScale(scratch).x;
    if (!light.camera) return;
    camera.updateMatrixWorld();
    // Not the camera's matrix, which in a headset also carries the scale of the room.
    ref.current.position
      .fromArray(light.position)
      .applyQuaternion(camera.getWorldQuaternion(turned))
      .add(camera.getWorldPosition(scratch));
  });
  return (
    <pointLight
      ref={ref}
      position={light.camera ? undefined : light.position}
      color={light.color}
      intensity={light.intensity}
      distance={light.range}
      decay={0}
    />
  );
}

function Lights({ frame, shadows }: { frame: SceneFrame; shadows: boolean }) {
  const lighting = useEditor(sceneLighting);
  const gl = useThree((s) => s.gl),
    invalidate = useThree((s) => s.invalidate);
  useLayoutEffect(() => {
    gl.toneMappingExposure = lighting.exposure;
    invalidate();
  }, [gl, lighting.exposure, invalidate]);
  return (
    <>
      <ambientLight intensity={lighting.ambient} />
      <hemisphereLight
        color={lighting.sky}
        groundColor={lighting.ground}
        intensity={lighting.hemisphere}
      />
      {lighting.lights.map((light) =>
        !light.enabled ? null : light.kind === 'directional' ? (
          <DirectionalSceneLight
            key={`${light.id}:directional`}
            light={light}
            frame={frame}
            shadow={shadows && light.castShadow && !light.camera}
          />
        ) : (
          <PointSceneLight key={`${light.id}:point`} light={light} />
        ),
      )}
    </>
  );
}

const blurMaterial = (shader: typeof HorizontalBlurShader | typeof VerticalBlurShader) => {
  const material = new ShaderMaterial({
    ...shader,
    uniforms: UniformsUtils.clone(shader.uniforms),
  });
  material.depthTest = false;
  return material;
};

/**
 * drei's ContactShadows, blurred where it is rather than at the origin, and freed when replaced,
 * so it can follow the scene anywhere and at any size.
 */
function ContactShadow({
  position: [x, y, z],
  size,
  far,
  opacity,
  blur,
}: {
  position: [number, number, number];
  size: number;
  far: number;
  opacity: number;
  blur: number;
}) {
  const gl = useThree((s) => s.gl),
    scene = useThree((s) => s.scene),
    invalidate = useThree((s) => s.invalidate);
  const group = useRef<Group>(null),
    camera = useRef<OrthographicCamera>(null),
    pending = useRef(true);
  const kit = useMemo(() => {
    const target = new WebGLRenderTarget(256, 256),
      blurred = new WebGLRenderTarget(256, 256);
    target.texture.generateMipmaps = blurred.texture.generateMipmaps = false;
    const plane = new PlaneGeometry(size, size).rotateX(Math.PI / 2);
    const depth = new MeshDepthMaterial();
    depth.depthTest = depth.depthWrite = false;
    depth.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        'vec4( vec3( 1.0 - fragCoordZ ), opacity );',
        'vec4( vec3( 0.0 ), 1.0 - fragCoordZ );',
      );
    };
    return {
      target,
      blurred,
      plane,
      depth,
      horizontal: blurMaterial(HorizontalBlurShader),
      vertical: blurMaterial(VerticalBlurShader),
      blurPlane: new Mesh(plane),
    };
  }, [size]);
  useEffect(
    () => () => {
      for (const resource of [
        kit.target,
        kit.blurred,
        kit.plane,
        kit.depth,
        kit.horizontal,
        kit.vertical,
      ])
        resource.dispose();
    },
    [kit],
  );
  // Drawn once after each render, which happens whenever the parts change.
  useLayoutEffect(() => {
    pending.current = true;
    invalidate();
  });
  const blurPass = (amount: number) => {
    const { blurPlane, horizontal, vertical } = kit;
    horizontal.uniforms.tDiffuse.value = kit.target.texture;
    horizontal.uniforms.h.value = amount / 256;
    blurPlane.material = horizontal;
    gl.setRenderTarget(kit.blurred);
    gl.render(blurPlane, camera.current!);
    vertical.uniforms.tDiffuse.value = kit.blurred.texture;
    vertical.uniforms.v.value = amount / 256;
    blurPlane.material = vertical;
    gl.setRenderTarget(kit.target);
    gl.render(blurPlane, camera.current!);
  };
  useFrame(() => {
    if (!pending.current || !camera.current || !group.current) return;
    pending.current = false;
    const background = scene.background,
      override = scene.overrideMaterial;
    group.current.visible = false;
    scene.background = null;
    scene.overrideMaterial = kit.depth;
    gl.setRenderTarget(kit.target);
    gl.render(scene, camera.current);
    // The blur passes draw a plane filling the shadow camera's view, so it goes where the camera is.
    kit.blurPlane.position.set(x, y + far / 2, z);
    blurPass(blur);
    blurPass(blur * 0.4);
    gl.setRenderTarget(null);
    group.current.visible = true;
    scene.overrideMaterial = override;
    scene.background = background;
  });
  return (
    <group ref={group} position={[x, y, z]} rotation-x={Math.PI / 2}>
      <mesh geometry={kit.plane} scale={[1, -1, 1]} rotation={[-Math.PI / 2, 0, 0]}>
        <meshBasicMaterial
          transparent
          map={kit.target.texture}
          opacity={opacity}
          depthWrite={false}
        />
      </mesh>
      <orthographicCamera ref={camera} args={[-size / 2, size / 2, size / 2, -size / 2, 0, far]} />
    </group>
  );
}

// Ground shadows keep their look on scenes near the sample's size (radius 76 mm) and step by
// powers of two for much larger or smaller ones, so ordinary edits never resize them.
const groundReference = 80;

function GroundShadow({ frame }: { frame: SceneFrame }) {
  const step = 2 ** Math.round(Math.log2(frame.radius / groundReference));
  const size = 300 * step,
    cell = size / 4;
  return (
    <ContactShadow
      position={[
        Math.round(frame.center.x / cell) * cell,
        // Just under the grid, or just under the parts of a tiny scene.
        -0.1 * Math.min(step, 1),
        Math.round(frame.center.z / cell) * cell,
      ]}
      size={size}
      far={160 * step}
      opacity={0.48}
      blur={2.5}
    />
  );
}

/**
 * The scene's own lighting, or the user's default. Ground shadows render once each time
 * this re-renders with the scene, and not when only the lights change.
 */
export function SceneLighting() {
  const shadows = useEditor((s) => sceneLighting(s).shadows);
  const moving = useDisplayPerformance((s) => s.moving);
  const headset = useXR((s) => !!s.session);
  const sparse = useEditor(
    (s) =>
      s.scene.parts.reduce(
        (total, part) => total + (part.visible ? triangleCount(part.geometry) : 0),
        0,
      ) <= headsetShadowTriangles,
  );
  const frame = useSceneFrame();
  const drawShadows = shadows && (sparse || (!headset && !moving));
  return (
    <>
      <Lights frame={frame} shadows={drawShadows} />
      {/* The ground shadow is drawn to a texture with its own camera, which a headset replaces. */}
      {drawShadows && !headset ? <GroundShadow frame={frame} /> : null}
    </>
  );
}
