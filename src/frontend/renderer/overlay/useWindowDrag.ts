import { useCallback } from 'react';

/**
 * Renderer-driven window drag. While the button is held the browser has an
 * implicit pointer grab, so pointer events keep flowing with reliable
 * screenX/screenY — anchor and motion live in ONE coordinate space. The main
 * process only applies setPosition. This works where the alternatives fail:
 * compositor app-region drags are ignored for unfocusable toolbar windows,
 * and main-process getCursorScreenPoint() is stale on GNOME (XWayland).
 */
export function useDragBarPointerDown(): (e: React.PointerEvent<HTMLDivElement>) => void {
  return useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    const startX = e.screenX;
    const startY = e.screenY;
    window.electronAPI.startWindowDrag();
    const onMove = (ev: PointerEvent) => {
      window.electronAPI.dragWindowBy(ev.screenX - startX, ev.screenY - startY);
    };
    const onUp = () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      window.electronAPI.stopWindowDrag();
    };
    el.setPointerCapture(e.pointerId);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  }, []);
}
