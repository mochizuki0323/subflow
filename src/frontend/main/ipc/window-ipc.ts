import { BrowserWindow, ipcMain, screen } from 'electron';
import type { IpcContext } from './context';

export interface WindowIpc {
  saveWindowPositions(): void;
  setDragMode(enabled: boolean): void;
}

export function registerWindowIpc(ctx: IpcContext): WindowIpc {
  let isDragMode = false;
  let positionSaveTimer: ReturnType<typeof setTimeout> | null = null;

  function saveWindowPositions(): void {
    const overlay = ctx.overlayWindow();
    const history = ctx.historyWindow();
    if (!overlay || overlay.isDestroyed() || !history || history.isDestroyed()) return;
    const ob = overlay.getBounds();
    const hb = history.getBounds();
    ctx.config.updateWindowPositions({
      overlay: { x: ob.x, y: ob.y, width: ob.width, height: ob.height },
      history: { x: hb.x, y: hb.y, width: hb.width, height: hb.height },
    });
  }

  function setDragMode(enabled: boolean) {
    const overlay = ctx.overlayWindow();
    const history = ctx.historyWindow();
    if (!overlay || !history) return;
    isDragMode = enabled;
    if (enabled) {
      overlay.setIgnoreMouseEvents(false);
      history.setIgnoreMouseEvents(false);
    } else {
      overlay.setIgnoreMouseEvents(true);
      history.setIgnoreMouseEvents(true);
      if (positionSaveTimer) clearTimeout(positionSaveTimer);
      positionSaveTimer = setTimeout(saveWindowPositions, 300);
    }
    ctx.safeSend(overlay, 'drag-mode', enabled);
    ctx.safeSend(history, 'drag-mode', enabled);
  }

  // Overlay windows must stay above everything. The topmost flag can be lost
  // on both platforms (new topmost windows, hide/show cycles, WM quirks), so
  // re-assert it whenever a window is shown and periodically while visible.
  function assertOnTop(win: BrowserWindow | null): void {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    win.setAlwaysOnTop(true, 'screen-saver');
    win.moveTop();
  }

  setInterval(() => {
    assertOnTop(ctx.overlayWindow());
    assertOnTop(ctx.historyWindow());
  }, 2000);

  // ---- Window toggles ----
  ipcMain.handle('toggle-overlay', () => {
    const overlay = ctx.overlayWindow();
    if (!overlay) return false;
    if (overlay.isVisible()) { overlay.hide(); return false; }
    overlay.show();
    assertOnTop(overlay);
    return true;
  });

  ipcMain.handle('toggle-history', () => {
    const history = ctx.historyWindow();
    if (!history) return false;
    if (history.isVisible()) { history.hide(); return false; }
    history.show();
    assertOnTop(history);
    return true;
  });

  ipcMain.handle('toggle-drag-mode', () => {
    setDragMode(!isDragMode);
    return isDragMode;
  });

  ipcMain.on('exit-drag-mode', () => {
    setDragMode(false);
    ctx.safeSend(ctx.mainWindow(), 'drag-mode', false);
  });

  // ---- Manual window dragging ----
  let dragInterval: ReturnType<typeof setInterval> | null = null;
  let dragWin: BrowserWindow | null = null;
  let dragStartCursor = { x: 0, y: 0 };
  let dragStartWin = { x: 0, y: 0 };

  // Anchor the drag from the main-process cursor, NOT the renderer's
  // screenX/screenY: on some Linux WMs (GNOME scaling, frameless transparent
  // windows) renderer screen coords disagree with getCursorScreenPoint(),
  // which made the delta wrong and the window undraggable.
  ipcMain.on('start-window-drag', (event) => {
    if (dragInterval) clearInterval(dragInterval);
    dragWin = BrowserWindow.fromWebContents(event.sender);
    if (!dragWin) return;
    const [wx, wy] = dragWin.getPosition();
    const cur = screen.getCursorScreenPoint();
    dragStartCursor = { x: cur.x, y: cur.y };
    dragStartWin = { x: wx, y: wy };
    dragInterval = setInterval(() => {
      if (!dragWin) return;
      const cur = screen.getCursorScreenPoint();
      dragWin.setPosition(
        dragStartWin.x + (cur.x - dragStartCursor.x),
        dragStartWin.y + (cur.y - dragStartCursor.y),
      );
    }, 16);
  });

  ipcMain.on('stop-window-drag', () => {
    if (dragInterval) { clearInterval(dragInterval); dragInterval = null; }
    dragWin = null;
    saveWindowPositions();
  });

  // ---- Window resizing ----
  const MIN_W = 200, MIN_H = 80;
  let resizeInterval: ReturnType<typeof setInterval> | null = null;
  let resizeWin: BrowserWindow | null = null;
  let resizeDir = '';
  let rsStartCursor = { x: 0, y: 0 };
  let rsStartBounds = { x: 0, y: 0, width: 0, height: 0 };

  ipcMain.on('start-window-resize', (event, { direction }: { direction: string }) => {
    if (resizeInterval) clearInterval(resizeInterval);
    resizeWin = BrowserWindow.fromWebContents(event.sender);
    if (!resizeWin) return;
    rsStartBounds = resizeWin.getBounds();
    const cur = screen.getCursorScreenPoint();
    rsStartCursor = { x: cur.x, y: cur.y };
    resizeDir = direction;
    resizeInterval = setInterval(() => {
      if (!resizeWin) return;
      const cur = screen.getCursorScreenPoint();
      const dx = cur.x - rsStartCursor.x;
      const dy = cur.y - rsStartCursor.y;
      let { x, y, width, height } = rsStartBounds;
      if (resizeDir.includes('e')) width = Math.max(MIN_W, width + dx);
      if (resizeDir.includes('s')) height = Math.max(MIN_H, height + dy);
      if (resizeDir.includes('w')) { const nw = Math.max(MIN_W, width - dx); x += width - nw; width = nw; }
      if (resizeDir.includes('n')) { const nh = Math.max(MIN_H, height - dy); y += height - nh; height = nh; }
      resizeWin.setBounds({ x, y, width, height });
    }, 16);
  });

  ipcMain.on('stop-window-resize', () => {
    if (resizeInterval) { clearInterval(resizeInterval); resizeInterval = null; }
    resizeWin = null;
    saveWindowPositions();
  });

  return { saveWindowPositions, setDragMode };
}
