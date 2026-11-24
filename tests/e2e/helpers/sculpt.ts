import type { Page } from '@playwright/test';

type Shortcut = Pick<KeyboardEventInit, 'key' | 'code' | 'shiftKey' | 'ctrlKey'>;

/** Dispatch shortcuts in the same task as a pen lift, with stroke work left for the next frame. */
export async function queueAfterPenRelease(
  page: Page,
  point: { x: number; y: number },
  shortcuts: Shortcut[],
) {
  await page.evaluate(
    ({ point, shortcuts }) => {
      const now = performance.now.bind(performance);
      let elapsed = now();
      performance.now = () => (elapsed += 8);
      try {
        const canvas = document.querySelector('canvas')!;
        const pen = {
          clientX: point.x,
          clientY: point.y,
          pointerType: 'pen',
          pointerId: 40,
          isPrimary: true,
          pressure: 0.8,
          bubbles: true,
        };
        canvas.dispatchEvent(new PointerEvent('pointerdown', { ...pen, buttons: 1 }));
        canvas.dispatchEvent(new PointerEvent('pointerup', pen));
        for (const shortcut of shortcuts)
          window.dispatchEvent(new KeyboardEvent('keydown', shortcut));
      } finally {
        performance.now = now;
      }
    },
    { point, shortcuts },
  );
}
