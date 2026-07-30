import { ipcMain } from 'electron';
import { Translator } from '../translator';
import type { IpcContext } from './context';

export function registerTranslatorIpc(ctx: IpcContext): void {
  ipcMain.on('set-translator-config', (_event, config: any) => {
    const wasEnabled = ctx.translator.getConfig().enabled;
    ctx.translator.setConfig(config);
    const updated = ctx.translator.getConfig();
    ctx.config.updateTranslator(updated);

    // Translation only runs when the subtitle mode asks for it, so enabling it while
    // the mode is "original" used to produce nothing and say nothing. Rather than
    // warning about the contradiction, remove it: switching translation on means you
    // want to see the translation.
    if (!wasEnabled && updated.enabled && ctx.appSettings().subtitleMode === 'original') {
      ctx.updateAppSettings({ subtitleMode: 'bilingual' });
      ctx.ws.send({ type: 'set_subtitle_mode', data: { mode: 'bilingual' } });
      ctx.safeSend(ctx.mainWindow(), 'subtitle-mode', 'bilingual');
      ctx.safeSend(ctx.overlayWindow(), 'subtitle-mode', 'bilingual');
      ctx.safeSend(ctx.historyWindow(), 'subtitle-mode', 'bilingual');
    }
  });

  ipcMain.handle('get-translator-config', () => ctx.translator.getConfig());

  ipcMain.handle('test-translator', async () => {
    try {
      const result = await ctx.translator.translate('Hello, this is a test.');
      return result ? { success: true } : { success: false, error: 'Empty response' };
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('test-translator-with-config', async (_event, config: any) => {
    const tempTranslator = new Translator();
    tempTranslator.setConfig(config);
    try {
      const result = await tempTranslator.translate('Hello, this is a test.');
      return result ? { success: true } : { success: false, error: 'Empty response' };
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) };
    }
  });
}
