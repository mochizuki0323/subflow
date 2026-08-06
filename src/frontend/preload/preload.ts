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
  startWindowDrag: () => ipcRenderer.send('start-window-drag'),
  dragWindowBy: (dx: number, dy: number) => ipcRenderer.send('window-drag-move', { dx, dy }),
  stopWindowDrag: () => ipcRenderer.send('stop-window-drag'),
  startWindowResize: (direction: string) => ipcRenderer.send('start-window-resize', { direction }),
  resizeWindowBy: (dx: number, dy: number) => ipcRenderer.send('window-resize-move', { dx, dy }),
  stopWindowResize: () => ipcRenderer.send('stop-window-resize'),
  testTranslator: () => ipcRenderer.invoke('test-translator'),
  testTranslatorWithConfig: (config: any) => ipcRenderer.invoke('test-translator-with-config', config),

  // App info
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),

  // Updates (check + tell; nothing is downloaded or installed)
  getUpdateStatus: () => ipcRenderer.invoke('get-update-status'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  setCheckUpdatesOnStartup: (on: boolean) => ipcRenderer.invoke('set-check-updates-on-startup', on),
  onUpdateStatus: (callback: (status: any) => void) => {
    ipcRenderer.on('update-status', (_event, status) => callback(status));
  },

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

  // Nemotron streaming ASR
  getNemotronConfig: () => ipcRenderer.invoke('get-nemotron-config'),
  setNemotronConfig: (config: any) => ipcRenderer.invoke('set-nemotron-config', config),
  getNemotronModels: () => ipcRenderer.invoke('get-nemotron-models'),
  downloadNemotronModel: (modelId: string) => ipcRenderer.invoke('download-nemotron-model', modelId),
  deleteNemotronModel: (modelId: string) => ipcRenderer.invoke('delete-nemotron-model', modelId),
  getNemotronDownloadStatus: () => ipcRenderer.invoke('get-nemotron-download-status') as Promise<Array<{ modelId: string; percent: number }>>,
  onNemotronDownloadProgress: (callback: (data: { modelId: string; percent: number }) => void) => {
    ipcRenderer.on('nemotron-download-progress', (_event, data) => callback(data));
  },

  // STT provider
  getSttProvider: () => ipcRenderer.invoke('get-stt-provider'),
  setSttProvider: (provider: string) => ipcRenderer.invoke('set-stt-provider', provider),
  getLanguageSupport: () => ipcRenderer.invoke('get-language-support'),



  // Remote Parakeet config
  getRemoteParakeetConfig: () => ipcRenderer.invoke('get-remote-parakeet-config'),
  setRemoteParakeetConfig: (config: { serverUrl?: string; apiKey?: string; model?: string }) =>
    ipcRenderer.invoke('set-remote-parakeet-config', config),
  testRemoteParakeet: (serverUrl: string, apiKey: string) =>
    ipcRenderer.invoke('test-remote-parakeet', { serverUrl, apiKey }),
  fetchRemoteParakeetModels: (serverUrl: string, apiKey: string) =>
    ipcRenderer.invoke('fetch-remote-parakeet-models', { serverUrl, apiKey }),
  setRemoteParakeetVadConfig: (vad: any) =>
    ipcRenderer.invoke('set-remote-parakeet-vad-config', vad),
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
  getBackendState: () => ipcRenderer.invoke('get-backend-state'),

  getTranscriptLog: () => ipcRenderer.invoke('get-transcript-log'),
  clearTranscriptLog: () => ipcRenderer.invoke('clear-transcript-log'),
  exportTranscript: (format: 'srt' | 'txt') => ipcRenderer.invoke('export-transcript', format),
  onTranscriptCleared: (callback: () => void) => {
    ipcRenderer.on('transcript-cleared', () => callback());
  },

  onBackendState: (callback: (data: { state: string; code?: number | null }) => void) => {
    ipcRenderer.on('backend-state', (_event, data) => callback(data));
  },

  onAudioLevel: (callback: (data: { level: number }) => void) => {
    ipcRenderer.on('audio_level', (_event, data) => callback(data));
  },

  // Cleanup helpers — call these in component unmount effects
  removeListeners: (channel: string) => {
    ipcRenderer.removeAllListeners(channel);
  },
});
