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

  /** Push the stored denoise config to the backend. Reports whether it landed. */
  function pushDenoise(): boolean {
    const updated = ctx.config.getDenoiser();
    const model = findDenoiseModel(updated.modelId);

    if (updated.enabled && model && isModelDownloaded(ctx.configDir, model)) {
      const path = getModelPath(ctx.configDir, model);
      ctx.backend.setDenoiseParams(true, path, model.architecture, getModelsDir(ctx.configDir));
      return ctx.ws.send({
        type: 'set_denoise',
        data: { enabled: true, model_path: path, architecture: model.architecture },
      });
    }
    ctx.backend.setDenoiseParams(false, '', '', getModelsDir(ctx.configDir));
    return ctx.ws.send({ type: 'set_denoise', data: { enabled: false, model_path: '', architecture: '' } });
  }

  ipcMain.handle('set-denoiser-config', (_event, config: { enabled?: boolean; modelId?: string }) => {
    ctx.config.updateDenoiser(config);
    // `applied: false` means the socket was down; the config is saved and will be
    // replayed on reconnect, so the UI must say "will apply", not "applied".
    return { success: true, applied: pushDenoise() };
  });

  ipcMain.handle('get-download-status', () => denoiserDownloads.status());

  ipcMain.handle('download-denoiser-model', (_event, modelId: string) =>
    denoiserDownloads.download(modelId, async (onProgress) => ({
      localPath: await downloadModel(ctx.configDir, modelId, onProgress),
    })));

  ipcMain.handle('delete-denoiser-model', (_event, modelId: string) => {
    deleteModel(ctx.configDir, modelId);
    // Deleting the model that is in use used to leave the config pointing at it, so
    // the next launch quietly ran without denoising while the UI still claimed it
    // was on. Reconcile here, where we know what was removed.
    if (ctx.config.getDenoiser().modelId === modelId) {
      ctx.config.updateDenoiser({ enabled: false, modelId: '' });
      pushDenoise();
    }
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
    // Same reconciliation as denoise: a provider left pointing at a deleted model
    // respawns with an empty --parakeet-model-dir and transcribes nothing at all.
    if (ctx.config.getParakeet().modelId === modelId) {
      ctx.config.updateParakeet({ modelId: '' });
    }
    return { success: true };
  });
}
