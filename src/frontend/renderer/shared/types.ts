export interface AudioSource {
  id: number;
  name: string;
  desc: string;
  class: string;
}

export interface TranscriptSegment {
  text: string;
  translated_text?: string;
  t0: number;
  t1: number;
  partial: boolean;
  speaker?: number;  // undefined when diarization is off
}

export interface BackendStatus {
  state: string;
  language: string;
  translate: boolean;
  model_loaded: boolean;
  subtitle_mode?: SubtitleMode;
  capture_source_id?: number;
  capture_source_name?: string;
  audio_level?: number;
}

export interface LogEntry {
  level: string;
  message: string;
  timestamp?: string;
}



export type SttProvider = 'parakeet' | 'remote_parakeet';




export type SubtitleMode = 'original' | 'translated' | 'bilingual';

export type AppearanceMode = 'light' | 'dark' | 'system';
export type AccentSource = 'default' | 'wallpaper';

/** How the accent was actually obtained, so the UI can explain a fallback. */
export type AccentResolution =
  | { status: 'wallpaper'; path: string }
  | { status: 'desktop-accent'; name: string }
  | { status: 'no-wallpaper' }
  | { status: 'decode-failed'; path: string }
  | { status: 'low-chroma'; path: string };

export interface UiThemePayload {
  appearance: AppearanceMode;
  effectiveMode: 'light' | 'dark';
  accentSource: AccentSource;
  accentResolution: AccentResolution | null;
  vars: Record<string, string>;
}

export type ApiFormat = 'openai' | 'anthropic' | 'google';

export interface TranslatorConfig {
  baseUrl: string;
  /** Active-format key. Mirrors `apiKeys[apiFormat]`; kept for backward compat. */
  apiKey: string;
  /** Per-format API keys so switching provider doesn't clobber the others. */
  apiKeys: Record<ApiFormat, string>;
  model: string;
  apiFormat: ApiFormat;
  targetLanguage: string;
  enabled: boolean;
  /** When false, only final transcripts are translated (interim/partial ones are skipped). */
  translatePartials: boolean;
  contextPrompt: string;
  useHistory: boolean;
  historyMaxPairs: number;
  historyMaxCharsPerEntry: number;
  historySystemHint: string;
}

export interface DenoiserConfig {
  enabled: boolean;
  modelId: string;
}

export interface ParakeetVadConfig {
  threshold: number;
  minSilence: number;
  minSpeech: number;
  maxSpeech: number;
  partialInterval: number;
}

export interface ParakeetConfig {
  modelId: string;
  vad: ParakeetVadConfig;
}

export interface RemoteParakeetConfig {
  serverUrl: string;
  apiKey: string;
  model: string;
  vad: ParakeetVadConfig;
}

// One model advertised by a remote Parakeet server (GET /models).
export interface RemoteParakeetModelInfo {
  id: string;
  type: string;
}

export interface ParakeetModelInfo {
  id: string;
  archive: string;
  dir_name: string;
  type: string;
  files: Record<string, string>;
  languages: string[];
  archive_size_bytes: number;
  description_en: string;
  description_zh: string;
  downloaded: boolean;
  localDir: string;
}

export interface DenoiseModelInfo {
  id: string;
  filename: string;
  architecture: string;
  sample_rate: number;
  size_bytes: number;
  description_en: string;
  description_zh: string;
  downloaded: boolean;
  localPath: string;
}

export type UiLanguage = 'en' | 'zh';

export interface AppSettings {
  sourceLanguage: string;
  uiLanguage: UiLanguage;
  subtitleMode: SubtitleMode;
  showPartials: boolean;
}

export interface ElectronAPI {
  listSources: () => void;
  selectSource: (id: number) => void;
  setLanguage: (lang: string) => void;
  setTranslate: (translate: boolean) => void;
  setSubtitleMode: (mode: SubtitleMode) => void;
  setTranslatorConfig: (config: Partial<TranslatorConfig>) => void;
  startCapture: () => void;
  stopCapture: () => void;
  toggleOverlay: () => Promise<boolean>;
  toggleHistory: () => Promise<boolean>;
  toggleDragMode: () => Promise<boolean>;
  exitDragMode: () => void;
  startWindowDrag: () => void;
  dragWindowBy: (dx: number, dy: number) => void;
  stopWindowDrag: () => void;
  startWindowResize: (direction: string, startX: number, startY: number) => void;
  stopWindowResize: () => void;
  testTranslator: () => Promise<{ success: boolean; error?: string }>;

  getAppVersion: () => Promise<string>;
  openExternal: (url: string) => Promise<void>;

  getDenoiserConfig: () => Promise<DenoiserConfig>;
  setDenoiserConfig: (config: Partial<DenoiserConfig>) => Promise<{ success: boolean; applied?: boolean }>;
  getDenoiserModels: () => Promise<DenoiseModelInfo[]>;
  downloadDenoiserModel: (modelId: string) => Promise<{ success: boolean; localPath?: string; error?: string }>;
  deleteDenoiserModel: (modelId: string) => Promise<{ success: boolean }>;
  getDownloadStatus: () => Promise<Array<{ modelId: string; percent: number }>>;
  onDenoiserDownloadProgress: (callback: (data: { modelId: string; percent: number }) => void) => void;

  getParakeetConfig: () => Promise<ParakeetConfig>;
  setParakeetConfig: (config: Partial<ParakeetConfig>) => Promise<{ success: boolean }>;
  setParakeetVadConfig: (vad: ParakeetVadConfig) => Promise<{ success: boolean; applied?: boolean; vad?: ParakeetVadConfig }>;
  getParakeetModels: () => Promise<ParakeetModelInfo[]>;
  downloadParakeetModel: (modelId: string) => Promise<{ success: boolean; localDir?: string; error?: string }>;
  deleteParakeetModel: (modelId: string) => Promise<{ success: boolean }>;
  getParakeetDownloadStatus: () => Promise<Array<{ modelId: string; percent: number }>>;
  onParakeetDownloadProgress: (callback: (data: { modelId: string; percent: number }) => void) => void;

  getSttProvider: () => Promise<SttProvider>;
  setSttProvider: (provider: SttProvider) => Promise<{ success: boolean }>;
  getRemoteParakeetConfig: () => Promise<RemoteParakeetConfig>;
  setRemoteParakeetConfig: (config: Partial<RemoteParakeetConfig>) => Promise<{ success: boolean; config?: RemoteParakeetConfig }>;
  testRemoteParakeet: (serverUrl: string, apiKey: string) => Promise<{ success: boolean; error?: string }>;
  fetchRemoteParakeetModels: (serverUrl: string, apiKey: string) => Promise<{ success: boolean; models?: RemoteParakeetModelInfo[]; error?: string }>;
  setRemoteParakeetVadConfig: (vad: ParakeetVadConfig) => Promise<{ success: boolean; applied?: boolean; vad?: ParakeetVadConfig }>;
  getTranslatorConfig: () => Promise<TranslatorConfig>;
  getAppSettings: () => Promise<AppSettings>;
  setUiLanguage: (lang: UiLanguage) => Promise<AppSettings>;
  setShowPartials: (show: boolean) => Promise<AppSettings>;
  onUiLanguage: (callback: (lang: UiLanguage) => void) => void;
  onShowPartials: (callback: (show: boolean) => void) => void;

  getUiTheme: () => Promise<UiThemePayload>;
  setUiTheme: (partial: { appearance?: AppearanceMode; accentSource?: AccentSource }) => Promise<UiThemePayload>;
  refreshWallpaperColors: () => Promise<UiThemePayload>;
  onUiTheme: (callback: (data: UiThemePayload) => void) => void;

  onSubtitle: (callback: (data: TranscriptSegment) => void) => void;
  onSources: (callback: (data: AudioSource[]) => void) => void;
  onStatus: (callback: (data: BackendStatus) => void) => void;
  onLog: (callback: (data: LogEntry) => void) => void;
  onModelLoaded: (callback: (data: any) => void) => void;
  onSubtitleMode: (callback: (mode: string) => void) => void;
  onDragMode: (callback: (enabled: boolean) => void) => void;
  onTranslatorError: (callback: (error: string) => void) => void;
  onAudioLevel: (callback: (data: { level: number }) => void) => void;
  getBackendState: () => Promise<{ state: string; code?: number | null }>;
  /** Backend process/socket liveness: connected | disconnected | restarting | exited. */
  onBackendState: (callback: (data: { state: string; code?: number | null }) => void) => void;
  removeListeners: (channel: string) => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
