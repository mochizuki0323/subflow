import { BrowserWindow, app } from 'electron';
import path from 'path';
import { PRODUCT_NAME } from '../app-metadata';
import { getRendererPage } from '../paths';
import { getWindowIcon } from '../window-icon';

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 920,
    height: 760,
    title: PRODUCT_NAME,
    icon: getWindowIcon(),
    webPreferences: {
      preload: path.join(__dirname, '../../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(getRendererPage('control-panel', 'index.html'));

  return win;
}
