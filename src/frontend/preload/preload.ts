import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // Commands to backend
  listSources: () => ipcRenderer.send('list-sources'),
  selectSource: (id: number) => ipcRenderer.send('select-source', id),
  setLanguage: (lang: string) => ipcRenderer.send('set-language', lang),
  setTranslate: (translate: boolean) => ipcRenderer.send('set-translate', translate),
  setSubtitleMode: (mode: string) => ipcRenderer.send('set-subtitle-mode', mode),
  setTranslatorConfig: (config: any) => ipcRenderer.send('set-translator-config', config),
  startCapture: () => ipcRenderer.send('start-capture'),
  stopCapture: () => ipcRenderer.send('stop-capture'),
  toggleOverlay: () => ipcRenderer.invoke('toggle-overlay'),
  toggleHistory: () => ipcRenderer.invoke('toggle-history'),
  toggleDragMode: () => ipcRenderer.invoke('toggle-drag-mode'),
  exitDragMode: () => ipcRenderer.send('exit-drag-mode'),
  startWindowDrag: (startX: number, startY: number) =>
    ipcRenderer.send('start-window-drag', { startX, startY }),
  stopWindowDrag: () => ipcRenderer.send('stop-window-drag'),
  startWindowResize: (direction: string, startX: number, startY: number) =>
    ipcRenderer.send('start-window-resize', { direction, startX, startY }),
  stopWindowResize: () => ipcRenderer.send('stop-window-resize'),
  testTranslator: () => ipcRenderer.invoke('test-translator'),
  testTranslatorWithConfig: (config: any) => ipcRenderer.invoke('test-translator-with-config', config),

  // App info
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),

  // Denoiser
  getDenoiserConfig: () => ipcRenderer.invoke('get-denoiser-config'),
  setDenoiserConfig: (config: { enabled?: boolean; modelId?: string }) =>
    ipcRenderer.invoke('set-denoiser-config', config),
  getDenoiserModels: () => ipcRenderer.invoke('get-denoiser-models'),
  downloadDenoiserModel: (modelId: string) => ipcRenderer.invoke('download-denoiser-model', modelId),
  deleteDenoiserModel: (modelId: string) => ipcRenderer.invoke('delete-denoiser-model', modelId),
  getDownloadStatus: () => ipcRenderer.invoke('get-download-status') as Promise<Array<{ modelId: string; percent: number }>>,
  onDenoiserDownloadProgress: (callback: (data: { modelId: string; percent: number }) => void) => {
    ipcRenderer.on('denoiser-download-progress', (_event, data) => callback(data));
  },

  // Parakeet local ASR
  getParakeetConfig: () => ipcRenderer.invoke('get-parakeet-config'),
  setParakeetConfig: (config: any) => ipcRenderer.invoke('set-parakeet-config', config),
  setParakeetVadConfig: (vad: any) => ipcRenderer.invoke('set-parakeet-vad-config', vad),
  getParakeetModels: () => ipcRenderer.invoke('get-parakeet-models'),
  downloadParakeetModel: (modelId: string) => ipcRenderer.invoke('download-parakeet-model', modelId),
  deleteParakeetModel: (modelId: string) => ipcRenderer.invoke('delete-parakeet-model', modelId),
  getParakeetDownloadStatus: () => ipcRenderer.invoke('get-parakeet-download-status') as Promise<Array<{ modelId: string; percent: number }>>,
  onParakeetDownloadProgress: (callback: (data: { modelId: string; percent: number }) => void) => {
    ipcRenderer.on('parakeet-download-progress', (_event, data) => callback(data));
  },

  // STT provider
  getSttProvider: () => ipcRenderer.invoke('get-stt-provider'),
  setSttProvider: (provider: string) => ipcRenderer.invoke('set-stt-provider', provider),

  // Deepgram config
  getDeepgramConfig: () => ipcRenderer.invoke('get-deepgram-config'),
  setDeepgramConfig: (config: any) => ipcRenderer.invoke('set-deepgram-config', config),
  fetchDeepgramModels: () => ipcRenderer.invoke('fetch-deepgram-models'),

  // Gladia config
  getGladiaConfig: () => ipcRenderer.invoke('get-gladia-config'),
  setGladiaConfig: (config: any) => ipcRenderer.invoke('set-gladia-config', config),
  fetchGladiaModels: () => ipcRenderer.invoke('fetch-gladia-models'),
  getTranslatorConfig: () => ipcRenderer.invoke('get-translator-config'),
  getAppSettings: () => ipcRenderer.invoke('get-app-settings'),
  setUiLanguage: (lang: 'en' | 'zh') => ipcRenderer.invoke('set-ui-language', lang),
  setShowPartials: (show: boolean) => ipcRenderer.invoke('set-show-partials', show),
  onShowPartials: (callback: (show: boolean) => void) => {
    ipcRenderer.on('show-partials', (_event, show: boolean) => callback(show));
  },
  onUiLanguage: (callback: (lang: 'en' | 'zh') => void) => {
    ipcRenderer.on('ui-language', (_event, lang: 'en' | 'zh') => callback(lang));
  },

  getUiTheme: () => ipcRenderer.invoke('get-ui-theme'),
  setUiTheme: (partial: { appearance?: string; accentSource?: string }) =>
    ipcRenderer.invoke('set-ui-theme', partial),
  previewUiTheme: (partial: { appearance?: string; accentSource?: string }) =>
    ipcRenderer.invoke('preview-ui-theme', partial),
  refreshWallpaperColors: () => ipcRenderer.invoke('refresh-wallpaper-colors'),
  onUiTheme: (callback: (data: unknown) => void) => {
    ipcRenderer.on('ui-theme', (_event, data) => callback(data));
  },

  // Events from backend
  onSubtitle: (callback: (data: any) => void) => {
    ipcRenderer.on('subtitle', (_event, data) => callback(data));
  },
  onSources: (callback: (data: any) => void) => {
    ipcRenderer.on('sources', (_event, data) => callback(data));
  },
  onStatus: (callback: (data: any) => void) => {
    ipcRenderer.on('status', (_event, data) => callback(data));
  },
  onLog: (callback: (data: any) => void) => {
    ipcRenderer.on('log', (_event, data) => callback(data));
  },
  onModelLoaded: (callback: (data: any) => void) => {
    ipcRenderer.on('model_loaded', (_event, data) => callback(data));
  },
  onSubtitleMode: (callback: (mode: string) => void) => {
    ipcRenderer.on('subtitle-mode', (_event, mode) => callback(mode));
  },
  onDragMode: (callback: (enabled: boolean) => void) => {
    ipcRenderer.on('drag-mode', (_event, enabled) => callback(enabled));
  },
  onTranslatorError: (callback: (error: string) => void) => {
    ipcRenderer.on('translator-error', (_event, error) => callback(error));
  },
  onAudioLevel: (callback: (data: { level: number }) => void) => {
    ipcRenderer.on('audio_level', (_event, data) => callback(data));
  },

  // Cleanup helpers — call these in component unmount effects
  removeListeners: (channel: string) => {
    ipcRenderer.removeAllListeners(channel);
  },
});
