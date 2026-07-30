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

  // ---- Window toggles ----
  ipcMain.handle('toggle-overlay', () => {
    const overlay = ctx.overlayWindow();
    if (!overlay) return false;
    if (overlay.isVisible()) { overlay.hide(); return false; }
    overlay.show(); return true;
  });

  ipcMain.handle('toggle-history', () => {
    const history = ctx.historyWindow();
    if (!history) return false;
    if (history.isVisible()) { history.hide(); return false; }
    history.show(); return true;
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

  ipcMain.on('start-window-drag', (event, { startX, startY }: { startX: number; startY: number }) => {
    if (dragInterval) clearInterval(dragInterval);
    dragWin = BrowserWindow.fromWebContents(event.sender);
    if (!dragWin) return;
    const [wx, wy] = dragWin.getPosition();
    dragStartCursor = { x: startX, y: startY };
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

  ipcMain.on('start-window-resize', (event, { direction, startX, startY }: { direction: string; startX: number; startY: number }) => {
    if (resizeInterval) clearInterval(resizeInterval);
    resizeWin = BrowserWindow.fromWebContents(event.sender);
    if (!resizeWin) return;
    rsStartBounds = resizeWin.getBounds();
    rsStartCursor = { x: startX, y: startY };
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
