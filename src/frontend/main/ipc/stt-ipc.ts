import { ipcMain } from 'electron';
import {
  findParakeetModel,
  getParakeetModelDir,
  getParakeetModels,
  getVadModelPath,
  isParakeetModelDownloaded,
  isVadModelDownloaded,
} from '../parakeet-manager';
import {
  getNemotronModelDir,
  resolveNemotronModel,
  toNemotronLanguage,
} from '../nemotron-manager';
import type { ParakeetVadConfig } from '../unified-config';
import type { IpcContext } from './context';

const FETCH_TIMEOUT_MS = 10000;
const REMOTE_PROBE_TIMEOUT_MS = 5000;

function errorMessage(err: unknown, timeoutLabel: string): string {
  if (err instanceof Error && err.name === 'TimeoutError') return timeoutLabel;
  return err instanceof Error ? err.message : String(err);
}

/** Derive the http(s) base URL from a ws:// or wss:// server URL. */
function httpBaseFromWsUrl(serverUrl: string): { base?: string; error?: string } {
  let u: URL;
  try {
    u = new URL(serverUrl);
  } catch {
    return { error: 'invalid URL' };
  }
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
    return { error: 'URL must start with ws:// or wss://' };
  }
  return { base: `${u.protocol === 'wss:' ? 'https' : 'http'}://${u.host}` };
}

/**
 * Resolve CLI args for a downloaded Parakeet model (empty strings when none is
 * usable). A configured id whose files are not on disk falls back to the first
 * fully-downloaded model — same rule as the panel's picker — and `modelId`
 * names what was actually chosen so the caller can write it back.
 */
export function resolveParakeetModelArgs(
  configDir: string,
  modelId: string | undefined,
): { modelDir: string; modelType: string; vadModel: string; modelId: string } {
  const chosen = modelId ? findParakeetModel(modelId) : undefined;
  const model = chosen && isParakeetModelDownloaded(configDir, chosen)
    ? chosen
    : getParakeetModels().find(m => isParakeetModelDownloaded(configDir, m));
  if (!model) return { modelDir: '', modelType: '', vadModel: '', modelId: '' };
  return {
    modelDir: getParakeetModelDir(configDir, model),
    modelType: model.type,
    vadModel: isVadModelDownloaded(configDir) ? getVadModelPath(configDir) : '',
    modelId: model.id,
  };
}

function vadCommandData(vad: ParakeetVadConfig) {
  return {
    threshold: vad.threshold,
    min_silence: vad.minSilence,
    min_speech: vad.minSpeech,
    max_speech: vad.maxSpeech,
    partial_interval: vad.partialInterval,
  };
}

export function registerSttIpc(ctx: IpcContext): void {
  // ---- STT provider ----
  ipcMain.handle('get-stt-provider', () => ctx.config.getProvider());

  ipcMain.handle('set-stt-provider', (_event, provider: string) => {
    if (provider !== 'parakeet' && provider !== 'nemotron' && provider !== 'remote_parakeet') return { success: false };
    ctx.config.updateProvider(provider);
    const pk = ctx.config.getParakeet();
    const pkArgs = provider === 'parakeet'
      ? resolveParakeetModelArgs(ctx.configDir, pk.modelId)
      : { modelDir: '', modelType: '', vadModel: '', modelId: '' };
    // Persist what the fallback picked: the backend and the panel must name the
    // same model, or the picker shows a selection the backend never received.
    if (provider === 'parakeet' && pkArgs.modelId && pkArgs.modelId !== pk.modelId) {
      ctx.config.updateParakeet({ modelId: pkArgs.modelId });
    }
    const nemo = provider === 'nemotron'
      ? resolveNemotronModel(ctx.configDir, ctx.config.getNemotron().modelId)
      : undefined;
    if (nemo && nemo.id !== ctx.config.getNemotron().modelId) {
      ctx.config.updateNemotron({ modelId: nemo.id });
    }
    ctx.restartBackend({
      provider,
      language: provider === 'nemotron'
        ? toNemotronLanguage(ctx.appSettings().sourceLanguage)
        : ctx.appSettings().sourceLanguage,
      parakeetModelDir: pkArgs.modelDir, parakeetModelType: pkArgs.modelType, parakeetVadModel: pkArgs.vadModel,
      parakeetThreads: pk.numThreads,
      parakeetVad: provider === 'remote_parakeet' ? ctx.config.getRemoteParakeet().vad : pk.vad,
      remoteParakeetUrl: ctx.config.getRemoteParakeet().serverUrl,
      remoteParakeetApiKey: ctx.config.getRemoteParakeet().apiKey,
      remoteParakeetModel: ctx.config.getRemoteParakeet().model,
      nemotronModelDir: nemo ? getNemotronModelDir(ctx.configDir, nemo) : '',
      nemotronThreads: ctx.config.getNemotron().numThreads,
      nemotronMinSilence: ctx.config.getNemotron().minSilence,
      nemotronMaxUtterance: ctx.config.getNemotron().maxUtterance,
    });
    return { success: true };
  });

  /**
   * Whether the running recogniser can actually be asked for the configured
   * source language. Each Parakeet model covers a fixed list, and asking the
   * 25-language European one for Japanese produces confident nonsense with
   * nothing anywhere saying why — the model loads, the backend reports ready,
   * and only the captions are wrong. Answered here rather than in the panel
   * because it resolves by the same rule the spawn does, so a stale config that
   * makes the picker and the backend name different models cannot make this
   * answer follow the picker. It reads config and disk rather than the running
   * process, so it describes the model a respawn would load — the two differ
   * only in the window after deleting the model that is still resident.
   */
  ipcMain.handle('get-language-support', () => {
    const language = ctx.appSettings().sourceLanguage || 'auto';
    const none = { language, supported: true, modelLanguages: [] as string[] };
    if (language === 'auto') return none;
    const provider = ctx.config.getProvider();
    if (provider === 'parakeet') {
      const { modelId } = resolveParakeetModelArgs(ctx.configDir, ctx.config.getParakeet().modelId);
      const model = modelId ? findParakeetModel(modelId) : undefined;
      // No usable model is already its own fault on the rail; do not accuse twice.
      if (!model) return none;
      return { language, supported: model.languages.includes(language), modelLanguages: model.languages };
    }
    if (provider === 'nemotron') {
      // An unlisted language is not an error to this model — it quietly falls
      // back to auto-detect — so the mapping refusing to resolve is the only
      // signal that the prompt dictionary has no entry for it.
      return { ...none, supported: toNemotronLanguage(language) !== 'auto' };
    }
    // The remote server owns its model list; the app cannot know it.
    return none;
  });

  // ---- Nemotron (local, streaming) config ----
  ipcMain.handle('get-nemotron-config', () => ctx.config.getNemotron());

  ipcMain.handle('set-nemotron-config', (_event, config: {
    modelId?: string; numThreads?: number; minSilence?: number; maxUtterance?: number;
  }) => {
    ctx.config.updateNemotron(config);
    let updated = ctx.config.getNemotron();
    if (ctx.config.getProvider() === 'nemotron') {
      const nemo = resolveNemotronModel(ctx.configDir, updated.modelId);
      if (nemo && nemo.id !== updated.modelId) {
        ctx.config.updateNemotron({ modelId: nemo.id });
        updated = ctx.config.getNemotron();
      }
      // The language lives in app.sourceLanguage like every provider's; it only
      // rides along here because a restart respawns with fresh CLI args.
      ctx.restartBackend({
        provider: 'nemotron',
        nemotronModelDir: nemo ? getNemotronModelDir(ctx.configDir, nemo) : '',
        nemotronThreads: updated.numThreads,
        nemotronMinSilence: updated.minSilence,
        nemotronMaxUtterance: updated.maxUtterance,
        language: toNemotronLanguage(ctx.appSettings().sourceLanguage),
      });
    }
    return { success: true, config: updated };
  });

  // ---- Parakeet (local) config ----
  ipcMain.handle('get-parakeet-config', () => ctx.config.getParakeet());

  ipcMain.handle('set-parakeet-config', (_event, config: { modelId?: string; numThreads?: number }) => {
    ctx.config.updateParakeet(config);
    const updated = ctx.config.getParakeet();
    if (ctx.config.getProvider() === 'parakeet' && updated.modelId) {
      const pkArgs = resolveParakeetModelArgs(ctx.configDir, updated.modelId);
      if (pkArgs.modelId && pkArgs.modelId !== updated.modelId) {
        ctx.config.updateParakeet({ modelId: pkArgs.modelId });
      }
      if (pkArgs.modelDir) {
        ctx.restartBackend({
          provider: 'parakeet',
          parakeetModelDir: pkArgs.modelDir,
          parakeetModelType: pkArgs.modelType,
          parakeetVadModel: pkArgs.vadModel,
          parakeetThreads: updated.numThreads,
          language: ctx.appSettings().sourceLanguage,
        });
      }
    }
    return { success: true };
  });

  ipcMain.handle('set-parakeet-vad-config', (_event, vad: Partial<ParakeetVadConfig>) => {
    ctx.config.updateParakeet({ vad: vad as ParakeetVadConfig });
    const updated = ctx.config.getParakeet();
    // VAD tuning applies at runtime (no restart) when Parakeet is active. Guarding on
    // the provider keeps the shared BackendManager VAD field from being overwritten
    // by a panel for a provider that is not running.
    let applied = false;
    if (ctx.config.getProvider() === 'parakeet') {
      applied = ctx.ws.send({ type: 'set_vad', data: vadCommandData(updated.vad) });
      ctx.backend.setParakeetVadParams(updated.vad);
    }
    return { success: true, applied, vad: updated.vad };
  });

  // ---- Remote Parakeet config ----
  ipcMain.handle('get-remote-parakeet-config', () => ctx.config.getRemoteParakeet());

  ipcMain.handle('set-remote-parakeet-config', (_event, config: { serverUrl?: string; apiKey?: string; model?: string }) => {
    ctx.config.updateRemoteParakeet(config);
    const updated = ctx.config.getRemoteParakeet();
    if (ctx.config.getProvider() === 'remote_parakeet') {
      ctx.restartBackend({
        remoteParakeetUrl: updated.serverUrl,
        remoteParakeetApiKey: updated.apiKey,
        remoteParakeetModel: updated.model,
        parakeetVad: updated.vad,
        language: ctx.appSettings().sourceLanguage,
      });
    }
    return { success: true, config: updated };
  });

  // VAD tuning applies at runtime (no restart/reconnect) — same set_vad command
  // the backend forwards to the remote server session.
  ipcMain.handle('set-remote-parakeet-vad-config', (_event, vad: Partial<ParakeetVadConfig>) => {
    ctx.config.updateRemoteParakeet({ vad: vad as ParakeetVadConfig });
    const updated = ctx.config.getRemoteParakeet();
    let applied = false;
    if (ctx.config.getProvider() === 'remote_parakeet') {
      applied = ctx.ws.send({ type: 'set_vad', data: vadCommandData(updated.vad) });
      ctx.backend.setParakeetVadParams(updated.vad);
    }
    return { success: true, applied, vad: updated.vad };
  });

  // Probe the server's /healthz (HTTP derived from the ws/wss URL).
  ipcMain.handle('test-remote-parakeet', async (_event, { serverUrl, apiKey }: { serverUrl: string; apiKey: string }) => {
    const { base, error } = httpBaseFromWsUrl(serverUrl);
    if (!base) return { success: false, error };
    try {
      const res = await fetch(`${base}/healthz`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(REMOTE_PROBE_TIMEOUT_MS),
      });
      void res.arrayBuffer().catch(() => {});
      if (res.status === 200) return { success: true };
      return { success: false, error: `HTTP ${res.status}` };
    } catch (err) {
      return { success: false, error: errorMessage(err, 'timeout') };
    }
  });

  // Fetch the server's model list from GET /models (HTTP derived from the ws/wss URL).
  ipcMain.handle('fetch-remote-parakeet-models', async (_event, { serverUrl, apiKey }: { serverUrl: string; apiKey: string }) => {
    const { base, error } = httpBaseFromWsUrl(serverUrl);
    if (!base) return { success: false, error };
    try {
      const res = await fetch(`${base}/models`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(REMOTE_PROBE_TIMEOUT_MS),
      });
      if (res.status !== 200) {
        void res.arrayBuffer().catch(() => {});
        return { success: false, error: `HTTP ${res.status}` };
      }
      let data: any;
      try {
        data = await res.json();
      } catch {
        return { success: false, error: 'invalid response' };
      }
      const models = Array.isArray(data?.models)
        ? data.models.map((m: any) => ({ id: String(m.id ?? ''), type: String(m.type ?? '') })).filter((m: any) => m.id)
        : [];
      return { success: true, models };
    } catch (err) {
      return { success: false, error: errorMessage(err, 'timeout') };
    }
  });
}
