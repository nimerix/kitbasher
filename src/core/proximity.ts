import { Box3, Vector3 } from 'three';
import type { BufferGeometry, Matrix4 } from 'three';
import { binaryGeometry } from './geometry';

export interface ProximitySource {
  geometry: BufferGeometry;
  /** From mesh coordinates to the field's frame, in mm. */
  matrix: Matrix4;
}

/** Distance to the nearest surface, sampled on a grid so a shader can look it up. */
export interface ProximityField {
  /** One byte per node, 0 to 255 across `range`. */
  data: Uint8Array;
  size: [number, number, number];
  /** The first node's position in the field's frame. */
  origin: [number, number, number];
  /** Node spacing in mm, which is also the detail the field resolves. */
  cell: number;
  /** The distance in mm stored as 255. Farther nodes hold 255 too. */
  range: number;
}

export interface FieldLimits {
  nodes: number;
  /** Longest grid side, which a 3D texture also limits. */
  axis: number;
}

export const fieldLimits: FieldLimits = { nodes: 1_200_000, axis: 256 };

// Surface samples are at most this far apart, in cells.
const spacing = 0.5;
// Work done between yields, sized to take a millisecond or two.
const chunk = 1 << 16;
const sweeps = [
  [1, 1, 1],
  [-1, 1, 1],
  [1, -1, 1],
  [-1, -1, 1],
  [1, 1, -1],
  [-1, 1, -1],
  [1, -1, -1],
  [-1, -1, -1],
] as const;

/** Shared grid layout keeps CPU and GPU texture sampling in the same coordinate frame. */
export function proximityGrid(
  sources: ProximitySource[],
  reach: number,
  limits = fieldLimits,
): Omit<ProximityField, 'data'> | null {
  const bounds = new Box3(),
    box = new Box3();
  for (const { geometry, matrix } of sources) {
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    bounds.union(box.copy(geometry.boundingBox!).applyMatrix4(matrix));
  }
  if (bounds.isEmpty()) return null;
  const extent = bounds.getSize(new Vector3()).addScalar(2 * reach);
  let cell = Math.max(
    Math.cbrt((extent.x * extent.y * extent.z) / limits.nodes),
    Math.max(extent.x, extent.y, extent.z) / (limits.axis - 3),
    // A wide reach serves distances of its own scale, which need no finer grid.
    reach / 16,
    1e-6,
  );
  // One cell beyond the reach on every side keeps lookups inside the grid.
  const nodes = (length: number) => Math.ceil(length / cell) + 3;
  // Rounding can leave the longest side one node over.
  while (Math.max(nodes(extent.x), nodes(extent.y), nodes(extent.z)) > limits.axis) cell *= 1.001;
  const nx = nodes(extent.x),
    ny = nodes(extent.y),
    nz = nodes(extent.z);
  const ox = bounds.min.x - reach - cell,
    oy = bounds.min.y - reach - cell,
    oz = bounds.min.z - reach - cell;

  return { size: [nx, ny, nz], origin: [ox, oy, oz], cell, range: reach + 2 * cell };
}

/**
 * Measures how far each grid node around the meshes is from their surfaces, out to `reach` mm.
 * Yields often, so a caller can spread a dense mesh over several frames.
 */
export function* bakeProximityField(
  sources: ProximitySource[],
  reach: number,
  limits = fieldLimits,
): Generator<void, ProximityField | null> {
  const grid = proximityGrid(sources, reach, limits);
  if (!grid) return null;
  const {
    size: [nx, ny, nz],
    origin: [ox, oy, oz],
    cell,
  } = grid;
  const count = nx * ny * nz;
  // The nearest surface sample found so far for each node, and its squared distance in cells.
  const seed = new Float32Array(count * 3);
  const dist = new Float32Array(count).fill(Infinity);

  const layer = nx * ny;
  const put = (i: number, d: number, x: number, y: number, z: number) => {
    if (d < dist[i]) {
      dist[i] = d;
      seed[i * 3] = x;
      seed[i * 3 + 1] = y;
      seed[i * 3 + 2] = z;
    }
  };
  const splat = (x: number, y: number, z: number) => {
    const ix = Math.min(Math.max(Math.floor(x), 0), nx - 2),
      iy = Math.min(Math.max(Math.floor(y), 0), ny - 2),
      iz = Math.min(Math.max(Math.floor(z), 0), nz - 2);
    const fx = x - ix,
      fy = y - iy,
      fz = z - iz;
    const x0 = fx * fx,
      x1 = (1 - fx) * (1 - fx),
      y0 = fy * fy,
      y1 = (1 - fy) * (1 - fy),
      z0 = fz * fz,
      z1 = (1 - fz) * (1 - fz);
    const base = ix + nx * (iy + ny * iz);
    put(base, x0 + y0 + z0, x, y, z);
    put(base + 1, x1 + y0 + z0, x, y, z);
    put(base + nx, x0 + y1 + z0, x, y, z);
    put(base + nx + 1, x1 + y1 + z0, x, y, z);
    put(base + layer, x0 + y0 + z1, x, y, z);
    put(base + layer + 1, x1 + y0 + z1, x, y, z);
    put(base + layer + nx, x0 + y1 + z1, x, y, z);
    put(base + layer + nx + 1, x1 + y1 + z1, x, y, z);
  };

  for (const { geometry, matrix } of sources) {
    const { positions, indices: index } = binaryGeometry(geometry);
    // Mesh coordinates to grid coordinates.
    const e = matrix.elements;
    const m00 = e[0] / cell,
      m01 = e[4] / cell,
      m02 = e[8] / cell,
      m03 = (e[12] - ox) / cell,
      m10 = e[1] / cell,
      m11 = e[5] / cell,
      m12 = e[9] / cell,
      m13 = (e[13] - oy) / cell,
      m20 = e[2] / cell,
      m21 = e[6] / cell,
      m22 = e[10] / cell,
      m23 = (e[14] - oz) / cell;

    for (let start = 0; start < positions.length; start += chunk * 3) {
      const end = Math.min(positions.length, start + chunk * 3);
      for (let i = start; i < end; i += 3) {
        const x = positions[i],
          y = positions[i + 1],
          z = positions[i + 2];
        splat(
          m00 * x + m01 * y + m02 * z + m03,
          m10 * x + m11 * y + m12 * z + m13,
          m20 * x + m21 * y + m22 * z + m23,
        );
      }
      yield;
    }

    // Vertices cover small triangles. Larger ones are sampled across their face as well.
    const stretch =
      m00 * m00 +
      m01 * m01 +
      m02 * m02 +
      m10 * m10 +
      m11 * m11 +
      m12 * m12 +
      m20 * m20 +
      m21 * m21 +
      m22 * m22;
    const small = (spacing * spacing) / stretch;
    const triangles = (index ? index.length : positions.length / 3) / 3;
    const p = new Float64Array(9);
    let work = 0;
    for (let t = 0; t < triangles; t++) {
      if (++work >= chunk * 2) {
        work = 0;
        yield;
      }
      const a = (index ? index[t * 3] : t * 3) * 3,
        b = (index ? index[t * 3 + 1] : t * 3 + 1) * 3,
        c = (index ? index[t * 3 + 2] : t * 3 + 2) * 3;
      const ax = positions[a],
        ay = positions[a + 1],
        az = positions[a + 2],
        bx = positions[b],
        by = positions[b + 1],
        bz = positions[b + 2],
        cx = positions[c],
        cy = positions[c + 1],
        cz = positions[c + 2];
      if (
        (bx - ax) ** 2 + (by - ay) ** 2 + (bz - az) ** 2 <= small &&
        (cx - bx) ** 2 + (cy - by) ** 2 + (cz - bz) ** 2 <= small &&
        (ax - cx) ** 2 + (ay - cy) ** 2 + (az - cz) ** 2 <= small
      )
        continue;
      p[0] = m00 * ax + m01 * ay + m02 * az + m03;
      p[1] = m10 * ax + m11 * ay + m12 * az + m13;
      p[2] = m20 * ax + m21 * ay + m22 * az + m23;
      p[3] = m00 * bx + m01 * by + m02 * bz + m03;
      p[4] = m10 * bx + m11 * by + m12 * bz + m13;
      p[5] = m20 * bx + m21 * by + m22 * bz + m23;
      p[6] = m00 * cx + m01 * cy + m02 * cz + m03;
      p[7] = m10 * cx + m11 * cy + m12 * cz + m13;
      p[8] = m20 * cx + m21 * cy + m22 * cz + m23;
      work += sampleTriangle(p, splat) * 4;
    }
    yield;
  }

  // Each node takes the nearest sample any neighbor knows, sweeping from all eight corners.
  for (const [dx, dy, dz] of sweeps)
    for (let slab = 0; slab < nz; slab++) {
      const z = dz > 0 ? slab : nz - 1 - slab;
      const behind = slab > 0 ? -dz * layer : 0;
      for (let line = 0; line < ny; line++) {
        const y = dy > 0 ? line : ny - 1 - line;
        const row = nx * (y + ny * z);
        const beside = line > 0 ? -dy * nx : 0;
        for (let step = 0; step < nx; step++) {
          const x = dx > 0 ? step : nx - 1 - step;
          const i = row + x;
          let best = dist[i],
            from = -1;
          if (step > 0 && dist[i - dx] < Infinity) {
            const n = (i - dx) * 3;
            const d = (seed[n] - x) ** 2 + (seed[n + 1] - y) ** 2 + (seed[n + 2] - z) ** 2;
            if (d < best) {
              best = d;
              from = n;
            }
          }
          if (beside && dist[i + beside] < Infinity) {
            const n = (i + beside) * 3;
            const d = (seed[n] - x) ** 2 + (seed[n + 1] - y) ** 2 + (seed[n + 2] - z) ** 2;
            if (d < best) {
              best = d;
              from = n;
            }
          }
          if (behind && dist[i + behind] < Infinity) {
            const n = (i + behind) * 3;
            const d = (seed[n] - x) ** 2 + (seed[n + 1] - y) ** 2 + (seed[n + 2] - z) ** 2;
            if (d < best) {
              best = d;
              from = n;
            }
          }
          if (from >= 0) {
            dist[i] = best;
            seed[i * 3] = seed[from];
            seed[i * 3 + 1] = seed[from + 1];
            seed[i * 3 + 2] = seed[from + 2];
          }
        }
      }
      yield;
    }

  const range = reach + 2 * cell;
  const scale = (255 * cell) / range;
  const data = new Uint8Array(count);
  for (let start = 0; start < count; start += chunk * 4) {
    const end = Math.min(count, start + chunk * 4);
    for (let i = start; i < end; i++)
      data[i] = Math.min(255, Math.round(Math.sqrt(dist[i]) * scale));
    yield;
  }
  return { data, size: [nx, ny, nz], origin: [ox, oy, oz], cell, range };
}

/**
 * Covers a triangle, given in cells, with samples no farther apart than the spacing.
 * Returns how many it placed.
 */
function sampleTriangle(p: Float64Array, splat: (x: number, y: number, z: number) => void) {
  const edge = (i: number, j: number) =>
    (p[j * 3] - p[i * 3]) ** 2 +
    (p[j * 3 + 1] - p[i * 3 + 1]) ** 2 +
    (p[j * 3 + 2] - p[i * 3 + 2]) ** 2;
  const ab = edge(0, 1),
    bc = edge(1, 2),
    ca = edge(2, 0);
  const longest = Math.max(ab, bc, ca);
  if (longest <= spacing * spacing) return 0;
  // Rows run along the longest edge, so a sliver costs samples for its length, not its square.
  const [a, b, c] = longest === ab ? [0, 3, 6] : longest === bc ? [3, 6, 0] : [6, 0, 3];
  const ux = p[b] - p[a],
    uy = p[b + 1] - p[a + 1],
    uz = p[b + 2] - p[a + 2],
    vx = p[c] - p[a],
    vy = p[c + 1] - p[a + 1],
    vz = p[c + 2] - p[a + 2];
  const length = Math.sqrt(longest);
  const area = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  const rows = Math.max(1, Math.ceil(area / length / spacing));
  let placed = 0;
  for (let row = 0; row <= rows; row++) {
    const v = row / rows;
    const steps = Math.ceil(((1 - v) * length) / spacing);
    for (let step = 0; step <= steps; step++) {
      const u = steps ? ((1 - v) * step) / steps : 0;
      splat(p[a] + u * ux + v * vx, p[a + 1] + u * uy + v * vy, p[a + 2] + u * uz + v * vz);
    }
    placed += steps + 1;
  }
  return placed;
}

/** Distance in mm from a point in the field's frame to the nearest surface, as a shader reads it. */
export function fieldDistance(field: ProximityField, x: number, y: number, z: number) {
  const [nx, ny, nz] = field.size;
  const gx = (x - field.origin[0]) / field.cell,
    gy = (y - field.origin[1]) / field.cell,
    gz = (z - field.origin[2]) / field.cell;
  if (gx < 0 || gy < 0 || gz < 0 || gx > nx - 1 || gy > ny - 1 || gz > nz - 1) return Infinity;
  const ix = Math.min(Math.floor(gx), nx - 2),
    iy = Math.min(Math.floor(gy), ny - 2),
    iz = Math.min(Math.floor(gz), nz - 2);
  const fx = gx - ix,
    fy = gy - iy,
    fz = gz - iz;
  const { data } = field;
  const at = (dx: number, dy: number, dz: number) =>
    data[ix + dx + nx * (iy + dy + ny * (iz + dz))];
  const along = (dy: number, dz: number) => at(0, dy, dz) * (1 - fx) + at(1, dy, dz) * fx;
  const across = (dz: number) => along(0, dz) * (1 - fy) + along(1, dz) * fy;
  return ((across(0) * (1 - fz) + across(1) * fz) * field.range) / 255;
}
