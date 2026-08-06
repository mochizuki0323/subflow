import { BrowserWindow, screen } from 'electron';
import path from 'path';
import { getRendererPage } from '../paths';

/**
 * Where this window starts: a full-width strip along the bottom of the primary
 * display. Exported because "reset position" has to mean exactly this and
 * nothing else — a second copy of these numbers would be a reset that drifts
 * away from the real default one edit at a time.
 */
export function defaultOverlayBounds(): { x: number; y: number; width: number; height: number } {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const overlayHeight = 200;
  return { x: 0, y: height - overlayHeight, width, height: overlayHeight };
}

export function createOverlayWindow(): BrowserWindow {
  const bounds = defaultOverlayBounds();

  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    show: false,       // start hidden; user toggles via the control panel button
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: true,
    focusable: false,
    type: 'toolbar', // Helps with transparency on some Linux WMs
    webPreferences: {
      preload: path.join(__dirname, '../../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.loadFile(getRendererPage('overlay', 'index.html'));

  return win;
}
