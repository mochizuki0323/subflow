import { useCallback } from 'react';

/**
 * Window drag and resize, both driven from renderer pointer events.
 *
 * While the button is held the browser keeps an implicit pointer grab, so
 * screenX/screenY keep flowing in ONE coordinate space even as the window
 * moves or resizes out from under the cursor — and the release always
 * arrives, so a gesture cannot be left running after the button comes up.
 * The main process only applies the deltas. This works where the
 * alternatives fail: compositor app-region drags are ignored for these
 * unfocusable toolbar windows, and main-process getCursorScreenPoint() is
 * stale on GNOME (XWayland).
 *
 * On GNOME (XWayland) the very first press on a freshly shown overlay reports
 * a screen position that is not a number yet, which is why the anchor is taken
 * from the first usable sample rather than assumed to be the press itself, and
 * why unusable samples are dropped instead of forwarded. The window has not
 * moved by then, so anchoring late lands in the same place.
 */
function beginPointerGesture(
  e: React.PointerEvent<HTMLElement>,
  moveBy: (dx: number, dy: number) => void,
  end: () => void,
): void {
  const el = e.currentTarget;
  let startX = Number.isFinite(e.screenX) ? e.screenX : null;
  let startY = Number.isFinite(e.screenY) ? e.screenY : null;
  let done = false;

  const onMove = (ev: PointerEvent) => {
    if (!Number.isFinite(ev.screenX) || !Number.isFinite(ev.screenY)) return;
    if (startX === null || startY === null) {
      startX = ev.screenX;
      startY = ev.screenY;
      return;
    }
    moveBy(ev.screenX - startX, ev.screenY - startY);
  };
  const onEnd = () => {
    // lostpointercapture also fires right after pointerup, and the handles
    // unmount the moment drag mode is switched off mid-gesture — either way
    // the window must be told exactly once.
    if (done) return;
    done = true;
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onEnd);
    el.removeEventListener('pointercancel', onEnd);
    el.removeEventListener('lostpointercapture', onEnd);
    end();
  };

  el.setPointerCapture(e.pointerId);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onEnd);
  el.addEventListener('pointercancel', onEnd);
  el.addEventListener('lostpointercapture', onEnd);
}

export function useDragBarPointerDown(): (e: React.PointerEvent<HTMLDivElement>) => void {
  return useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // Presses on interactive children (the lock button) must stay clicks:
    // capturing the pointer here would swallow their click event.
    if ((e.target as HTMLElement).closest('button, input, select, a')) return;
    e.preventDefault();
    window.electronAPI.startWindowDrag();
    beginPointerGesture(
      e,
      (dx, dy) => window.electronAPI.dragWindowBy(dx, dy),
      () => window.electronAPI.stopWindowDrag(),
    );
  }, []);
}

export function useResizeHandlePointerDown(): (
  direction: string,
) => (e: React.PointerEvent<HTMLDivElement>) => void {
  return useCallback(
    (direction: string) => (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      window.electronAPI.startWindowResize(direction);
      beginPointerGesture(
        e,
        (dx, dy) => window.electronAPI.resizeWindowBy(dx, dy),
        () => window.electronAPI.stopWindowResize(),
      );
    },
    [],
  );
}
