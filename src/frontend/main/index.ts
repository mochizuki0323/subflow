import { app, ipcMain, BrowserWindow, screen, nativeTheme, Menu, shell } from 'electron';
import { BackendManager } from './backend-manager';
import { WsClient } from './ws-client';
import { buildExtraParams, buildGladiaConfig } from './model-manager';
import { Translator } from './translator';
import { createMainWindow } from './windows/main-window';
import { createOverlayWindow } from './windows/overlay-window';
import { createHistoryWindow } from './windows/history-window';
import fs from 'fs';
import { resolveUiTheme, type UiPreferences } from './ui-theme';
import { PRODUCT_NAME } from './app-metadata';
import {
  getAppConfigDir,
  ensureConfigDirExists,
  migrateConfigsFromLinuxExecDir,
  migrateConfigsFromUserData,
} from './app-config-dir';
import type { AppSettings, UiLanguage } from './app-settings';
import { UnifiedConfigManager } from './unified-config';
import {
  getDenoiseModels,
  findDenoiseModel,
  getModelStatus,
  getModelPath,
  isModelDownloaded,
  downloadModel,
  getModelsDir,
} from './denoiser-manager';
import {
  findParakeetModel,
  getParakeetModelStatus,
  getParakeetModelDir,
  isParakeetModelDownloaded,
  downloadParakeetModel,
  deleteParakeetModel,
  getVadModelPath,
  isVadModelDownloaded,
  downloadVadModel,
} from './parakeet-manager';
import path from 'path';

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-transparent-visuals');
}

const WS_PORT = 9876;

let backendManager: BackendManager;
let wsClient: WsClient;
let configManager: UnifiedConfigManager;
const translator = new Translator();

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let historyWindow: BrowserWindow | null = null;

let appSettings: AppSettings = { sourceLanguage: 'auto', uiLanguage: 'zh', subtitleMode: 'original', showPartials: false };
let subtitleMode = 'original';
let lastCaptureSourceId = 0;
let uiPrefs: UiPreferences = { appearance: 'system', accentSource: 'default' };

function safeSend(win: BrowserWindow | null, channel: string, ...args: unknown[]): void {
  if (!win || win.isDestroyed()) return;
  (win.webContents as { send: (ch: string, ...a: unknown[]) => void }).send(channel, ...args);
}

function broadcastUiTheme(): void {
  const payload = resolveUiTheme(uiPrefs, nativeTheme.shouldUseDarkColors);
  safeSend(mainWindow, 'ui-theme', payload);
  safeSend(overlayWindow, 'ui-theme', payload);
  safeSend(historyWindow, 'ui-theme', payload);
}

function saveWindowPositions(): void {
  if (!overlayWindow || overlayWindow.isDestroyed() || !historyWindow || historyWindow.isDestroyed()) return;
  const ob = overlayWindow.getBounds();
  const hb = historyWindow.getBounds();
  configManager.updateWindowPositions({
    overlay: { x: ob.x, y: ob.y, width: ob.width, height: ob.height },
    history: { x: hb.x, y: hb.y, width: hb.width, height: hb.height },
  });
}

// ---- Drag mode ----
let isDragMode = false;
let positionSaveTimer: ReturnType<typeof setTimeout> | null = null;

function setDragMode(enabled: boolean) {
  if (!overlayWindow || !historyWindow) return;
  isDragMode = enabled;
  if (enabled) {
    overlayWindow.setIgnoreMouseEvents(false);
    historyWindow.setIgnoreMouseEvents(false);
  } else {
    overlayWindow.setIgnoreMouseEvents(true);
    historyWindow.setIgnoreMouseEvents(true);
    if (positionSaveTimer) clearTimeout(positionSaveTimer);
    positionSaveTimer = setTimeout(saveWindowPositions, 300);
  }
  safeSend(overlayWindow, 'drag-mode', enabled);
  safeSend(historyWindow, 'drag-mode', enabled);
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
  subtitleMode = appSettings.subtitleMode;
  uiPrefs = configManager.getUi();
  translator.setConfig(configManager.getTranslator());

  const provider = configManager.getProvider();
  const dgConfig = configManager.getDeepgram();
  const gdConfig = configManager.getGladia();
  const pkConfig = configManager.getParakeet();
  const extraParams = buildExtraParams(dgConfig.features);

  // Resolve parakeet model directory, type, and VAD path
  let parakeetModelDir = '';
  let parakeetModelType = '';
  let parakeetVadModel = '';
  if (provider === 'parakeet' && pkConfig.modelId) {
    const pkModel = findParakeetModel(pkConfig.modelId);
    if (pkModel && isParakeetModelDownloaded(configDir, pkModel)) {
      parakeetModelDir = getParakeetModelDir(configDir, pkModel);
      parakeetModelType = pkModel.type;
      if (isVadModelDownloaded(configDir)) {
        parakeetVadModel = getVadModelPath(configDir);
      }
    }
  }

  backendManager = new BackendManager(backendPath, WS_PORT, {
    provider,
    apiKey: dgConfig.apiKey || undefined,
    model: dgConfig.model || 'nova-3',
    extraParams: extraParams || undefined,
    language: appSettings.sourceLanguage,
    gladiaApiKey: gdConfig.apiKey || undefined,
    gladiaModel: gdConfig.model || 'solaria-1',
    gladiaConfig: buildGladiaConfig(gdConfig.features),
    parakeetModelDir: parakeetModelDir || undefined,
    parakeetModelType: parakeetModelType || undefined,
    parakeetVadModel: parakeetVadModel || undefined,
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
      if (translator.getConfig().enabled && subtitleMode !== 'original' && data.text) {
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
      wsClient.send({ type: 'set_subtitle_mode', data: { mode: subtitleMode } });
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

    // ---- IPC: Commands ----
    ipcMain.on('send-command', (_event, msg) => wsClient.send(msg));
    ipcMain.on('list-sources', () => wsClient.send({ type: 'list_sources' }));

    ipcMain.on('select-source', (_event, id: number) => {
      lastCaptureSourceId = id;
      wsClient.send({ type: 'select_source', data: { id } });
    });

    ipcMain.on('set-language', (_event, language: string) => {
      appSettings = { ...appSettings, sourceLanguage: language };
      configManager.updateApp({ sourceLanguage: language });
      wsClient.send({ type: 'set_language', data: { language } });
    });

    ipcMain.on('set-translate', (_event, translate: boolean) => {
      wsClient.send({ type: 'set_translate', data: { translate } });
    });

    ipcMain.on('set-subtitle-mode', (_event, mode: string) => {
      if (mode !== 'original' && mode !== 'translated' && mode !== 'bilingual') return;
      subtitleMode = mode;
      appSettings = { ...appSettings, subtitleMode: mode as AppSettings['subtitleMode'] };
      configManager.updateApp({ subtitleMode: mode as AppSettings['subtitleMode'] });
      wsClient.send({ type: 'set_subtitle_mode', data: { mode } });
      safeSend(overlayWindow, 'subtitle-mode', mode);
      safeSend(historyWindow, 'subtitle-mode', mode);
    });

    ipcMain.on('set-translator-config', (_event, config: any) => {
      translator.setConfig(config);
      configManager.updateTranslator(translator.getConfig());
    });

    ipcMain.on('start-capture', () => wsClient.send({ type: 'start' }));
    ipcMain.on('stop-capture', () => wsClient.send({ type: 'stop' }));

    // ---- IPC: Deepgram config ----
    ipcMain.handle('get-deepgram-config', () => configManager.getDeepgram());

    ipcMain.handle('set-deepgram-config', (_event, config: any) => {
      configManager.updateDeepgram(config);
      const updated = configManager.getDeepgram();
      const newExtra = buildExtraParams(updated.features);
      wsClient.disconnect();
      backendManager.restart({
        apiKey: updated.apiKey || '', model: updated.model || 'nova-3',
        extraParams: newExtra || undefined, language: appSettings.sourceLanguage,
      });
      setTimeout(() => wsClient.connect(), 2000);
      return { success: true };
    });

    ipcMain.handle('fetch-deepgram-models', async () => {
      const apiKey = configManager.getDeepgram().apiKey;
      if (!apiKey) return { success: false, error: 'No API key configured' };
      try {
        const { default: https } = await import('https');
        return await new Promise((resolve) => {
          const req = https.request({
            hostname: 'api.deepgram.com',
            path: '/v1/models',
            method: 'GET',
            headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'application/json' },
          }, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
              try {
                const data = JSON.parse(body);
                const models = (data.stt || []).map((m: any) => ({
                  name: m.name || '', canonical_name: m.canonical_name || m.name || '',
                  version: m.version || '', languages: m.languages || [],
                }));
                resolve({ success: true, models });
              } catch {
                resolve({ success: false, error: `Failed to parse response: ${body.slice(0, 200)}` });
              }
            });
          });
          req.on('error', (err) => resolve({ success: false, error: err.message }));
          req.setTimeout(10000, () => { req.destroy(); resolve({ success: false, error: 'Timeout' }); });
          req.end();
        });
      } catch (err: any) {
        return { success: false, error: err?.message || String(err) };
      }
    });

    // ---- IPC: STT provider ----
    ipcMain.handle('get-stt-provider', () => configManager.getProvider());

    ipcMain.handle('set-stt-provider', (_event, provider: string) => {
      if (provider !== 'deepgram' && provider !== 'gladia' && provider !== 'parakeet') return { success: false };
      configManager.updateProvider(provider as any);
      wsClient.disconnect();
      const dg = configManager.getDeepgram();
      const gd = configManager.getGladia();
      const pk = configManager.getParakeet();
      let pkDir = '';
      let pkType = '';
      let pkVad = '';
      if (provider === 'parakeet' && pk.modelId) {
        const pkModel = findParakeetModel(pk.modelId);
        if (pkModel && isParakeetModelDownloaded(configDir, pkModel)) {
          pkDir = getParakeetModelDir(configDir, pkModel);
          pkType = pkModel.type;
          if (isVadModelDownloaded(configDir)) pkVad = getVadModelPath(configDir);
        }
      }
      backendManager.restart({
        provider,
        apiKey: dg.apiKey || '', model: dg.model || 'nova-3',
        extraParams: buildExtraParams(dg.features) || undefined,
        language: appSettings.sourceLanguage,
        gladiaApiKey: gd.apiKey || '', gladiaModel: gd.model || 'solaria-1',
        gladiaConfig: buildGladiaConfig(gd.features),
        parakeetModelDir: pkDir, parakeetModelType: pkType, parakeetVadModel: pkVad,
      });
      setTimeout(() => wsClient.connect(), 2000);
      return { success: true };
    });

    // ---- IPC: Gladia config ----
    ipcMain.handle('get-gladia-config', () => configManager.getGladia());

    ipcMain.handle('set-gladia-config', (_event, config: any) => {
      configManager.updateGladia(config);
      const updated = configManager.getGladia();
      wsClient.disconnect();
      backendManager.restart({
        gladiaApiKey: updated.apiKey || '', gladiaModel: updated.model || 'solaria-1',
        gladiaConfig: buildGladiaConfig(updated.features),
        language: appSettings.sourceLanguage,
      });
      setTimeout(() => wsClient.connect(), 2000);
      return { success: true };
    });

    ipcMain.handle('fetch-gladia-models', async () => {
      const apiKey = configManager.getGladia().apiKey;
      if (!apiKey) return { success: false, error: 'No API key configured' };
      try {
        const { default: https } = await import('https');
        return await new Promise((resolve) => {
          const req = https.request({
            hostname: 'api.gladia.io',
            path: '/v2/models',
            method: 'GET',
            headers: { 'x-gladia-key': apiKey, 'Content-Type': 'application/json' },
          }, (res) => {
            let body = '';
            res.on('data', (chunk: string) => { body += chunk; });
            res.on('end', () => {
              try {
                const data = JSON.parse(body);
                if (Array.isArray(data)) {
                  const models = data.map((m: any) => ({
                    name: m.name || m.id || '',
                    description: m.description || '',
                  }));
                  resolve({ success: true, models });
                  return;
                }
              } catch { /* fall through */ }
              // API didn't return a usable list — return known models
              resolve({
                success: true,
                models: [
                  { name: 'solaria-1', description: 'Latest and most powerful model' },
                ],
              });
            });
          });
          req.on('error', () => {
            resolve({
              success: true,
              models: [
                { name: 'solaria-1', description: 'Latest and most powerful model' },
              ],
            });
          });
          req.setTimeout(10000, () => {
            req.destroy();
            resolve({
              success: true,
              models: [
                { name: 'solaria-1', description: 'Latest and most powerful model' },
              ],
            });
          });
          req.end();
        });
      } catch {
        return {
          success: true,
          models: [
            { name: 'solaria-1', description: 'Latest and most powerful model' },
          ],
        };
      }
    });

    // ---- IPC: Translator config ----
    ipcMain.handle('get-translator-config', () => translator.getConfig());

    ipcMain.handle('test-translator', async () => {
      try {
        const result = await translator.translate('Hello, this is a test.');
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

    // ---- IPC: App info ----
    ipcMain.handle('get-app-version', () => app.getVersion());
    ipcMain.handle('open-external', (_event, url: string) => {
      if (url.startsWith('https://')) shell.openExternal(url);
    });

    // ---- IPC: Denoiser ----
    ipcMain.handle('get-denoiser-config', () => configManager.getDenoiser());

    ipcMain.handle('get-denoiser-models', () => getModelStatus(configDir));

    ipcMain.handle('set-denoiser-config', (_event, config: { enabled?: boolean; modelId?: string }) => {
      configManager.updateDenoiser(config);
      const updated = configManager.getDenoiser();
      const model = findDenoiseModel(updated.modelId);

      if (updated.enabled && model && isModelDownloaded(configDir, model)) {
        wsClient.send({
          type: 'set_denoise',
          data: { enabled: true, model_path: getModelPath(configDir, model), architecture: model.architecture },
        });
        backendManager.setDenoiseParams(true, getModelPath(configDir, model), model.architecture, getModelsDir(configDir));
      } else {
        wsClient.send({ type: 'set_denoise', data: { enabled: false, model_path: '', architecture: '' } });
        backendManager.setDenoiseParams(false, '', '', getModelsDir(configDir));
      }
      return { success: true };
    });

    const activeDownloads = new Map<string, Promise<{ success: boolean; localPath?: string; error?: string }>>();
    const downloadProgress = new Map<string, number>();

    ipcMain.handle('get-download-status', () => {
      const entries: Array<{ modelId: string; percent: number }> = [];
      for (const [modelId, percent] of downloadProgress) {
        entries.push({ modelId, percent });
      }
      return entries;
    });

    ipcMain.handle('download-denoiser-model', (_event, modelId: string) => {
      const existing = activeDownloads.get(modelId);
      if (existing) return existing;

      const task = (async () => {
        try {
          const localPath = await downloadModel(configDir, modelId, (percent) => {
            downloadProgress.set(modelId, percent);
            safeSend(mainWindow, 'denoiser-download-progress', { modelId, percent });
          });
          safeSend(mainWindow, 'denoiser-download-progress', { modelId, percent: 100 });
          return { success: true, localPath };
        } catch (err: any) {
          return { success: false, error: err?.message || String(err) };
        } finally {
          activeDownloads.delete(modelId);
          downloadProgress.delete(modelId);
        }
      })();

      activeDownloads.set(modelId, task);
      return task;
    });

    // ---- IPC: Parakeet ----
    ipcMain.handle('get-parakeet-config', () => configManager.getParakeet());

    ipcMain.handle('get-parakeet-models', () => getParakeetModelStatus(configDir));

    ipcMain.handle('set-parakeet-config', (_event, config: { modelId?: string }) => {
      configManager.updateParakeet(config);
      const updated = configManager.getParakeet();
      if (configManager.getProvider() === 'parakeet' && updated.modelId) {
        const pkModel = findParakeetModel(updated.modelId);
        if (pkModel && isParakeetModelDownloaded(configDir, pkModel)) {
          const pkDir = getParakeetModelDir(configDir, pkModel);
          const pkVad = isVadModelDownloaded(configDir) ? getVadModelPath(configDir) : '';
          wsClient.disconnect();
          backendManager.restart({
            provider: 'parakeet',
            parakeetModelDir: pkDir,
            parakeetModelType: pkModel.type,
            parakeetVadModel: pkVad,
            language: appSettings.sourceLanguage,
          });
          setTimeout(() => wsClient.connect(), 2000);
        }
      }
      return { success: true };
    });

    ipcMain.handle('delete-parakeet-model', (_event, modelId: string) => {
      deleteParakeetModel(configDir, modelId);
      return { success: true };
    });

    const parakeetActiveDownloads = new Map<string, Promise<{ success: boolean; localDir?: string; error?: string }>>();
    const parakeetDownloadProgress = new Map<string, number>();

    ipcMain.handle('get-parakeet-download-status', () => {
      const entries: Array<{ modelId: string; percent: number }> = [];
      for (const [modelId, percent] of parakeetDownloadProgress) {
        entries.push({ modelId, percent });
      }
      return entries;
    });

    ipcMain.handle('download-parakeet-model', (_event, modelId: string) => {
      const existing = parakeetActiveDownloads.get(modelId);
      if (existing) return existing;

      const task = (async () => {
        try {
          // Auto-download VAD model if not present (small, ~629KB)
          if (!isVadModelDownloaded(configDir)) {
            await downloadVadModel(configDir);
          }

          const localDir = await downloadParakeetModel(configDir, modelId, (percent) => {
            parakeetDownloadProgress.set(modelId, percent);
            safeSend(mainWindow, 'parakeet-download-progress', { modelId, percent });
          });
          safeSend(mainWindow, 'parakeet-download-progress', { modelId, percent: 100 });
          return { success: true, localDir };
        } catch (err: any) {
          return { success: false, error: err?.message || String(err) };
        } finally {
          parakeetActiveDownloads.delete(modelId);
          parakeetDownloadProgress.delete(modelId);
        }
      })();

      parakeetActiveDownloads.set(modelId, task);
      return task;
    });

    // ---- IPC: App settings ----
    ipcMain.handle('get-app-settings', () => appSettings);

    ipcMain.handle('set-ui-language', (_event, lang: UiLanguage) => {
      if (lang !== 'en' && lang !== 'zh') return appSettings;
      appSettings = { ...appSettings, uiLanguage: lang };
      configManager.updateApp({ uiLanguage: lang });
      safeSend(mainWindow, 'ui-language', lang);
      safeSend(overlayWindow, 'ui-language', lang);
      safeSend(historyWindow, 'ui-language', lang);
      return appSettings;
    });

    ipcMain.handle('set-show-partials', (_event, show: boolean) => {
      appSettings = { ...appSettings, showPartials: !!show };
      configManager.updateApp({ showPartials: !!show });
      safeSend(overlayWindow, 'show-partials', !!show);
      safeSend(historyWindow, 'show-partials', !!show);
      return appSettings;
    });

    // ---- IPC: Window toggles ----
    ipcMain.handle('toggle-overlay', () => {
      if (!overlayWindow) return false;
      if (overlayWindow.isVisible()) { overlayWindow.hide(); return false; }
      overlayWindow.show(); return true;
    });

    ipcMain.handle('toggle-history', () => {
      if (!historyWindow) return false;
      if (historyWindow.isVisible()) { historyWindow.hide(); return false; }
      historyWindow.show(); return true;
    });

    ipcMain.handle('toggle-drag-mode', () => {
      setDragMode(!isDragMode);
      return isDragMode;
    });

    ipcMain.on('exit-drag-mode', () => {
      setDragMode(false);
      safeSend(mainWindow, 'drag-mode', false);
    });

    // ---- Manual window dragging ----
    let dragInterval: ReturnType<typeof setInterval> | null = null;
    let dragWin: BrowserWindow | null = null;
    let dragStartCursor = { x: 0, y: 0 };
    let dragStartWin = { x: 0, y: 0 };

    ipcMain.on('start-window-drag', (event, { startX, startY }: { startX: number; startY: number }) => {
      if (dragInterval) clearInterval(dragInterval);
      dragWin = BrowserWindow.fromWebContents(event.sender);
      if (!dragWin) return;
      const [wx, wy] = dragWin.getPosition();
      dragStartCursor = { x: startX, y: startY };
      dragStartWin = { x: wx, y: wy };
      dragInterval = setInterval(() => {
        if (!dragWin) return;
        const cur = screen.getCursorScreenPoint();
        dragWin.setPosition(
          dragStartWin.x + (cur.x - dragStartCursor.x),
          dragStartWin.y + (cur.y - dragStartCursor.y),
        );
      }, 16);
    });

    ipcMain.on('stop-window-drag', () => {
      if (dragInterval) { clearInterval(dragInterval); dragInterval = null; }
      dragWin = null;
      saveWindowPositions();
    });

    // ---- Window resizing ----
    const MIN_W = 200, MIN_H = 80;
    let resizeInterval: ReturnType<typeof setInterval> | null = null;
    let resizeWin: BrowserWindow | null = null;
    let resizeDir = '';
    let rsStartCursor = { x: 0, y: 0 };
    let rsStartBounds = { x: 0, y: 0, width: 0, height: 0 };

    ipcMain.on('start-window-resize', (event, { direction, startX, startY }: { direction: string; startX: number; startY: number }) => {
      if (resizeInterval) clearInterval(resizeInterval);
      resizeWin = BrowserWindow.fromWebContents(event.sender);
      if (!resizeWin) return;
      rsStartBounds = resizeWin.getBounds();
      rsStartCursor = { x: startX, y: startY };
      resizeDir = direction;
      resizeInterval = setInterval(() => {
        if (!resizeWin) return;
        const cur = screen.getCursorScreenPoint();
        const dx = cur.x - rsStartCursor.x;
        const dy = cur.y - rsStartCursor.y;
        let { x, y, width, height } = rsStartBounds;
        if (resizeDir.includes('e')) width = Math.max(MIN_W, width + dx);
        if (resizeDir.includes('s')) height = Math.max(MIN_H, height + dy);
        if (resizeDir.includes('w')) { const nw = Math.max(MIN_W, width - dx); x += width - nw; width = nw; }
        if (resizeDir.includes('n')) { const nh = Math.max(MIN_H, height - dy); y += height - nh; height = nh; }
        resizeWin.setBounds({ x, y, width, height });
      }, 16);
    });

    ipcMain.on('stop-window-resize', () => {
      if (resizeInterval) { clearInterval(resizeInterval); resizeInterval = null; }
      resizeWin = null;
      saveWindowPositions();
    });

    // ---- UI theme ----
    broadcastUiTheme();

    nativeTheme.on('updated', () => {
      if (uiPrefs.appearance === 'system') broadcastUiTheme();
    });

    ipcMain.handle('get-ui-theme', () => resolveUiTheme(uiPrefs, nativeTheme.shouldUseDarkColors));

    ipcMain.handle('set-ui-theme', (_event, partial: Partial<UiPreferences>) => {
      uiPrefs = {
        ...uiPrefs,
        ...partial,
        appearance: partial.appearance ?? uiPrefs.appearance,
        accentSource: partial.accentSource ?? uiPrefs.accentSource,
      };
      configManager.updateUi(uiPrefs);
      broadcastUiTheme();
      return resolveUiTheme(uiPrefs, nativeTheme.shouldUseDarkColors);
    });

    ipcMain.handle('preview-ui-theme', (_event, partial: Partial<UiPreferences>) => {
      const previewPrefs: UiPreferences = {
        appearance: partial.appearance ?? uiPrefs.appearance,
        accentSource: partial.accentSource ?? uiPrefs.accentSource,
      };
      const payload = resolveUiTheme(previewPrefs, nativeTheme.shouldUseDarkColors);
      safeSend(mainWindow, 'ui-theme', payload);
      safeSend(overlayWindow, 'ui-theme', payload);
      safeSend(historyWindow, 'ui-theme', payload);
      return payload;
    });

    ipcMain.handle('refresh-wallpaper-colors', () => {
      broadcastUiTheme();
      return resolveUiTheme(uiPrefs, nativeTheme.shouldUseDarkColors);
    });
  }, 500);
  });

  app.on('window-all-closed', () => {
    backendManager?.kill();
    app.quit();
  });

  app.on('before-quit', () => {
    saveWindowPositions();
    wsClient?.shutdown();
    backendManager?.kill();
  });
}
