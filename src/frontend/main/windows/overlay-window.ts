import { BrowserWindow, screen } from 'electron';
import path from 'path';
import { getRendererPage } from '../paths';

export function createOverlayWindow(): BrowserWindow {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;

  const overlayHeight = 200;

  const win = new BrowserWindow({
    width: width,
    height: overlayHeight,
    x: 0,
    y: height - overlayHeight,
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
  win.setVisibleOnAllWorkspaces(true);

  win.loadFile(getRendererPage('overlay', 'index.html'));

  return win;
}
