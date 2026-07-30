import { app, BrowserWindow, dialog, ipcMain, Menu, screen } from 'electron';
import { BackendManager } from './backend-manager';
import { WsClient } from './ws-client';
import { Translator } from './translator';
import { createMainWindow } from './windows/main-window';
import { createOverlayWindow } from './windows/overlay-window';
import { createHistoryWindow } from './windows/history-window';
import fs from 'fs';
import { PRODUCT_NAME } from './app-metadata';
import {
  getAppConfigDir,
  ensureConfigDirExists,
  migrateConfigsFromLinuxExecDir,
  migrateConfigsFromUserData,
} from './app-config-dir';
import type { AppSettings } from './app-settings';
import { UnifiedConfigManager } from './unified-config';
import { TranscriptLog, toSrt, toText } from './transcript-log';
import { findDenoiseModel, getModelPath, getModelsDir, isModelDownloaded } from './denoiser-manager';
import type { BackendRestartOptions, IpcContext } from './ipc/context';
import { registerAppIpc } from './ipc/app-ipc';
import { registerModelsIpc } from './ipc/models-ipc';
import { registerSttIpc, resolveParakeetModelArgs } from './ipc/stt-ipc';
import { registerThemeIpc } from './ipc/theme-ipc';
import { registerTranslatorIpc } from './ipc/translator-ipc';
import { registerWindowIpc, type WindowIpc } from './ipc/window-ipc';
import path from 'path';

if (process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland') {
  // With ozone forced to x11 below, XDG_SESSION_TYPE=wayland (always set in
  // Wayland sessions) still sends Chromium's GL init down a Wayland path that
  // fails and falls back to broken software presentation — windows are
  // created but never painted. Chromium reads the variable before this script
  // runs, so mutating process.env here is too late for this process: respawn
  // ourselves once with the session type aligned to the platform we force.
  const { spawn } = require('child_process') as typeof import('child_process');
  spawn(process.execPath, process.argv.slice(1), {
    env: { ...process.env, XDG_SESSION_TYPE: 'x11' },
    detached: true,
    stdio: 'ignore',
  }).unref();
  process.exit(0);
}

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-transparent-visuals');
  // Force XWayland: Electron 41 defaults to native Wayland in Wayland
  // sessions, where xdg-shell has no client positioning — setPosition is a
  // no-op, so window dragging, position restore, and always-on-top all break.
  app.commandLine.appendSwitch('ozone-platform', 'x11');
  // The GPU process segfaults in a loop under XWayland on some virtio/VM
  // setups (exit_code=139, no frame ever painted → invisible windows), and
  // fully disabling the GPU breaks transparent-window presentation
  // (XGetWindowAttributes failures). SwiftShader keeps the normal GPU
  // pipeline but rasterizes in software — plenty for subtitle overlays.
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
}

const WS_PORT = 9876;

let backendManager: BackendManager;
let wsClient: WsClient;
let configManager: UnifiedConfigManager;
const translator = new Translator();

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let historyWindow: BrowserWindow | null = null;
let windowIpc: WindowIpc | null = null;

let appSettings: AppSettings = { sourceLanguage: 'auto', uiLanguage: 'zh', subtitleMode: 'original', showPartials: false };
let lastCaptureSourceId = 0;
let backendState: { state: string; code?: number | null } = { state: 'connecting' };
const transcriptLog = new TranscriptLog();

function safeSend(win: BrowserWindow | null, channel: string, ...args: unknown[]): void {
  if (!win || win.isDestroyed()) return;
  (win.webContents as { send: (ch: string, ...a: unknown[]) => void }).send(channel, ...args);
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  app.setName(PRODUCT_NAME);

  const isDev = !app.isPackaged;
  const backendExe = process.platform === 'win32' ? 'subflow-backend.exe' : 'subflow-backend';
  const backendCandidates = isDev
    ? [
        path.join(__dirname, '../../build/bin', backendExe),
        path.join(__dirname, '../../build-mingw/bin', backendExe),
      ]
    : [path.join(process.resourcesPath, 'bin', backendExe)];
  const backendPath = backendCandidates.find((p) => fs.existsSync(p)) || backendCandidates[0];
  if (!fs.existsSync(backendPath)) {
    console.error(`Backend binary not found: ${backendPath}`);
  }

  const configDir = getAppConfigDir();
  ensureConfigDirExists(configDir);
  migrateConfigsFromLinuxExecDir(configDir);
  migrateConfigsFromUserData(configDir);

  configManager = new UnifiedConfigManager(configDir);
  appSettings = configManager.getApp();
  translator.setConfig(configManager.getTranslator());

  const provider = configManager.getProvider();
  const pkConfig = configManager.getParakeet();

  // Resolve parakeet model directory, type, and VAD path
  const pkArgs = provider === 'parakeet'
    ? resolveParakeetModelArgs(configDir, pkConfig.modelId)
    : { modelDir: '', modelType: '', vadModel: '' };

  backendManager = new BackendManager(backendPath, WS_PORT, {
    provider,
    language: appSettings.sourceLanguage,
    parakeetModelDir: pkArgs.modelDir || undefined,
    parakeetModelType: pkArgs.modelType || undefined,
    parakeetVadModel: pkArgs.vadModel || undefined,
    parakeetVad: provider === 'remote_parakeet' ? configManager.getRemoteParakeet().vad : pkConfig.vad,
    remoteParakeetUrl: configManager.getRemoteParakeet().serverUrl || undefined,
    remoteParakeetApiKey: configManager.getRemoteParakeet().apiKey || undefined,
    remoteParakeetModel: configManager.getRemoteParakeet().model || undefined,
  });

  // Set up denoiser if configured
  const denoiserConfig = configManager.getDenoiser();
  if (denoiserConfig.enabled) {
    const model = findDenoiseModel(denoiserConfig.modelId);
    if (model && isModelDownloaded(configDir, model)) {
      backendManager.setDenoiseParams(true, getModelPath(configDir, model), model.architecture, getModelsDir(configDir));
    }
  }

  backendManager.spawn();

  wsClient = new WsClient(`ws://127.0.0.1:${WS_PORT}`);

  const ctx: IpcContext = {
    configDir,
    config: configManager,
    backend: backendManager,
    ws: wsClient,
    translator,
    mainWindow: () => mainWindow,
    overlayWindow: () => overlayWindow,
    historyWindow: () => historyWindow,
    safeSend,
    appSettings: () => appSettings,
    updateAppSettings: (partial) => {
      appSettings = { ...appSettings, ...partial };
      configManager.updateApp(partial);
    },
    setLastCaptureSourceId: (id) => { lastCaptureSourceId = id; },
    restartBackend: (opts: BackendRestartOptions) => {
      backendState = { state: 'restarting' };
      safeSend(mainWindow, 'backend-state', backendState);
      wsClient.disconnect();
      backendManager.restart(opts);
      setTimeout(() => wsClient.connect(), 2000);
    },
  };

  await new Promise(resolve => setTimeout(resolve, 1000));

  setTimeout(() => {
    mainWindow = createMainWindow();
    overlayWindow = createOverlayWindow();
    historyWindow = createHistoryWindow();

    mainWindow.on('close', () => {
      app.quit();
    });

    backendManager.on('log', (line: string) => {
      safeSend(mainWindow, 'log', {
        level: line.toLowerCase().includes('error') ? 'error' : 'info',
        message: line,
      });
    });

    // Restore saved positions. Positions persisted by older builds running
    // native Wayland are garbage (clients can't know their position there) —
    // drop any rect that doesn't intersect a display instead of restoring it.
    const isOnSomeDisplay = (x: number, y: number, w: number, h: number): boolean =>
      screen.getAllDisplays().some((d) => {
        const a = d.workArea;
        return x < a.x + a.width && x + w > a.x && y < a.y + a.height && y + h > a.y;
      });
    const positions = configManager.getWindowPositions();
    if (positions.overlay) {
      const { x, y, width, height } = positions.overlay;
      const [dw, dh] = overlayWindow!.getSize();
      if (isOnSomeDisplay(x, y, width || dw, height || dh)) {
        if (width && height) overlayWindow!.setBounds({ x, y, width, height });
        else overlayWindow!.setPosition(x, y);
      }
    }
    if (positions.history) {
      const { x, y, width, height } = positions.history;
      const [dw, dh] = historyWindow!.getSize();
      if (isOnSomeDisplay(x, y, width || dw, height || dh)) {
        if (width && height) historyWindow!.setBounds({ x, y, width, height });
        else historyWindow!.setPosition(x, y);
      }
    }

    // Route backend messages to renderers
    wsClient.on('transcript', async (data) => {
      const tcfg = translator.getConfig();
      // Skip interim/partial transcripts unless the user opted in — translating
      // every partial multiplies API requests and easily trips provider rate limits.
      if (tcfg.enabled && appSettings.subtitleMode !== 'original' && data.text && (!data.partial || tcfg.translatePartials)) {
        try {
          const sourceText = data.text.trim();
          const translated = await translator.translate(sourceText);
          if (translated) {
            data.translated_text = translated;
            translator.pushHistory(sourceText, translated);
          }
        } catch (err: any) {
          const errMsg = err?.message || String(err);
          safeSend(mainWindow, 'translator-error', errMsg);
        }
      }
      transcriptLog.push(data);
      safeSend(overlayWindow, 'subtitle', data);
      safeSend(historyWindow, 'subtitle', data);
      safeSend(mainWindow, 'subtitle', data);
    });

    /**
     * Everything the backend needs to match the config, replayed on every connect.
     *
     * A fresh process starts from its CLI args and a reconnect starts from nothing,
     * so anything applied as a live command has to be re-sent here. Denoise and VAD
     * used to be missing, which meant any change made during the ~2.5 s restart
     * window was silently dropped while the UI reported success.
     */
    // The renderer is created after the socket already connected, so it would miss
    // the first event entirely. Keep the value and let it be fetched on mount.
    const setBackendState = (state: string, code?: number | null) => {
      backendState = { state, code };
      safeSend(mainWindow, 'backend-state', backendState);
    };

    const applyLiveState = () => {
      wsClient.send({ type: 'set_language', data: { language: appSettings.sourceLanguage } });
      wsClient.send({ type: 'set_subtitle_mode', data: { mode: appSettings.subtitleMode } });

      const denoise = configManager.getDenoiser();
      const denoiseModel = denoise.enabled ? findDenoiseModel(denoise.modelId) : null;
      if (denoiseModel && isModelDownloaded(configDir, denoiseModel)) {
        wsClient.send({
          type: 'set_denoise',
          data: {
            enabled: true,
            model_path: getModelPath(configDir, denoiseModel),
            architecture: denoiseModel.architecture,
          },
        });
      } else {
        wsClient.send({ type: 'set_denoise', data: { enabled: false, model_path: '', architecture: '' } });
      }

      const activeProvider = configManager.getProvider();
      if (activeProvider === 'parakeet' || activeProvider === 'remote_parakeet') {
        const vad = activeProvider === 'remote_parakeet'
          ? configManager.getRemoteParakeet().vad
          : configManager.getParakeet().vad;
        wsClient.send({ type: 'set_vad', data: vad });
      }

      // Only resume capture if the user did not stop it. `lastCaptureSourceId` is
      // cleared by stop-capture precisely so a restart cannot revive a session the
      // user ended.
      if (lastCaptureSourceId > 0) {
        setTimeout(() => {
          wsClient.send({ type: 'select_source', data: { id: lastCaptureSourceId } });
        }, 300);
      }
    };

    wsClient.on('connected', () => {
      applyLiveState();
      setBackendState('connected');
    });

    wsClient.on('disconnected', () => setBackendState('disconnected'));

    backendManager.on('exited', (code: number | null) => setBackendState('exited', code));

    ipcMain.handle('get-backend-state', () => backendState);

    // Both history views read this one record instead of accumulating their own.
    ipcMain.handle('get-transcript-log', () => transcriptLog.all());
    ipcMain.handle('clear-transcript-log', () => {
      transcriptLog.clear();
      safeSend(mainWindow, 'transcript-cleared');
      safeSend(historyWindow, 'transcript-cleared');
      return { success: true };
    });

    ipcMain.handle('export-transcript', async (_event, format: 'srt' | 'txt') => {
      const entries = transcriptLog.finals();
      if (entries.length === 0) return { success: false, error: 'empty' };
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const { canceled, filePath } = await dialog.showSaveDialog({
        defaultPath: `subflow-${stamp}.${format}`,
        filters: [{ name: format.toUpperCase(), extensions: [format] }],
      });
      if (canceled || !filePath) return { success: false, error: 'canceled' };
      try {
        fs.writeFileSync(filePath, format === 'srt' ? toSrt(entries) : toText(entries), 'utf-8');
        return { success: true, path: filePath };
      } catch (err: any) {
        return { success: false, error: err?.message || String(err) };
      }
    });

    wsClient.connect();

    wsClient.on('sources', (data) => safeSend(mainWindow, 'sources', data));
    wsClient.on('status', (data) => safeSend(mainWindow, 'status', data));
    wsClient.on('log', (data) => safeSend(mainWindow, 'log', data));
    wsClient.on('model_loaded', (data) => safeSend(mainWindow, 'model_loaded', data));
    // The overlay needs this too: its level tick is the only thing telling the user
    // the pipeline is still alive while they are looking at something else.
    wsClient.on('audio_level', (data) => {
      safeSend(mainWindow, 'audio_level', data);
      safeSend(overlayWindow, 'audio_level', data);
    });

    registerAppIpc(ctx);
    registerSttIpc(ctx);
    registerTranslatorIpc(ctx);
    registerModelsIpc(ctx);
    windowIpc = registerWindowIpc(ctx);
    registerThemeIpc(ctx);
  }, 500);
  });

  app.on('window-all-closed', () => {
    backendManager?.kill();
    app.quit();
  });

  app.on('before-quit', () => {
    windowIpc?.saveWindowPositions();
    wsClient?.shutdown();
    backendManager?.kill();
  });
}
