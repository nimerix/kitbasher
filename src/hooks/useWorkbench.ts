import { useEffect, useRef } from 'react';
import { useEditor } from '../core/store';
import { readRecovery, saveRecovery } from '../core/scene-file';
import { saveSceneFile } from '../core/files';

export function useRecovery() {
  const scene = useEditor((s) => s.scene),
    revision = useEditor((s) => s.revision);
  const ready = useRef(false);
  useEffect(() => {
    let active = true;
    readRecovery()
      .then((saved) => {
        if (!active) return;
        if (saved && useEditor.getState().revision === 0) {
          useEditor.getState().setScene(saved, true);
          useEditor.getState().notify('Recovered your local assembly', 'info');
        }
        ready.current = true;
        return saveRecovery(useEditor.getState().scene);
      })
      .catch(() => {
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

export function useKeyboard(openScene: () => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const state = useEditor.getState();
      if (state.modal || target.closest('[role=dialog]')) return;
      const cmd = event.metaKey || event.ctrlKey,
        key = event.key.toLowerCase();
      if (cmd && key === 's') {
        event.preventDefault();
        if (target.tagName === 'INPUT') target.blur();
        const current = useEditor.getState();
        saveSceneFile(current.scene);
        current.markSaved();
        current.notify('Scene file downloaded');
        return;
      }
      if (cmd && key === 'o') {
        event.preventDefault();
        openScene();
        return;
      }
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)
        return;
      if (cmd) {
        if (key === 'z') {
          event.preventDefault();
          if (
            !event.shiftKey &&
            state.tool === 'align' &&
            state.operation.mode === 'surface' &&
            state.paintHistory.length
          ) {
            state.undoPaintStroke();
            return;
          }
          event.shiftKey ? state.redo() : state.undo();
        }
        if (key === 'y') {
          event.preventDefault();
          state.redo();
        }
        if (key === 'd') {
          event.preventDefault();
          state.duplicateSelected();
        }
        return;
      }
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
        state.setTool('select');
        state.resetPicks();
      }
      if (key === 'delete' || key === 'backspace') {
        event.preventDefault();
        state.deleteSelected();
      }
      if (key === 'enter' && ['align', 'joint'].includes(state.tool)) {
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
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openScene]);
}
