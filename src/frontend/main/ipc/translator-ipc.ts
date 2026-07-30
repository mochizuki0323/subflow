import { ipcMain } from 'electron';
import { Translator } from '../translator';
import type { IpcContext } from './context';

export function registerTranslatorIpc(ctx: IpcContext): void {
  ipcMain.on('set-translator-config', (_event, config: any) => {
    ctx.translator.setConfig(config);
    ctx.config.updateTranslator(ctx.translator.getConfig());
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
