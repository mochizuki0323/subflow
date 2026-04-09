import { BrowserWindow } from 'electron';
import path from 'path';
import { PRODUCT_NAME } from '../app-metadata';
import { getRendererPage } from '../paths';

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    title: PRODUCT_NAME,
    webPreferences: {
      preload: path.join(__dirname, '../../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(getRendererPage('control-panel', 'index.html'));

  return win;
}
