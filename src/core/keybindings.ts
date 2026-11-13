export type KeyGroup = 'Tools' | 'Camera' | 'Edit' | 'File';

interface KeyActionDefinition {
  group: KeyGroup;
  label: string;
  keys: readonly string[];
  /** Keeps firing while the key auto-repeats. */
  repeat?: boolean;
}

/**
 * Bindings are written as `Mod+Alt+Shift+Key`. Mod is ⌘ or Ctrl, and keys use their
 * unshifted name, so `Shift+.` is the period key with Shift held.
 */
export const keyActions = {
  select: { group: 'Tools', label: 'Select', keys: ['V'] },
  move: { group: 'Tools', label: 'Move', keys: ['G'] },
  rotate: { group: 'Tools', label: 'Rotate', keys: ['R'] },
  freeMove: { group: 'Tools', label: 'Free move with pointer', keys: ['Shift+G'] },
  freeRotate: { group: 'Tools', label: 'Free rotate with pointer', keys: ['Shift+R'] },
  scale: { group: 'Tools', label: 'Scale', keys: ['S'] },
  pivot: { group: 'Tools', label: 'Pick pivot on model', keys: ['P'] },
  align: { group: 'Tools', label: 'Align parts', keys: ['A'] },
  paint: { group: 'Tools', label: 'Paint contact surfaces', keys: ['B'] },
  anchors: { group: 'Tools', label: 'Rigid anchor fit', keys: ['K'] },
  joint: { group: 'Tools', label: 'Create joint', keys: ['J'] },
  measure: { group: 'Tools', label: 'Measure distance', keys: ['D'] },
  brushSmaller: { group: 'Tools', label: 'Shrink paint brush', keys: ['['], repeat: true },
  brushLarger: { group: 'Tools', label: 'Grow paint brush', keys: [']'], repeat: true },
  apply: { group: 'Tools', label: 'Apply alignment or joint', keys: ['Enter'] },
  cancel: { group: 'Tools', label: 'Cancel tool / clear selection', keys: ['Escape'] },
  orbitTool: { group: 'Camera', label: 'Orbit tool', keys: ['O'] },
  panTool: { group: 'Camera', label: 'Pan tool', keys: ['H'] },
  holdOrbit: { group: 'Camera', label: 'Orbit while held', keys: ['Space'] },
  centerOrbit: { group: 'Camera', label: 'Center orbit on selection', keys: ['.'] },
  orbitSelection: { group: 'Camera', label: 'Toggle orbit around selection', keys: ['Shift+.'] },
  focus: { group: 'Camera', label: 'Frame selection', keys: ['F'] },
  frameAll: { group: 'Camera', label: 'Frame all parts', keys: ['Home'] },
  isolate: { group: 'Camera', label: 'Isolate selection', keys: ['I'] },
  isolateNearby: { group: 'Camera', label: 'Isolate with nearby surfaces', keys: ['Shift+I'] },
  viewFront: { group: 'Camera', label: 'Front view', keys: ['1'] },
  viewRight: { group: 'Camera', label: 'Right view', keys: ['3'] },
  viewTop: { group: 'Camera', label: 'Top view', keys: ['7'] },
  projection: { group: 'Camera', label: 'Toggle projection', keys: ['5'] },
  undo: { group: 'Edit', label: 'Undo', keys: ['Mod+Z'] },
  redo: { group: 'Edit', label: 'Redo', keys: ['Mod+Shift+Z', 'Mod+Y'] },
  selectAll: { group: 'Edit', label: 'Select all components', keys: ['Mod+A'] },
  deselect: { group: 'Edit', label: 'Deselect all', keys: ['Mod+Shift+A'] },
  copy: { group: 'Edit', label: 'Copy components', keys: ['Mod+C'] },
  cut: { group: 'Edit', label: 'Cut components', keys: ['Mod+X'] },
  paste: { group: 'Edit', label: 'Paste components', keys: ['Mod+V'] },
  duplicate: { group: 'Edit', label: 'Duplicate selected', keys: ['Mod+D'] },
  rename: { group: 'Edit', label: 'Rename component', keys: ['F2'] },
  delete: { group: 'Edit', label: 'Delete unlocked parts', keys: ['Delete', 'Backspace'] },
  new: { group: 'File', label: 'New assembly', keys: ['Mod+N'] },
  open: { group: 'File', label: 'Open scene', keys: ['Mod+O'] },
  import: { group: 'File', label: 'Import parts', keys: ['Mod+I'] },
  save: { group: 'File', label: 'Save scene', keys: ['Mod+S', 'Mod+Shift+S'] },
  export: { group: 'File', label: 'Export assembly', keys: ['Mod+Shift+E'] },
  search: { group: 'File', label: 'Find a component', keys: ['Mod+F'] },
  help: { group: 'File', label: 'Keyboard shortcuts', keys: ['F1', '?'] },
  preferences: { group: 'File', label: 'Preferences', keys: ['Mod+,'] },
} satisfies Record<string, KeyActionDefinition>;

export type KeyActionId = keyof typeof keyActions;
export type KeyBindingOverrides = Partial<Record<KeyActionId, string[]>>;
export const keyActionIds = Object.keys(keyActions) as KeyActionId[];
export const keyGroups: KeyGroup[] = ['Tools', 'Camera', 'Edit', 'File'];

export const isKeyAction = (id: string): id is KeyActionId => Object.hasOwn(keyActions, id);
export const actionRepeats = (id: KeyActionId) => !!(keyActions[id] as KeyActionDefinition).repeat;

export function bindingsFor(id: KeyActionId, overrides: KeyBindingOverrides): readonly string[] {
  const own = overrides[id];
  if (own) return own;
  // A key the user gave to another action stays there, also when a later default wants it.
  const taken = Object.values(overrides).flat();
  const defaults: readonly string[] = keyActions[id].keys;
  return taken.length ? defaults.filter((key) => !taken.includes(key)) : defaults;
}

export interface KeyChord {
  mod: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

export function parseBinding(binding: string): KeyChord {
  const key =
    binding === '+' || binding.endsWith('++') ? '+' : binding.slice(binding.lastIndexOf('+') + 1);
  const modifiers = binding.slice(0, Math.max(0, binding.length - key.length - 1)).split('+');
  return {
    key,
    mod: modifiers.includes('Mod'),
    alt: modifiers.includes('Alt'),
    shift: modifiers.includes('Shift'),
  };
}

export function serializeChord(chord: KeyChord) {
  return [chord.mod && 'Mod', chord.alt && 'Alt', chord.shift && 'Shift', chord.key]
    .filter(Boolean)
    .join('+');
}

const punctuationCodes: Record<string, string> = {
  Period: '.',
  NumpadDecimal: '.',
  Comma: ',',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
};

/** The unshifted key printed on the physical key, independent of layout and modifiers. */
function physicalKey(code: string | undefined) {
  if (!code) return null;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return punctuationCodes[code] ?? null;
}

/**
 * With Num Lock off, the keypad reports navigation keys such as Delete, but its keys are
 * still bound by the character printed on them, as in Blender.
 */
function numpadKey(event: Pick<KeyInput, 'key' | 'code'>) {
  if (event.key.length === 1 || !event.code) return null;
  if (event.code === 'NumpadDecimal') return '.';
  return /^Numpad[0-9]$/.test(event.code) ? event.code.slice(6) : null;
}

export function keyName(key: string) {
  if (key === ' ' || key === 'Spacebar') return 'Space';
  if (key === 'Esc') return 'Escape';
  if (key === 'Del') return 'Delete';
  return key.length === 1 ? key.toUpperCase() : key;
}

const isSymbol = (key: string) => key.length === 1 && !/[A-Z0-9]/.test(key);
const isAsciiPrintable = (key: string) => key.length === 1 && key >= ' ' && key <= '~';
const modifierKeys = new Set([
  'Shift',
  'Control',
  'Meta',
  'Alt',
  'AltGraph',
  'CapsLock',
  'Fn',
  'OS',
  'Super',
  'Hyper',
]);

export interface KeyInput {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

type MatchStrength = 0 | 1 | 2 | 3;

/** 3: exact key, 2: symbol whose Shift is implied by the layout, 1: physical key fallback. */
function matchStrength(chord: KeyChord, event: KeyInput): MatchStrength {
  if (chord.mod !== (event.metaKey || event.ctrlKey) || chord.alt !== event.altKey) return 0;
  const key = numpadKey(event) ?? keyName(event.key);
  if (chord.key === key) {
    if (chord.shift === event.shiftKey) return 3;
    if (!chord.shift && event.shiftKey && isSymbol(key)) return 2;
    return 0;
  }
  const physical = physicalKey(event.code);
  if (!physical || chord.key !== physical || chord.shift !== event.shiftKey) return 0;
  // Alt, Shift on punctuation, and non-Latin layouts all change the typed character.
  const changed =
    event.altKey || (event.shiftKey && !/^[A-Z]$/.test(physical)) || !isAsciiPrintable(event.key);
  return changed ? 1 : 0;
}

export function matchKeyAction(
  event: KeyInput,
  overrides: KeyBindingOverrides,
  candidates: readonly KeyActionId[] = keyActionIds,
): KeyActionId | null {
  let best: KeyActionId | null = null,
    strength = 0;
  for (const id of candidates)
    for (const binding of bindingsFor(id, overrides)) {
      const next = matchStrength(parseBinding(binding), event);
      if (next > strength) {
        best = id;
        strength = next;
      }
    }
  return best;
}

/** The binding a key press records, or null for a lone modifier. */
export function bindingFromEvent(event: KeyInput): string | null {
  if (modifierKeys.has(event.key) || event.key === 'Dead' || event.key === 'Unidentified')
    return null;
  let key = numpadKey(event) ?? keyName(event.key);
  const physical = physicalKey(event.code);
  if (
    physical &&
    (event.altKey ||
      (event.shiftKey && isSymbol(key)) ||
      (event.key.length === 1 && !isAsciiPrintable(event.key)))
  )
    key = physical;
  return serializeChord({
    key,
    mod: event.metaKey || event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
  });
}

export const isApplePlatform = () =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

const keyLabels: Record<string, string> = {
  Escape: 'Esc',
  Delete: 'Del',
  Backspace: '⌫',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
};

export function formatBinding(binding: string, apple = isApplePlatform()) {
  const chord = parseBinding(binding);
  return [
    chord.mod && (apple ? '⌘' : 'Ctrl'),
    chord.alt && (apple ? '⌥' : 'Alt'),
    chord.shift && 'Shift',
    keyLabels[chord.key] ?? chord.key,
  ]
    .filter(Boolean)
    .join('+');
}

export function formatBindings(bindings: readonly string[], apple = isApplePlatform()) {
  return bindings.map((binding) => formatBinding(binding, apple)).join(' / ');
}

/**
 * Gives `binding` to `id`, taking it from any other action so one key never runs two
 * actions. Returns the new overrides and the actions that lost the binding.
 */
export function assignBinding(
  overrides: KeyBindingOverrides,
  id: KeyActionId,
  binding: string,
  replace?: string,
): { overrides: KeyBindingOverrides; displaced: KeyActionId[] } {
  const next: KeyBindingOverrides = { ...overrides };
  const displaced: KeyActionId[] = [];
  for (const other of keyActionIds) {
    if (other === id) continue;
    const current = bindingsFor(other, next);
    if (current.includes(binding)) {
      next[other] = current.filter((b) => b !== binding);
      displaced.push(other);
    }
  }
  const own = bindingsFor(id, next).filter((b) => b !== binding);
  const index = replace ? own.indexOf(replace) : -1;
  if (index >= 0) own.splice(index, 1, binding);
  else own.push(binding);
  next[id] = own;
  return { overrides: normalizeOverrides(next), displaced };
}

export function removeBinding(overrides: KeyBindingOverrides, id: KeyActionId, binding: string) {
  return normalizeOverrides({
    ...overrides,
    [id]: bindingsFor(id, overrides).filter((b) => b !== binding),
  });
}

export function resetBindings(overrides: KeyBindingOverrides, id: KeyActionId) {
  const next = { ...overrides };
  delete next[id];
  return next;
}

/** Overrides that equal the defaults are dropped, so later default changes still apply. */
function normalizeOverrides(overrides: KeyBindingOverrides): KeyBindingOverrides {
  const next: KeyBindingOverrides = {};
  for (const id of keyActionIds) {
    const value = overrides[id];
    if (!value) continue;
    const defaults = keyActions[id].keys;
    if (value.length !== defaults.length || value.some((b, i) => b !== defaults[i]))
      next[id] = value;
  }
  return next;
}

export function sanitizeOverrides(value: unknown): KeyBindingOverrides {
  if (!value || typeof value !== 'object') return {};
  const next: KeyBindingOverrides = {};
  for (const [id, bindings] of Object.entries(value)) {
    if (!isKeyAction(id) || !Array.isArray(bindings)) continue;
    next[id] = [
      ...new Set(bindings.filter((b): b is string => typeof b === 'string' && b.length > 0)),
    ].slice(0, 4);
  }
  return normalizeOverrides(next);
}
