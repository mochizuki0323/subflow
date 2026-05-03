import { app, ipcMain, BrowserWindow, screen, nativeTheme, Menu } from 'electron';
import { BackendManager } from './backend-manager';
import { WsClient } from './ws-client';
import { buildExtraParams } from './model-manager';
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

let appSettings: AppSettings = { sourceLanguage: 'auto', uiLanguage: 'zh', subtitleMode: 'original' };
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

  const dgConfig = configManager.getDeepgram();
  const extraParams = buildExtraParams(dgConfig.features);

  backendManager = new BackendManager(
    backendPath,
    WS_PORT,
    dgConfig.apiKey || undefined,
    dgConfig.model || 'nova-3',
    extraParams || undefined,
    appSettings.sourceLanguage,
  );
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
      backendManager.restart(updated.apiKey || '', updated.model || 'nova-3', newExtra || undefined, appSettings.sourceLanguage);
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
