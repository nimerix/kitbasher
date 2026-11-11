import { Vector3 } from 'three';
import type { Matrix4 } from 'three';
import { hexColor } from './appearance';
import { uid } from './geometry';
import type { LightKind, SceneLight, SceneLighting, Vec3 } from './types';

export const lightingLimits = {
  exposure: { min: 0.1, max: 4, step: 0.05 },
  ambient: { min: 0, max: 5, step: 0.05 },
  hemisphere: { min: 0, max: 5, step: 0.05 },
  intensity: { min: 0, max: 10, step: 0.05 },
  range: { min: 0, max: 1_000_000, step: 1 },
  lights: 8,
} as const;

export type LightingPresetId = 'studio' | 'soft' | 'headlight' | 'dramatic';

const light = (
  id: string,
  name: string,
  position: Vec3,
  intensity: number,
  color: string,
  extra: Partial<SceneLight> = {},
): SceneLight => ({
  id,
  name,
  kind: 'directional',
  color,
  intensity,
  position,
  range: 0,
  castShadow: false,
  enabled: true,
  camera: false,
  ...extra,
});

export const lightingPresets: Record<
  LightingPresetId,
  { label: string; description: string; lighting: SceneLighting }
> = {
  studio: {
    label: 'Studio',
    description: 'Warm key, cool rim, and soft fill',
    lighting: {
      exposure: 1,
      ambient: 1,
      hemisphere: 1.25,
      sky: '#e6e9ef',
      ground: '#8b8073',
      shadows: true,
      lights: [
        light('key', 'Key', [90, 150, 90], 2.5, '#fff1dc', { castShadow: true }),
        light('rim', 'Rim', [-90, 80, -90], 2.2, '#d5e5f4'),
        light('fill', 'Fill', [-90, 40, 90], 0.6, '#ddd0b8'),
      ],
    },
  },
  soft: {
    label: 'Soft',
    description: 'Even light that shows colors truly',
    lighting: {
      exposure: 1.05,
      ambient: 1.8,
      hemisphere: 1.6,
      sky: '#eef1f5',
      ground: '#a39b90',
      shadows: false,
      lights: [
        light('key', 'Key', [60, 150, 110], 1.4, '#ffffff'),
        light('fill', 'Fill', [-110, 90, -40], 1, '#eef3fa'),
        light('front', 'Front', [0, 40, 160], 0.8, '#ffffff'),
      ],
    },
  },
  headlight: {
    label: 'Headlight',
    description: 'Lights whatever the camera faces',
    lighting: {
      exposure: 1,
      ambient: 0.5,
      hemisphere: 0.7,
      sky: '#e6e9ef',
      ground: '#8b8073',
      shadows: true,
      lights: [
        light('head', 'Headlight', [0.25, 0.35, 1], 2.8, '#ffffff', { camera: true }),
        light('key', 'Key', [90, 150, 90], 0.8, '#fff1dc', { castShadow: true }),
      ],
    },
  },
  dramatic: {
    label: 'Dramatic',
    description: 'Strong side light and deep shadow',
    lighting: {
      exposure: 1,
      ambient: 0.2,
      hemisphere: 0.35,
      sky: '#dfe6f0',
      ground: '#6f665c',
      shadows: true,
      lights: [
        light('key', 'Key', [140, 110, 30], 3.6, '#ffe6c7', { castShadow: true }),
        light('rim', 'Rim', [-70, 90, -140], 2.4, '#bcd4ff'),
      ],
    },
  },
};

export const lightingPresetIds = Object.keys(lightingPresets) as LightingPresetId[];

export const presetLighting = (id: LightingPresetId) => cloneLighting(lightingPresets[id].lighting);

export function cloneLighting(lighting: SceneLighting): SceneLighting {
  return {
    ...lighting,
    lights: lighting.lights.map((l) => ({ ...l, position: [...l.position] as Vec3 })),
  };
}

const finite3 = (value: unknown): value is Vec3 =>
  Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);

const clamp = (value: unknown, limit: { min: number; max: number }, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(limit.min, Math.min(limit.max, value))
    : fallback;

const colorOr = (value: unknown, fallback: string) =>
  typeof value === 'string' && hexColor.test(value) ? value : fallback;

const boolOr = (value: unknown, fallback: boolean) =>
  typeof value === 'boolean' ? value : fallback;

const kinds: LightKind[] = ['directional', 'point'];

function sanitizeLight(value: unknown): SceneLight | null {
  const source = (value && typeof value === 'object' ? value : null) as Record<
    string,
    unknown
  > | null;
  if (!source || typeof source.id !== 'string' || !source.id) return null;
  const kind = source.kind as LightKind;
  if (!kinds.includes(kind) || !finite3(source.position)) return null;
  // A directional light needs a direction.
  if (kind === 'directional' && source.position.every((v) => v === 0)) return null;
  return {
    id: source.id,
    name: typeof source.name === 'string' ? source.name : kind === 'point' ? 'Point' : 'Light',
    kind,
    color: colorOr(source.color, '#ffffff'),
    intensity: clamp(source.intensity, lightingLimits.intensity, 1),
    position: [...source.position] as Vec3,
    range: clamp(source.range, lightingLimits.range, 0),
    castShadow: boolOr(source.castShadow, false),
    enabled: boolOr(source.enabled, true),
    camera: boolOr(source.camera, false),
  };
}

/**
 * Returns lighting that is safe to render. Valid lighting comes back value-for-value, so
 * sanitizing again, or after a round trip through a file or the live view, changes nothing.
 */
export function sanitizeLighting(
  value: unknown,
  fallback: SceneLighting = lightingPresets.studio.lighting,
): SceneLighting {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return cloneLighting(fallback);
  const source = value as Record<string, unknown>;
  const ids = new Set<string>();
  const lights: SceneLight[] = [];
  for (const entry of Array.isArray(source.lights) ? source.lights : []) {
    const next = sanitizeLight(entry);
    if (!next || ids.has(next.id)) continue;
    ids.add(next.id);
    lights.push(next);
    if (lights.length === lightingLimits.lights) break;
  }
  return {
    exposure: clamp(source.exposure, lightingLimits.exposure, fallback.exposure),
    ambient: clamp(source.ambient, lightingLimits.ambient, fallback.ambient),
    hemisphere: clamp(source.hemisphere, lightingLimits.hemisphere, fallback.hemisphere),
    sky: colorOr(source.sky, fallback.sky),
    ground: colorOr(source.ground, fallback.ground),
    shadows: boolOr(source.shadows, fallback.shadows),
    lights,
  };
}

const storageKey = 'kitbasher.lighting';

/** The lighting a scene uses until it is changed: the user's saved default, or Studio. */
export function readDefaultLighting(): SceneLighting {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved) return sanitizeLighting(JSON.parse(saved));
  } catch {
    // Fall back to the built-in default.
  }
  return presetLighting('studio');
}

export function saveDefaultLighting(lighting: SceneLighting | null) {
  try {
    if (lighting) localStorage.setItem(storageKey, JSON.stringify(lighting));
    else localStorage.removeItem(storageKey);
  } catch {
    // The default still applies for this session when browser storage is unavailable.
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys)
    if (!sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
      return false;
  return true;
}

/** The preset this lighting matches exactly, or null once it has been customized. */
export function matchingPreset(lighting: SceneLighting): LightingPresetId | null {
  return lightingPresetIds.find((id) => sameValue(lighting, lightingPresets[id].lighting)) ?? null;
}

export function updateLight(
  lighting: SceneLighting,
  id: string,
  patch: Partial<Omit<SceneLight, 'id'>>,
): SceneLighting {
  return {
    ...lighting,
    lights: lighting.lights.map((l) => (l.id === id ? { ...l, ...patch } : l)),
  };
}

export function removeLight(lighting: SceneLighting, id: string): SceneLighting {
  return { ...lighting, lights: lighting.lights.filter((l) => l.id !== id) };
}

/** Adds a light, or returns null when the scene already has the most it can draw. */
export function addLight(
  lighting: SceneLighting,
  kind: LightKind,
  position?: Vec3,
): { lighting: SceneLighting; id: string } | null {
  if (lighting.lights.length >= lightingLimits.lights) return null;
  const id = uid();
  const count = lighting.lights.filter((l) => l.kind === kind).length + 1;
  const added =
    kind === 'point'
      ? light(id, `Point ${count}`, position ?? [0, 100, 60], 2, '#ffffff', { kind: 'point' })
      : light(id, `Light ${count}`, position ?? [80, 120, 100], 1.5, '#ffffff');
  return { lighting: { ...lighting, lights: [...lighting.lights, added] }, id };
}

const degrees = (radians: number) => (radians * 180) / Math.PI;
const radians = (deg: number) => (deg * Math.PI) / 180;

/** Azimuth from the front (+Z) toward the right (+X), and elevation above the ground, in degrees. */
export function lightAngles([x, y, z]: Vec3) {
  return {
    azimuth: degrees(Math.atan2(x, z)),
    elevation: degrees(Math.atan2(y, Math.hypot(x, z))),
  };
}

export function positionFromAngles(azimuth: number, elevation: number, length = 1): Vec3 {
  const a = radians(azimuth),
    e = radians(elevation);
  return [
    length * Math.cos(e) * Math.sin(a),
    length * Math.sin(e),
    length * Math.cos(e) * Math.cos(a),
  ];
}

/**
 * The same light in the camera's frame, or back in the world's, so turning Follow camera on or
 * off leaves it lighting from where it was. `camera` is the view camera's world matrix.
 */
export function reframeLight(light: SceneLight, camera: Matrix4, follow: boolean): SceneLight {
  if (light.camera === follow) return light;
  const matrix = follow ? camera.clone().invert() : camera;
  const position = new Vector3().fromArray(light.position);
  if (light.kind === 'directional')
    position.transformDirection(matrix).multiplyScalar(Math.hypot(...light.position));
  else position.applyMatrix4(matrix);
  return { ...light, camera: follow, position: position.toArray() };
}
