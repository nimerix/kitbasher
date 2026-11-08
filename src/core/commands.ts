import { saveSceneFile } from './files';
import { useEditor } from './store';
import type { SurfacePoint } from './types';

export function primaryShortcut(key: string, shift = false) {
  const apple = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  return `${apple ? '⌘' : 'Ctrl'}${shift ? '+Shift' : ''}+${key}`;
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
  const command = (label: string, run: () => void, enabled = true, shortcut?: string) => ({
    label,
    run,
    enabled,
    shortcut,
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
      idle && (state.past.length > 0 || state.paintHistory.length > 0),
      primaryShortcut('Z'),
    ),
    redo: command('Redo', state.redo, idle && state.future.length > 0, primaryShortcut('Z', true)),
    selectAll: command(
      'Select all components',
      state.selectAll,
      !!state.scene.parts.length,
      primaryShortcut('A'),
    ),
    deselect: command(
      'Deselect all',
      () => state.select(null),
      hasSelection,
      primaryShortcut('A', true),
    ),
    copy: command(
      'Copy components',
      () => state.copySelected(),
      hasSelection,
      primaryShortcut('C'),
    ),
    cut: command(
      'Cut components',
      () => state.copySelected(true),
      idle && editable,
      primaryShortcut('X'),
    ),
    paste: command(
      'Paste components',
      state.pasteClipboard,
      idle && !!state.clipboard?.parts.length,
      primaryShortcut('V'),
    ),
    duplicate: command(
      'Duplicate selected',
      state.duplicateSelected,
      idle && hasSelection,
      primaryShortcut('D'),
    ),
    rename: command(
      'Rename component…',
      () => state.setModal('rename'),
      idle && selected.length === 1,
      'F2',
    ),
    delete: command('Delete unlocked parts', state.deleteSelected, idle && editable, 'Del / ⌫'),
    move: command('Move', () => state.setTool('translate'), idle && editable, 'G'),
    rotate: command('Rotate', () => state.setTool('rotate'), idle && editable, 'R'),
    scale: command('Scale', () => state.setTool('scale'), idle && editable, 'S'),
    focus: command(
      'Frame selection',
      () => state.focus(),
      selected.some((part) => part.visible),
      'F',
    ),
    frameAll: command(
      'Frame all parts',
      () => state.focus(undefined, true),
      state.scene.parts.some((part) => part.visible),
      'Home',
    ),
    centerOrbit: command(
      'Center orbit on selection',
      state.centerOrbit,
      selected.some((part) => part.visible),
      '.',
    ),
    pivot: command(
      context.point ? 'Set pivot here' : 'Pick pivot on model',
      () => (context.point ? state.setPartPivot(context.point) : state.setPivotPicking(true)),
      idle &&
        (context.point
          ? state.scene.parts.some((part) => part.id === context.point!.partId && part.visible)
          : hasSelection),
      context.point ? undefined : 'P',
    ),
    align: command('Align parts', () => state.setTool('align'), idle && editable, 'A'),
    paint: command(
      'Paint contact surfaces',
      () => {
        state.setTool('align');
        useEditor.getState().setOperation({ mode: 'surface' });
      },
      idle && editable,
      'B',
    ),
    joint: command('Create joint', () => state.setTool('joint'), idle && editable, 'J'),
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
    new: command('New assembly…', () => state.setModal('new'), idle, primaryShortcut('N')),
    open: command(
      'Open scene…',
      () => context.openScene?.(),
      idle && !!context.openScene,
      primaryShortcut('O'),
    ),
    import: command('Import parts…', () => state.setModal('import'), idle, primaryShortcut('I')),
    save: command(
      'Save scene',
      () => {
        saveSceneFile(state.scene);
        state.markSaved();
        state.notify('Scene file downloaded');
      },
      true,
      primaryShortcut('S'),
    ),
    export: command(
      'Export assembly…',
      () => state.setModal('export'),
      !!state.scene.parts.length,
      primaryShortcut('E', true),
    ),
    search: command(
      'Find a component',
      () => context.searchParts?.(),
      !!context.searchParts,
      primaryShortcut('F'),
    ),
    help: command('Keyboard shortcuts', () => state.setModal('help'), true, 'F1 / ?'),
  };
}

export type CommandId = keyof ReturnType<typeof editorCommands>;

export function executeEditorCommand(id: CommandId, context: CommandContext = {}) {
  const command = editorCommands(context)[id];
  useEditor.getState().closeContextMenu();
  if (command.enabled) command.run();
}

export function shortcutCommand(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
): CommandId | null {
  if (event.altKey) return null;
  const key = event.key.toLowerCase();
  if (event.metaKey || event.ctrlKey) {
    if (key === 'a') return event.shiftKey ? 'deselect' : 'selectAll';
    if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
    if (key === 's') return 'save';
    if (key === 'e' && event.shiftKey) return 'export';
    if (event.shiftKey) return null;
    const commands: Record<string, CommandId> = {
      c: 'copy',
      x: 'cut',
      v: 'paste',
      d: 'duplicate',
      y: 'redo',
      o: 'open',
      n: 'new',
      i: 'import',
      f: 'search',
    };
    return commands[key] ?? null;
  }
  if (key === 'f2') return 'rename';
  if (key === 'f1') return 'help';
  return null;
}
