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
import {
  getNemotronModelStatus,
  downloadNemotronModel,
  deleteNemotronModel,
  getNemotronModelDir,
  resolveNemotronModel,
} from '../nemotron-manager';
import { resolveParakeetModelArgs } from './stt-ipc';
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
      // If nothing usable was on disk when this download began, the running
      // backend is necessarily modelless and idle — restarting it with the new
      // model interrupts nothing, and it is the only recovery there is:
      // load_model runs once at spawn and is never retried.
      const hadUsable = !!resolveParakeetModelArgs(ctx.configDir, ctx.config.getParakeet().modelId).modelDir;
      // Auto-download VAD model if not present (small, ~629KB)
      if (!isVadModelDownloaded(ctx.configDir)) {
        await downloadVadModel(ctx.configDir);
      }
      const localDir = await downloadParakeetModel(ctx.configDir, modelId, onProgress);
      if (!hadUsable && ctx.config.getProvider() === 'parakeet') {
        const pkArgs = resolveParakeetModelArgs(ctx.configDir, ctx.config.getParakeet().modelId);
        if (pkArgs.modelDir) {
          if (pkArgs.modelId !== ctx.config.getParakeet().modelId) {
            ctx.config.updateParakeet({ modelId: pkArgs.modelId });
          }
          ctx.restartBackend({
            provider: 'parakeet',
            parakeetModelDir: pkArgs.modelDir,
            parakeetModelType: pkArgs.modelType,
            parakeetVadModel: pkArgs.vadModel,
            // Read from config rather than left to whatever the manager holds:
            // this is the one restart that can be the first with a usable model,
            // so a thread count saved while none existed never reached the
            // manager — the settings panel cannot restart without a model.
            parakeetThreads: ctx.config.getParakeet().numThreads,
          });
        }
      }
      return { localDir };
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

  // ---- Nemotron (streaming) ----
  // No VAD to fetch alongside: these models endpoint themselves.
  const nemotronDownloads = new DownloadTracker((modelId, percent) =>
    ctx.safeSend(ctx.mainWindow(), 'nemotron-download-progress', { modelId, percent }));

  ipcMain.handle('get-nemotron-models', () => getNemotronModelStatus(ctx.configDir));

  ipcMain.handle('get-nemotron-download-status', () => nemotronDownloads.status());

  ipcMain.handle('download-nemotron-model', (_event, modelId: string) =>
    nemotronDownloads.download(modelId, async (onProgress) => {
      // Same recovery as the parakeet download above: a modelless backend can
      // only be revived by a respawn, so give it the first usable model.
      const hadUsable = !!resolveNemotronModel(ctx.configDir, ctx.config.getNemotron().modelId);
      const localDir = await downloadNemotronModel(ctx.configDir, modelId, onProgress);
      if (!hadUsable && ctx.config.getProvider() === 'nemotron') {
        const nemo = resolveNemotronModel(ctx.configDir, ctx.config.getNemotron().modelId);
        if (nemo) {
          if (nemo.id !== ctx.config.getNemotron().modelId) {
            ctx.config.updateNemotron({ modelId: nemo.id });
          }
          ctx.restartBackend({
            provider: 'nemotron',
            nemotronModelDir: getNemotronModelDir(ctx.configDir, nemo),
          });
        }
      }
      return { localDir };
    }));

  ipcMain.handle('delete-nemotron-model', (_event, modelId: string) => {
    deleteNemotronModel(ctx.configDir, modelId);
    if (ctx.config.getNemotron().modelId === modelId) {
      ctx.config.updateNemotron({ modelId: '' });
    }
    return { success: true };
  });
}
