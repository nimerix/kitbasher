import { Matrix4, Vector3 } from 'three';
import { partMatrix, quat, vec } from './geometry';
import type { ProximitySource } from './proximity';
import type { IsolationSettings, Part, ViewSettings } from './types';

export const isolationLimits = { min: 0, max: 200, step: 0.5 } as const;
export const defaultIsolationSettings: IsolationSettings = { nearby: false, distance: 2 };

const storageKey = 'kitbasher.isolation';

export function sanitizeIsolationSettings(
  value: unknown,
  fallback = defaultIsolationSettings,
): IsolationSettings {
  const source = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const distance = source.distance;
  return {
    nearby: typeof source.nearby === 'boolean' ? source.nearby : fallback.nearby,
    distance:
      typeof distance === 'number' && Number.isFinite(distance)
        ? Math.max(isolationLimits.min, Math.min(isolationLimits.max, distance))
        : fallback.distance,
  };
}

export function readIsolationSettings(): IsolationSettings {
  try {
    const saved = localStorage.getItem(storageKey);
    return saved ? sanitizeIsolationSettings(JSON.parse(saved)) : defaultIsolationSettings;
  } catch {
    return defaultIsolationSettings;
  }
}

/** Only the distance outlasts a session. Each isolation says whether it shows nearby surfaces. */
export function saveIsolationSettings(settings: IsolationSettings) {
  try {
    localStorage.setItem(storageKey, JSON.stringify({ distance: settings.distance }));
  } catch {
    // The setting still applies for this session when browser storage is unavailable.
  }
}

/** Nearby surfaces follow real placement, so they pause while parts are drawn apart or as ghosts. */
export const showsNearby = (view: ViewSettings) =>
  view.isolation.nearby && !view.explode && !view.inspection.enabled;

/**
 * Whether an isolated view leaves a part out entirely. `nearby` lists the other parts close
 * enough to be drawn in part. Isolation only changes what is drawn: the part stays in the
 * assembly.
 */
export const hiddenByIsolation = (isolated: string[] | null, nearby: string[] | null, id: string) =>
  !!isolated && !isolated.includes(id) && !nearby?.includes(id);

/** What the isolate command does next: the parts to isolate, or null to show everything. */
export function nextIsolation(parts: Part[], selected: string[], isolated: string[] | null) {
  const ids = selected.filter((id) => parts.some((part) => part.id === id && part.visible));
  const same =
    !!isolated && ids.length === isolated.length && ids.every((id) => isolated.includes(id));
  return ids.length && !same ? ids : null;
}

/** How far a distance field extends. Stepped, so nudging the distance reuses the field. */
export const nearbyReach = (distance: number) => Math.max(1, 2 ** Math.ceil(Math.log2(distance)));

/**
 * The largest field reading that is still drawn. A field is only valid out to its reach, which
 * matters while a wider one is being measured. Between grid nodes a touching surface reads up
 * to three quarters of a cell away, so a smaller limit would drop real contact.
 */
export const nearbyLimit = (distance: number, reach: number, cell: number) =>
  Math.max(Math.min(distance, reach), 0.75 * cell);

/** Everything a distance field around the isolated parts is measured from. */
export interface NearbySpec {
  parts: string[];
  sources: ProximitySource[];
  reach: number;
  /** The field's frame in the world. It rides on the first part, so moving it costs nothing. */
  frame: Matrix4;
}

export function nearbySpec(parts: Part[], isolated: string[], distance: number): NearbySpec | null {
  const shown = isolated
    .map((id) => parts.find((part) => part.id === id))
    .filter((part): part is Part => !!part?.visible);
  if (!shown.length) return null;
  const frame = new Matrix4().compose(
    vec(shown[0].position),
    quat(shown[0].quaternion),
    new Vector3(1, 1, 1),
  );
  const inverse = frame.clone().invert();
  return {
    parts: shown.map((part) => part.id),
    sources: shown.map((part) => ({
      geometry: part.geometry,
      matrix: inverse.clone().multiply(partMatrix(part)),
    })),
    reach: nearbyReach(distance),
    frame,
  };
}

/** Whether a field measured for one spec is still exact for another. */
export function sameField(a: NearbySpec, b: NearbySpec) {
  return (
    a.reach === b.reach &&
    a.sources.length === b.sources.length &&
    a.sources.every((source, i) => {
      const other = b.sources[i];
      return (
        a.parts[i] === b.parts[i] &&
        source.geometry === other.geometry &&
        source.matrix.elements.every(
          (value, j) =>
            Math.abs(value - other.matrix.elements[j]) <= 1e-6 * Math.max(1, Math.abs(value)),
        )
      );
    })
  );
}
