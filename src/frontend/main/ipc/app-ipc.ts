import { app, ipcMain, shell } from 'electron';
import type { AppSettings, UiLanguage } from '../app-settings';
import type { IpcContext } from './context';

export function registerAppIpc(ctx: IpcContext): void {
  // ---- Commands ----
  ipcMain.on('send-command', (_event, msg) => ctx.ws.send(msg));
  ipcMain.on('list-sources', () => ctx.ws.send({ type: 'list_sources' }));

  ipcMain.on('select-source', (_event, id: number) => {
    ctx.setLastCaptureSourceId(id);
    ctx.ws.send({ type: 'select_source', data: { id } });
  });

  ipcMain.on('set-language', (_event, language: string) => {
    ctx.updateAppSettings({ sourceLanguage: language });
    ctx.ws.send({ type: 'set_language', data: { language } });
  });

  ipcMain.on('set-translate', (_event, translate: boolean) => {
    ctx.ws.send({ type: 'set_translate', data: { translate } });
  });

  ipcMain.on('set-subtitle-mode', (_event, mode: string) => {
    if (mode !== 'original' && mode !== 'translated' && mode !== 'bilingual') return;
    ctx.updateAppSettings({ subtitleMode: mode as AppSettings['subtitleMode'] });
    ctx.ws.send({ type: 'set_subtitle_mode', data: { mode } });
    ctx.safeSend(ctx.overlayWindow(), 'subtitle-mode', mode);
    ctx.safeSend(ctx.historyWindow(), 'subtitle-mode', mode);
  });

  ipcMain.on('start-capture', () => ctx.ws.send({ type: 'start' }));
  ipcMain.on('stop-capture', () => ctx.ws.send({ type: 'stop' }));

  // ---- App info ----
  ipcMain.handle('get-app-version', () => app.getVersion());

  ipcMain.handle('open-external', (_event, url: string) => {
    if (url.startsWith('https://')) shell.openExternal(url);
  });

  // ---- App settings ----
  ipcMain.handle('get-app-settings', () => ctx.appSettings());

  ipcMain.handle('set-ui-language', (_event, lang: UiLanguage) => {
    if (lang !== 'en' && lang !== 'zh') return ctx.appSettings();
    ctx.updateAppSettings({ uiLanguage: lang });
    ctx.safeSend(ctx.mainWindow(), 'ui-language', lang);
    ctx.safeSend(ctx.overlayWindow(), 'ui-language', lang);
    ctx.safeSend(ctx.historyWindow(), 'ui-language', lang);
    return ctx.appSettings();
  });

  ipcMain.handle('set-show-partials', (_event, show: boolean) => {
    ctx.updateAppSettings({ showPartials: !!show });
    ctx.safeSend(ctx.overlayWindow(), 'show-partials', !!show);
    ctx.safeSend(ctx.historyWindow(), 'show-partials', !!show);
    return ctx.appSettings();
  });
}
