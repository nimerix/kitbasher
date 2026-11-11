import { Color, LinearSRGBColorSpace, Vector3 } from 'three';
import type { Part, PartColorMode } from './types';

export const hexColor = /^#[\da-f]{6}$/i;

export const partColorModes: { id: PartColorMode; label: string; description: string }[] = [
  { id: 'material', label: 'Material', description: 'The colors parts export with' },
  { id: 'editor', label: 'Editor', description: 'Editor colors where set, material elsewhere' },
  { id: 'distinct', label: 'Distinct', description: 'A different color for every part' },
];

export const defaultPartColorMode: PartColorMode = 'editor';
const storageKey = 'kitbasher.part-colors';

export function sanitizePartColorMode(value: unknown): PartColorMode {
  return partColorModes.some((mode) => mode.id === value)
    ? (value as PartColorMode)
    : defaultPartColorMode;
}

export function readPartColorMode(): PartColorMode {
  try {
    return sanitizePartColorMode(localStorage.getItem(storageKey));
  } catch {
    return defaultPartColorMode;
  }
}

export function savePartColorMode(mode: PartColorMode) {
  try {
    localStorage.setItem(storageKey, mode);
  } catch {
    // The mode still applies for this session when browser storage is unavailable.
  }
}

const linear = new Color();

/** The nearest displayable sRGB color and its OKLab coordinates, lowering chroma to fit. */
function oklch(lightness: number, chroma: number, hue: number) {
  const angle = (hue * Math.PI) / 180;
  // A chroma that is not finite would never step down into the gamut.
  for (let c = Number.isFinite(chroma) ? chroma : 0; ; c = Math.max(0, c - 0.005)) {
    const a = c * Math.cos(angle),
      b = c * Math.sin(angle);
    const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3,
      m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3,
      s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const rgb = [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
    if (c === 0 || rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4)) {
      const [r, g, bl] = rgb.map((v) => Math.min(1, Math.max(0, v)));
      return {
        hex: `#${linear.setRGB(r, g, bl, LinearSRGBColorSpace).getHexString()}`,
        lab: [lightness, a, b],
      };
    }
  }
}

export const oklchHex = (lightness: number, chroma: number, hue: number) =>
  oklch(lightness, chroma, hue).hex;

const tones = [0.62, 0.675, 0.73, 0.785, 0.84];
const hueStep = 5;
let palette: string[] | null = null;

/** Each color is the candidate farthest from all before it, so any first n stay far apart. */
function distinctPalette() {
  if (palette) return palette;
  const candidates = tones.flatMap((tone) =>
    Array.from({ length: 360 / hueStep }, (_, i) => oklch(tone, 0.14, 24 + i * hueStep)),
  );
  const nearest = candidates.map(() => Infinity);
  const order: string[] = [];
  for (let pick = Math.floor(tones.length / 2) * (360 / hueStep); pick >= 0;) {
    const chosen = candidates[pick].lab;
    order.push(candidates[pick].hex);
    nearest[pick] = -1;
    let next = -1;
    candidates.forEach(({ lab }, i) => {
      if (nearest[i] < 0) return;
      nearest[i] = Math.min(
        nearest[i],
        Math.hypot(lab[0] - chosen[0], lab[1] - chosen[1], lab[2] - chosen[2]),
      );
      if (next < 0 || nearest[i] > nearest[next]) next = i;
    });
    pick = next;
  }
  return (palette = order);
}

export function distinctColor(index: number) {
  const colors = distinctPalette();
  return colors[index % colors.length];
}

/** One color per part, by its place in the scene, so moving parts never recolors them. */
export function distinctColors(parts: readonly { id: string }[]) {
  return new Map(parts.map((part, index) => [part.id, distinctColor(index)]));
}

/** How the viewport paints a part. Overrides replace per-vertex colors so they show. */
export function shownColor(part: Part, mode: PartColorMode, distinct?: string) {
  const override =
    mode === 'material'
      ? undefined
      : (part.displayColor ?? (mode === 'distinct' ? distinct : undefined));
  return override
    ? { color: override, vertexColors: false }
    : { color: part.color, vertexColors: !!part.geometry.getAttribute('color') };
}

const dominantCache = new WeakMap<object, [number, number, number][]>();
const tint = new Color(),
  mixed = new Color();
const corners = [new Vector3(), new Vector3(), new Vector3()];

/** The one or two vertex colors covering most of a mesh's area, sampled so dense scans stay cheap. */
function dominantColors(geometry: Part['geometry']) {
  let colors = dominantCache.get(geometry);
  if (colors) return colors;
  const color = geometry.getAttribute('color'),
    position = geometry.getAttribute('position'),
    index = geometry.index;
  const triangles = Math.floor((index ? index.count : position.count) / 3);
  const stride = Math.max(1, Math.floor(triangles / 20000));
  const bins = new Map<number, [number, number, number, number]>();
  let total = 0;
  for (let t = 0; t < triangles; t += stride) {
    const vertex = (k: number) => (index ? index.getX(t * 3 + k) : t * 3 + k);
    corners.forEach((corner, k) => corner.fromBufferAttribute(position, vertex(k)));
    const area = corners[1].sub(corners[0]).cross(corners[2].sub(corners[0])).length();
    const first = vertex(0),
      r = color.getX(first),
      g = color.getY(first),
      b = color.getZ(first);
    const key = (Math.round(r * 15) << 8) | (Math.round(g * 15) << 4) | Math.round(b * 15);
    const bin = bins.get(key) ?? [0, 0, 0, 0];
    bin[0] += area;
    bin[1] += r * area;
    bin[2] += g * area;
    bin[3] += b * area;
    bins.set(key, bin);
    total += area;
  }
  colors = [...bins.values()]
    .filter(([weight]) => weight > 0)
    .sort((a, b) => b[0] - a[0])
    .filter(([weight], i) => i === 0 || (i === 1 && weight > total * 0.2))
    .map(([weight, r, g, b]) => [r / weight, g / weight, b / weight]);
  dominantCache.set(geometry, colors);
  return colors;
}

/** The colors a part is painted with in the viewport, for swatches: one, or two for vertex colors. */
export function swatchColors(part: Part, mode: PartColorMode, distinct?: string) {
  const shown = shownColor(part, mode, distinct);
  if (!shown.vertexColors) return [shown.color];
  const colors = dominantColors(part.geometry);
  if (!colors.length) return [shown.color];
  tint.set(shown.color);
  return colors.map(
    ([r, g, b]) =>
      `#${mixed.setRGB(r * tint.r, g * tint.g, b * tint.b, LinearSRGBColorSpace).getHexString()}`,
  );
}

export const swatchBackground = (colors: string[]) =>
  colors.length > 1
    ? `linear-gradient(135deg, ${colors[0]} 0 50%, ${colors[1]} 50% 100%)`
    : colors[0];
