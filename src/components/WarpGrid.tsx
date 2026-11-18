import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  BufferAttribute,
  DoubleSide,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Object3D,
  type Mesh,
} from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import type { WarpSession } from '../core/store';
import { writtenNodePositions } from '../core/warp-evaluate';
import type { WarpModel } from '../core/warp-model';
import {
  traceWarpGridPath,
  warpGridChords,
  warpGridSegments,
  writeWarpGridNormals,
  writeWarpGridPath,
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
 * A grid line material. `cell` is the grid's typical edge length; its projected length sets the
 * line's width in pixels, up to `linewidth`, so the surface stays visible between lines however
 * fine the grid or far the camera. Below a pixel a line fades instead of thinning, and `fade`
 * gives the projected cell length in pixels over which a line fades out as the grid closes up.
 */
function gridMaterial(
  color: string,
  linewidth: number,
  share: number,
  opacity: number,
  fade: [number, number] = [0, 0],
) {
  const material = new LineMaterial({
    color,
    linewidth,
    opacity,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    // A mirrored part's matrix flips the winding of the screen-facing quads.
    side: DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  Object.assign(material.uniforms, {
    cell: { value: 1 },
    cellShare: { value: share },
    cellFade: { value: fade },
  });
  material.vertexShader = material.vertexShader
    .replace(
      'uniform float linewidth;',
      `uniform float linewidth;
      uniform float cell;
      uniform float cellShare;
      uniform vec2 cellFade;
      attribute vec3 instanceNormalStart;
      attribute vec3 instanceNormalEnd;
      varying float vFade;`,
    )
    .replace(
      'offset *= linewidth;',
      `float cellPixels = cell * projectionMatrix[ 1 ][ 1 ] * resolution.y * 0.5 /
        ( ( position.y < 0.5 ) ? clipStart.w : clipEnd.w );
      float width = min( linewidth, cellPixels * cellShare );
      vFade = clamp( width, 0.0, 1.0 ) *
        ( cellFade.y > cellFade.x ? smoothstep( cellFade.x, cellFade.y, cellPixels ) : 1.0 );
      offset *= max( width, 1.0 );`,
    )
    .replace(
      'clip.xy += offset;',
      `clip.xy += offset;
      // Lay the corners on the surface's tangent plane, so a line's sides keep to the surface
      // where it slopes across the line.
      vec3 surfaceNormal = normalMatrix *
        ( ( position.y < 0.5 ) ? instanceNormalStart : instanceNormalEnd );
      if ( dot( surfaceNormal, surfaceNormal ) > 1e-12 ) {
        vec3 centre = ( ( position.y < 0.5 ) ? start : end ).xyz;
        vec2 shift = offset / vec2( projectionMatrix[ 0 ][ 0 ], projectionMatrix[ 1 ][ 1 ] );
        float reach = 4.0 * length( shift );
        float slope = abs( surfaceNormal.z ) > 1e-6 ? surfaceNormal.z : 1e-6;
        float rise = clamp( - dot( surfaceNormal.xy, shift ) / slope, - reach, reach );
        vec4 corner = projectionMatrix * vec4( centre + vec3( shift, rise ), 1.0 );
        clip = vec4( clip.xy * ( corner.w / clip.w ), corner.z, corner.w );
      }`,
    );
  material.fragmentShader = material.fragmentShader
    .replace('uniform float linewidth;', 'uniform float linewidth;\nvarying float vFade;')
    .replace('float alpha = opacity;', 'float alpha = opacity * vFade;');
  return material;
}

/** The middle of a grid's edge lengths. */
function typicalLength(lengths: Float32Array) {
  const sorted = lengths.slice().sort();
  return sorted[sorted.length >> 1] || 1;
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
 * Grid edges laid along the written surface, a dark core over a light casing, drawn in the
 * part's own space and depth-tested like the surface they lie on. Positions are uploaded only
 * when nodes or the written surface move, and normals only when the surface is written.
 */
export function WarpGrid({ warp }: { warp: WarpSession }) {
  const model = warp.model!;
  const latest = useRef(warp);
  latest.current = warp;
  const invalidate = useThree((s) => s.invalidate);
  const size = useThree((s) => s.size);
  const path = useTracedPath(model);
  const grid = useMemo(() => {
    const segments = warpGridSegments(path);
    const buffer = new InstancedInterleavedBuffer(new Float32Array(segments * 6), 6, 1);
    const geometry = new LineSegmentsGeometry();
    geometry.setAttribute('instanceStart', new InterleavedBufferAttribute(buffer, 3, 0));
    geometry.setAttribute('instanceEnd', new InterleavedBufferAttribute(buffer, 3, 3));
    const normals = new InstancedInterleavedBuffer(new Float32Array(segments * 6), 6, 1);
    geometry.setAttribute('instanceNormalStart', new InterleavedBufferAttribute(normals, 3, 0));
    geometry.setAttribute('instanceNormalEnd', new InterleavedBufferAttribute(normals, 3, 3));
    geometry.instanceCount = segments;
    // A light casing, fading out as cells close from 32 to 14 px, under a dark core.
    const casing = new LineSegments2(geometry, gridMaterial('#f2f5f4', 6.5, 0.16, 1, [14, 32])),
      core = new LineSegments2(geometry, gridMaterial('#0e1114', 2.5, 0.065, 1, [5, 14]));
    const cell = typicalLength(path.length);
    casing.material.uniforms.cell.value = core.material.uniforms.cell.value = cell;
    casing.name = 'warp-grid:casing';
    core.name = 'warp-grid:core';
    casing.renderOrder = 6;
    core.renderOrder = 7;
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
    space.userData = { model, traced: path.traced };
    space.add(casing, core);
    const nodeCount = model.restNodes.length;
    return {
      path,
      buffer,
      normals,
      geometry,
      casing,
      core,
      space,
      local: new Float32Array(nodeCount),
      // Node positions when the surface was last written, and when the grid was last drawn.
      atWrite: new Float32Array(nodeCount),
      shift: new Float32Array(nodeCount),
      drawn: new Float64Array(nodeCount).fill(Number.NaN),
      version: -1,
    };
  }, [path, model]);
  useEffect(
    () => () => {
      grid.geometry.dispose();
      grid.casing.material.dispose();
      grid.core.material.dispose();
    },
    [grid],
  );
  useLayoutEffect(() => {
    grid.casing.material.resolution.set(size.width, size.height);
    grid.core.material.resolution.set(size.width, size.height);
    invalidate();
  }, [grid, size, invalidate]);
  useLayoutEffect(() => invalidate(), [grid, invalidate]);
  useFrame(() => {
    const warp = latest.current;
    if (warp.model !== model || !warp.output) return;
    const nodes = gridNodePositions(warp);
    const position = warp.preview?.getAttribute('position') as BufferAttribute | undefined;
    const version = position?.version ?? 0;
    const { drawn, local, atWrite, shift } = grid;
    let moved = false;
    for (let i = 0; i < nodes.length; i++)
      if (nodes[i] !== drawn[i]) {
        moved = true;
        break;
      }
    if (!moved && version === grid.version) return;
    drawn.set(nodes);
    const m = model.inverse;
    for (let i = 0; i < nodes.length; i += 3) {
      const x = nodes[i],
        y = nodes[i + 1],
        z = nodes[i + 2];
      local[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
      local[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      local[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    }
    // Large regions follow a drag on the grid alone, so the points between nodes move with them
    // until the surface is written again.
    let shifted = false;
    if (version !== grid.version) {
      grid.version = version;
      atWrite.set(local);
      if (warp.output.normals) {
        writeWarpGridNormals(grid.path, warp.output.normals, grid.normals.array as Float32Array);
        grid.normals.needsUpdate = true;
      }
    } else
      for (let i = 0; i < local.length; i++) {
        shift[i] = local[i] - atWrite[i];
        if (shift[i] !== 0) shifted = true;
      }
    writeWarpGridPath(
      grid.path,
      local,
      warp.output.positions,
      shifted ? shift : null,
      grid.buffer.array as Float32Array,
    );
    grid.buffer.needsUpdate = true;
  });
  return <primitive object={grid.space} />;
}
