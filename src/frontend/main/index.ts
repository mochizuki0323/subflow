import { app, ipcMain, BrowserWindow, screen, nativeTheme, Menu } from 'electron';
import { BackendManager } from './backend-manager';
import { WsClient } from './ws-client';
import { DeepgramConfigManager, buildExtraParams } from './model-manager';
import { Translator } from './translator';
import { createMainWindow } from './windows/main-window';
import { createOverlayWindow } from './windows/overlay-window';
import { createHistoryWindow } from './windows/history-window';
import path from 'path';
import fs from 'fs';
import { loadUiPreferences, saveUiPreferences, resolveUiTheme, type UiPreferences } from './ui-theme';
import { PRODUCT_NAME } from './app-metadata';
import {
  getAppConfigDir,
  ensureConfigDirExists,
  migrateConfigsFromLinuxExecDir,
  migrateConfigsFromUserData,
} from './app-config-dir';
import { loadAppSettings, saveAppSettings, type AppSettings, type UiLanguage } from './app-settings';

// Transparent window support (Linux; harmless elsewhere but only needed there)
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-transparent-visuals');
}

const WS_PORT = 9876;

let backendManager: BackendManager;
let wsClient: WsClient;
let deepgramConfig: DeepgramConfigManager;
const translator = new Translator();

/** Shared by deepgram / window positions etc. Assigned inside app.ready */
let appConfigDir = '';

let appSettings: AppSettings = { sourceLanguage: 'auto', uiLanguage: 'zh', subtitleMode: 'original' };

function loadTranslatorConfig() {
  if (!appConfigDir) return;
  try {
    const data = fs.readFileSync(path.join(appConfigDir, 'translator-config.json'), 'utf-8');
    const config = JSON.parse(data);
    translator.setConfig(config);
  } catch {
    // No config file yet, use defaults
  }
}

function saveTranslatorConfig() {
  if (!appConfigDir) return;
  try {
    fs.writeFileSync(
      path.join(appConfigDir, 'translator-config.json'),
      JSON.stringify(translator.getConfig(), null, 2),
    );
  } catch (err) {
    console.error('Failed to save translator config:', err);
  }
}

function safeSend(win: BrowserWindow | null, channel: string, ...args: unknown[]): void {
  if (!win || win.isDestroyed()) return;
  (win.webContents as { send: (ch: string, ...a: unknown[]) => void }).send(channel, ...args);
}

let mainWindow: BrowserWindow | null = null;

const gotSingleInstanceLock = app.requestSingleInstanceLock();

// Current subtitle mode
let subtitleMode = 'original';
// Last known audio capture source — restored when the backend restarts
let lastCaptureSourceId = 0;

// ---- Window position persistence ----
function getPositionsPath(configDir: string) {
  return path.join(configDir, 'window-positions.json');
}

interface WindowBounds {
  x: number; y: number; width?: number; height?: number;
}
interface WindowPositions {
  overlay?: WindowBounds;
  history?: WindowBounds;
}

function loadWindowPositions(configDir: string): WindowPositions {
  try {
    return JSON.parse(fs.readFileSync(getPositionsPath(configDir), 'utf-8'));
  } catch {
    return {};
  }
}

function saveWindowPositions(configDir: string, overlay: BrowserWindow, history: BrowserWindow) {
  try {
    const ob = overlay.getBounds();
    const hb = history.getBounds();
    const data: WindowPositions = {
      overlay: { x: ob.x, y: ob.y, width: ob.width, height: ob.height },
      history: { x: hb.x, y: hb.y, width: hb.width, height: hb.height },
    };
    fs.writeFileSync(getPositionsPath(configDir), JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Failed to save window positions:', err);
  }
}

// ---- Drag mode ----
let isDragMode = false;
let positionSaveTimer: ReturnType<typeof setTimeout> | null = null;

function setDragMode(
  enabled: boolean,
  overlayWin: BrowserWindow,
  historyWin: BrowserWindow,
  configDir: string,
) {
  isDragMode = enabled;
  if (enabled) {
    overlayWin.setIgnoreMouseEvents(false);
    historyWin.setIgnoreMouseEvents(false);
  } else {
    overlayWin.setIgnoreMouseEvents(true);
    historyWin.setIgnoreMouseEvents(true);
    // Save positions when drag mode is exited
    if (positionSaveTimer) clearTimeout(positionSaveTimer);
    positionSaveTimer = setTimeout(() => {
      saveWindowPositions(configDir, overlayWin, historyWin);
    }, 300);
  }
  safeSend(overlayWin, 'drag-mode', enabled);
  safeSend(historyWin, 'drag-mode', enabled);
}

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  app.setName(PRODUCT_NAME);

  // Determine backend binary path
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
  appConfigDir = configDir;
  appSettings = loadAppSettings(configDir);
  subtitleMode = appSettings.subtitleMode;

  deepgramConfig = new DeepgramConfigManager(configDir);
  const dgConfig = deepgramConfig.get();

  // Load saved translator config
  loadTranslatorConfig();

  const extraParams = buildExtraParams(dgConfig.features);

  // Spawn C++ backend with Deepgram API key and model
  backendManager = new BackendManager(
    backendPath,
    WS_PORT,
    dgConfig.apiKey || undefined,
    dgConfig.model || 'nova-3',
    extraParams || undefined,
  );
  backendManager.spawn();

  // Wait for backend to start
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Connect WebSocket
  wsClient = new WsClient(`ws://127.0.0.1:${WS_PORT}`);
  wsClient.connect();

  // Create windows (delay slightly for transparent visuals on Linux)
  setTimeout(() => {
    mainWindow = createMainWindow();
    const overlayWindow = createOverlayWindow();
    const historyWindow = createHistoryWindow();

    mainWindow.on('close', () => {
      app.quit();
    });

    backendManager.on('log', (line: string) => {
      safeSend(mainWindow, 'log', {
        level: line.toLowerCase().includes('error') ? 'error' : 'info',
        message: line,
      });
    });

    // Restore saved positions and sizes
    const positions = loadWindowPositions(configDir);
    if (positions.overlay) {
      const { x, y, width, height } = positions.overlay;
      if (width && height) overlayWindow.setBounds({ x, y, width, height });
      else overlayWindow.setPosition(x, y);
    }
    if (positions.history) {
      const { x, y, width, height } = positions.history;
      if (width && height) historyWindow.setBounds({ x, y, width, height });
      else historyWindow.setPosition(x, y);
    }

    // Route backend messages to renderer processes
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

    // After connect or reconnect: restore saved source language and capture source
    wsClient.on('connected', () => {
      wsClient.send({ type: 'set_language', data: { language: appSettings.sourceLanguage } });
      wsClient.send({ type: 'set_subtitle_mode', data: { mode: subtitleMode } });
      if (lastCaptureSourceId > 0) {
        setTimeout(() => {
          wsClient.send({ type: 'select_source', data: { id: lastCaptureSourceId } });
        }, 300); // brief delay so the backend is fully ready
      }
    });

    wsClient.on('sources', (data) => {
      safeSend(mainWindow, 'sources', data);
    });

    wsClient.on('status', (data) => {
      safeSend(mainWindow, 'status', data);
    });

    wsClient.on('log', (data) => {
      safeSend(mainWindow, 'log', data);
    });

    wsClient.on('model_loaded', (data) => {
      safeSend(mainWindow, 'model_loaded', data);
    });

    wsClient.on('audio_level', (data) => {
      safeSend(mainWindow, 'audio_level', data);
    });

    // Commands from renderer
    ipcMain.on('send-command', (_event, msg) => {
      wsClient.send(msg);
    });

    ipcMain.on('list-sources', () => {
      wsClient.send({ type: 'list_sources' });
    });

    ipcMain.on('select-source', (_event, id: number) => {
      lastCaptureSourceId = id;
      wsClient.send({ type: 'select_source', data: { id } });
    });

    ipcMain.on('set-language', (_event, language: string) => {
      appSettings = { ...appSettings, sourceLanguage: language };
      saveAppSettings(configDir, appSettings);
      wsClient.send({ type: 'set_language', data: { language } });
    });

    ipcMain.on('set-translate', (_event, translate: boolean) => {
      wsClient.send({ type: 'set_translate', data: { translate } });
    });

    ipcMain.on('set-subtitle-mode', (_event, mode: string) => {
      if (mode !== 'original' && mode !== 'translated' && mode !== 'bilingual') {
        return;
      }
      subtitleMode = mode;
      appSettings = { ...appSettings, subtitleMode: mode };
      saveAppSettings(configDir, appSettings);
      wsClient.send({ type: 'set_subtitle_mode', data: { mode } });
      safeSend(overlayWindow, 'subtitle-mode', mode);
      safeSend(historyWindow, 'subtitle-mode', mode);
    });

    ipcMain.on('set-translator-config', (_event, config: any) => {
      translator.setConfig(config);
      saveTranslatorConfig();
    });

    ipcMain.on('start-capture', () => {
      wsClient.send({ type: 'start' });
    });

    ipcMain.on('stop-capture', () => {
      wsClient.send({ type: 'stop' });
    });

    // Deepgram config management
    ipcMain.handle('get-deepgram-config', () => {
      return deepgramConfig.get();
    });

    ipcMain.handle('set-deepgram-config', (_event, config: any) => {
      deepgramConfig.save(config);
      const updated = deepgramConfig.get();
      const newExtra = buildExtraParams(updated.features);
      wsClient.disconnect(); // close current WS; close event will trigger auto-reconnect
      backendManager.restart(updated.apiKey || '', updated.model || 'nova-3', newExtra || undefined);
      // Backend takes ~500ms to spawn + time to bind port; reconnect after 2s
      setTimeout(() => wsClient.connect(), 2000);
      return { success: true };
    });

    ipcMain.handle('fetch-deepgram-models', async () => {
      try {
        const models = await deepgramConfig.fetchModels();
        return { success: true, models };
      } catch (err: any) {
        return { success: false, error: err?.message || String(err) };
      }
    });

    ipcMain.handle('get-translator-config', () => {
      return translator.getConfig();
    });

    ipcMain.handle('get-app-settings', () => {
      return appSettings;
    });

    ipcMain.handle('set-ui-language', (_event, lang: UiLanguage) => {
      if (lang !== 'en' && lang !== 'zh') {
        return appSettings;
      }
      appSettings = { ...appSettings, uiLanguage: lang };
      saveAppSettings(configDir, appSettings);
      safeSend(mainWindow, 'ui-language', lang);
      safeSend(overlayWindow, 'ui-language', lang);
      safeSend(historyWindow, 'ui-language', lang);
      return appSettings;
    });

    // Toggle overlay visibility — returns new state
    ipcMain.handle('toggle-overlay', () => {
      if (overlayWindow.isVisible()) {
        overlayWindow.hide();
        return false;
      } else {
        overlayWindow.show();
        return true;
      }
    });

    // Toggle history window visibility
    ipcMain.handle('toggle-history', () => {
      if (historyWindow.isVisible()) {
        historyWindow.hide();
        return false;
      } else {
        historyWindow.show();
        return true;
      }
    });

    // Toggle drag mode for both overlay windows
    ipcMain.handle('toggle-drag-mode', () => {
      setDragMode(!isDragMode, overlayWindow, historyWindow, configDir);
      return isDragMode;
    });

    // Exit drag mode (triggered from lock button inside the overlay windows)
    ipcMain.on('exit-drag-mode', () => {
      setDragMode(false, overlayWindow, historyWindow, configDir);
      safeSend(mainWindow, 'drag-mode', false);
    });

    // ---- Manual window dragging (Linux: -webkit-app-region:drag not supported) ----
    let dragInterval: ReturnType<typeof setInterval> | null = null;
    let dragWin: BrowserWindow | null = null;
    let dragStartCursor = { x: 0, y: 0 };
    let dragStartWin    = { x: 0, y: 0 };

    ipcMain.on('start-window-drag', (event, { startX, startY }: { startX: number; startY: number }) => {
      if (dragInterval) clearInterval(dragInterval);
      dragWin = BrowserWindow.fromWebContents(event.sender);
      if (!dragWin) return;
      const [wx, wy] = dragWin.getPosition();
      dragStartCursor = { x: startX, y: startY };
      dragStartWin    = { x: wx, y: wy };

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
      saveWindowPositions(configDir, overlayWindow, historyWindow);
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

        if (resizeDir.includes('e')) width  = Math.max(MIN_W, width  + dx);
        if (resizeDir.includes('s')) height = Math.max(MIN_H, height + dy);
        if (resizeDir.includes('w')) {
          const nw = Math.max(MIN_W, width - dx);
          x += width - nw; width = nw;
        }
        if (resizeDir.includes('n')) {
          const nh = Math.max(MIN_H, height - dy);
          y += height - nh; height = nh;
        }
        resizeWin.setBounds({ x, y, width, height });
      }, 16);
    });

    ipcMain.on('stop-window-resize', () => {
      if (resizeInterval) { clearInterval(resizeInterval); resizeInterval = null; }
      resizeWin = null;
      saveWindowPositions(configDir, overlayWindow, historyWindow);
    });

    // Test translator API connection
    ipcMain.handle('test-translator', async () => {
      try {
        const result = await translator.translate('Hello, this is a test.');
        if (result) {
          return { success: true };
        }
        return { success: false, error: 'Empty response' };
      } catch (err: any) {
        return { success: false, error: err?.message || String(err) };
      }
    });

    // ---- UI theme (light/dark/system + pywal accent) ----
    let uiPrefs: UiPreferences = loadUiPreferences(configDir);

    function broadcastUiTheme(): void {
      const payload = resolveUiTheme(uiPrefs, nativeTheme.shouldUseDarkColors);
      safeSend(mainWindow, 'ui-theme', payload);
      safeSend(overlayWindow, 'ui-theme', payload);
      safeSend(historyWindow, 'ui-theme', payload);
    }

    broadcastUiTheme();

    nativeTheme.on('updated', () => {
      if (uiPrefs.appearance === 'system') {
        broadcastUiTheme();
      }
    });

    ipcMain.handle('get-ui-theme', () => {
      return resolveUiTheme(uiPrefs, nativeTheme.shouldUseDarkColors);
    });

    ipcMain.handle('set-ui-theme', (_event, partial: Partial<UiPreferences>) => {
      uiPrefs = {
        ...uiPrefs,
        ...partial,
        appearance: partial.appearance ?? uiPrefs.appearance,
        accentSource: partial.accentSource ?? uiPrefs.accentSource,
      };
      saveUiPreferences(configDir, uiPrefs);
      broadcastUiTheme();
      return resolveUiTheme(uiPrefs, nativeTheme.shouldUseDarkColors);
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
    wsClient?.shutdown();
    backendManager?.kill();
  });
}
