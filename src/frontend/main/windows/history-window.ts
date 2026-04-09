import { BrowserWindow, screen } from 'electron';
import path from 'path';
import { getRendererPage } from '../paths';

export function createHistoryWindow(): BrowserWindow {
  const display = screen.getPrimaryDisplay();
  const { width } = display.workAreaSize;

  const win = new BrowserWindow({
    width: 380,
    height: 480,
    x: width - 400,
    y: 20,
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
  win.setVisibleOnAllWorkspaces(true);

  win.loadFile(getRendererPage('overlay', 'history.html'));

  return win;
}
