import { create } from 'zustand';
import {
  assignBinding,
  bindingsFor,
  formatBindings,
  removeBinding,
  resetBindings,
  sanitizeOverrides,
} from './keybindings';
import type { KeyActionId, KeyBindingOverrides } from './keybindings';
import type { ZoomSettings } from './zoom';

export type LabelStyle = 'inline' | 'callout';

export interface MarkerSettings {
  /** Point diameter in screen pixels. */
  size: number;
  labelSize: number;
  style: LabelStyle;
  /** Local label spacing in pixels; crowded labels can move a little farther. */
  leader: number;
}

export interface Preferences {
  transform: { scaling: boolean };
  zoom: ZoomSettings;
  markers: MarkerSettings;
  keybindings: KeyBindingOverrides;
}

export type PreferencesTab = 'navigation' | 'markers' | 'keyboard' | 'headset';

export const defaultPreferences: Preferences = {
  transform: { scaling: true },
  zoom: { sensitivity: 1, curve: 0.5, smoothing: 40, invert: false },
  markers: {
    size: 8,
    labelSize: 12,
    style: 'inline',
    leader: 24,
  },
  keybindings: {},
};

export const preferenceLimits = {
  sensitivity: { min: 0.1, max: 4, step: 0.05 },
  curve: { min: 0.2, max: 2, step: 0.05 },
  smoothing: { min: 0, max: 100, step: 1 },
  size: { min: 4, max: 24, step: 1 },
  labelSize: { min: 12, max: 18, step: 1 },
  leader: { min: 16, max: 48, step: 1 },
} as const;

const storageKey = 'kitbasher.preferences';

function number(value: unknown, limit: { min: number; max: number }, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(limit.min, Math.min(limit.max, value))
    : fallback;
}

function pick<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback;
}

export function sanitizePreferences(value: unknown): Preferences {
  const source = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const zoom = (source.zoom ?? {}) as Record<string, unknown>;
  const markers = (source.markers ?? {}) as Record<string, unknown>;
  const transform = (source.transform ?? {}) as Record<string, unknown>;
  const z = defaultPreferences.zoom,
    m = defaultPreferences.markers;
  return {
    transform: { scaling: typeof transform.scaling === 'boolean' ? transform.scaling : true },
    zoom: {
      sensitivity: number(zoom.sensitivity, preferenceLimits.sensitivity, z.sensitivity),
      curve: number(zoom.curve, preferenceLimits.curve, z.curve),
      smoothing: number(zoom.smoothing, preferenceLimits.smoothing, z.smoothing),
      invert: typeof zoom.invert === 'boolean' ? zoom.invert : z.invert,
    },
    markers: {
      size: number(markers.size, preferenceLimits.size, m.size),
      labelSize: number(markers.labelSize, preferenceLimits.labelSize, m.labelSize),
      style: pick(markers.style, ['inline', 'callout'], m.style),
      // Old model-clearance preferences caused screen-spanning routes. Start their
      // replacement at compact spacing; explicit old fixed lengths are safely clamped.
      leader:
        markers.placement === 'model'
          ? m.leader
          : number(markers.leader, preferenceLimits.leader, m.leader),
    },
    keybindings: sanitizeOverrides(source.keybindings),
  };
}

function readPreferences(): Preferences {
  try {
    const saved = localStorage.getItem(storageKey);
    return saved ? sanitizePreferences(JSON.parse(saved)) : defaultPreferences;
  } catch {
    return defaultPreferences;
  }
}

function writePreferences({ zoom, markers, keybindings, transform }: Preferences) {
  try {
    localStorage.setItem(
      storageKey,
      JSON.stringify({ version: 1, zoom, markers, keybindings, transform }),
    );
  } catch {
    // Preferences still apply for this session when browser storage is unavailable.
  }
}

interface PreferencesState extends Preferences {
  panel: PreferencesTab | null;
  openPanel: (tab?: PreferencesTab) => void;
  closePanel: () => void;
  setZoom: (patch: Partial<ZoomSettings>) => void;
  setMarkers: (patch: Partial<MarkerSettings>) => void;
  setTransformScaling: (scaling: boolean) => void;
  /** Returns the actions that lost the binding to this one. */
  assignBinding: (id: KeyActionId, binding: string, replace?: string) => KeyActionId[];
  removeBinding: (id: KeyActionId, binding: string) => void;
  resetBindings: (id?: KeyActionId) => void;
  resetSection: (section: 'zoom' | 'markers') => void;
}

export const usePreferences = create<PreferencesState>((set, get) => {
  const update = (patch: Partial<Preferences>) => {
    set(patch);
    writePreferences(get());
  };
  return {
    ...readPreferences(),
    panel: null,
    openPanel: (tab) => set((state) => ({ panel: tab ?? state.panel ?? 'navigation' })),
    closePanel: () => set({ panel: null }),
    setTransformScaling: (scaling) => update({ transform: { scaling } }),
    setZoom: (patch) =>
      update({ zoom: sanitizePreferences({ zoom: { ...get().zoom, ...patch } }).zoom }),
    setMarkers: (patch) =>
      update({
        markers: sanitizePreferences({ markers: { ...get().markers, ...patch } }).markers,
      }),
    assignBinding: (id, binding, replace) => {
      const result = assignBinding(get().keybindings, id, binding, replace);
      update({ keybindings: result.overrides });
      return result.displaced;
    },
    removeBinding: (id, binding) =>
      update({ keybindings: removeBinding(get().keybindings, id, binding) }),
    resetBindings: (id) => update({ keybindings: id ? resetBindings(get().keybindings, id) : {} }),
    resetSection: (section) => update({ [section]: defaultPreferences[section] }),
  };
});

if (typeof window !== 'undefined')
  // Another tab changed them, so keep every open workbench in step.
  window.addEventListener('storage', (event) => {
    if (event.key === storageKey || event.key === null) usePreferences.setState(readPreferences());
  });

/** All bindings of an action, ready to display, such as `Del / ⌫`. Empty when unbound. */
export function shortcutText(id: KeyActionId) {
  return formatBindings(bindingsFor(id, usePreferences.getState().keybindings));
}

/** The first binding of an action, for compact hints such as tooltips. */
export function primaryShortcutText(id: KeyActionId) {
  return formatBindings(bindingsFor(id, usePreferences.getState().keybindings).slice(0, 1));
}

/** Subscribes so a hint updates as soon as the binding changes. */
export function useShortcut(id: KeyActionId, all = false) {
  usePreferences((state) => state.keybindings[id]);
  return all ? shortcutText(id) : primaryShortcutText(id);
}

/** `Move (G)`, or just `Move` when the action has no binding. */
export function withShortcut(label: string, shortcut: string) {
  return shortcut ? `${label} (${shortcut})` : label;
}
