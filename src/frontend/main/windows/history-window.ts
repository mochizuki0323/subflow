import { BrowserWindow, screen } from 'electron';
import path from 'path';
import { getRendererPage } from '../paths';

/** Where this window starts: top-right of the primary display. See
 *  defaultOverlayBounds for why the reset path reads it from here. */
export function defaultHistoryBounds(): { x: number; y: number; width: number; height: number } {
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  return { x: width - 400, y: 20, width: 380, height: 480 };
}

export function createHistoryWindow(): BrowserWindow {
  const bounds = defaultHistoryBounds();

  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    show: false,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: true,
    focusable: false,
    type: 'toolbar',
    webPreferences: {
      preload: path.join(__dirname, '../../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.loadFile(getRendererPage('overlay', 'history.html'));

  return win;
}
