import type { EditorContextMenu } from './store';

export function isEditableTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    ((target instanceof HTMLElement && target.isContentEditable) ||
      !!target.closest(
        'input, textarea, select, [role="textbox"], [contenteditable="true"], [contenteditable=""]',
      ))
  );
}

export function keyboardContextMenu(target: HTMLElement, brush = false): EditorContextMenu {
  const row = target.closest<HTMLElement>('[data-part-id]');
  const anchor = row ?? document.querySelector<HTMLElement>('.viewport') ?? target;
  const bounds = anchor.getBoundingClientRect();
  return {
    x: bounds.left + (row ? Math.min(bounds.width, 180) : bounds.width / 2),
    y: bounds.top + (row ? bounds.height : bounds.height / 2),
    kind: !row && brush ? 'brush' : undefined,
    ...(row?.dataset.partId ? { partId: row.dataset.partId } : {}),
  };
}
