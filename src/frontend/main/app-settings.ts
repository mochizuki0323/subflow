import fs from 'fs';
import path from 'path';

export type UiLanguage = 'en' | 'zh';

export type SubtitleMode = 'original' | 'translated' | 'bilingual';

export interface AppSettings {
  sourceLanguage: string;
  uiLanguage: UiLanguage;
  subtitleMode: SubtitleMode;
  showPartials: boolean;
}

const DEFAULTS: AppSettings = {
  sourceLanguage: 'auto',
  uiLanguage: 'zh',
  subtitleMode: 'original',
  showPartials: false,
};

function normalizeSubtitleMode(value: unknown): SubtitleMode {
  if (value === 'original' || value === 'translated' || value === 'bilingual') {
    return value;
  }
  return DEFAULTS.subtitleMode;
}

const FILE_NAME = 'app-settings.json';

export function getAppSettingsPath(configDir: string): string {
  return path.join(configDir, FILE_NAME);
}

export function loadAppSettings(configDir: string): AppSettings {
  try {
    const raw = fs.readFileSync(getAppSettingsPath(configDir), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    const uiLanguage: UiLanguage =
      parsed.uiLanguage === 'en' || parsed.uiLanguage === 'zh' ? parsed.uiLanguage : DEFAULTS.uiLanguage;
    return {
      ...DEFAULTS,
      ...parsed,
      sourceLanguage:
        typeof parsed.sourceLanguage === 'string' ? parsed.sourceLanguage : DEFAULTS.sourceLanguage,
      uiLanguage,
      subtitleMode: normalizeSubtitleMode(parsed.subtitleMode),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveAppSettings(configDir: string, settings: AppSettings): void {
  try {
    fs.writeFileSync(getAppSettingsPath(configDir), JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('Failed to save app settings:', err);
  }
}
