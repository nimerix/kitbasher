import { useEffect, useRef } from 'react';
import { useEditor } from '../core/store';
import { readRecovery, saveRecovery } from '../core/recovery';
import { executeEditorCommand, shortcutCommand } from '../core/commands';
import { isEditableTarget, keyboardContextMenu } from '../core/context-menu';

export function useRecovery() {
  const scene = useEditor((s) => s.scene),
    revision = useEditor((s) => s.revision);
  const ready = useRef(false);
  useEffect(() => {
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
    const onPointerDown = () => {
      focusedByKeyboard = false;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Tab') focusedByKeyboard = true;
      if (event.defaultPrevented || event.isComposing) return;
      const target = event.target instanceof HTMLElement ? event.target : document.body;
      const state = useEditor.getState();
      if (state.modal || target.closest('[role=dialog]')) return;
      const cmd = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
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
      if (key === 'shift') useEditor.setState({ precision: true });
      // A control reached by keyboard keeps its native Space and Enter activation. Mouse
      // clicks also leave focus on buttons, and those must not capture the tool shortcuts.
      const nativeActivation =
        focusedByKeyboard &&
        !!target.closest('button, a[href], summary, [role="button"], [role="switch"]');
      if (
        event.code === 'Space' &&
        !nativeActivation &&
        !cmd &&
        !event.altKey &&
        !target.closest('[role=menu]')
      ) {
        event.preventDefault();
        state.endPaintStroke();
        useEditor.setState({ temporaryOrbit: true });
        return;
      }
      if (key === 'contextmenu' || (key === 'f10' && event.shiftKey)) {
        event.preventDefault();
        state.openContextMenu(keyboardContextMenu(target));
        return;
      }
      if (target.closest('[role=menu]') || cmd || event.altKey) return;
      // Auto-repeat would flicker toggles such as P, O, H, and 5. Only brush sizing repeats.
      if (event.repeat && key !== '[' && key !== ']') return;
      const tools = {
        v: 'select',
        g: 'translate',
        r: 'rotate',
        s: 'scale',
        a: 'align',
        j: 'joint',
        d: 'measure',
      } as const;
      if (key in tools) {
        event.preventDefault();
        state.setTool(tools[key as keyof typeof tools]);
      }
      if (key === 'p') {
        event.preventDefault();
        state.setPivotPicking(!state.pivotPicking);
        return;
      }
      if (key === 'b') {
        event.preventDefault();
        state.setTool('align');
        state.setOperation({ mode: 'surface' });
        return;
      }
      if (
        (key === '[' || key === ']') &&
        state.tool === 'align' &&
        state.operation.mode === 'surface'
      ) {
        event.preventDefault();
        state.setBrush({
          radius: Number((state.brushRadius * (key === '[' ? 0.8 : 1.25)).toFixed(2)),
        });
        return;
      }
      if (key === 'o' || key === 'h') {
        event.preventDefault();
        const mode = key === 'o' ? 'orbit' : 'pan';
        state.setNavigationMode(state.navigationMode === mode ? null : mode);
      }
      if (key === '.' || event.code === 'Period' || event.code === 'NumpadDecimal') {
        event.preventDefault();
        if (event.shiftKey) state.setView({ orbitSelection: !state.view.orbitSelection });
        else state.centerOrbit();
        return;
      }
      if (key === 'f') {
        event.preventDefault();
        state.focus();
      }
      if (key === 'home') {
        event.preventDefault();
        state.focus(undefined, true);
      }
      if (key === 'escape') {
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
      }
      if (key === 'delete' || key === 'backspace') {
        event.preventDefault();
        executeEditorCommand('delete');
      }
      if (key === 'enter' && !nativeActivation && ['align', 'joint'].includes(state.tool)) {
        event.preventDefault();
        state.tool === 'joint' ? state.createJoint() : state.applyAlignment();
      }
      if (key === '1') state.focus('front', true);
      if (key === '3') state.focus('right', true);
      if (key === '7') state.focus('top', true);
      if (key === '5')
        state.setView({
          projection: state.view.projection === 'perspective' ? 'orthographic' : 'perspective',
        });
      if (key === '?') state.setModal('help');
    };
    const up = (event: KeyboardEvent) => {
      if (event.key === 'Shift') useEditor.setState({ precision: false });
      if (event.code === 'Space' && useEditor.getState().temporaryOrbit) {
        event.preventDefault();
        useEditor.setState({ temporaryOrbit: false });
      }
    };
    const blur = () => useEditor.setState({ temporaryOrbit: false, precision: false });
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
