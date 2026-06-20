import fs from 'fs';
import path from 'path';
import type { DeepgramConfig, DeepgramFeatures, GladiaConfig, GladiaFeatures } from './model-manager';
import { DEFAULT_FEATURES, DEFAULT_GLADIA, DEFAULT_GLADIA_FEATURES } from './model-manager';
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
}

export interface DenoiserConfig {
  enabled: boolean;
  modelId: string;
}

export type SttProvider = 'deepgram' | 'gladia' | 'parakeet' | 'remote_parakeet';

export interface UnifiedConfig {
  provider: SttProvider;
  deepgram: DeepgramConfig;
  gladia: GladiaConfig;
  parakeet: ParakeetConfig;
  remoteParakeet: RemoteParakeetConfig;
  translator: TranslatorConfig;
  app: AppSettings;
  ui: UiPreferences;
  windowPositions: WindowPositions;
  denoiser: DenoiserConfig;
}

const DEFAULT_DEEPGRAM: DeepgramConfig = {
  apiKey: '',
  model: 'nova-3',
  features: { ...DEFAULT_FEATURES },
};

const DEFAULT_TRANSLATOR: TranslatorConfig = {
  baseUrl: 'https://openrouter.ai/api',
  apiKey: '',
  model: 'google/gemma-4-31b-it',
  apiFormat: 'openai' as ApiFormat,
  targetLanguage: 'zh',
  enabled: false,
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
  if (value === 'openai' || value === 'anthropic') return value;
  return 'openai';
}

function mergeDenoiser(base: DenoiserConfig, partial: Partial<DenoiserConfig>): DenoiserConfig {
  return {
    ...base,
    ...partial,
    enabled: typeof partial.enabled === 'boolean' ? partial.enabled : base.enabled,
    modelId: typeof partial.modelId === 'string' && partial.modelId ? partial.modelId : base.modelId,
  };
}

function normalizeProvider(value: unknown): SttProvider {
  if (value === 'deepgram' || value === 'gladia' || value === 'parakeet' || value === 'remote_parakeet') return value;
  return 'deepgram';
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
  };
}

function mergeGladia(base: GladiaConfig, partial: Partial<GladiaConfig>): GladiaConfig {
  return {
    ...base,
    ...partial,
    apiKey: typeof partial.apiKey === 'string' ? partial.apiKey : base.apiKey,
    model: typeof partial.model === 'string' && partial.model ? partial.model : base.model,
    features: { ...base.features, ...((partial as any).features || {}) } as GladiaFeatures,
  };
}

function buildDefaults(): UnifiedConfig {
  return {
    provider: 'deepgram',
    deepgram: { ...DEFAULT_DEEPGRAM, features: { ...DEFAULT_FEATURES } },
    gladia: { ...DEFAULT_GLADIA },
    parakeet: { ...DEFAULT_PARAKEET, vad: { ...DEFAULT_PARAKEET_VAD } },
    remoteParakeet: { ...DEFAULT_REMOTE_PARAKEET },
    translator: { ...DEFAULT_TRANSLATOR },
    app: { ...DEFAULT_APP },
    ui: { ...DEFAULT_UI },
    windowPositions: {},
    denoiser: { ...DEFAULT_DENOISER },
  };
}

function mergeDeepgram(base: DeepgramConfig, partial: Partial<DeepgramConfig>): DeepgramConfig {
  return {
    ...base,
    ...partial,
    features: { ...base.features, ...((partial as any).features || {}) } as DeepgramFeatures,
  };
}

function mergeTranslator(base: TranslatorConfig, partial: Partial<TranslatorConfig>): TranslatorConfig {
  return {
    ...base,
    ...partial,
    apiFormat: normalizeApiFormat(partial.apiFormat ?? base.apiFormat),
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
      return this.normalize(parsed);
    } catch {
      return this.migrate();
    }
  }

  private normalize(parsed: any): UnifiedConfig {
    const defaults = buildDefaults();
    return {
      provider: normalizeProvider(parsed.provider),
      deepgram: mergeDeepgram(defaults.deepgram, parsed.deepgram || {}),
      gladia: mergeGladia(defaults.gladia, parsed.gladia || {}),
      parakeet: mergeParakeet(defaults.parakeet, parsed.parakeet || {}),
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
      provider: 'deepgram',
      deepgram: mergeDeepgram(defaults.deepgram, this.readLegacy('deepgram-config.json')),
      gladia: { ...DEFAULT_GLADIA },
      parakeet: { ...DEFAULT_PARAKEET, vad: { ...DEFAULT_PARAKEET_VAD } },
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
  getDeepgram(): DeepgramConfig { return this.config.deepgram; }
  getGladia(): GladiaConfig { return this.config.gladia; }
  getParakeet(): ParakeetConfig { return this.config.parakeet; }
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

  updateDeepgram(partial: Partial<DeepgramConfig>): void {
    this.config.deepgram = mergeDeepgram(this.config.deepgram, partial);
    this.save();
  }

  updateGladia(partial: Partial<GladiaConfig>): void {
    this.config.gladia = mergeGladia(this.config.gladia, partial);
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
