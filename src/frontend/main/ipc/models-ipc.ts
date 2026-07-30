import { ipcMain } from 'electron';
import { DownloadTracker } from '../download-tracker';
import {
  findDenoiseModel,
  getModelStatus,
  getModelPath,
  isModelDownloaded,
  downloadModel,
  deleteModel,
  getModelsDir,
} from '../denoiser-manager';
import {
  getParakeetModelStatus,
  downloadParakeetModel,
  deleteParakeetModel,
  isVadModelDownloaded,
  downloadVadModel,
} from '../parakeet-manager';
import type { IpcContext } from './context';

export function registerModelsIpc(ctx: IpcContext): void {
  // ---- Denoiser ----
  const denoiserDownloads = new DownloadTracker((modelId, percent) =>
    ctx.safeSend(ctx.mainWindow(), 'denoiser-download-progress', { modelId, percent }));

  ipcMain.handle('get-denoiser-config', () => ctx.config.getDenoiser());

  ipcMain.handle('get-denoiser-models', () => getModelStatus(ctx.configDir));

  ipcMain.handle('set-denoiser-config', (_event, config: { enabled?: boolean; modelId?: string }) => {
    ctx.config.updateDenoiser(config);
    const updated = ctx.config.getDenoiser();
    const model = findDenoiseModel(updated.modelId);

    if (updated.enabled && model && isModelDownloaded(ctx.configDir, model)) {
      ctx.ws.send({
        type: 'set_denoise',
        data: { enabled: true, model_path: getModelPath(ctx.configDir, model), architecture: model.architecture },
      });
      ctx.backend.setDenoiseParams(true, getModelPath(ctx.configDir, model), model.architecture, getModelsDir(ctx.configDir));
    } else {
      ctx.ws.send({ type: 'set_denoise', data: { enabled: false, model_path: '', architecture: '' } });
      ctx.backend.setDenoiseParams(false, '', '', getModelsDir(ctx.configDir));
    }
    return { success: true };
  });

  ipcMain.handle('get-download-status', () => denoiserDownloads.status());

  ipcMain.handle('download-denoiser-model', (_event, modelId: string) =>
    denoiserDownloads.download(modelId, async (onProgress) => ({
      localPath: await downloadModel(ctx.configDir, modelId, onProgress),
    })));

  ipcMain.handle('delete-denoiser-model', (_event, modelId: string) => {
    deleteModel(ctx.configDir, modelId);
    return { success: true };
  });

  // ---- Parakeet models ----
  const parakeetDownloads = new DownloadTracker((modelId, percent) =>
    ctx.safeSend(ctx.mainWindow(), 'parakeet-download-progress', { modelId, percent }));

  ipcMain.handle('get-parakeet-models', () => getParakeetModelStatus(ctx.configDir));

  ipcMain.handle('get-parakeet-download-status', () => parakeetDownloads.status());

  ipcMain.handle('download-parakeet-model', (_event, modelId: string) =>
    parakeetDownloads.download(modelId, async (onProgress) => {
      // Auto-download VAD model if not present (small, ~629KB)
      if (!isVadModelDownloaded(ctx.configDir)) {
        await downloadVadModel(ctx.configDir);
      }
      return { localDir: await downloadParakeetModel(ctx.configDir, modelId, onProgress) };
    }));

  ipcMain.handle('delete-parakeet-model', (_event, modelId: string) => {
    deleteParakeetModel(ctx.configDir, modelId);
    return { success: true };
  });
}
