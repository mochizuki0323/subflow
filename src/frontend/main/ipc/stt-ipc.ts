import { ipcMain } from 'electron';
import {
  findParakeetModel,
  getParakeetModelDir,
  getVadModelPath,
  isParakeetModelDownloaded,
  isVadModelDownloaded,
} from '../parakeet-manager';
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

/** Resolve CLI args for a downloaded Parakeet model (empty strings when unavailable). */
export function resolveParakeetModelArgs(
  configDir: string,
  modelId: string | undefined,
): { modelDir: string; modelType: string; vadModel: string } {
  if (modelId) {
    const model = findParakeetModel(modelId);
    if (model && isParakeetModelDownloaded(configDir, model)) {
      return {
        modelDir: getParakeetModelDir(configDir, model),
        modelType: model.type,
        vadModel: isVadModelDownloaded(configDir) ? getVadModelPath(configDir) : '',
      };
    }
  }
  return { modelDir: '', modelType: '', vadModel: '' };
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
    if (provider !== 'parakeet' && provider !== 'remote_parakeet') return { success: false };
    ctx.config.updateProvider(provider);
    const pk = ctx.config.getParakeet();
    const pkArgs = provider === 'parakeet'
      ? resolveParakeetModelArgs(ctx.configDir, pk.modelId)
      : { modelDir: '', modelType: '', vadModel: '' };
    ctx.restartBackend({
      provider,
      language: ctx.appSettings().sourceLanguage,
      parakeetModelDir: pkArgs.modelDir, parakeetModelType: pkArgs.modelType, parakeetVadModel: pkArgs.vadModel,
      parakeetVad: provider === 'remote_parakeet' ? ctx.config.getRemoteParakeet().vad : pk.vad,
      remoteParakeetUrl: ctx.config.getRemoteParakeet().serverUrl,
      remoteParakeetApiKey: ctx.config.getRemoteParakeet().apiKey,
      remoteParakeetModel: ctx.config.getRemoteParakeet().model,
    });
    return { success: true };
  });

  // ---- Parakeet (local) config ----
  ipcMain.handle('get-parakeet-config', () => ctx.config.getParakeet());

  ipcMain.handle('set-parakeet-config', (_event, config: { modelId?: string }) => {
    ctx.config.updateParakeet(config);
    const updated = ctx.config.getParakeet();
    if (ctx.config.getProvider() === 'parakeet' && updated.modelId) {
      const pkArgs = resolveParakeetModelArgs(ctx.configDir, updated.modelId);
      if (pkArgs.modelDir) {
        ctx.restartBackend({
          provider: 'parakeet',
          parakeetModelDir: pkArgs.modelDir,
          parakeetModelType: pkArgs.modelType,
          parakeetVadModel: pkArgs.vadModel,
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
