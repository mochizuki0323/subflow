import fs from 'fs';
import path from 'path';
import type { AppSettings, SubtitleMode, UiLanguage } from './app-settings';
import type { UiPreferences, AppearanceMode, AccentSource } from './ui-theme';
import type { TranslatorConfig, ApiFormat } from './translator';

export interface WindowBounds {
  x: number;
  y: number;
  width?: number;
  height?: number;
}

export interface WindowPositions {
  overlay?: WindowBounds;
  history?: WindowBounds;
}

export interface ParakeetVadConfig {
  threshold: number;       // Silero VAD speech probability cutoff (0..1)
  minSilence: number;      // seconds of silence before a segment closes
  minSpeech: number;       // shortest accepted speech segment, seconds
  maxSpeech: number;       // force-cut very long speech, seconds
  partialInterval: number; // interim re-decode period, seconds
}

export interface ParakeetConfig {
  modelId: string;
  vad: ParakeetVadConfig;
}

export interface RemoteParakeetConfig {
  serverUrl: string;   // ws:// or wss:// address of the remote Parakeet server
  apiKey: string;      // optional Bearer token
  model: string;       // model id to select on the server (empty = server default)
  vad: ParakeetVadConfig;  // per-client server-side VAD tuning
}

export interface DenoiserConfig {
  enabled: boolean;
  modelId: string;
}

export type SttProvider = 'parakeet' | 'nemotron' | 'remote_parakeet';

export interface NemotronConfig {
  modelId: string;
  /** Locale sent to the model, e.g. "ja-JP" or "auto". Not the UI language. */
  language: string;
  /** ORT intra-op threads for the streaming encoder. */
  numThreads: number;
}

export interface UnifiedConfig {
  provider: SttProvider;
  parakeet: ParakeetConfig;
  nemotron: NemotronConfig;
  remoteParakeet: RemoteParakeetConfig;
  translator: TranslatorConfig;
  app: AppSettings;
  ui: UiPreferences;
  windowPositions: WindowPositions;
  denoiser: DenoiserConfig;
}


const DEFAULT_TRANSLATOR: TranslatorConfig = {
  baseUrl: 'https://openrouter.ai/api',
  apiKey: '',
  apiKeys: { openai: '', anthropic: '', google: '' },
  model: 'google/gemma-4-31b-it',
  apiFormat: 'openai' as ApiFormat,
  targetLanguage: 'zh',
  enabled: false,
  translatePartials: false,
  contextPrompt: '',
  useHistory: false,
  historyMaxPairs: 10,
  historyMaxCharsPerEntry: 0,
  historySystemHint: '',
};

const DEFAULT_APP: AppSettings = {
  sourceLanguage: 'auto',
  uiLanguage: 'zh',
  subtitleMode: 'original',
  showPartials: false,
};

const DEFAULT_UI: UiPreferences = {
  appearance: 'system',
  accentSource: 'default',
};

export const DEFAULT_PARAKEET_VAD: ParakeetVadConfig = {
  threshold: 0.3,
  minSilence: 0.5,
  minSpeech: 0.25,
  maxSpeech: 15,
  partialInterval: 0.2,
};

const DEFAULT_PARAKEET: ParakeetConfig = {
  modelId: '',
  vad: { ...DEFAULT_PARAKEET_VAD },
};

const DEFAULT_REMOTE_PARAKEET: RemoteParakeetConfig = {
  serverUrl: '',
  apiKey: '',
  model: '',
  vad: { ...DEFAULT_PARAKEET_VAD },
};

const DEFAULT_DENOISER: DenoiserConfig = {
  enabled: false,
  modelId: 'dpdfnet8',
};

function normalizeSubtitleMode(value: unknown): SubtitleMode {
  if (value === 'original' || value === 'translated' || value === 'bilingual') return value;
  return 'original';
}

function normalizeUiLanguage(value: unknown): UiLanguage {
  if (value === 'en' || value === 'zh') return value;
  return 'zh';
}

function normalizeAppearance(value: unknown): AppearanceMode {
  if (value === 'light' || value === 'dark' || value === 'system') return value;
  return 'system';
}

function normalizeAccentSource(value: unknown): AccentSource {
  if (value === 'default' || value === 'wallpaper') return value;
  return 'default';
}

function normalizeApiFormat(value: unknown): ApiFormat {
  if (value === 'openai' || value === 'anthropic' || value === 'google') return value;
  return 'openai';
}

function normalizeApiKeys(value: unknown, fallback: Record<ApiFormat, string>): Record<ApiFormat, string> {
  const v = (value && typeof value === 'object') ? value as Record<string, unknown> : {};
  const pick = (k: ApiFormat) => (typeof v[k] === 'string' ? v[k] as string : fallback[k]);
  return { openai: pick('openai'), anthropic: pick('anthropic'), google: pick('google') };
}

function mergeDenoiser(base: DenoiserConfig, partial: Partial<DenoiserConfig>): DenoiserConfig {
  return {
    ...base,
    ...partial,
    enabled: typeof partial.enabled === 'boolean' ? partial.enabled : base.enabled,
    modelId: typeof partial.modelId === 'string' && partial.modelId ? partial.modelId : base.modelId,
  };
}

/**
 * Deepgram and Gladia were removed. A config written by an older build still names
 * one of them, and silently leaving that string in place would spawn a backend with
 * a provider it no longer implements — so anything unrecognised lands on the local
 * model, which needs neither network nor credentials.
 */
function normalizeProvider(value: unknown): SttProvider {
  if (value === 'parakeet' || value === 'nemotron' || value === 'remote_parakeet') return value;
  return 'parakeet';
}

function clampFloat(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function mergeParakeetVad(
  base: ParakeetVadConfig,
  partial: Partial<ParakeetVadConfig> | undefined,
): ParakeetVadConfig {
  const p = partial || {};
  return {
    threshold: clampFloat(p.threshold ?? base.threshold, 0.1, 0.9, base.threshold),
    minSilence: clampFloat(p.minSilence ?? base.minSilence, 0.1, 3.0, base.minSilence),
    minSpeech: clampFloat(p.minSpeech ?? base.minSpeech, 0.05, 1.0, base.minSpeech),
    maxSpeech: clampFloat(p.maxSpeech ?? base.maxSpeech, 5, 30, base.maxSpeech),
    partialInterval: clampFloat(p.partialInterval ?? base.partialInterval, 0.1, 1.0, base.partialInterval),
  };
}

function mergeParakeet(base: ParakeetConfig, partial: Partial<ParakeetConfig>): ParakeetConfig {
  return {
    ...base,
    ...partial,
    modelId: typeof partial.modelId === 'string' ? partial.modelId : base.modelId,
    vad: mergeParakeetVad(base.vad, partial.vad),
  };
}

function mergeRemoteParakeet(
  base: RemoteParakeetConfig,
  partial: Partial<RemoteParakeetConfig>,
): RemoteParakeetConfig {
  return {
    serverUrl: typeof partial.serverUrl === 'string' ? partial.serverUrl : base.serverUrl,
    apiKey: typeof partial.apiKey === 'string' ? partial.apiKey : base.apiKey,
    model: typeof partial.model === 'string' ? partial.model : base.model,
    vad: mergeParakeetVad(base.vad, partial.vad),
  };
}


// 560ms is the balanced point on the model's latency/accuracy curve and the
// variant upstream ships as the default export.
const DEFAULT_NEMOTRON: NemotronConfig = {
  modelId: 'nemotron-3.5-streaming-560ms',
  language: 'auto',
  numThreads: 2,
};

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? Math.round(value) : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function mergeNemotron(base: NemotronConfig, parsed: any): NemotronConfig {
  return {
    modelId: typeof parsed.modelId === 'string' && parsed.modelId ? parsed.modelId : base.modelId,
    language: typeof parsed.language === 'string' && parsed.language ? parsed.language : base.language,
    // Same ceiling the UI offers and the backend accepts: a hand-edited
    // config cannot smuggle in a value the other two would reject.
    numThreads: clampInt(parsed.numThreads, 1, 8, base.numThreads),
  };
}

function buildDefaults(): UnifiedConfig {
  return {
    provider: 'parakeet',
    parakeet: { ...DEFAULT_PARAKEET, vad: { ...DEFAULT_PARAKEET_VAD } },
    nemotron: { ...DEFAULT_NEMOTRON },
    remoteParakeet: { ...DEFAULT_REMOTE_PARAKEET },
    translator: { ...DEFAULT_TRANSLATOR },
    app: { ...DEFAULT_APP },
    ui: { ...DEFAULT_UI },
    windowPositions: {},
    denoiser: { ...DEFAULT_DENOISER },
  };
}


function mergeTranslator(base: TranslatorConfig, partial: Partial<TranslatorConfig>): TranslatorConfig {
  const apiFormat = normalizeApiFormat(partial.apiFormat ?? base.apiFormat);
  const apiKeys = normalizeApiKeys(partial.apiKeys ?? base.apiKeys, base.apiKeys ?? DEFAULT_TRANSLATOR.apiKeys);
  // Backward compat: an old config (or a partial) carrying only the flat `apiKey`
  // seeds the active format's per-format key.
  const flatKey = partial.apiKey ?? base.apiKey;
  if (!apiKeys[apiFormat] && flatKey) apiKeys[apiFormat] = flatKey;
  return {
    ...base,
    ...partial,
    apiFormat,
    apiKeys,
    // Keep the flat mirror in sync with the active format.
    apiKey: apiKeys[apiFormat] || '',
    translatePartials: typeof partial.translatePartials === 'boolean' ? partial.translatePartials : base.translatePartials,
    historyMaxPairs: clampNumber(partial.historyMaxPairs ?? base.historyMaxPairs, 1, 100, 10),
    historyMaxCharsPerEntry: Math.max(0, Math.floor(partial.historyMaxCharsPerEntry ?? base.historyMaxCharsPerEntry)),
  };
}

function mergeApp(base: AppSettings, partial: Partial<AppSettings>): AppSettings {
  return {
    ...base,
    ...partial,
    sourceLanguage: typeof partial.sourceLanguage === 'string' ? partial.sourceLanguage : base.sourceLanguage,
    uiLanguage: normalizeUiLanguage(partial.uiLanguage ?? base.uiLanguage),
    subtitleMode: normalizeSubtitleMode(partial.subtitleMode ?? base.subtitleMode),
    showPartials: typeof partial.showPartials === 'boolean' ? partial.showPartials : base.showPartials,
  };
}

function mergeUi(base: UiPreferences, partial: Partial<UiPreferences>): UiPreferences {
  return {
    appearance: normalizeAppearance(partial.appearance ?? base.appearance),
    accentSource: normalizeAccentSource(partial.accentSource ?? base.accentSource),
  };
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export class UnifiedConfigManager {
  private configDir: string;
  private configPath: string;
  private config: UnifiedConfig;

  constructor(configDir: string) {
    this.configDir = configDir;
    const subdir = path.join(configDir, 'config');
    try { fs.mkdirSync(subdir, { recursive: true }); } catch { /* ignore */ }
    this.configPath = path.join(subdir, 'subflow-config.json');
    this.config = this.load();
  }

  private load(): UnifiedConfig {
    try {
      const raw = fs.readFileSync(this.configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      const config = this.normalize(parsed);
      // A config written before the cloud engines were removed still names one of
      // them and carries their now-dead sections. normalize() already ignores both,
      // but leaving the file saying "deepgram" while the app runs Parakeet is a lie
      // waiting to confuse whoever reads it next — so rewrite it once, here.
      const stale =
        parsed.provider !== config.provider || 'deepgram' in parsed || 'gladia' in parsed;
      if (stale) {
        this.config = config;
        this.save();
      }
      return config;
    } catch {
      return this.migrate();
    }
  }

  private normalize(parsed: any): UnifiedConfig {
    const defaults = buildDefaults();
    return {
      provider: normalizeProvider(parsed.provider),
      parakeet: mergeParakeet(defaults.parakeet, parsed.parakeet || {}),
      nemotron: mergeNemotron(defaults.nemotron, parsed.nemotron || {}),
      remoteParakeet: mergeRemoteParakeet(defaults.remoteParakeet, parsed.remoteParakeet || {}),
      translator: mergeTranslator(defaults.translator, parsed.translator || {}),
      app: mergeApp(defaults.app, parsed.app || {}),
      ui: mergeUi(defaults.ui, parsed.ui || {}),
      windowPositions: parsed.windowPositions || {},
      denoiser: mergeDenoiser(defaults.denoiser, parsed.denoiser || {}),
    };
  }

  private migrate(): UnifiedConfig {
    const defaults = buildDefaults();
    const config: UnifiedConfig = {
      provider: 'parakeet',
      parakeet: { ...DEFAULT_PARAKEET, vad: { ...DEFAULT_PARAKEET_VAD } },
      nemotron: { ...DEFAULT_NEMOTRON },
      remoteParakeet: { ...DEFAULT_REMOTE_PARAKEET },
      translator: mergeTranslator(defaults.translator, this.readLegacy('translator-config.json')),
      app: mergeApp(defaults.app, this.readLegacy('app-settings.json')),
      ui: mergeUi(defaults.ui, this.readLegacy('ui-preferences.json')),
      windowPositions: this.readLegacy('window-positions.json'),
      denoiser: { ...DEFAULT_DENOISER },
    };
    this.config = config;
    this.save();
    return config;
  }

  private readLegacy(filename: string): any {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.configDir, filename), 'utf-8'));
    } catch {
      return {};
    }
  }

  private save(): void {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
    } catch (err) {
      console.error('Failed to save config:', err);
    }
  }

  get(): UnifiedConfig { return this.config; }

  getProvider(): SttProvider { return this.config.provider; }
  getParakeet(): ParakeetConfig { return this.config.parakeet; }
  getNemotron(): NemotronConfig { return this.config.nemotron; }

  updateNemotron(partial: Partial<NemotronConfig>): void {
    this.config.nemotron = { ...this.config.nemotron, ...partial };
    this.save();
  }
  getRemoteParakeet(): RemoteParakeetConfig { return this.config.remoteParakeet; }
  getTranslator(): TranslatorConfig { return this.config.translator; }
  getApp(): AppSettings { return this.config.app; }
  getUi(): UiPreferences { return this.config.ui; }
  getWindowPositions(): WindowPositions { return this.config.windowPositions; }
  getDenoiser(): DenoiserConfig { return this.config.denoiser; }

  updateProvider(provider: SttProvider): void {
    this.config.provider = normalizeProvider(provider);
    this.save();
  }



  updateParakeet(partial: Partial<ParakeetConfig>): void {
    this.config.parakeet = mergeParakeet(this.config.parakeet, partial);
    this.save();
  }

  updateRemoteParakeet(partial: Partial<RemoteParakeetConfig>): void {
    this.config.remoteParakeet = mergeRemoteParakeet(this.config.remoteParakeet, partial);
    this.save();
  }

  updateTranslator(partial: Partial<TranslatorConfig>): void {
    this.config.translator = mergeTranslator(this.config.translator, partial);
    this.save();
  }

  updateApp(partial: Partial<AppSettings>): void {
    this.config.app = mergeApp(this.config.app, partial);
    this.save();
  }

  updateUi(partial: Partial<UiPreferences>): void {
    this.config.ui = mergeUi(this.config.ui, partial);
    this.save();
  }

  updateWindowPositions(positions: WindowPositions): void {
    this.config.windowPositions = positions;
    this.save();
  }

  updateDenoiser(partial: Partial<DenoiserConfig>): void {
    this.config.denoiser = mergeDenoiser(this.config.denoiser, partial);
    this.save();
  }
}
