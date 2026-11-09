import { useEffect, useRef } from 'react';
import { joinLiveSession } from '../core/live';
import { liveSession, useEditor } from '../core/store';
import { readRecovery, saveRecovery } from '../core/recovery';
import { executeEditorCommand, shortcutCommand } from '../core/commands';
import { isEditableTarget, keyboardContextMenu } from '../core/context-menu';
import { actionRepeats, keyName, matchKeyAction } from '../core/keybindings';
import { usePreferences } from '../core/preferences';

export function useLiveSession() {
  useEffect(() => (liveSession ? joinLiveSession() : undefined), []);
}

export function useRecovery() {
  const scene = useEditor((s) => s.scene),
    revision = useEditor((s) => s.revision);
  const ready = useRef(false);
  useEffect(() => {
    // The agent's server holds a shared scene. Leaving ready unset also stops autosaving it.
    if (liveSession) return;
    let active = true;
    useEditor.getState().setBusy('Restoring your local assembly…');
    readRecovery()
      .then((saved) => {
        if (!active) return;
        if (saved && useEditor.getState().revision === 0) {
          useEditor.getState().setScene(saved, true);
          useEditor.getState().notify('Recovered your local assembly', 'info');
        }
        useEditor.getState().setBusy(null);
        ready.current = true;
        return saveRecovery(useEditor.getState().scene);
      })
      .catch(() => {
        if (active) useEditor.getState().setBusy(null);
        ready.current = true;
        useEditor.setState({ recoveryStatus: 'error' });
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!ready.current) return;
    useEditor.setState({ recoveryStatus: 'saving' });
    const timeout = window.setTimeout(() => {
      saveRecovery(scene)
        .then(() => {
          if (useEditor.getState().revision === revision)
            useEditor.setState({ recoveryStatus: 'saved' });
        })
        .catch(() => useEditor.setState({ recoveryStatus: 'error' }));
    }, 850);
    return () => clearTimeout(timeout);
  }, [scene, revision]);
  useEffect(() => {
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (useEditor.getState().recoveryStatus !== 'saved') {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);
}

export function useKeyboard(openScene: () => void, searchParts: () => void) {
  useEffect(() => {
    // :focus-visible cannot tell these apart, because browsers set it on any key press.
    let focusedByKeyboard = false;
    // The physical key that started a held orbit, so its release ends it.
    let orbitKey: string | null = null;
    const onPointerDown = () => {
      focusedByKeyboard = false;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Tab') focusedByKeyboard = true;
      if (event.defaultPrevented || event.isComposing) return;
      const target = event.target instanceof HTMLElement ? event.target : document.body;
      const state = useEditor.getState();
      if (state.modal || target.closest('[role=dialog]')) return;
      const command = shortcutCommand(event);
      const editable = isEditableTarget(target);
      if (command && (!editable || command === 'save' || command === 'open')) {
        event.preventDefault();
        if (event.repeat) return;
        if (editable) target.blur();
        executeEditorCommand(command, { openScene, searchParts });
        return;
      }
      if (editable) return;
      if (event.key === 'Shift') useEditor.setState({ precision: true });
      // A control reached by keyboard keeps its native Space and Enter activation. Mouse
      // clicks also leave focus on buttons, and those must not capture the tool shortcuts.
      const nativeActivation =
        focusedByKeyboard &&
        !!target.closest('button, a[href], summary, [role="button"], [role="switch"]');
      const action = command ? null : matchKeyAction(event, usePreferences.getState().keybindings);
      const inMenu = !!target.closest('[role=menu]');
      if (action === 'holdOrbit' && !nativeActivation && !inMenu) {
        event.preventDefault();
        state.endPaintStroke();
        orbitKey = event.code || keyName(event.key);
        useEditor.setState({ temporaryOrbit: true });
        return;
      }
      const key = event.key.toLowerCase();
      if (key === 'contextmenu' || (key === 'f10' && event.shiftKey)) {
        event.preventDefault();
        state.openContextMenu(
          keyboardContextMenu(target, state.tool === 'align' && state.operation.mode === 'surface'),
        );
        return;
      }
      if (!action || inMenu) return;
      // Auto-repeat would flicker toggles such as P, O, H, and 5. Only brush sizing repeats.
      if (event.repeat && !actionRepeats(action)) return;
      const paintingSurface = state.tool === 'align' && state.operation.mode === 'surface';
      const tools = {
        select: 'select',
        move: 'translate',
        rotate: 'rotate',
        scale: 'scale',
        align: 'align',
        joint: 'joint',
        anchors: 'anchors',
        measure: 'measure',
      } as const;
      if (action in tools) {
        event.preventDefault();
        state.setTool(tools[action as keyof typeof tools]);
        return;
      }
      switch (action) {
        case 'pivot':
          event.preventDefault();
          state.setPivotPicking(!state.pivotPicking);
          return;
        case 'paint':
          event.preventDefault();
          state.setTool('align');
          state.setOperation({ mode: 'surface' });
          return;
        case 'brushSmaller':
        case 'brushLarger':
          if (!paintingSurface) return;
          event.preventDefault();
          state.setBrush({
            radius: Number(
              (state.brushRadius * (action === 'brushSmaller' ? 0.8 : 1.25)).toFixed(2),
            ),
          });
          return;
        case 'orbitTool':
        case 'panTool': {
          event.preventDefault();
          const mode = action === 'orbitTool' ? 'orbit' : 'pan';
          state.setNavigationMode(state.navigationMode === mode ? null : mode);
          return;
        }
        case 'centerOrbit':
          event.preventDefault();
          state.centerOrbit();
          return;
        case 'orbitSelection':
          event.preventDefault();
          state.setView({ orbitSelection: !state.view.orbitSelection });
          return;
        case 'focus':
          event.preventDefault();
          state.focus();
          return;
        case 'frameAll':
          event.preventDefault();
          state.focus(undefined, true);
          return;
        case 'cancel': {
          if (state.pivotPicking) {
            state.setPivotPicking(false);
            return;
          }
          if (state.navigationMode) {
            state.setNavigationMode(null);
            return;
          }
          const wasSelecting = state.tool === 'select';
          state.setTool('select');
          state.resetPicks();
          if (wasSelecting) state.select(null);
          return;
        }
        case 'delete':
          event.preventDefault();
          executeEditorCommand('delete');
          return;
        case 'apply':
          if (nativeActivation || !['align', 'joint'].includes(state.tool)) return;
          event.preventDefault();
          if (state.tool === 'joint') state.createJoint();
          else state.applyAlignment();
          return;
        case 'viewFront':
          state.focus('front', true);
          return;
        case 'viewRight':
          state.focus('right', true);
          return;
        case 'viewTop':
          state.focus('top', true);
          return;
        case 'projection':
          state.setView({
            projection: state.view.projection === 'perspective' ? 'orthographic' : 'perspective',
          });
          return;
      }
    };
    const up = (event: KeyboardEvent) => {
      if (event.key === 'Shift') useEditor.setState({ precision: false });
      if (
        useEditor.getState().temporaryOrbit &&
        orbitKey !== null &&
        (event.code || keyName(event.key)) === orbitKey
      ) {
        event.preventDefault();
        orbitKey = null;
        useEditor.setState({ temporaryOrbit: false });
      }
    };
    const blur = () => {
      orbitKey = null;
      useEditor.setState({ temporaryOrbit: false, precision: false });
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    window.addEventListener('pointercancel', blur);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      window.removeEventListener('pointercancel', blur);
    };
  }, [openScene, searchParts]);
}
