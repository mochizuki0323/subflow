import path from 'path';
import { app } from 'electron';

/**
 * Vite `outDir: dist/renderer` with entries in `src/frontend/renderer/...`,
 * so build artifacts land at dist/renderer/src/frontend/renderer/<page>/...
 * Both dev and asar paths are relative to app.getAppPath().
 */
export function getRendererPage(...segments: string[]): string {
  return path.join(app.getAppPath(), 'dist/renderer/src/frontend/renderer', ...segments);
}
