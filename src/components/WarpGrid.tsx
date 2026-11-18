import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  BufferAttribute,
  BufferGeometry,
  CustomBlending,
  DataTexture,
  DoubleSide,
  Float32BufferAttribute,
  FloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  MaxEquation,
  Mesh,
  Object3D,
  OneFactor,
  OneMinusSrcAlphaFactor,
  RGBAFormat,
  ShaderMaterial,
  Vector2,
  Vector3,
  type Camera,
} from 'three';
import { useEditor, type WarpSession } from '../core/store';
import { writtenNodePositions } from '../core/warp-evaluate';
import type { WarpModel } from '../core/warp-model';
import {
  traceWarpGridPath,
  typicalLength,
  warpGridChords,
  warpGridLevels,
  warpGridShiftWidth,
  WarpGridDrawing,
  type WarpGridPath,
} from '../core/warp-grid-path';

const noRaycast: Mesh['raycast'] = () => {};

/** World position of each grid node, as the grid is drawn. */
const blended = new WeakMap<WarpModel, Float64Array>();
export function gridNodePositions(warp: WarpSession) {
  const model = warp.model!,
    state = warp.state!;
  if (!model.blend) return state.positions;
  let out = blended.get(model);
  if (!out) blended.set(model, (out = new Float64Array(state.positions.length)));
  return writtenNodePositions(model, state, out);
}

/**
 * How grid lines are drawn, in CSS pixels against the cell's length on screen. The dark core is
 * what makes the grid stand out: full width and opaque down to `coreFull`, then thinner to
 * `coreThin` px and fading out to `coreGone`, by cells shrunk as the surface turns away. The
 * light casing lifts only what is darker than it, so it shows on dark parts and leaves light ones
 * alone, and fades out from `casingFull` to `casingGone`.
 */
export const warpGridStyle = {
  core: '#0e1114',
  coreWidth: 1.5,
  coreThin: 1,
  coreFull: 13,
  coreGone: 6,
  casing: '#b0b5b8',
  casingWidth: 4,
  casingFull: 22,
  casingGone: 12,
  /**
   * Coarser nets of the grid's own edges, for when its cells are too small to show: each comes in
   * over an octave of its own cells, from `coarseGone` to `coarseFull` px, as the net below it
   * goes over the same octave of its cells.
   */
  coarseFull: 20,
  coarseGone: 10,
  /** The same for their casing, which shows only on dark parts: about a default grid's cells. */
  coarseCasingFull: 48,
  coarseCasingGone: 24,
  /** How far a line may sit behind the surface and still show: pixels, and at most mm. */
  tolerance: 1,
  toleranceMax: 0.05,
};

const style = warpGridStyle;
const glsl = (value: number) => (Number.isInteger(value) ? `${value}.0` : `${value}`);

const vertexShader = `
uniform vec2 resolution;
uniform float cell;
uniform bool shifted;
uniform highp sampler2D shifts;
attribute float instanceCell;
attribute vec3 instanceStart;
attribute vec3 instanceEnd;
attribute vec4 instanceWeights;
attribute vec3 instanceNormalStart;
attribute vec3 instanceNormalEnd;
varying float vAcross;
varying float vHalf;
varying float vAlpha;
#ifdef GRID_ID
flat varying float vId;
#endif

vec3 shiftOf( float node ) {
  int i = int( node + 0.5 );
  return texelFetch( shifts, ivec2( i % ${warpGridShiftWidth}, i / ${warpGridShiftWidth} ), 0 ).xyz;
}

// How far a net has come in, by cells of so many px in the grid's own: the grid itself from
// own.x to own.y px, a coarser net by its own cells from coarse.x to coarse.y.
float fadeIn( float level, float pixels, vec2 own, vec2 coarse ) {
  vec2 range = level < 0.5 ? own : coarse;
  return clamp( ( pixels * exp2( level ) - range.x ) / ( range.y - range.x ), 0.0, 1.0 );
}

// How strongly this edge shows as part of the coarser nets it is in, each of which comes in as
// the one below it goes, or, when late, only as the grid's own is nearly gone.
float coarseStrength( float pixels, vec2 own, vec2 coarse, bool late ) {
  float strength = 0.0;
  for ( int level = 1; level <= 3; level++ ) {
    if ( exp2( float( level ) ) > instanceCell + 0.5 ) break;
    float below = 1.0 - fadeIn( float( level - 1 ), pixels, own, coarse );
    if ( late && level == 1 ) below *= below;
    strength = max( strength, min( below, fadeIn( float( level ), pixels, own, coarse ) ) );
  }
  return strength;
}

// As three's LineMaterial: a segment crossing the camera plane ends at the near plane.
void trimSegment( const in vec4 start, inout vec4 end ) {
  float nearEstimate = - 0.5 * projectionMatrix[ 3 ][ 2 ] / projectionMatrix[ 2 ][ 2 ];
  float alpha = ( nearEstimate - start.z ) / ( end.z - start.z );
  end.xyz = mix( start.xyz, end.xyz, alpha );
}

void main() {
  bool atEnd = position.y > 0.5;
  vec3 shiftA = vec3( 0.0 ), shiftB = vec3( 0.0 );
  if ( shifted ) {
    shiftA = shiftOf( instanceWeights.x );
    shiftB = shiftOf( instanceWeights.y );
  }
  vec4 start = modelViewMatrix * vec4( instanceStart + mix( shiftA, shiftB, instanceWeights.z ), 1.0 );
  vec4 end = modelViewMatrix * vec4( instanceEnd + mix( shiftA, shiftB, instanceWeights.w ), 1.0 );
  bool perspective = projectionMatrix[ 2 ][ 3 ] == - 1.0;
  if ( perspective ) {
    if ( start.z < 0.0 && end.z >= 0.0 ) trimSegment( start, end );
    else if ( end.z < 0.0 && start.z >= 0.0 ) trimSegment( end, start );
  }
  vec4 clipStart = projectionMatrix * start, clipEnd = projectionMatrix * end;
  vec2 along = ( clipEnd.xy / clipEnd.w - clipStart.xy / clipStart.w ) * resolution;
  float span = length( along );
  along = span > 1e-6 ? along / span : vec2( 1.0, 0.0 );
  vec2 across = vec2( - along.y, along.x );

  vec3 centre = atEnd ? end.xyz : start.xyz;
  vec4 clip = atEnd ? clipEnd : clipStart;
  float depth = perspective ? - centre.z : 1.0;
  vec3 normal = normalMatrix * ( atEnd ? instanceNormalEnd : instanceNormalStart );
  // The size of a CSS pixel at the line, and of a cell on screen, squeezed where the surface
  // turns away.
  float pixel = 2.0 * depth / ( projectionMatrix[ 1 ][ 1 ] * resolution.y );
  float facing = 1.0;
  if ( dot( normal, normal ) > 1e-12 )
    facing = abs( dot( normalize( normal ), perspective ? normalize( - centre ) : vec3( 0.0, 0.0, 1.0 ) ) );
  float cellPixels = cell / pixel * max( facing, 0.04 );
  float openPixels = cell / pixel;
  // An edge of a coarser net also shows as part of it once the grid's own cells are too small, by
  // zoom alone: where the surface turns away the coarse nets would crowd as the grid does.
  bool coarse = instanceCell > 1.5;
#ifdef CASING
  vHalf = 0.5 * ${glsl(style.casingWidth)};
  // Where the surface turns away, the casing still edges the core: it lifts only dark parts.
  vec2 own = vec2( ${glsl(style.casingGone)}, ${glsl(style.casingFull)} );
  vAlpha = smoothstep( own.x, own.y, openPixels );
  if ( coarse )
    vAlpha = max( vAlpha, smoothstep( 0.0, 1.0, coarseStrength( openPixels, own,
      vec2( ${glsl(style.coarseCasingGone)}, ${glsl(style.coarseCasingFull)} ), false ) ) );
  float cap = 0.0;
#else
  // The first coarse net's core comes in late, so on a light part the grid covers no more than
  // at its default density.
  vec2 own = vec2( ${glsl(style.coreGone)}, ${glsl(style.coreFull)} );
  float strength = fadeIn( 0.0, cellPixels, own, own );
  if ( coarse )
    strength = max( strength, coarseStrength( openPixels, own,
      vec2( ${glsl(style.coarseGone)}, ${glsl(style.coarseFull)} ), true ) );
  vHalf = 0.5 * mix( ${glsl(style.coreThin)}, ${glsl(style.coreWidth)}, strength );
  vAlpha = smoothstep( 0.0, 1.0, strength );
  float cap = vHalf;
#endif
  // A pixel beyond the line's edge, for antialiasing.
  float reach = vHalf + 1.0;
  vAcross = position.x * reach;
  vec2 offset = across * vAcross + along * ( atEnd ? cap : - cap );
  vec2 ndc = clip.xy / clip.w + offset * 2.0 / resolution;

  // Each corner lies where its view ray meets the surface's tangent plane at the line, then a
  // little nearer, by at most the tolerance. Where the plane is nearly edge on, a corner is held
  // nearer than it by little and allowed further by much, so it never pokes through what is in
  // front of the surface.
  float facingLimit = 1e-6 * length( normal );
  float limit = 8.0 * reach * pixel;
  float lift = min( ${glsl(style.tolerance)} * pixel, ${glsl(style.toleranceMax)} );
  vec3 corner;
  if ( perspective ) {
    vec3 ray = vec3(
      ( ndc.x + projectionMatrix[ 2 ][ 0 ] ) / projectionMatrix[ 0 ][ 0 ],
      ( ndc.y + projectionMatrix[ 2 ][ 1 ] ) / projectionMatrix[ 1 ][ 1 ],
      - 1.0 );
    float toward = dot( normal, ray );
    float t = abs( toward ) > facingLimit * length( ray ) ? dot( normal, centre ) / toward : depth;
    t = clamp( t, depth - limit, depth + 16.0 * limit );
    corner = ray * t;
    // Never pulled past halfway to the near plane, where it would be clipped.
    float near = projectionMatrix[ 3 ][ 2 ] / ( projectionMatrix[ 2 ][ 2 ] - 1.0 );
    corner -= normalize( corner ) * min( lift, max( 0.0, 0.5 * ( t - near ) ) * length( corner ) / t );
  } else {
    vec2 xy = vec2(
      ( ndc.x - projectionMatrix[ 3 ][ 0 ] ) / projectionMatrix[ 0 ][ 0 ],
      ( ndc.y - projectionMatrix[ 3 ][ 1 ] ) / projectionMatrix[ 1 ][ 1 ] );
    float z = abs( normal.z ) > facingLimit
      ? centre.z - dot( normal.xy, xy - centre.xy ) / normal.z
      : centre.z;
    z = clamp( z, centre.z - 16.0 * limit, centre.z + limit );
    float near = ( projectionMatrix[ 3 ][ 2 ] + 1.0 ) / projectionMatrix[ 2 ][ 2 ];
    corner = vec3( xy, z + min( lift, max( 0.0, 0.5 * ( - near - z ) ) ) );
  }
  gl_Position = projectionMatrix * vec4( corner, 1.0 );
#ifdef GRID_ID
  vId = float( gl_InstanceID );
#endif
}
`;

const fragmentShader = `
uniform vec3 color;
varying float vAcross;
varying float vHalf;
varying float vAlpha;

void main() {
  float aa = max( 0.75 * length( vec2( dFdx( vAcross ), dFdy( vAcross ) ) ), 1e-4 );
  float coverage = clamp( ( vHalf - abs( vAcross ) ) / aa + 0.5, 0.0, 1.0 ) * vAlpha;
  if ( coverage <= 0.0 ) discard;
#ifdef CASING
  gl_FragColor = vec4( color * coverage, 0.0 );
#else
  gl_FragColor = vec4( color * coverage, coverage );
#endif
}
`;

/** Colours as written to the canvas, which takes sRGB values. */
const outputColor = (hex: string) =>
  new Vector3(
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  );

/** One of the line's two draws over shared uniforms: the light casing, then the dark core. */
function gridMaterial(pass: 'casing' | 'core', uniforms: Record<string, { value: unknown }>) {
  return new ShaderMaterial({
    uniforms: {
      ...uniforms,
      color: { value: outputColor(pass === 'casing' ? style.casing : style.core) },
    },
    defines: pass === 'casing' ? { CASING: '' } : {},
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    // A mirrored part's matrix flips the winding of the screen-facing quads. One pass draws both.
    side: DoubleSide,
    forceSinglePass: true,
    blending: CustomBlending,
    // The casing only lifts what is darker than it; the core covers by its coverage.
    ...(pass === 'casing'
      ? { blendEquation: MaxEquation }
      : { blendSrc: OneFactor, blendDst: OneMinusSrcAlphaFactor }),
  });
}

/** Runs a trace in slices of a few milliseconds, so a large region never stalls a frame. */
function useTracedPath(model: WarpModel) {
  const [traced, setTraced] = useState<{ model: WarpModel; path: WarpGridPath } | null>(null);
  useEffect(() => {
    const trace = traceWarpGridPath(model);
    let timer: ReturnType<typeof setTimeout>;
    const advance = () => {
      const deadline = performance.now() + 6;
      do {
        const step = trace.next();
        if (step.done) return setTraced({ model, path: step.value });
      } while (performance.now() < deadline);
      timer = setTimeout(advance, 0);
    };
    timer = setTimeout(advance, 0);
    return () => clearTimeout(timer);
  }, [model]);
  const chords = useMemo(() => warpGridChords(model), [model]);
  return traced?.model === model ? traced.path : chords;
}

/**
 * Grid edges laid along the written surface, drawn in the part's own space and depth-tested like
 * the surface they lie on. Segment ends are uploaded when the surface is written; between writes,
 * as when a large region follows a drag on the grid alone, only the nodes' shifts are.
 */
export function WarpGrid({ warp }: { warp: WarpSession }) {
  return legacyGrid ? <LegacyWarpGrid warp={warp} /> : <SurfaceWarpGrid warp={warp} />;
}

/** In development, `?warp-grid=1px` draws the old 1 px chords, for the rendered-frame benchmark. */
const legacyGrid =
  import.meta.env.DEV &&
  typeof location !== 'undefined' &&
  new URLSearchParams(location.search).get('warp-grid') === '1px';

/** The grid as it was drawn before it followed the surface: 1 px chords between nodes. */
function LegacyWarpGrid({ warp }: { warp: WarpSession }) {
  const model = warp.model!;
  const invalidate = useThree((s) => s.invalidate);
  const geometry = useMemo(() => {
    const { edgeStart, edges } = model.grid;
    const pairs: number[] = [];
    for (let n = 0; n + 1 < edgeStart.length; n++)
      for (let k = edgeStart[n]; k < edgeStart[n + 1]; k++)
        if (edges[k] > n) pairs.push(n, edges[k]);
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array(model.restNodes.length), 3),
    );
    geometry.setIndex(pairs);
    return geometry;
  }, [model]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useLayoutEffect(() => {
    const position = geometry.getAttribute('position') as BufferAttribute;
    (position.array as Float32Array).set(warp.state!.positions);
    position.needsUpdate = true;
    geometry.computeBoundingSphere();
    invalidate();
  }, [geometry, warp, invalidate]);
  return (
    <lineSegments geometry={geometry} raycast={noRaycast} renderOrder={6} name="warp-grid">
      <lineBasicMaterial color="#b9e3dd" transparent opacity={0.55} depthWrite={false} />
    </lineSegments>
  );
}

const eye = new Vector3();

/** The longest a cell can appear anywhere on the grid, in CSS pixels. */
function largestCell(
  camera: Camera,
  height: number,
  cell: number,
  centre: Vector3,
  radius: number,
) {
  const scale = (camera.projectionMatrix.elements[5] * height) / 2;
  if (camera.projectionMatrix.elements[11] !== -1) return cell * scale;
  const nearest = camera.getWorldPosition(eye).distanceTo(centre) - radius;
  return nearest > 0 ? (cell * scale) / nearest : Infinity;
}

/** How long the written surface stays as it is before the drawn points are chosen on it again. */
const refineDelay = 80;

/** Uploads the first `count` floats of a buffer that changed. */
function upload(buffer: InstancedInterleavedBuffer | InstancedBufferAttribute, count: number) {
  buffer.clearUpdateRanges();
  buffer.addUpdateRange(0, count);
  buffer.needsUpdate = true;
}

function SurfaceWarpGrid({ warp }: { warp: WarpSession }) {
  const model = warp.model!;
  const latest = useRef(warp);
  latest.current = warp;
  const invalidate = useThree((s) => s.invalidate);
  const size = useThree((s) => s.size);
  const path = useTracedPath(model);
  // Inspection draws the part see-through without depth, so its far side's lines would show.
  const inspecting = useEditor((s) => s.view.inspection.enabled);
  const grid = useMemo(() => {
    const nodeCount = model.restNodes.length / 3;
    const drawing = new WarpGridDrawing(path, nodeCount, warpGridLevels(path, nodeCount));
    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute(
      'position',
      new Float32BufferAttribute([-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0], 3),
    );
    geometry.setIndex([0, 1, 2, 2, 1, 3]);
    const base = new InstancedInterleavedBuffer(drawing.base, 6, 1);
    geometry.setAttribute('instanceStart', new InterleavedBufferAttribute(base, 3, 0));
    geometry.setAttribute('instanceEnd', new InterleavedBufferAttribute(base, 3, 3));
    const normals = new InstancedInterleavedBuffer(drawing.normals, 6, 1);
    geometry.setAttribute('instanceNormalStart', new InterleavedBufferAttribute(normals, 3, 0));
    geometry.setAttribute('instanceNormalEnd', new InterleavedBufferAttribute(normals, 3, 3));
    const weights = new InstancedBufferAttribute(drawing.weights, 4);
    geometry.setAttribute('instanceWeights', weights);
    const cells = new InstancedBufferAttribute(drawing.cells, 1);
    geometry.setAttribute('instanceCell', cells);
    geometry.instanceCount = drawing.segments;
    const shifts = new DataTexture(
      drawing.shifts,
      warpGridShiftWidth,
      drawing.shifts.length / 4 / warpGridShiftWidth,
      RGBAFormat,
      FloatType,
    );
    shifts.needsUpdate = true;
    const uniforms = {
      resolution: { value: new Vector2(1, 1) },
      cell: { value: typicalLength(path.length) },
      shifted: { value: false },
      shifts: { value: shifts },
    };
    const casing = new Mesh(geometry, gridMaterial('casing', uniforms)),
      core = new Mesh(geometry, gridMaterial('core', uniforms));
    casing.name = 'warp-grid:casing';
    core.name = 'warp-grid:core';
    casing.renderOrder = 6;
    core.renderOrder = 7;
    // Each pass draws only the levels whose cells can show it, the coarsest first.
    const counts = { casing: 0, core: 0 };
    casing.onBeforeRender = () => (geometry.instanceCount = counts.casing);
    core.onBeforeRender = () => (geometry.instanceCount = counts.core);
    for (const line of [casing, core]) {
      line.frustumCulled = false;
      line.raycast = noRaycast;
    }
    // The part's matrix when the model was built: the space the preview is written in.
    const space = new Object3D();
    space.matrixAutoUpdate = false;
    space.matrix.fromArray(model.matrix);
    space.matrixWorldNeedsUpdate = true;
    space.name = 'warp-grid';
    // Until the trace is done, edges are chords.
    space.userData = { model, traced: path.traced, drawing };
    space.add(casing, core);
    // How far a line can stand off the sphere through its nodes.
    let reach = 0;
    for (let e = 0; e < path.length.length; e++) reach = Math.max(reach, path.length[e]);
    return {
      drawing,
      base,
      normals,
      weights,
      cells,
      shifts,
      geometry,
      casing,
      core,
      counts,
      space,
      uniforms,
      reach: reach * 1.5,
      // The most the part's matrix stretches it, for sizes in its own space.
      scale:
        Math.max(
          Math.hypot(model.matrix[0], model.matrix[1], model.matrix[2]),
          Math.hypot(model.matrix[4], model.matrix[5], model.matrix[6]),
          Math.hypot(model.matrix[8], model.matrix[9], model.matrix[10]),
        ) || 1,
      // Where the grid lies, for which levels have cells large enough to show.
      centre: new Vector3(),
      radius: Infinity,
      local: new Float32Array(nodeCount * 3),
      drawn: new Float64Array(nodeCount * 3).fill(Number.NaN),
      version: -1,
      refine: undefined as ReturnType<typeof setTimeout> | undefined,
    };
  }, [path, model]);
  useEffect(
    () => () => {
      clearTimeout(grid.refine);
      grid.geometry.dispose();
      grid.casing.material.dispose();
      grid.core.material.dispose();
      grid.shifts.dispose();
    },
    [grid],
  );
  useLayoutEffect(() => {
    grid.uniforms.resolution.value.set(size.width, size.height);
    invalidate();
  }, [grid, size, invalidate]);
  useLayoutEffect(() => invalidate(), [grid, invalidate]);

  /** Once the written surface has stayed put a moment, chooses the drawn points on it again. */
  const refineLater = (version: number) => {
    clearTimeout(grid.refine);
    if (!path.crossings) return;
    const current = () => {
      const warp = latest.current;
      const position = warp.preview?.getAttribute('position') as BufferAttribute | undefined;
      return warp.model === model && warp.output && (position?.version ?? 0) === version
        ? warp.output
        : null;
    };
    grid.refine = setTimeout(() => {
      const output = current();
      if (!output || grid.drawing.written !== version) return;
      const job = grid.drawing.refining(output.positions);
      const slice = () => {
        if (!current()) return;
        const deadline = performance.now() + 4;
        do {
          if (job.next().done) {
            const output = current();
            if (!output || grid.drawing.written !== version) return;
            const changed = grid.drawing.adopt(output.positions, output.normals);
            const segments = grid.drawing.segments;
            if (changed.base) upload(grid.base, segments * 6);
            if (changed.normals) upload(grid.normals, segments * 6);
            if (changed.layout) {
              upload(grid.weights, segments * 4);
              upload(grid.cells, segments);
            }
            invalidate();
            return;
          }
        } while (performance.now() < deadline);
        grid.refine = setTimeout(slice, 0);
      };
      slice();
    }, refineDelay);
  };

  useFrame(({ camera }) => {
    const { casing, core, counts, drawing, uniforms, centre } = grid;
    const warp = latest.current;
    if (warp.model === model && warp.output) {
      const nodes = gridNodePositions(warp);
      const position = warp.preview?.getAttribute('position') as BufferAttribute | undefined;
      const version = position?.version ?? 0;
      const { drawn, local } = grid;
      let moved = false;
      for (let i = 0; i < nodes.length; i++)
        if (nodes[i] !== drawn[i]) {
          moved = true;
          break;
        }
      if (moved || version !== grid.version) {
        drawn.set(nodes);
        grid.version = version;
        const m = model.inverse;
        let x = 0,
          y = 0,
          z = 0;
        for (let i = 0; i < nodes.length; i += 3) {
          x += nodes[i];
          y += nodes[i + 1];
          z += nodes[i + 2];
        }
        centre.set(x, y, z).divideScalar(Math.max(1, nodes.length / 3));
        let far = 0;
        for (let i = 0; i < nodes.length; i += 3) {
          const dx = nodes[i] - centre.x,
            dy = nodes[i + 1] - centre.y,
            dz = nodes[i + 2] - centre.z;
          far = Math.max(far, dx * dx + dy * dy + dz * dz);
          local[i] = m[0] * nodes[i] + m[4] * nodes[i + 1] + m[8] * nodes[i + 2] + m[12];
          local[i + 1] = m[1] * nodes[i] + m[5] * nodes[i + 1] + m[9] * nodes[i + 2] + m[13];
          local[i + 2] = m[2] * nodes[i] + m[6] * nodes[i + 1] + m[10] * nodes[i + 2] + m[14];
        }
        grid.radius = Math.sqrt(far) + grid.reach;
        const changed = drawing.update(local, warp.output.positions, warp.output.normals, version);
        const segments = drawing.segments;
        if (changed.base) {
          upload(grid.base, segments * 6);
          refineLater(version);
        }
        if (changed.normals) upload(grid.normals, segments * 6);
        if (changed.shifts) grid.shifts.needsUpdate = true;
        uniforms.shifted.value = drawing.shifted;
      }
    }
    // Points that bend a line by less than half the smallest pixel on the grid are left out, and
    // never by more than most of the pull toward the camera, so a chord never dips under.
    const output = warp.model === model ? warp.output : null;
    if (output) {
      const p = camera.projectionMatrix.elements,
        v = camera.matrixWorldInverse.elements,
        nodes = grid.drawn;
      // The nearest node's depth, less a cell, for the nearest any line comes.
      let nearest = Infinity;
      if (p[11] === -1)
        for (let i = 0; i < nodes.length; i += 3)
          nearest = Math.min(
            nearest,
            -(v[2] * nodes[i] + v[6] * nodes[i + 1] + v[10] * nodes[i + 2] + v[14]),
          );
      else nearest = 1 + uniforms.cell.value;
      nearest -= uniforms.cell.value;
      const pixel = (2 * nearest) / (p[5] * size.height) / grid.scale;
      const bound = Math.min(
        0.5 * style.tolerance * pixel,
        (0.75 * style.toleranceMax) / grid.scale,
      );
      // In steps of two, held while the bound stays within one more step, so a drag that
      // brings the grid a little nearer and back does not lay it out again each frame.
      const held = drawing.shown;
      const detail = !(nearest > 0 && bound > 0)
        ? 0
        : held > 0 && bound >= held && bound < 4 * held
          ? held
          : 2 ** Math.floor(Math.log2(bound));
      const changed = drawing.detail(detail, output.positions, output.normals);
      if (changed.layout) {
        const segments = drawing.segments;
        upload(grid.base, segments * 6);
        if (changed.normals) upload(grid.normals, segments * 6);
        upload(grid.weights, segments * 4);
        upload(grid.cells, segments);
      }
    }
    // Levels whose largest cell is too small on screen for a pass to show are not drawn by it.
    const largest = largestCell(camera, size.height, uniforms.cell.value, centre, grid.radius);
    const shown = (gone: number, coarseGone: number) => {
      for (let level = 0; level < drawing.levelEnd.length; level++)
        if (largest * 2 ** level > (level ? coarseGone : gone)) return drawing.levelEnd[level];
      return 0;
    };
    counts.casing = shown(style.casingGone, style.coarseCasingGone);
    counts.core = shown(style.coreGone, style.coarseGone);
    casing.visible = counts.casing > 0;
    core.visible = counts.core > 0;
  });
  return <primitive object={grid.space} visible={!inspecting} />;
}
