import fs from 'fs';
import path from 'path';
import type { DeepgramConfig, DeepgramFeatures } from './model-manager';
import { DEFAULT_FEATURES } from './model-manager';
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

export interface DenoiserConfig {
  enabled: boolean;
  modelId: string;
}

export interface UnifiedConfig {
  deepgram: DeepgramConfig;
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
};

const DEFAULT_UI: UiPreferences = {
  appearance: 'system',
  accentSource: 'default',
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

function buildDefaults(): UnifiedConfig {
  return {
    deepgram: { ...DEFAULT_DEEPGRAM, features: { ...DEFAULT_FEATURES } },
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
      deepgram: mergeDeepgram(defaults.deepgram, parsed.deepgram || {}),
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
      deepgram: mergeDeepgram(defaults.deepgram, this.readLegacy('deepgram-config.json')),
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

  getDeepgram(): DeepgramConfig { return this.config.deepgram; }
  getTranslator(): TranslatorConfig { return this.config.translator; }
  getApp(): AppSettings { return this.config.app; }
  getUi(): UiPreferences { return this.config.ui; }
  getWindowPositions(): WindowPositions { return this.config.windowPositions; }
  getDenoiser(): DenoiserConfig { return this.config.denoiser; }

  updateDeepgram(partial: Partial<DeepgramConfig>): void {
    this.config.deepgram = mergeDeepgram(this.config.deepgram, partial);
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
