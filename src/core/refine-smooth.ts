import { type RefineMesh, type RefineTopology, moveVertex } from './refine-mesh';

/** Taubin's shrink and inflate factors: a low-pass filter that keeps a surface's size. */
const shrink = 0.5;
const inflate = -0.53;

/** Passes that Smooth runs at a strength from 0 to 1. */
export const smoothPasses = (strength: number) => Math.round(strength * 40);

/** Non-shrinking low-pass passes over `vertices`, each scaled by its weight (0 holds a vertex). */
export function smoothVertices(
  mesh: RefineMesh,
  topology: RefineTopology,
  vertices: Uint32Array,
  weight: Float32Array,
  passes: number,
): void {
  const { position } = mesh;
  const { neighbourStart, neighbours } = topology;
  const count = vertices.length;
  const step = new Float64Array(count * 3);
  for (let pass = 0; pass < passes; pass++)
    for (const factor of [shrink, inflate]) {
      // Every step of one half-pass is read from the same positions, then all are applied.
      for (let i = 0; i < count; i++) {
        const v = vertices[i];
        const from = neighbourStart[v],
          to = neighbourStart[v + 1];
        if (!(weight[i] > 0)) continue;
        let x = 0,
          y = 0,
          z = 0;
        for (let j = from; j < to; j++) {
          const w = neighbours[j] * 3;
          x += position[w];
          y += position[w + 1];
          z += position[w + 2];
        }
        const scale = to > from ? (factor * weight[i]) / (to - from) : 0;
        step[i * 3] = scale * (x - (to - from) * position[v * 3]);
        step[i * 3 + 1] = scale * (y - (to - from) * position[v * 3 + 1]);
        step[i * 3 + 2] = scale * (z - (to - from) * position[v * 3 + 2]);
      }
      for (let i = 0; i < count; i++) {
        if (!(weight[i] > 0)) continue;
        const v = vertices[i] * 3;
        moveVertex(
          mesh,
          vertices[i],
          position[v] + step[i * 3],
          position[v + 1] + step[i * 3 + 1],
          position[v + 2] + step[i * 3 + 2],
        );
      }
    }
}
