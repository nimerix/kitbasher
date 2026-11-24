import { downloadScene } from './files';
import { driveAutosave, useDrive } from './drive-sync';
import { nextIsolation } from './isolation';
import { matchKeyAction } from './keybindings';
import type { KeyActionId, KeyInput } from './keybindings';
import { primaryShortcutText, usePreferences } from './preferences';
import {
  canRedo,
  canUndo,
  afterReleasedSculpt,
  refineEdited,
  useEditor,
  warpEdited,
  type WarpGizmo,
} from './store';
import {
  activeTransformTool,
  stepTransform,
  transformSelection,
  warpMovesFromPatches,
} from './transform-selection';
import type { SurfacePoint } from './types';

function waitForReleasedSculpt(run: () => Promise<void>) {
  let resolveSave!: () => void;
  let rejectSave!: (error: unknown) => void;
  const saved = new Promise<void>((resolve, reject) => {
    resolveSave = resolve;
    rejectSave = reject;
  });
  if (afterReleasedSculpt(() => void run().then(resolveSave, rejectSave))) return saved;
}

export async function saveCurrentScene() {
  const pending = waitForReleasedSculpt(saveCurrentScene);
  if (pending) return pending;
  if (useEditor.getState().driveFile) {
    if (!(await driveAutosave.flush())) useDrive.setState({ dialogOpen: true });
    return;
  }
  await downloadCurrentScene();
}

export async function downloadCurrentScene() {
  const pending = waitForReleasedSculpt(downloadCurrentScene);
  if (pending) return pending;
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

type EditorState = ReturnType<typeof useEditor.getState>;

/** Whether scene undo and redo would end a warp or refine session that holds work. */
const holdingSession = (state: EditorState) =>
  (state.tool === 'warp' && !!state.warp && warpEdited(state.warp)) ||
  (state.tool === 'refine' && !!state.refine && refineEdited(state.refine));

/**
 * What Undo steps back first: a paint stroke, a step of the warp or refine session, or the scene.
 * Scene undo would leave the tool and end the session, so it waits until the session holds no work.
 */
export function undoTarget(state: EditorState) {
  if (state.tool === 'warp' && state.warp) {
    if (state.paintHistory.length) return 'stroke';
    if (state.warp.undo.length) return 'warp';
    return holdingSession(state) ? null : 'scene';
  }
  if (state.tool === 'refine' && state.refine) {
    if (state.refine.undo.length) return 'refine';
    return holdingSession(state) ? null : 'scene';
  }
  if (state.tool === 'align' && state.operation.mode === 'surface' && state.paintHistory.length)
    return 'stroke';
  return 'scene';
}

export const undoAvailable = (state: EditorState) => {
  const target = undoTarget(state);
  return target === 'scene' ? canUndo(state) || state.paintHistory.length > 0 : target !== null;
};

/** Whether Redo steps a refine session forward rather than the scene. */
const redoingRefine = (state: EditorState) =>
  state.tool === 'refine' && !!state.refine?.redo.length;

export const redoAvailable = (state: EditorState) =>
  redoingRefine(state) || (canRedo(state) && !holdingSession(state));

/** Chooses a transform tool, or while warping, the gizmo that moves control points. */
export function chooseTransformTool(tool: WarpGizmo) {
  const state = useEditor.getState();
  if (state.tool === 'warp' && state.warp) state.setWarpOptions({ gizmo: tool });
  else state.setTool(tool);
}

/** Moves or turns the selection one step along an axis: parts, or control points while warping. */
export function stepSelection(axis: 0 | 1 | 2, direction: number) {
  // Read fresh state so rapid repeated clicks always start from the last accepted pose.
  const state = useEditor.getState(),
    mode = activeTransformTool(state);
  if (mode !== 'translate' && mode !== 'rotate') return;
  const amount = mode === 'rotate' ? state.view.rotationSnapStep : state.view.snapStep;
  const selection = transformSelection(state, mode);
  const patches = stepTransform(selection, mode, axis, direction * amount);
  if (selection.kind === 'warp') {
    const moves = warpMovesFromPatches(selection, patches);
    if (moves.length) state.moveWarpPoints(moves, 'end');
  } else if (patches.length) state.transformMany(patches, true, mode === 'translate', true);
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
  const canIsolate = !!nextIsolation(state.scene.parts, state.selected, state.isolated);
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
        const target = undoTarget(state);
        if (target === 'stroke') state.undoPaintStroke();
        else if (target === 'warp') void state.undoWarpEdit();
        else if (target === 'refine') state.undoRefine();
        else if (target === 'scene') state.undo();
      },
      idle && undoAvailable(state),
      'undo',
    ),
    redo: command(
      'Redo',
      () => (redoingRefine(state) ? state.redoRefine() : state.redo()),
      idle && redoAvailable(state),
      'redo',
    ),
    selectAll: command(
      'Select all components',
      state.selectAll,
      !!state.scene.parts.length,
      'selectAll',
    ),
    deselect: command('Deselect all', () => state.select(null), hasSelection, 'deselect'),
    copy: command('Copy components', () => state.copySelected(), hasSelection, 'copy'),
    cut: command(
      'Cut components',
      () => state.copySelected(true),
      idle && editable && !holdingSession(state),
      'cut',
    ),
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
    delete: command(
      'Delete unlocked parts',
      state.deleteSelected,
      idle && editable && !holdingSession(state),
      'delete',
    ),
    move: command('Move', () => chooseTransformTool('translate'), idle && editable, 'move'),
    rotate: command('Rotate', () => chooseTransformTool('rotate'), idle && editable, 'rotate'),
    scale: command('Scale', () => chooseTransformTool('scale'), idle && editable, 'scale'),
    transform: command(
      'Transform',
      () => chooseTransformTool('transform'),
      idle && editable,
      'transform',
    ),
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
    hideOthers: command(
      'Hide others',
      state.hideOthers,
      idle &&
        hasSelection &&
        state.scene.parts.some((part) => part.visible !== state.selected.includes(part.id)),
    ),
    isolate: command(
      state.isolated && !canIsolate ? 'Exit isolation' : 'Isolate selected',
      state.toggleIsolation,
      !!state.isolated || canIsolate,
      'isolate',
    ),
    isolateNearby: command(
      !state.isolated
        ? 'Isolate with nearby surfaces'
        : state.view.isolation.nearby
          ? 'Hide nearby surfaces'
          : 'Show nearby surfaces',
      state.toggleNearby,
      !!state.isolated || canIsolate,
      'isolateNearby',
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
    save: command(
      state.driveFile ? 'Save to Google Drive' : 'Save scene',
      saveCurrentScene,
      idle,
      'save',
    ),
    export: command(
      'Export assembly…',
      () => {
        const open = () => useEditor.getState().setModal('export');
        if (!afterReleasedSculpt(open)) open();
      },
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
  if (afterReleasedSculpt(() => executeEditorCommand(id, context))) return;
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
