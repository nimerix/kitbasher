import { downloadScene } from './files';
import { matchKeyAction } from './keybindings';
import type { KeyActionId, KeyInput } from './keybindings';
import { primaryShortcutText, usePreferences } from './preferences';
import { canRedo, canUndo, useEditor } from './store';
import type { SurfacePoint } from './types';

export async function saveCurrentScene() {
  const state = useEditor.getState();
  if (state.busy) return;
  const { revision } = state;
  state.setBusy('Preparing scene file…');
  try {
    await downloadScene(state.scene);
    state.markSaved(revision);
    state.notify('Scene file downloaded');
  } catch (error) {
    state.notify(`The scene could not be saved. ${(error as Error).message}`, 'error');
  } finally {
    state.setBusy(null);
  }
}

export interface CommandContext {
  openScene?: () => void;
  searchParts?: () => void;
  point?: SurfacePoint;
}

export function editorCommands(context: CommandContext = {}) {
  const state = useEditor.getState();
  const selected = state.scene.parts.filter((part) => state.selected.includes(part.id));
  const hasSelection = selected.length > 0;
  const editable = selected.some((part) => !part.locked);
  const idle = !state.busy;
  const command = (label: string, run: () => void, enabled = true, key?: KeyActionId) => ({
    label,
    run,
    enabled,
    shortcut: key ? primaryShortcutText(key) || undefined : undefined,
  });
  const updateSelected = (patch: { visible?: boolean; locked?: boolean }) =>
    state.patchParts(
      selected.map((part) => part.id),
      patch,
    );
  return {
    undo: command(
      'Undo',
      () => {
        if (
          state.tool === 'align' &&
          state.operation.mode === 'surface' &&
          state.paintHistory.length
        )
          state.undoPaintStroke();
        else state.undo();
      },
      idle && (canUndo(state) || state.paintHistory.length > 0),
      'undo',
    ),
    redo: command('Redo', state.redo, idle && canRedo(state), 'redo'),
    selectAll: command(
      'Select all components',
      state.selectAll,
      !!state.scene.parts.length,
      'selectAll',
    ),
    deselect: command('Deselect all', () => state.select(null), hasSelection, 'deselect'),
    copy: command('Copy components', () => state.copySelected(), hasSelection, 'copy'),
    cut: command('Cut components', () => state.copySelected(true), idle && editable, 'cut'),
    paste: command(
      'Paste components',
      state.pasteClipboard,
      idle && !!state.clipboard?.parts.length,
      'paste',
    ),
    duplicate: command(
      'Duplicate selected',
      state.duplicateSelected,
      idle && hasSelection,
      'duplicate',
    ),
    rename: command(
      'Rename component…',
      () => state.setModal('rename'),
      idle && selected.length === 1,
      'rename',
    ),
    delete: command('Delete unlocked parts', state.deleteSelected, idle && editable, 'delete'),
    move: command('Move', () => state.setTool('translate'), idle && editable, 'move'),
    rotate: command('Rotate', () => state.setTool('rotate'), idle && editable, 'rotate'),
    scale: command('Scale', () => state.setTool('scale'), idle && editable, 'scale'),
    focus: command(
      'Frame selection',
      () => state.focus(),
      selected.some((part) => part.visible),
      'focus',
    ),
    frameAll: command(
      'Frame all parts',
      () => state.focus(undefined, true),
      state.scene.parts.some((part) => part.visible),
      'frameAll',
    ),
    centerOrbit: command(
      'Center orbit on selection',
      state.centerOrbit,
      selected.some((part) => part.visible),
      'centerOrbit',
    ),
    pivot: command(
      context.point ? 'Set pivot here' : 'Pick pivot on model',
      () => (context.point ? state.setPartPivot(context.point) : state.setPivotPicking(true)),
      idle &&
        (context.point
          ? state.scene.parts.some((part) => part.id === context.point!.partId && part.visible)
          : hasSelection),
      context.point ? undefined : 'pivot',
    ),
    align: command('Align parts', () => state.setTool('align'), idle && editable, 'align'),
    paint: command(
      'Paint contact surfaces',
      () => {
        state.setTool('align');
        useEditor.getState().setOperation({ mode: 'surface' });
      },
      idle && editable,
      'paint',
    ),
    joint: command('Create joint', () => state.setTool('joint'), idle && editable, 'joint'),
    merge: command(
      'Merge selected parts…',
      () => state.setModal('merge'),
      idle && selected.length >= 2 && selected.every((part) => !part.locked),
    ),
    inspect: command(
      'Inspect selected interfaces',
      () =>
        state.setView({
          explode: 0,
          inspection: { ...state.view.inspection, enabled: true, scope: 'selected' },
        }),
      selected.filter((part) => part.visible).length >= 2,
    ),
    hide: command(
      'Hide selected',
      () => updateSelected({ visible: false }),
      idle && selected.some((part) => part.visible),
    ),
    isolate: command(
      'Isolate selected',
      state.isolateSelected,
      idle &&
        hasSelection &&
        state.scene.parts.some((part) => part.visible !== state.selected.includes(part.id)),
    ),
    showAll: command(
      'Show all parts',
      () =>
        state.patchParts(
          state.scene.parts.filter((part) => !part.visible).map((part) => part.id),
          { visible: true },
        ),
      idle && state.scene.parts.some((part) => !part.visible),
    ),
    lock: command('Lock selected', () => updateSelected({ locked: true }), idle && editable),
    unlock: command(
      'Unlock selected',
      () => updateSelected({ locked: false }),
      idle && selected.some((part) => part.locked),
    ),
    new: command('New assembly…', () => state.setModal('new'), idle, 'new'),
    open: command('Open scene…', () => context.openScene?.(), idle && !!context.openScene, 'open'),
    import: command('Import parts…', () => state.setModal('import'), idle, 'import'),
    save: command('Save scene', saveCurrentScene, true, 'save'),
    export: command(
      'Export assembly…',
      () => state.setModal('export'),
      !!state.scene.parts.length,
      'export',
    ),
    search: command(
      'Find a component',
      () => context.searchParts?.(),
      !!context.searchParts,
      'search',
    ),
    help: command('Keyboard shortcuts', () => state.setModal('help'), true, 'help'),
    preferences: command(
      'Preferences…',
      () => {
        state.setModal(null);
        usePreferences.getState().openPanel();
      },
      true,
      'preferences',
    ),
  };
}

export type CommandId = keyof ReturnType<typeof editorCommands>;

export function executeEditorCommand(id: CommandId, context: CommandContext = {}) {
  const command = editorCommands(context)[id];
  useEditor.getState().closeContextMenu();
  if (command.enabled) command.run();
}

/** Commands that run from the keyboard, including in text fields where noted. */
const keyboardCommands = [
  'undo',
  'redo',
  'selectAll',
  'deselect',
  'copy',
  'cut',
  'paste',
  'duplicate',
  'rename',
  'new',
  'open',
  'import',
  'save',
  'export',
  'search',
  'help',
  'preferences',
] as const satisfies readonly (CommandId & KeyActionId)[];

export function shortcutCommand(
  event: Pick<KeyInput, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'> & { code?: string },
): CommandId | null {
  return matchKeyAction(
    event,
    usePreferences.getState().keybindings,
    keyboardCommands,
  ) as CommandId | null;
}
