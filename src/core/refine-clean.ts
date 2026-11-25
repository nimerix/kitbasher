import { type RefineMesh, type RefineTopology, buildTopology } from './refine-mesh';

/** How Clean treats the surface. Each setting reads 0 as leaving that part of the job out. */
export interface CleanSettings {
  /** How much noise and small unevenness to remove, 0 to 1. */
  smooth: number;
  /** How crisp edges and corners become, 0 to 1. */
  sharpen: number;
  /** How much deeper features become, 0 to `maxCleanDepth`: 1 doubles their relief. */
  depth: number;
  /** The widest feature, mm, that Depth deepens; null takes `autoCleanSize` of the scan. */
  size: number | null;
}

export interface CleanInput extends CleanSettings {
  /** The painted triangles to clean, or null for the whole part. */
  triangles: Uint32Array | null;
}

export interface CleanResult {
  /** Welded vertices that moved, ascending. */
  moved: Uint32Array;
  /** Their new positions, three values each. */
  position: Float64Array;
  /** The feature size Depth used, mm. */
  size: number;
  /** Vertices kept in place because moving them would fold or collapse a triangle. */
  held: number;
  /** Triangles whose corners changed to follow a sharpened edge, ascending. */
  triangles: Uint32Array;
  /** Their new geometry vertices, three each. */
  corners: Uint32Array;
  /** The topology of the mesh with those corners, or null when no triangle changed. */
  topology: RefineTopology | null;
}

export const cleanDefaults: CleanSettings = { smooth: 0.5, sharpen: 0.5, depth: 1, size: null };
export const maxCleanDepth = 3;
/** Depth's feature size when none is set: a few triangles across, where scans lose relief. */
export const autoCleanSize = (step: number) => 8 * step;
export const minCleanSize = 0.05;
export const maxCleanSize = 5;

/** Edge lengths over which a painted area eases from untouched to fully cleaned. */
const featherRings = 4;
/** Bilateral normal filtering rounds at full Smooth. */
const smoothRounds = 10;
/** Normal difference (chord length) that still averages: differences across an edge are larger. */
const range = 0.35;
/** Sharpen's passes, the rounds of averaging that blur the normals it sharpens against, and the
 * amount of the difference it adds at full Sharpen. */
const sharpenPasses = 3;
const blurRounds = 3;
const sharpenAmount = 1.2;
/** Rounds fitting vertices to the filtered normals. */
const fitRounds = 10;
/** Relief within this many times the scan's noise is noise, and is not deepened. */
const reliefNoise = 1.5;
/** Passes averaging the relief field before it is deepened, so no single vertex is pushed alone. */
const reliefPasses = 2;
/** Taubin smoothing of the base Depth measures relief from: lambda, and the most rounds. */
const lambda = 0.5;
const maxBaseRounds = 300;
/** A moved triangle may keep no less than this fraction of its area. */
const collapse = 1e-3;
/** Times a vertex's move is halved for a triangle it would fold or collapse before it is dropped. */
const halvings = 6;
/** Rounds of edge flips that line triangles up with sharpened edges. */
const flipRounds = 4;
/** An edge flips when that leaves at most this share of the bending around it. */
const flipGain = 0.85;
/** Edges whose two triangles turn less than this (cosine of 8 degrees) are left alone. */
const flipBend = Math.cos((8 * Math.PI) / 180);
/** The least shape quality (1 for an equilateral triangle) a flip may make. */
const flipQuality = 0.15;

const cancelled = () => new DOMException('Refine cancelled', 'AbortError');

/** What the settings run, for a scan of median edge `step` mm. */
export function cleanPlan(settings: CleanSettings, step: number) {
  const smooth = clamp01(settings.smooth),
    sharpen = clamp01(settings.sharpen);
  const rounds = Math.round(smoothRounds * smooth);
  const size = Math.min(
    maxCleanSize,
    Math.max(minCleanSize, settings.size ?? autoCleanSize(step), step),
  );
  // The base keeps wavelengths longer than about four times the size, so relief up to the size
  // stands off it whole (measured on a rippled grid: a quarter of the cutoff passes at 0.09).
  const pass = 0.5 * ((Math.PI * step) / (4 * size)) ** 2;
  return {
    rounds,
    passes: sharpen > 0 ? sharpenPasses : 0,
    amount: sharpenAmount * sharpen,
    depth: Math.min(maxCleanDepth, Math.max(0, settings.depth)),
    size,
    pass,
    baseRounds: Math.min(maxBaseRounds, Math.ceil(2 / pass)),
  };
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value || 0));

/**
 * Removes noise, sharpens edges and deepens relief, as a sharpen filter does for a photo.
 *
 * Smooth filters the face normals bilaterally (Zheng et al. 2011): each face takes the area- and
 * distance-weighted mean of the normals around it that are near its own, so noise averages out
 * while the two sides of an edge stay apart. The vertices are then refitted to the filtered normals
 * (Sun et al. 2007). More Smooth runs more rounds.
 *
 * Sharpen is an unsharp mask on the normals: each face's normal moves away from a blurred copy of
 * the normals around it, which steepens the turn of a softened edge as sharpening steepens a
 * blurred edge in a photo, and the vertices are refitted. Each of its passes first filters the
 * normals once, so it sharpens edges and not noise.
 *
 * Depth is an unsharp mask along the surface normal. A Taubin-smoothed base, which keeps shapes
 * longer than about four times Size without shrinking them, stands in for the surface without its
 * relief; each vertex's height above or below it is averaged with its neighbours', faded to nothing
 * where it is within the noise, and added again `depth` times.
 *
 * A painted area eases in over `featherRings` edges from its border; everything outside it, every
 * vertex on an open border or a refined edge, keeps its exact position. A vertex whose move would
 * fold or collapse a triangle moves less, or not at all.
 */
export function cleanSurface(
  mesh: RefineMesh,
  topology: RefineTopology,
  noise: number,
  step: number,
  input: CleanInput,
  report: (fraction: number) => void = () => {},
  signal?: AbortSignal,
): CleanResult {
  const plan = cleanPlan(input, step);
  const empty: CleanResult = {
    moved: new Uint32Array(0),
    position: new Float64Array(0),
    size: plan.size,
    held: 0,
    triangles: new Uint32Array(0),
    corners: new Uint32Array(0),
    topology: null,
  };
  if (!plan.rounds && !plan.passes && !plan.depth) return empty;
  const work = workingSet(mesh, topology, input.triangles, plan, step);
  if (!work) return empty;
  const check = () => {
    if (signal?.aborted) throw cancelled();
  };
  check();
  report(0.05);
  const { count, weight } = work;
  const start = new Float64Array(count * 3);
  for (let i = 0; i < count; i++)
    for (let a = 0; a < 3; a++) start[i * 3 + a] = mesh.position[work.vertex[i] * 3 + a];
  let position = start.slice();
  if (plan.rounds || plan.passes) {
    // Progress: Smooth's rounds and fit, then each Sharpen pass, share 0.05 to 0.6.
    const units = (plan.rounds ? plan.rounds + 2 : 0) + 4 * plan.passes;
    let done = 0;
    const advance = (amount: number) => {
      check();
      done += amount;
      report(Math.min(0.6, 0.05 + (0.55 * done) / units));
    };
    if (plan.rounds) {
      const normals = filterNormals(work, position, plan.rounds, () => advance(1));
      fitToNormals(work, position, normals, fitRounds);
      advance(2);
    }
    for (let pass = 0; pass < plan.passes; pass++) {
      const filtered = filterNormals(work, position, 1, () => advance(1));
      const sharpened = sharpenNormals(work, position, filtered, plan.amount);
      advance(1);
      fitToNormals(work, position, sharpened, fitRounds);
      advance(2);
    }
    for (let i = 0; i < count; i++)
      for (let a = 0; a < 3; a++) {
        const k = i * 3 + a;
        position[k] = start[k] + weight[i] * (position[k] - start[k]);
      }
  }
  report(0.6);
  if (plan.depth) {
    const threshold = reliefNoise * Math.max(noise, 0.05 * step);
    position = deepen(work, position, plan, threshold, (f) => {
      check();
      report(0.6 + 0.35 * f);
    });
  }
  check();
  const held = holdFolds(work, start, position);
  report(0.97);
  const flipped =
    plan.rounds || plan.passes ? alignEdges(work, start, position) : new Uint32Array(0);
  let moved = 0;
  for (let i = 0; i < count; i++) if (changed(start, position, i)) moved++;
  const result: CleanResult = {
    ...empty,
    moved: new Uint32Array(moved),
    position: new Float64Array(moved * 3),
    held,
  };
  if (flipped.length) {
    // Each flipped triangle takes its corners' geometry vertices from the two it was made from,
    // which `alignEdges` carried along in `work.geometry`.
    const order = Array.from(flipped).sort((a, b) => work.triangle[a] - work.triangle[b]);
    result.triangles = Uint32Array.from(order, (f) => work.triangle[f]);
    result.corners = new Uint32Array(order.length * 3);
    order.forEach((f, i) => result.corners.set(work.geometry.subarray(f * 3, f * 3 + 3), i * 3));
    const corners = mesh.corners.slice(0, mesh.triangleCount * 3);
    result.triangles.forEach((t, i) =>
      corners.set(result.corners.subarray(i * 3, i * 3 + 3), t * 3),
    );
    result.topology = buildTopology({ ...mesh, corners });
  }
  report(1);
  // The working set is in ascending welded order, so the moved list is too.
  for (let i = 0, j = 0; i < count; i++) {
    if (!changed(start, position, i)) continue;
    result.moved[j] = work.vertex[i];
    for (let a = 0; a < 3; a++) result.position[j * 3 + a] = position[i * 3 + a];
    j++;
  }
  return result;
}

const changed = (a: Float64Array, b: Float64Array, i: number) =>
  a[i * 3] !== b[i * 3] || a[i * 3 + 1] !== b[i * 3 + 1] || a[i * 3 + 2] !== b[i * 3 + 2];

/**
 * The vertices and triangles a run reads, indexed locally: what it may move with the margin its
 * filters read around it. `weight` is how far each vertex moves toward its cleaned position;
 * `fixed` marks the vertices the base smoothing must hold, those with a neighbour outside the set.
 */
interface WorkingSet {
  count: number;
  /** Welded vertex of each local vertex, ascending. */
  vertex: Uint32Array;
  weight: Float32Array;
  fixed: Uint8Array;
  /** Local corners of each local triangle. */
  corners: Uint32Array;
  /** The geometry vertex of each of those corners. */
  geometry: Uint32Array;
  /** Global triangle of each local triangle. */
  triangle: Uint32Array;
  /** CSR: local triangles around each local vertex. */
  faceStart: Uint32Array;
  faces: Uint32Array;
  /** CSR: local neighbours of each local vertex. */
  neighbourStart: Uint32Array;
  neighbours: Uint32Array;
  /** The sign that turns each triangle's winding normal outward. */
  sign: number;
}

function workingSet(
  mesh: RefineMesh,
  topology: RefineTopology,
  painted: Uint32Array | null,
  plan: ReturnType<typeof cleanPlan>,
  step: number,
): WorkingSet | null {
  const { weldedCount, triangleCount, weldOf, corners: geometryCorners } = mesh;
  const { triangleStart, trianglesOf, neighbourStart, neighbours } = topology;
  const corner = (t: number, k: number) => weldOf[geometryCorners[t * 3 + k]];
  const inside = painted ? new Uint8Array(triangleCount) : null;
  const region = new Uint8Array(weldedCount);
  if (inside) {
    for (const t of painted!)
      if (t < triangleCount) {
        inside[t] = 1;
        for (let k = 0; k < 3; k++) region[corner(t, k)] = 1;
      }
  } else
    for (let v = 0; v < weldedCount; v++)
      if (triangleStart[v + 1] > triangleStart[v]) region[v] = 1;
  // Ring distance inside the region from the vertices that stay put: the painted border, open and
  // non-manifold edges, and refined edges. -1 outside the region.
  const ring = new Int32Array(weldedCount).fill(-1);
  const queue = new Uint32Array(weldedCount);
  let head = 0,
    tail = 0;
  for (let v = 0; v < weldedCount; v++) {
    if (!region[v]) continue;
    const around = triangleStart[v + 1] - triangleStart[v];
    let held = !!mesh.crease[v] || around !== neighbourStart[v + 1] - neighbourStart[v];
    if (inside)
      for (let i = triangleStart[v]; i < triangleStart[v + 1] && !held; i++)
        held = !inside[trianglesOf[i]];
    if (!held) continue;
    ring[v] = 0;
    queue[tail++] = v;
  }
  while (head < tail) {
    const v = queue[head++];
    if (ring[v] >= featherRings) continue;
    for (let i = neighbourStart[v]; i < neighbourStart[v + 1]; i++) {
      const w = neighbours[i];
      if (!region[w] || ring[w] >= 0) continue;
      ring[w] = ring[v] + 1;
      queue[tail++] = w;
    }
  }
  for (let v = 0; v < weldedCount; v++) if (region[v] && ring[v] < 0) ring[v] = featherRings;
  // The margin the filters read: a ring for each normal round, with room for the fit, and Depth's
  // base, which reaches about three sizes.
  const margin = Math.max(
    plan.rounds || plan.passes ? 2 * (plan.rounds + plan.passes * (1 + blurRounds)) + 2 : 0,
    plan.depth ? Math.ceil((3 * plan.size) / Math.max(1e-9, step)) : 0,
  );
  const reach = new Int32Array(weldedCount).fill(-1);
  head = tail = 0;
  for (let v = 0; v < weldedCount; v++)
    if (ring[v] >= 0) {
      reach[v] = 0;
      queue[tail++] = v;
    }
  if (!tail) return null;
  const whole = !painted;
  if (!whole)
    while (head < tail) {
      const v = queue[head++];
      if (reach[v] >= margin) continue;
      for (let i = neighbourStart[v]; i < neighbourStart[v + 1]; i++) {
        const w = neighbours[i];
        if (reach[w] >= 0) continue;
        reach[w] = reach[v] + 1;
        queue[tail++] = w;
      }
    }
  const local = new Int32Array(weldedCount).fill(-1);
  let count = 0;
  for (let v = 0; v < weldedCount; v++) if (reach[v] >= 0) local[v] = count++;
  const vertex = new Uint32Array(count);
  for (let v = 0; v < weldedCount; v++) if (local[v] >= 0) vertex[local[v]] = v;
  // Triangles with every corner in the set.
  let faceCount = 0;
  const keep = (t: number) => {
    const a = corner(t, 0),
      b = corner(t, 1),
      c = corner(t, 2);
    return local[a] >= 0 && local[b] >= 0 && local[c] >= 0 && a !== b && b !== c && a !== c;
  };
  for (let t = 0; t < triangleCount; t++) if (keep(t)) faceCount++;
  const triangle = new Uint32Array(faceCount);
  const corners = new Uint32Array(faceCount * 3);
  const geometry = new Uint32Array(faceCount * 3);
  for (let t = 0, f = 0; t < triangleCount; t++) {
    if (!keep(t)) continue;
    triangle[f] = t;
    for (let k = 0; k < 3; k++) {
      corners[f * 3 + k] = local[corner(t, k)];
      geometry[f * 3 + k] = geometryCorners[t * 3 + k];
    }
    f++;
  }
  const faceStart = new Uint32Array(count + 1);
  for (let i = 0; i < corners.length; i++) faceStart[corners[i] + 1]++;
  for (let i = 0; i < count; i++) faceStart[i + 1] += faceStart[i];
  const faces = new Uint32Array(corners.length);
  const fill = faceStart.slice(0, count);
  for (let i = 0; i < corners.length; i++) faces[fill[corners[i]]++] = (i / 3) | 0;
  const localStart = new Uint32Array(count + 1);
  const fixed = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const v = vertex[i];
    for (let j = neighbourStart[v]; j < neighbourStart[v + 1]; j++)
      if (local[neighbours[j]] >= 0) localStart[i + 1]++;
      else fixed[i] = 1;
  }
  for (let i = 0; i < count; i++) localStart[i + 1] += localStart[i];
  const localNeighbours = new Uint32Array(localStart[count]);
  for (let i = 0, o = 0; i < count; i++) {
    const v = vertex[i];
    for (let j = neighbourStart[v]; j < neighbourStart[v + 1]; j++)
      if (local[neighbours[j]] >= 0) localNeighbours[o++] = local[neighbours[j]];
  }
  const weight = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const v = vertex[i];
    // Open borders, refined edges, non-manifold vertices and those whose triangles are not all in
    // the set stay where they are.
    const around = triangleStart[v + 1] - triangleStart[v];
    const closedFan = around > 0 && around === neighbourStart[v + 1] - neighbourStart[v];
    if (ring[v] < 0 || !closedFan || faceStart[i + 1] - faceStart[i] !== around) continue;
    const t = Math.min(1, ring[v] / featherRings);
    weight[i] = t * t * (3 - 2 * t);
  }
  return {
    count,
    vertex,
    weight,
    fixed,
    corners,
    geometry,
    triangle,
    faceStart,
    faces,
    neighbourStart: localStart,
    neighbours: localNeighbours,
    sign: mesh.flipped ? -1 : 1,
  };
}

/** Unit normal, centroid and area of each local triangle at `position`. */
function faceGeometry(work: WorkingSet, position: Float64Array) {
  const n = work.triangle.length;
  const normal = new Float64Array(n * 3);
  const centre = new Float64Array(n * 3);
  const area = new Float64Array(n);
  faceNormals(work, position, normal, area);
  faceCentres(work, position, centre);
  return { normal, centre, area };
}

function faceNormals(work: WorkingSet, p: Float64Array, normal: Float64Array, area: Float64Array) {
  const { corners, sign } = work;
  for (let f = 0; f < area.length; f++) {
    const a = corners[f * 3] * 3,
      b = corners[f * 3 + 1] * 3,
      c = corners[f * 3 + 2] * 3;
    const ux = p[b] - p[a],
      uy = p[b + 1] - p[a + 1],
      uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a],
      vy = p[c + 1] - p[a + 1],
      vz = p[c + 2] - p[a + 2];
    const x = uy * vz - uz * vy,
      y = uz * vx - ux * vz,
      z = ux * vy - uy * vx;
    const length = Math.sqrt(x * x + y * y + z * z);
    area[f] = length / 2;
    const scale = length > 0 ? sign / length : 0;
    normal[f * 3] = x * scale;
    normal[f * 3 + 1] = y * scale;
    normal[f * 3 + 2] = z * scale;
  }
}

function faceCentres(work: WorkingSet, p: Float64Array, centre: Float64Array) {
  const { corners } = work;
  for (let f = 0; f < centre.length / 3; f++) {
    const a = corners[f * 3] * 3,
      b = corners[f * 3 + 1] * 3,
      c = corners[f * 3 + 2] * 3;
    for (let k = 0; k < 3; k++) centre[f * 3 + k] = (p[a + k] + p[b + k] + p[c + k]) / 3;
  }
}

/**
 * Bilateral filtering of the face normals over the triangles that share a vertex with each face,
 * weighted by area, by distance between centroids against their mean spacing, and by how near the
 * two normals are against `range`.
 */
function filterNormals(
  work: WorkingSet,
  position: Float64Array,
  rounds: number,
  progress: () => void,
) {
  const { corners, faceStart, faces } = work;
  const { normal, centre, area } = faceGeometry(work, position);
  const n = area.length;
  const stamp = new Int32Array(n).fill(-1);
  const around = (f: number, visit: (g: number) => void) => {
    stamp[f] = f;
    for (let k = 0; k < 3; k++) {
      const v = corners[f * 3 + k];
      for (let i = faceStart[v]; i < faceStart[v + 1]; i++) {
        const g = faces[i];
        if (stamp[g] === f) continue;
        stamp[g] = f;
        visit(g);
      }
    }
  };
  let total = 0,
    samples = 0;
  const stride = Math.max(1, Math.floor(n / 20000));
  for (let f = 0; f < n; f += stride)
    around(f, (g) => {
      total += Math.hypot(
        centre[g * 3] - centre[f * 3],
        centre[g * 3 + 1] - centre[f * 3 + 1],
        centre[g * 3 + 2] - centre[f * 3 + 2],
      );
      samples++;
    });
  stamp.fill(-1);
  const spacing = samples ? total / samples : 1;
  const spatial = 1 / (2 * spacing * spacing);
  const similar = 1 / (2 * range * range);
  let current = normal;
  let next = new Float64Array(n * 3);
  for (let round = 0; round < rounds; round++) {
    for (let f = 0; f < n; f++) {
      const cx = centre[f * 3],
        cy = centre[f * 3 + 1],
        cz = centre[f * 3 + 2];
      const nx = current[f * 3],
        ny = current[f * 3 + 1],
        nz = current[f * 3 + 2];
      let sx = area[f] * nx,
        sy = area[f] * ny,
        sz = area[f] * nz;
      stamp[f] = f + round * n;
      for (let k = 0; k < 3; k++) {
        const v = corners[f * 3 + k];
        for (let i = faceStart[v]; i < faceStart[v + 1]; i++) {
          const g = faces[i];
          if (stamp[g] === f + round * n) continue;
          stamp[g] = f + round * n;
          const dx = centre[g * 3] - cx,
            dy = centre[g * 3 + 1] - cy,
            dz = centre[g * 3 + 2] - cz;
          const mx = current[g * 3] - nx,
            my = current[g * 3 + 1] - ny,
            mz = current[g * 3 + 2] - nz;
          const w =
            area[g] *
            Math.exp(
              -(dx * dx + dy * dy + dz * dz) * spatial - (mx * mx + my * my + mz * mz) * similar,
            );
          sx += w * current[g * 3];
          sy += w * current[g * 3 + 1];
          sz += w * current[g * 3 + 2];
        }
      }
      const length = Math.sqrt(sx * sx + sy * sy + sz * sz);
      const scale = length > 0 ? 1 / length : 0;
      next[f * 3] = sx * scale;
      next[f * 3 + 1] = sy * scale;
      next[f * 3 + 2] = sz * scale;
    }
    [current, next] = [next, current];
    progress();
  }
  return current;
}

/**
 * Each face's normal plus `amount` times its difference from the area-weighted mean of the normals
 * within `blurRounds` rounds of averaging over the faces that share a vertex with it.
 */
function sharpenNormals(
  work: WorkingSet,
  position: Float64Array,
  normals: Float64Array,
  amount: number,
) {
  const { corners, faceStart, faces } = work;
  const n = normals.length / 3;
  const area = new Float64Array(n);
  faceNormals(work, position, new Float64Array(n * 3), area);
  const stamp = new Int32Array(n).fill(-1);
  let blur = normals.slice();
  let next = new Float64Array(n * 3);
  for (let round = 0; round < blurRounds; round++) {
    for (let f = 0; f < n; f++) {
      let sx = area[f] * blur[f * 3],
        sy = area[f] * blur[f * 3 + 1],
        sz = area[f] * blur[f * 3 + 2];
      const mark = f + round * n;
      stamp[f] = mark;
      for (let k = 0; k < 3; k++) {
        const v = corners[f * 3 + k];
        for (let i = faceStart[v]; i < faceStart[v + 1]; i++) {
          const g = faces[i];
          if (stamp[g] === mark) continue;
          stamp[g] = mark;
          sx += area[g] * blur[g * 3];
          sy += area[g] * blur[g * 3 + 1];
          sz += area[g] * blur[g * 3 + 2];
        }
      }
      const length = Math.sqrt(sx * sx + sy * sy + sz * sz);
      const scale = length > 0 ? 1 / length : 0;
      next[f * 3] = sx * scale;
      next[f * 3 + 1] = sy * scale;
      next[f * 3 + 2] = sz * scale;
    }
    [blur, next] = [next, blur];
  }
  const out = next;
  for (let f = 0; f < n; f++) {
    const k = f * 3;
    const x = normals[k] + amount * (normals[k] - blur[k]),
      y = normals[k + 1] + amount * (normals[k + 1] - blur[k + 1]),
      z = normals[k + 2] + amount * (normals[k + 2] - blur[k + 2]);
    const length = Math.sqrt(x * x + y * y + z * z);
    const scale = length > 0 ? 1 / length : 0;
    out[k] = x * scale;
    out[k + 1] = y * scale;
    out[k + 2] = z * scale;
  }
  return out;
}

/** Moves each weighted vertex toward the planes of its triangles under their filtered normals. */
function fitToNormals(
  work: WorkingSet,
  position: Float64Array,
  normals: Float64Array,
  rounds: number,
) {
  const { count, weight, faceStart, faces } = work;
  const centre = new Float64Array(normals.length);
  for (let round = 0; round < rounds; round++) {
    faceCentres(work, position, centre);
    for (let i = 0; i < count; i++) {
      if (!weight[i]) continue;
      const from = faceStart[i],
        to = faceStart[i + 1];
      const px = position[i * 3],
        py = position[i * 3 + 1],
        pz = position[i * 3 + 2];
      let dx = 0,
        dy = 0,
        dz = 0;
      for (let j = from; j < to; j++) {
        const f = faces[j] * 3;
        const nx = normals[f],
          ny = normals[f + 1],
          nz = normals[f + 2];
        const d = nx * (centre[f] - px) + ny * (centre[f + 1] - py) + nz * (centre[f + 2] - pz);
        dx += nx * d;
        dy += ny * d;
        dz += nz * d;
      }
      const scale = 1 / (to - from);
      position[i * 3] = px + dx * scale;
      position[i * 3 + 1] = py + dy * scale;
      position[i * 3 + 2] = pz + dz * scale;
    }
  }
}

/** One uniform Laplacian step over the set, holding fixed vertices: out = p + factor * (mean - p). */
function laplacian(work: WorkingSet, p: Float64Array, out: Float64Array, factor: number) {
  const { count, fixed, neighbourStart, neighbours } = work;
  for (let i = 0; i < count; i++) {
    const from = neighbourStart[i],
      to = neighbourStart[i + 1];
    const k = i * 3;
    if (fixed[i] || to === from) {
      out[k] = p[k];
      out[k + 1] = p[k + 1];
      out[k + 2] = p[k + 2];
      continue;
    }
    let x = 0,
      y = 0,
      z = 0;
    for (let j = from; j < to; j++) {
      const u = neighbours[j] * 3;
      x += p[u];
      y += p[u + 1];
      z += p[u + 2];
    }
    const inverse = 1 / (to - from);
    out[k] = p[k] + factor * (x * inverse - p[k]);
    out[k + 1] = p[k + 1] + factor * (y * inverse - p[k + 1]);
    out[k + 2] = p[k + 2] + factor * (z * inverse - p[k + 2]);
  }
}

/** Area-weighted vertex normals of the set at `p`, outward. */
function vertexNormals(work: WorkingSet, p: Float64Array) {
  const { count, faceStart, faces } = work;
  const normal = new Float64Array(work.triangle.length * 3);
  const area = new Float64Array(work.triangle.length);
  faceNormals(work, p, normal, area);
  const out = new Float64Array(count * 3);
  for (let i = 0; i < count; i++) {
    let x = 0,
      y = 0,
      z = 0;
    for (let j = faceStart[i]; j < faceStart[i + 1]; j++) {
      const f = faces[j];
      x += area[f] * normal[f * 3];
      y += area[f] * normal[f * 3 + 1];
      z += area[f] * normal[f * 3 + 2];
    }
    const length = Math.sqrt(x * x + y * y + z * z);
    const scale = length > 0 ? 1 / length : 0;
    out[i * 3] = x * scale;
    out[i * 3 + 1] = y * scale;
    out[i * 3 + 2] = z * scale;
  }
  return out;
}

/** The unsharp mask: relief above a Taubin base, averaged, thresholded and added `depth` times. */
function deepen(
  work: WorkingSet,
  position: Float64Array,
  plan: ReturnType<typeof cleanPlan>,
  threshold: number,
  progress: (fraction: number) => void,
) {
  const { count, weight, neighbourStart, neighbours } = work;
  const mu = 1 / (plan.pass - 1 / lambda);
  let base = position.slice(),
    spare = new Float64Array(position.length);
  for (let round = 0; round < plan.baseRounds; round++) {
    laplacian(work, base, spare, lambda);
    laplacian(work, spare, base, mu);
    if (round % 16 === 15) progress((0.9 * (round + 1)) / plan.baseRounds);
  }
  const normal = vertexNormals(work, base);
  let relief = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const k = i * 3;
    relief[i] =
      (position[k] - base[k]) * normal[k] +
      (position[k + 1] - base[k + 1]) * normal[k + 1] +
      (position[k + 2] - base[k + 2]) * normal[k + 2];
  }
  let averaged = new Float64Array(count);
  for (let pass = 0; pass < reliefPasses; pass++) {
    for (let i = 0; i < count; i++) {
      let sum = relief[i],
        n = 1;
      for (let j = neighbourStart[i]; j < neighbourStart[i + 1]; j++) {
        sum += relief[neighbours[j]];
        n++;
      }
      averaged[i] = sum / n;
    }
    [relief, averaged] = [averaged, relief];
  }
  const out = position.slice();
  const t2 = threshold * threshold;
  for (let i = 0; i < count; i++) {
    if (!weight[i]) continue;
    const h = relief[i];
    const lift = weight[i] * plan.depth * h * ((h * h) / (h * h + t2));
    const k = i * 3;
    out[k] += lift * normal[k];
    out[k + 1] += lift * normal[k + 1];
    out[k + 2] += lift * normal[k + 2];
  }
  progress(1);
  return out;
}

/**
 * Halves the moves of the corners of each triangle that would turn over or collapse, up to
 * `halvings` times, then returns those still at fault to where they started. Returns how many
 * vertices did not move as far as cleaning asked.
 */
function holdFolds(work: WorkingSet, start: Float64Array, position: Float64Array) {
  const { corners } = work;
  const n = work.triangle.length;
  const before = new Float64Array(n * 3);
  const area = new Float64Array(n);
  faceNormals(work, start, before, area);
  const startArea = area.slice();
  const after = new Float64Array(n * 3);
  const flagged = new Uint8Array(work.count);
  const reduced = new Uint8Array(work.count);
  for (let round = 0; round <= halvings; round++) {
    faceNormals(work, position, after, area);
    flagged.fill(0);
    let any = false;
    for (let f = 0; f < n; f++) {
      const a = corners[f * 3],
        b = corners[f * 3 + 1],
        c = corners[f * 3 + 2];
      if (
        !changed(start, position, a) &&
        !changed(start, position, b) &&
        !changed(start, position, c)
      )
        continue;
      const turned =
        before[f * 3] * after[f * 3] +
          before[f * 3 + 1] * after[f * 3 + 1] +
          before[f * 3 + 2] * after[f * 3 + 2] <=
        0;
      if (!turned && area[f] >= collapse * startArea[f]) continue;
      flagged[a] = flagged[b] = flagged[c] = 1;
      any = true;
    }
    if (!any) break;
    for (let i = 0; i < work.count; i++) {
      if (!flagged[i]) continue;
      reduced[i] = 1;
      const last = round === halvings;
      for (let a = 0; a < 3; a++) {
        const k = i * 3 + a;
        position[k] = last ? start[k] : start[k] + 0.5 * (position[k] - start[k]);
      }
    }
  }
  let held = 0;
  for (let i = 0; i < work.count; i++) if (reduced[i]) held++;
  return held;
}

/**
 * Flips edges between moved vertices where the other diagonal of their two triangles bends the
 * surface less, so an edge that sharpening made crisp runs along triangle edges instead of
 * zigzagging across them. The bending of the five edges a flip changes is each edge's length times
 * the angle between the normals of its two triangles; minimising its sum recovers sharp edges from a
 * triangulation (Dyn, Hormann, Kim and Levin 2001). A flip must keep both triangles facing the way
 * the pair did, keep them well shaped, and not join two vertices already joined. Vertices do not
 * move. Returns the local triangles whose corners changed; `work.corners` and `work.geometry` are
 * updated in place.
 */
function alignEdges(work: WorkingSet, start: Float64Array, p: Float64Array): Uint32Array {
  const { corners: tri, geometry, faceStart, faces, weight, neighbourStart } = work;
  const slots = tri.length;
  const next = (s: number) => (s % 3 === 2 ? s - 2 : s + 1);
  const prev = (s: number) => (s % 3 === 0 ? s + 2 : s - 1);
  // The slot across each slot's edge, from the triangles around its far end.
  const opposite = new Int32Array(slots).fill(-1);
  for (let s = 0; s < slots; s++) {
    const a = tri[s],
      b = tri[next(s)];
    for (let i = faceStart[b]; i < faceStart[b + 1] && opposite[s] < 0; i++) {
      const t = faces[i] * 3;
      for (let k = 0; k < 3; k++)
        if (tri[t + k] === b && tri[t + ((k + 1) % 3)] === a) opposite[s] = t + k;
    }
  }
  const degree = new Int32Array(work.count);
  for (let i = 0; i < work.count; i++) degree[i] = neighbourStart[i + 1] - neighbourStart[i];
  const moved = (i: number) => weight[i] > 0 && changed(start, p, i);
  const faceCount = slots / 3;
  const normal = new Float64Array(slots);
  const area = new Float64Array(faceCount);
  faceNormals(work, p, normal, area);
  const unit = (a: number, b: number, c: number, out: Float64Array) => {
    const ux = p[b * 3] - p[a * 3],
      uy = p[b * 3 + 1] - p[a * 3 + 1],
      uz = p[b * 3 + 2] - p[a * 3 + 2];
    const vx = p[c * 3] - p[a * 3],
      vy = p[c * 3 + 1] - p[a * 3 + 1],
      vz = p[c * 3 + 2] - p[a * 3 + 2];
    const x = uy * vz - uz * vy,
      y = uz * vx - ux * vz,
      z = ux * vy - uy * vx;
    const length = Math.sqrt(x * x + y * y + z * z);
    const scale = length > 0 ? work.sign / length : 0;
    out[0] = x * scale;
    out[1] = y * scale;
    out[2] = z * scale;
    return length / 2;
  };
  const length = (a: number, b: number) =>
    Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2]);
  const angle = (x: ArrayLike<number>, i: number, y: ArrayLike<number>, j: number) =>
    Math.acos(Math.max(-1, Math.min(1, x[i] * y[j] + x[i + 1] * y[j + 1] + x[i + 2] * y[j + 2])));
  const quality = (area: number, a: number, b: number, c: number) =>
    (4 * Math.sqrt(3) * area) / (a * a + b * b + c * c);
  /** Whether `c` and `d` are joined, turning around `c` from its slot `from` both ways. */
  const joined = (from: number, d: number) => {
    let s = from;
    do {
      if (tri[next(s)] === d) return true;
      const o = opposite[prev(s)];
      if (o < 0) break;
      s = o;
    } while (s !== from);
    for (s = from; ;) {
      const o = opposite[s];
      if (o < 0) return false;
      s = next(o);
      if (s === from) return false;
      if (tri[next(s)] === d) return true;
    }
  };
  const m1 = new Float64Array(3),
    m2 = new Float64Array(3);
  const flipped = new Uint8Array(faceCount);
  for (let round = 0; round < flipRounds; round++) {
    let flips = 0;
    for (let s1 = 0; s1 < slots; s1++) {
      const s2 = opposite[s1];
      if (s2 < s1) continue;
      const t1 = (s1 / 3) | 0,
        t2 = (s2 / 3) | 0;
      const a = tri[s1],
        b = tri[next(s1)],
        c = tri[prev(s1)],
        d = tri[prev(s2)];
      if (c === d || degree[a] <= 3 || degree[b] <= 3) continue;
      if (!moved(a) || !moved(b) || !moved(c) || !moved(d)) continue;
      const n1 = t1 * 3,
        n2 = t2 * 3;
      const bend =
        normal[n1] * normal[n2] + normal[n1 + 1] * normal[n2 + 1] + normal[n1 + 2] * normal[n2 + 2];
      if (bend > flipBend) continue;
      const bc = next(s1),
        ca = prev(s1),
        ad = next(s2),
        db = prev(s2);
      const obc = opposite[bc],
        oca = opposite[ca],
        oad = opposite[ad],
        odb = opposite[db];
      if (obc < 0 || oca < 0 || oad < 0 || odb < 0) continue;
      const area1 = unit(c, a, d, m1),
        area2 = unit(d, b, c, m2);
      // Both new triangles face the way the pair does.
      const sx = normal[n1] + normal[n2],
        sy = normal[n1 + 1] + normal[n2 + 1],
        sz = normal[n1 + 2] + normal[n2 + 2];
      if (m1[0] * sx + m1[1] * sy + m1[2] * sz <= 0 || m2[0] * sx + m2[1] * sy + m2[2] * sz <= 0)
        continue;
      const lab = length(a, b),
        lcd = length(c, d),
        lbc = length(b, c),
        lca = length(c, a),
        lad = length(a, d),
        ldb = length(d, b);
      if (
        quality(area1, lca, lad, lcd) < flipQuality ||
        quality(area2, ldb, lbc, lcd) < flipQuality
      )
        continue;
      const face = (slot: number) => ((slot / 3) | 0) * 3;
      const before =
        lab * angle(normal, n1, normal, n2) +
        lbc * angle(normal, n1, normal, face(obc)) +
        lca * angle(normal, n1, normal, face(oca)) +
        lad * angle(normal, n2, normal, face(oad)) +
        ldb * angle(normal, n2, normal, face(odb));
      const after =
        lcd * angle(m1, 0, m2, 0) +
        lbc * angle(m2, 0, normal, face(obc)) +
        lca * angle(m1, 0, normal, face(oca)) +
        lad * angle(m1, 0, normal, face(oad)) +
        ldb * angle(m2, 0, normal, face(odb));
      if (after >= flipGain * before || joined(prev(s1), d)) continue;
      // t1 becomes (c, a, d) and t2 (d, b, c), each corner keeping a geometry vertex it had.
      const gc = geometry[prev(s1)],
        ga = geometry[s1],
        gb = geometry[s2],
        gd = geometry[prev(s2)];
      tri.set([c, a, d], n1);
      tri.set([d, b, c], n2);
      geometry.set([gc, ga, gd], n1);
      geometry.set([gd, gb, gc], n2);
      const link = (x: number, y: number) => {
        opposite[x] = y;
        opposite[y] = x;
      };
      link(n1, oca);
      link(n1 + 1, oad);
      link(n2, odb);
      link(n2 + 1, obc);
      link(n1 + 2, n2 + 2);
      normal.set(m1, n1);
      normal.set(m2, n2);
      degree[a]--;
      degree[b]--;
      degree[c]++;
      degree[d]++;
      flipped[t1] = flipped[t2] = 1;
      flips++;
    }
    if (!flips) break;
  }
  let total = 0;
  for (let f = 0; f < faceCount; f++) total += flipped[f];
  const out = new Uint32Array(total);
  for (let f = 0, i = 0; f < faceCount; f++) if (flipped[f]) out[i++] = f;
  return out;
}
