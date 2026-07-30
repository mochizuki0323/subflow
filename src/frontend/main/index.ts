import { app, BrowserWindow, Menu } from 'electron';
import { BackendManager } from './backend-manager';
import { WsClient } from './ws-client';
import { buildExtraParams, buildGladiaConfig } from './model-manager';
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
import { findDenoiseModel, getModelPath, getModelsDir, isModelDownloaded } from './denoiser-manager';
import type { BackendRestartOptions, IpcContext } from './ipc/context';
import { registerAppIpc } from './ipc/app-ipc';
import { registerModelsIpc } from './ipc/models-ipc';
import { registerSttIpc, resolveParakeetModelArgs } from './ipc/stt-ipc';
import { registerThemeIpc } from './ipc/theme-ipc';
import { registerTranslatorIpc } from './ipc/translator-ipc';
import { registerWindowIpc, type WindowIpc } from './ipc/window-ipc';
import path from 'path';

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-transparent-visuals');
  // Force XWayland: Electron 41 defaults to native Wayland in Wayland
  // sessions, where xdg-shell has no client positioning — setPosition is a
  // no-op, so window dragging, position restore, and always-on-top all break.
  app.commandLine.appendSwitch('ozone-platform', 'x11');
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
  const dgConfig = configManager.getDeepgram();
  const gdConfig = configManager.getGladia();
  const pkConfig = configManager.getParakeet();
  const extraParams = buildExtraParams(dgConfig.features);

  // Resolve parakeet model directory, type, and VAD path
  const pkArgs = provider === 'parakeet'
    ? resolveParakeetModelArgs(configDir, pkConfig.modelId)
    : { modelDir: '', modelType: '', vadModel: '' };

  backendManager = new BackendManager(backendPath, WS_PORT, {
    provider,
    apiKey: dgConfig.apiKey || undefined,
    model: dgConfig.model || 'nova-3',
    extraParams: extraParams || undefined,
    language: appSettings.sourceLanguage,
    gladiaApiKey: gdConfig.apiKey || undefined,
    gladiaModel: gdConfig.model || 'solaria-1',
    gladiaConfig: buildGladiaConfig(gdConfig.features),
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

    // Restore saved positions
    const positions = configManager.getWindowPositions();
    if (positions.overlay) {
      const { x, y, width, height } = positions.overlay;
      if (width && height) overlayWindow!.setBounds({ x, y, width, height });
      else overlayWindow!.setPosition(x, y);
    }
    if (positions.history) {
      const { x, y, width, height } = positions.history;
      if (width && height) historyWindow!.setBounds({ x, y, width, height });
      else historyWindow!.setPosition(x, y);
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
      safeSend(overlayWindow, 'subtitle', data);
      safeSend(historyWindow, 'subtitle', data);
      safeSend(mainWindow, 'subtitle', data);
    });

    wsClient.on('connected', () => {
      wsClient.send({ type: 'set_language', data: { language: appSettings.sourceLanguage } });
      wsClient.send({ type: 'set_subtitle_mode', data: { mode: appSettings.subtitleMode } });
      if (lastCaptureSourceId > 0) {
        setTimeout(() => {
          wsClient.send({ type: 'select_source', data: { id: lastCaptureSourceId } });
        }, 300);
      }
    });

    wsClient.connect();

    wsClient.on('sources', (data) => safeSend(mainWindow, 'sources', data));
    wsClient.on('status', (data) => safeSend(mainWindow, 'status', data));
    wsClient.on('log', (data) => safeSend(mainWindow, 'log', data));
    wsClient.on('model_loaded', (data) => safeSend(mainWindow, 'model_loaded', data));
    wsClient.on('audio_level', (data) => safeSend(mainWindow, 'audio_level', data));

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
