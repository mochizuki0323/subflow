import { ipcMain, nativeTheme } from 'electron';
import { resolveUiTheme, type UiPreferences } from '../ui-theme';
import { invalidateWallpaperAccentCache } from '../wallpaper-accent';
import type { IpcContext } from './context';

export function registerThemeIpc(ctx: IpcContext): void {
  let uiPrefs: UiPreferences = ctx.config.getUi();

  async function broadcastUiTheme(): Promise<void> {
    const payload = await resolveUiTheme(uiPrefs, nativeTheme.shouldUseDarkColors);
    ctx.safeSend(ctx.mainWindow(), 'ui-theme', payload);
    ctx.safeSend(ctx.overlayWindow(), 'ui-theme', payload);
    ctx.safeSend(ctx.historyWindow(), 'ui-theme', payload);
  }

  void broadcastUiTheme();

  nativeTheme.on('updated', () => {
    if (uiPrefs.appearance === 'system') void broadcastUiTheme();
  });

  ipcMain.handle('get-ui-theme', () => resolveUiTheme(uiPrefs, nativeTheme.shouldUseDarkColors));

  ipcMain.handle('set-ui-theme', async (_event, partial: Partial<UiPreferences>) => {
    uiPrefs = {
      ...uiPrefs,
      ...partial,
      appearance: partial.appearance ?? uiPrefs.appearance,
      accentSource: partial.accentSource ?? uiPrefs.accentSource,
    };
    ctx.config.updateUi(uiPrefs);
    const payload = await resolveUiTheme(uiPrefs, nativeTheme.shouldUseDarkColors);
    ctx.safeSend(ctx.mainWindow(), 'ui-theme', payload);
    ctx.safeSend(ctx.overlayWindow(), 'ui-theme', payload);
    ctx.safeSend(ctx.historyWindow(), 'ui-theme', payload);
    return payload;
  });

  ipcMain.handle('preview-ui-theme', async (_event, partial: Partial<UiPreferences>) => {
    const previewPrefs: UiPreferences = {
      appearance: partial.appearance ?? uiPrefs.appearance,
      accentSource: partial.accentSource ?? uiPrefs.accentSource,
    };
    const payload = await resolveUiTheme(previewPrefs, nativeTheme.shouldUseDarkColors);
    ctx.safeSend(ctx.mainWindow(), 'ui-theme', payload);
    ctx.safeSend(ctx.overlayWindow(), 'ui-theme', payload);
    ctx.safeSend(ctx.historyWindow(), 'ui-theme', payload);
    return payload;
  });

  ipcMain.handle('refresh-wallpaper-colors', async () => {
    // Explicit user action: re-read the wallpaper instead of serving the memoised accent.
    invalidateWallpaperAccentCache();
    const payload = await resolveUiTheme(uiPrefs, nativeTheme.shouldUseDarkColors);
    ctx.safeSend(ctx.mainWindow(), 'ui-theme', payload);
    ctx.safeSend(ctx.overlayWindow(), 'ui-theme', payload);
    ctx.safeSend(ctx.historyWindow(), 'ui-theme', payload);
    return payload;
  });
}
