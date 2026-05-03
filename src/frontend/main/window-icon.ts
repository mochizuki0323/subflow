import { app } from 'electron';
import path from 'path';

export function getWindowIcon(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'icon.ico');
  }
  return path.join(__dirname, '../../resources/icon.ico');
}
