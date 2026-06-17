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

export interface DeepgramFeatures {
  smart_format: boolean;
  punctuate: boolean;
  interim_results: boolean;
  endpointing: number | false;
  utterance_end_ms: number | false;
  diarize: boolean;
  vad_events: boolean;
  numerals: boolean;
}

export interface DeepgramConfig {
  apiKey: string;
  model: string;
  features: DeepgramFeatures;
}

export type SttProvider = 'deepgram' | 'gladia' | 'parakeet';

export interface CustomVocabularyItem {
  value: string;
  language?: string;
  pronunciations?: string[];
  intensity?: number;
}

export interface GladiaFeatures {
  code_switching: boolean;
  speech_threshold: number;
  audio_enhancer: boolean;
  endpointing: number;
  max_duration_without_endpointing: number;
  partial_transcripts: boolean;
  custom_vocabulary: boolean;
  custom_vocabulary_config: {
    vocabulary: (string | CustomVocabularyItem)[];
    default_intensity: number;
  };
  custom_spelling: boolean;
  custom_spelling_config: {
    spelling_dictionary: Record<string, string[]>;
  };
}

export interface GladiaConfig {
  apiKey: string;
  model: string;
  features: GladiaFeatures;
}

export type SubtitleMode = 'original' | 'translated' | 'bilingual';

export type AppearanceMode = 'light' | 'dark' | 'system';
export type AccentSource = 'default' | 'wallpaper';

export interface UiThemePayload {
  appearance: AppearanceMode;
  effectiveMode: 'light' | 'dark';
  accentSource: AccentSource;
  vars: Record<string, string>;
}

export type ApiFormat = 'openai' | 'anthropic';

export interface TranslatorConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  apiFormat: ApiFormat;
  targetLanguage: string;
  enabled: boolean;
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
  startWindowDrag: (startX: number, startY: number) => void;
  stopWindowDrag: () => void;
  startWindowResize: (direction: string, startX: number, startY: number) => void;
  stopWindowResize: () => void;
  testTranslator: () => Promise<{ success: boolean; error?: string }>;

  getAppVersion: () => Promise<string>;
  openExternal: (url: string) => Promise<void>;

  getDenoiserConfig: () => Promise<DenoiserConfig>;
  setDenoiserConfig: (config: Partial<DenoiserConfig>) => Promise<{ success: boolean }>;
  getDenoiserModels: () => Promise<DenoiseModelInfo[]>;
  downloadDenoiserModel: (modelId: string) => Promise<{ success: boolean; localPath?: string; error?: string }>;
  deleteDenoiserModel: (modelId: string) => Promise<{ success: boolean }>;
  getDownloadStatus: () => Promise<Array<{ modelId: string; percent: number }>>;
  onDenoiserDownloadProgress: (callback: (data: { modelId: string; percent: number }) => void) => void;

  getParakeetConfig: () => Promise<ParakeetConfig>;
  setParakeetConfig: (config: Partial<ParakeetConfig>) => Promise<{ success: boolean }>;
  setParakeetVadConfig: (vad: ParakeetVadConfig) => Promise<{ success: boolean; vad?: ParakeetVadConfig }>;
  getParakeetModels: () => Promise<ParakeetModelInfo[]>;
  downloadParakeetModel: (modelId: string) => Promise<{ success: boolean; localDir?: string; error?: string }>;
  deleteParakeetModel: (modelId: string) => Promise<{ success: boolean }>;
  getParakeetDownloadStatus: () => Promise<Array<{ modelId: string; percent: number }>>;
  onParakeetDownloadProgress: (callback: (data: { modelId: string; percent: number }) => void) => void;

  getSttProvider: () => Promise<SttProvider>;
  setSttProvider: (provider: SttProvider) => Promise<{ success: boolean }>;
  getDeepgramConfig: () => Promise<DeepgramConfig>;
  setDeepgramConfig: (config: Partial<DeepgramConfig>) => Promise<{ success: boolean }>;
  fetchDeepgramModels: () => Promise<{ success: boolean; models?: Array<{ name: string; canonical_name: string; version: string; languages: string[] }>; error?: string }>;
  getGladiaConfig: () => Promise<GladiaConfig>;
  setGladiaConfig: (config: Partial<GladiaConfig>) => Promise<{ success: boolean }>;
  fetchGladiaModels: () => Promise<{ success: boolean; models?: Array<{ name: string; description: string }>; error?: string }>;
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
  removeListeners: (channel: string) => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
