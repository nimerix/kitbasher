import { create } from 'zustand';

export const xrButtons = ['a', 'b', 'x', 'y', 'leftStick', 'rightStick'] as const;
export type XRButton = (typeof xrButtons)[number];
export type XRButtonAction =
  | 'none'
  | 'advance'
  | 'back'
  | 'undo'
  | 'redo'
  | 'tools'
  | 'panel'
  | 'precision'
  | 'erase'
  | 'frame'
  | 'previousView';
export type XRAxisAction = 'none' | 'translate' | 'rotate' | 'context' | 'world';
export type XRControllerHand = 'left' | 'right';

export const xrButtonLabels: Record<XRButton, string> = {
  a: 'A · right',
  b: 'B · right',
  x: 'X · left',
  y: 'Y · left',
  leftStick: 'Left stick click',
  rightStick: 'Right stick click',
};

export const xrButtonActions: { id: XRButtonAction; label: string }[] = [
  { id: 'none', label: 'Unassigned' },
  { id: 'advance', label: 'Advance / confirm' },
  { id: 'back', label: 'Step back' },
  { id: 'undo', label: 'Undo' },
  { id: 'redo', label: 'Redo' },
  { id: 'tools', label: 'Toggle wrist tools' },
  { id: 'panel', label: 'Bring panel here' },
  { id: 'precision', label: 'Toggle precision' },
  { id: 'erase', label: 'Toggle brush eraser' },
  { id: 'frame', label: 'Frame visible' },
  { id: 'previousView', label: 'Previous view' },
];

export const xrAxisActions: { id: XRAxisAction; label: string }[] = [
  { id: 'none', label: 'Unassigned' },
  { id: 'translate', label: 'Move selection' },
  { id: 'rotate', label: 'Rotate selection' },
  { id: 'context', label: 'Active tool adjustment' },
  { id: 'world', label: 'World zoom / turn' },
];

export interface XRInputSettings {
  buttons: Record<XRButton, XRButtonAction>;
  axes: Record<XRControllerHand, XRAxisAction>;
  dominantHand: XRControllerHand;
  deadzone: number;
  /** Multiplier for deliberate thumbstick zoom; direct hand tracking stays one-to-one. */
  zoomSpeed: number;
  turnAngle: 15 | 30 | 45;
  /** Legacy controller behavior: a trigger miss or locked part drags the world. */
  triggerWorld: boolean;
}

export const defaultXRInputSettings: XRInputSettings = {
  buttons: {
    a: 'advance',
    b: 'back',
    x: 'undo',
    y: 'tools',
    leftStick: 'panel',
    rightStick: 'precision',
  },
  axes: { left: 'translate', right: 'context' },
  dominantHand: 'right',
  deadzone: 0.18,
  zoomSpeed: 1,
  turnAngle: 30,
  triggerWorld: false,
};

const storageKey = 'kitbasher.xr-input';
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Stored values never introduce unknown actions or unusable stick ranges. */
export function sanitizeXRInputSettings(value: unknown): XRInputSettings {
  const source = object(value),
    buttons = object(source.buttons),
    axes = object(source.axes);
  const defaults = defaultXRInputSettings;
  return {
    buttons: Object.fromEntries(
      xrButtons.map((button) => [
        button,
        xrButtonActions.some((action) => action.id === buttons[button])
          ? buttons[button]
          : defaults.buttons[button],
      ]),
    ) as XRInputSettings['buttons'],
    axes: Object.fromEntries(
      (['left', 'right'] as const).map((hand) => [
        hand,
        xrAxisActions.some((action) => action.id === axes[hand]) ? axes[hand] : defaults.axes[hand],
      ]),
    ) as XRInputSettings['axes'],
    dominantHand: source.dominantHand === 'left' ? 'left' : 'right',
    deadzone:
      typeof source.deadzone === 'number' && Number.isFinite(source.deadzone)
        ? Math.max(0.05, Math.min(0.5, source.deadzone))
        : defaults.deadzone,
    zoomSpeed:
      typeof source.zoomSpeed === 'number' && Number.isFinite(source.zoomSpeed)
        ? Math.max(0.25, Math.min(2, source.zoomSpeed))
        : defaults.zoomSpeed,
    turnAngle:
      source.turnAngle === 15 || source.turnAngle === 30 || source.turnAngle === 45
        ? source.turnAngle
        : defaults.turnAngle,
    triggerWorld:
      typeof source.triggerWorld === 'boolean' ? source.triggerWorld : defaults.triggerWorld,
  };
}

export function readXRInputSettings(): XRInputSettings {
  try {
    return sanitizeXRInputSettings(JSON.parse(localStorage.getItem(storageKey) ?? 'null'));
  } catch {
    return sanitizeXRInputSettings(null);
  }
}

export function saveXRInputSettings(settings: XRInputSettings) {
  try {
    localStorage.setItem(storageKey, JSON.stringify({ version: 1, ...settings }));
  } catch {
    // Controls still work for this session when storage is unavailable.
  }
}

interface XRInputState {
  settings: XRInputSettings;
  setSettings: (patch: Partial<XRInputSettings>) => void;
  reset: () => void;
}

export const useXRInput = create<XRInputState>((set, get) => {
  const update = (settings: XRInputSettings) => {
    saveXRInputSettings(settings);
    set({ settings });
  };
  return {
    settings: readXRInputSettings(),
    setSettings: (patch) => {
      const current = get().settings;
      update(
        sanitizeXRInputSettings({
          ...current,
          ...patch,
          buttons: { ...current.buttons, ...patch.buttons },
          axes: { ...current.axes, ...patch.axes },
        }),
      );
    },
    reset: () => update(sanitizeXRInputSettings(null)),
  };
});

if (typeof window !== 'undefined')
  window.addEventListener('storage', (event) => {
    if (event.key === storageKey || event.key === null)
      useXRInput.setState({ settings: readXRInputSettings() });
  });

/** The relevant part of a WebXR gamepad, also usable by controller simulations. */
export interface XRGamepadInput {
  mapping: string;
  buttons: readonly { pressed: boolean }[];
  axes: readonly number[];
}

/** Quest face buttons follow the reserved xr-standard trigger, grip, pad, and stick slots. */
export function readXRButtons(
  hand: XRHandedness,
  gamepad: XRGamepadInput | null | undefined,
  previous: ReadonlySet<XRButton> = new Set(),
): { pressed: Set<XRButton>; down: XRButton[] } {
  const pressed = new Set<XRButton>();
  if (gamepad?.mapping === 'xr-standard' && (hand === 'left' || hand === 'right')) {
    const entries: [XRButton, number][] =
      hand === 'left'
        ? [
            ['x', 4],
            ['y', 5],
            ['leftStick', 3],
          ]
        : [
            ['a', 4],
            ['b', 5],
            ['rightStick', 3],
          ];
    for (const [button, index] of entries) if (gamepad.buttons[index]?.pressed) pressed.add(button);
  }
  return { pressed, down: [...pressed].filter((button) => !previous.has(button)) };
}

/** Radial deadzone keeps diagonals even and gives the remaining travel its full range. */
export function readXRStick(
  gamepad: XRGamepadInput | null | undefined,
  deadzone: number,
): [number, number] {
  if (gamepad?.mapping !== 'xr-standard') return [0, 0];
  const x = gamepad.axes[2],
    y = gamepad.axes[3];
  if (!Number.isFinite(x) || !Number.isFinite(y)) return [0, 0];
  const length = Math.hypot(x, y);
  const zone = Number.isFinite(deadzone) ? Math.max(0.05, Math.min(0.5, deadzone)) : 0.18;
  if (length <= zone) return [0, 0];
  const magnitude = (Math.min(1, length) - zone) / (1 - zone);
  return [(x / length) * magnitude, (y / length) * magnitude];
}
