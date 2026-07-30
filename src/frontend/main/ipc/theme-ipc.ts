import { ipcMain, nativeTheme } from 'electron';
import { resolveUiTheme, type UiPreferences } from '../ui-theme';
import type { IpcContext } from './context';

export function registerThemeIpc(ctx: IpcContext): void {
  let uiPrefs: UiPreferences = ctx.config.getUi();

  function broadcastUiTheme(): void {
    const payload = resolveUiTheme(uiPrefs, nativeTheme.shouldUseDarkColors);
    ctx.safeSend(ctx.mainWindow(), 'ui-theme', payload);
    ctx.safeSend(ctx.overlayWindow(), 'ui-theme', payload);
    ctx.safeSend(ctx.historyWindow(), 'ui-theme', payload);
  }

  broadcastUiTheme();

  nativeTheme.on('updated', () => {
    if (uiPrefs.appearance === 'system') broadcastUiTheme();
  });

  ipcMain.handle('get-ui-theme', () => resolveUiTheme(uiPrefs, nativeTheme.shouldUseDarkColors));

  ipcMain.handle('set-ui-theme', (_event, partial: Partial<UiPreferences>) => {
    uiPrefs = {
      ...uiPrefs,
      ...partial,
      appearance: partial.appearance ?? uiPrefs.appearance,
      accentSource: partial.accentSource ?? uiPrefs.accentSource,
    };
    ctx.config.updateUi(uiPrefs);
    broadcastUiTheme();
    return resolveUiTheme(uiPrefs, nativeTheme.shouldUseDarkColors);
  });

  ipcMain.handle('preview-ui-theme', (_event, partial: Partial<UiPreferences>) => {
    const previewPrefs: UiPreferences = {
      appearance: partial.appearance ?? uiPrefs.appearance,
      accentSource: partial.accentSource ?? uiPrefs.accentSource,
    };
    const payload = resolveUiTheme(previewPrefs, nativeTheme.shouldUseDarkColors);
    ctx.safeSend(ctx.mainWindow(), 'ui-theme', payload);
    ctx.safeSend(ctx.overlayWindow(), 'ui-theme', payload);
    ctx.safeSend(ctx.historyWindow(), 'ui-theme', payload);
    return payload;
  });

  ipcMain.handle('refresh-wallpaper-colors', () => {
    broadcastUiTheme();
    return resolveUiTheme(uiPrefs, nativeTheme.shouldUseDarkColors);
  });
}
