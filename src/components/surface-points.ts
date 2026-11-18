import {
  Vector2,
  Vector4,
  type WebGLProgramParametersWithUniforms,
  type WebGLRenderer,
} from 'three';
import { warpGridStyle } from './WarpGrid';

const viewport = new Vector4();
const uniforms = {
  surfaceViewport: { value: new Vector2(1, 1) },
  surfacePixelRatio: { value: 1 },
};

const glsl = (value: number) => (Number.isInteger(value) ? `${value}.0` : `${value}`);

const vertexHead = `
uniform vec2 surfaceViewport;
uniform float surfacePixelRatio;
flat varying float vSurfaceDepth;
flat varying vec2 vSurfaceSlope;
flat varying vec4 vSurfaceRange;
flat varying float vSurfaceSize;

// Window depth of a view-space point.
float surfaceWindowDepth( vec3 point ) {
  vec4 clip = projectionMatrix * vec4( point, 1.0 );
  return 0.5 * clip.z / clip.w + 0.5;
}

// Window depth where the view ray through an NDC position meets the plane through a centre.
float surfacePlaneDepth( vec3 centre, vec3 normal, vec2 ndc, bool perspective ) {
  if ( perspective ) {
    vec3 ray = vec3(
      ( ndc.x + projectionMatrix[ 2 ][ 0 ] ) / projectionMatrix[ 0 ][ 0 ],
      ( ndc.y + projectionMatrix[ 2 ][ 1 ] ) / projectionMatrix[ 1 ][ 1 ],
      - 1.0 );
    return surfaceWindowDepth( ray * dot( normal, centre ) / dot( normal, ray ) );
  }
  vec2 xy = vec2(
    ( ndc.x - projectionMatrix[ 3 ][ 0 ] ) / projectionMatrix[ 0 ][ 0 ],
    ( ndc.y - projectionMatrix[ 3 ][ 1 ] ) / projectionMatrix[ 1 ][ 1 ] );
  return surfaceWindowDepth( vec3( xy, centre.z - dot( normal.xy, xy - centre.xy ) / normal.z ) );
}
`;

// After the point is placed: its depth across the sprite follows the surface's tangent plane, held
// within a band around the centre as the grid's corners are, and a little nearer, as the grid is.
const vertexBody = `
  {
    bool perspective = projectionMatrix[ 2 ][ 3 ] == - 1.0;
    vec3 centre = mvPosition.xyz;
    vec3 surfaceNormal = normalMatrix * normal;
    float depth = perspective ? - centre.z : 1.0;
    float pixel = 2.0 * depth / ( projectionMatrix[ 1 ][ 1 ] * surfaceViewport.y );
    vec4 clip = projectionMatrix * vec4( centre, 1.0 );
    vec2 ndc = clip.xy / clip.w;
    vSurfaceDepth = surfaceWindowDepth( centre );
    vSurfaceSlope = vec2( 0.0 );
    float toward = dot( normalize( surfaceNormal ), perspective ? normalize( - centre ) : vec3( 0.0, 0.0, 1.0 ) );
    if ( dot( surfaceNormal, surfaceNormal ) > 1e-12 && abs( toward ) > 1e-3 ) {
      vec2 step = 2.0 / surfaceViewport;
      vSurfaceSlope = vec2(
        surfacePlaneDepth( centre, surfaceNormal, ndc + vec2( step.x, 0.0 ), perspective ),
        surfacePlaneDepth( centre, surfaceNormal, ndc + vec2( 0.0, step.y ), perspective ) ) - vSurfaceDepth;
    }
    float limit = 8.0 * ( 0.5 * gl_PointSize + 1.0 ) * pixel;
    float lift = min( ${glsl(warpGridStyle.tolerance)} * pixel * surfacePixelRatio, ${glsl(warpGridStyle.toleranceMax)} );
    float turn = 2.0 * pixel * surfacePixelRatio;
    if ( perspective ) {
      float near = projectionMatrix[ 3 ][ 2 ] / ( projectionMatrix[ 2 ][ 2 ] - 1.0 );
      lift = min( lift, max( 0.0, 0.5 * ( depth - near ) ) );
      turn = min( turn, max( 0.0, 0.5 * ( depth - near ) ) );
      vSurfaceRange = vec4(
        surfaceWindowDepth( centre * ( depth - limit ) / depth ),
        surfaceWindowDepth( centre * ( depth + 16.0 * limit ) / depth ),
        vSurfaceDepth - surfaceWindowDepth( centre - normalize( centre ) * lift ),
        vSurfaceDepth - surfaceWindowDepth( centre - normalize( centre ) * turn ) );
    } else {
      float near = ( projectionMatrix[ 3 ][ 2 ] + 1.0 ) / projectionMatrix[ 2 ][ 2 ];
      lift = min( lift, max( 0.0, 0.5 * ( - near - centre.z ) ) );
      turn = min( turn, max( 0.0, 0.5 * ( - near - centre.z ) ) );
      vSurfaceRange = vec4(
        surfaceWindowDepth( centre + vec3( 0.0, 0.0, limit ) ),
        surfaceWindowDepth( centre - vec3( 0.0, 0.0, 16.0 * limit ) ),
        vSurfaceDepth - surfaceWindowDepth( centre + vec3( 0.0, 0.0, lift ) ),
        vSurfaceDepth - surfaceWindowDepth( centre + vec3( 0.0, 0.0, turn ) ) );
    }
    vSurfaceSize = gl_PointSize;
  }
`;

const fragmentHead = `
flat varying float vSurfaceDepth;
flat varying vec2 vSurfaceSlope;
flat varying vec4 vSurfaceRange;
flat varying float vSurfaceSize;
`;

const fragmentBody = `
  {
    vec2 offset = ( gl_PointCoord - 0.5 ) * vec2( 1.0, - 1.0 ) * vSurfaceSize;
    float low = min( vSurfaceRange.x, vSurfaceRange.y ), high = max( vSurfaceRange.x, vSurfaceRange.y );
    // A vertex normal can be some degrees off the faces around it, so each side of the dot is
    // drawn nearer than its tangent plane by as much as the plane turns there, but by no more
    // than two pixels, so a surface just in front of the dot still hides it.
    float rise = dot( vSurfaceSlope, offset );
    gl_FragDepth = clamp( vSurfaceDepth + rise - min( abs( rise ), vSurfaceRange.w ), low, high ) - vSurfaceRange.z;
  }
`;

/**
 * Settings for a `pointsMaterial` whose dots lie on the surface beneath them: each fragment takes
 * its depth from the surface's tangent plane at the point, read from the geometry's `normal`
 * attribute, so a whole dot shows on a slope while anything nearer still hides it. The dots are
 * drawn among transparent objects, by render order, so after the warp grid's lines.
 */
export const surfacePoints = {
  transparent: true,
  depthWrite: false,
  customProgramCacheKey: () => 'surface-points',
  onBeforeCompile(shader: WebGLProgramParametersWithUniforms) {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', `${vertexHead}\nvoid main() {`)
      .replace('gl_PointSize = size;', `gl_PointSize = size;\n${vertexBody}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `${fragmentHead}\nvoid main() {`)
      .replace(/}\s*$/, `${fragmentBody}\n}`);
  },
  onBeforeRender(renderer: WebGLRenderer) {
    renderer.getCurrentViewport(viewport);
    uniforms.surfaceViewport.value.set(viewport.z, viewport.w);
    uniforms.surfacePixelRatio.value = renderer.getPixelRatio();
  },
};
