import { BrowserWindow, ipcMain } from 'electron';
import type { IpcContext } from './context';
import { defaultOverlayBounds } from '../windows/overlay-window';
import { defaultHistoryBounds } from '../windows/history-window';

// setPosition/setBounds take int32 in native code and throw a TypeError that
// takes the whole main process down with it when handed anything else. The
// numbers reaching them are a renderer's pointer deltas added to bounds a
// window manager reported, so neither end is trustworthy: everything is
// checked here, and an unusable value cancels the gesture instead of crashing.
function asInt(v: unknown): number | null {
  if (typeof v !== 'number') return null;
  const n = Math.round(v);
  return Number.isFinite(n) && Math.abs(n) <= 2147483647 ? n : null;
}

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

  // A window dragged off the screen, or shrunk to nothing, cannot be recovered
  // by dragging it — there is nothing left to grab. The saved rect is rewritten
  // as well as the live one, or the next launch would restore the mess.
  ipcMain.handle('reset-window-position', (_event, target: unknown) => {
    const which = target === 'overlay' || target === 'history' ? target : null;
    if (!which) return { success: false };
    const win = which === 'overlay' ? ctx.overlayWindow() : ctx.historyWindow();
    if (!win || win.isDestroyed()) return { success: false };
    win.setBounds(which === 'overlay' ? defaultOverlayBounds() : defaultHistoryBounds());
    saveWindowPositions();
    return { success: true };
  });

  ipcMain.handle('toggle-drag-mode', () => {
    setDragMode(!isDragMode);
    return isDragMode;
  });

  ipcMain.on('exit-drag-mode', () => {
    setDragMode(false);
    ctx.safeSend(ctx.mainWindow(), 'drag-mode', false);
  });

  // ---- Renderer-driven window dragging ----
  // The renderer computes deltas from its own pointer events (implicit grab
  // keeps them flowing with one consistent coordinate space); we only apply
  // setPosition. getCursorScreenPoint() is stale on GNOME (XWayland) and
  // compositor app-region drags are ignored for these unfocusable toolbar
  // windows — neither can be used here.
  //
  // Moving is done with setBounds carrying the size captured when the drag
  // began, never setPosition. setPosition reads the window's current size back
  // out and re-applies it, and on a Windows display scaled past 100% that
  // physical -> DIP -> physical round trip can land a pixel high; at one call
  // per pointer event the window visibly swells as it is dragged. Restating the
  // size every move pins it instead of letting it compound.
  let dragWin: BrowserWindow | null = null;
  let dragStartWin = { x: 0, y: 0 };
  let dragSize = { width: 0, height: 0 };
  let dragApplied = { x: 0, y: 0 };

  ipcMain.on('start-window-drag', (event) => {
    dragWin = null; // never let a stale anchor survive into the next drag
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    const b = win.getBounds();
    const x = asInt(b.x), y = asInt(b.y);
    const width = asInt(b.width), height = asInt(b.height);
    if (x === null || y === null || width === null || height === null) return; // no anchor, no drag
    dragStartWin = { x, y };
    dragSize = { width, height };
    dragApplied = { x, y };
    dragWin = win;
  });

  ipcMain.on('window-drag-move', (event, payload: { dx?: unknown; dy?: unknown }) => {
    if (!dragWin || dragWin.isDestroyed()) return;
    if (BrowserWindow.fromWebContents(event.sender) !== dragWin) return;
    const dx = asInt(payload?.dx), dy = asInt(payload?.dy);
    if (dx === null || dy === null) return;
    const x = asInt(dragStartWin.x + dx), y = asInt(dragStartWin.y + dy);
    if (x === null || y === null) return;
    // Compare against what we last applied, not getPosition(): the window
    // manager's answer lags mid-drag and would make us re-send every move.
    if (x === dragApplied.x && y === dragApplied.y) return;
    dragApplied = { x, y };
    dragWin.setBounds({ x, y, width: dragSize.width, height: dragSize.height });
  });

  ipcMain.on('stop-window-drag', () => {
    dragWin = null;
    saveWindowPositions();
  });

  // ---- Window resizing ----
  // Resizing is renderer-driven for the same reasons dragging is, and it is
  // strictly event-driven: geometry is written only when a pointer actually
  // moved and only when the result differs from what we last wrote. The
  // earlier version polled getCursorScreenPoint() on a 16ms timer and pushed
  // setBounds 60x a second for as long as the button was down — which resized
  // the window on a mere press-and-hold, and left the timer running whenever
  // the matching release went missing.
  const MIN_W = 200, MIN_H = 80;
  let resizeWin: BrowserWindow | null = null;
  let resizeDir = '';
  let rsStartBounds = { x: 0, y: 0, width: 0, height: 0 };
  let rsApplied = { x: 0, y: 0, width: 0, height: 0 };

  ipcMain.on('start-window-resize', (event, payload: { direction?: unknown }) => {
    resizeWin = null;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    const b = win.getBounds();
    const x = asInt(b.x), y = asInt(b.y), width = asInt(b.width), height = asInt(b.height);
    if (x === null || y === null || width === null || height === null) return;
    rsStartBounds = { x, y, width, height };
    rsApplied = { x, y, width, height };
    resizeDir = typeof payload?.direction === 'string' ? payload.direction : '';
    resizeWin = win;
  });

  ipcMain.on('window-resize-move', (event, payload: { dx?: unknown; dy?: unknown }) => {
    if (!resizeWin || resizeWin.isDestroyed()) return;
    if (BrowserWindow.fromWebContents(event.sender) !== resizeWin) return;
    const dx = asInt(payload?.dx), dy = asInt(payload?.dy);
    if (dx === null || dy === null) return;
    let { x, y, width, height } = rsStartBounds;
    if (resizeDir.includes('e')) width = Math.max(MIN_W, width + dx);
    if (resizeDir.includes('s')) height = Math.max(MIN_H, height + dy);
    if (resizeDir.includes('w')) { const nw = Math.max(MIN_W, width - dx); x += width - nw; width = nw; }
    if (resizeDir.includes('n')) { const nh = Math.max(MIN_H, height - dy); y += height - nh; height = nh; }
    if (x === rsApplied.x && y === rsApplied.y && width === rsApplied.width && height === rsApplied.height) return;
    rsApplied = { x, y, width, height };
    resizeWin.setBounds({ x, y, width, height });
  });

  ipcMain.on('stop-window-resize', () => {
    resizeWin = null;
    saveWindowPositions();
  });

  return { saveWindowPositions, setDragMode };
}
