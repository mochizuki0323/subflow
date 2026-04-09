import fs from 'fs';
import path from 'path';

import { accentFromDesktopWallpaper } from './wallpaper-accent';

export type AppearanceMode = 'light' | 'dark' | 'system';
export type AccentSource = 'default' | 'wallpaper';

export interface UiPreferences {
  appearance: AppearanceMode;
  accentSource: AccentSource;
}

const DEFAULT_PREFS: UiPreferences = {
  appearance: 'system',
  accentSource: 'default',
};

/** Payload sent to all renderers (control panel + overlay + history). */
export interface UiThemePayload {
  appearance: AppearanceMode;
  effectiveMode: 'light' | 'dark';
  accentSource: AccentSource;
  /** CSS custom properties without leading `--` for JSON clarity, applied as --key */
  vars: Record<string, string>;
}

export function getUiPreferencesPath(configDir: string): string {
  return path.join(configDir, 'ui-preferences.json');
}

export function loadUiPreferences(configDir: string): UiPreferences {
  try {
    const raw = fs.readFileSync(getUiPreferencesPath(configDir), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<UiPreferences>;
    return {
      ...DEFAULT_PREFS,
      ...parsed,
      appearance: parsed.appearance ?? DEFAULT_PREFS.appearance,
      accentSource: parsed.accentSource ?? DEFAULT_PREFS.accentSource,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function saveUiPreferences(configDir: string, prefs: UiPreferences): void {
  try {
    fs.writeFileSync(getUiPreferencesPath(configDir), JSON.stringify(prefs, null, 2));
  } catch (err) {
    console.error('Failed to save UI preferences:', err);
  }
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const h = hex.replace(/^#/, '');
  if (h.length === 3) {
    const r = parseInt(h[0] + h[0], 16);
    const g = parseInt(h[1] + h[1], 16);
    const b = parseInt(h[2] + h[2], 16);
    if ([r, g, b].some((n) => Number.isNaN(n))) return null;
    return { r, g, b };
  }
  if (h.length === 6) {
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    if ([r, g, b].some((n) => Number.isNaN(n))) return null;
    return { r, g, b };
  }
  return null;
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return `#${[clamp(r), clamp(g), clamp(b)].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

function mixRgb(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }, t: number): { r: number; g: number; b: number } {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  };
}

function lighten(hex: string, amount: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const white = { r: 255, g: 255, b: 255 };
  const m = mixRgb(rgb, white, amount);
  return rgbToHex(m.r, m.g, m.b);
}

function darken(hex: string, amount: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const black = { r: 0, g: 0, b: 0 };
  const m = mixRgb(rgb, black, amount);
  return rgbToHex(m.r, m.g, m.b);
}

const SEMANTIC_DARK: Record<string, string> = {
  danger: '#f87171',
  'danger-subtle': 'rgba(248,113,113,0.14)',
  error: '#f87171',
  success: '#4ade80',
  'success-subtle': 'rgba(74,222,128,0.14)',
  warning: '#fbbf24',
  'warning-subtle': 'rgba(251,191,36,0.14)',
};

const SEMANTIC_LIGHT: Record<string, string> = {
  danger: '#dc2626',
  'danger-subtle': 'rgba(220,38,38,0.12)',
  error: '#dc2626',
  success: '#16a34a',
  'success-subtle': 'rgba(22,163,74,0.12)',
  warning: '#d97706',
  'warning-subtle': 'rgba(217,119,6,0.12)',
};

const BASE_DARK: Record<string, string> = {
  'bg-primary': '#0c0e12',
  'bg-secondary': '#12151c',
  'bg-card': '#181c26',
  'bg-hover': '#1e2430',
  'text-primary': '#e8eaef',
  'text-secondary': '#9aa3b2',
  'text-muted': '#6b7280',
  border: 'rgba(255,255,255,0.08)',
  'border-subtle': 'rgba(255,255,255,0.05)',
  ...SEMANTIC_DARK,
};

const BASE_LIGHT: Record<string, string> = {
  'bg-primary': '#f4f2ee',
  'bg-secondary': '#ebe8e3',
  'bg-card': '#ffffff',
  'bg-hover': '#e5e2dc',
  'text-primary': '#1a1d24',
  'text-secondary': '#4b5563',
  'text-muted': '#6b7280',
  border: 'rgba(0,0,0,0.08)',
  'border-subtle': 'rgba(0,0,0,0.05)',
  ...SEMANTIC_LIGHT,
};

const DEFAULT_ACCENT_DARK = '#2dd4bf';
const DEFAULT_ACCENT_LIGHT = '#0d9488';

function accentDerived(accent: string, mode: 'light' | 'dark'): Record<string, string> {
  const hover = mode === 'dark' ? lighten(accent, 0.18) : darken(accent, 0.08);
  const rgb = hexToRgb(accent);
  const subtleAlpha = mode === 'dark' ? '0.18' : '0.14';
  const subtle = rgb
    ? `rgba(${rgb.r},${rgb.g},${rgb.b},${subtleAlpha})`
    : mode === 'dark'
      ? 'rgba(45,212,191,0.18)'
      : 'rgba(13,148,136,0.14)';
  return {
    accent,
    'accent-hover': hover,
    'accent-subtle': subtle,
  };
}

export function resolveUiTheme(
  prefs: UiPreferences,
  shouldUseDarkColors: boolean,
): UiThemePayload {
  const effectiveDark =
    prefs.appearance === 'system' ? shouldUseDarkColors : prefs.appearance === 'dark';
  const effectiveMode: 'light' | 'dark' = effectiveDark ? 'dark' : 'light';
  const base = effectiveDark ? BASE_DARK : BASE_LIGHT;
  let accent = effectiveDark ? DEFAULT_ACCENT_DARK : DEFAULT_ACCENT_LIGHT;

  if (prefs.accentSource === 'wallpaper') {
    const fromWall = accentFromDesktopWallpaper(effectiveDark);
    if (fromWall) {
      accent = fromWall;
    }
  }

  const derived = accentDerived(accent, effectiveMode);
  const vars: Record<string, string> = { ...base, ...derived };

  const rgb =
    hexToRgb(accent) ??
    hexToRgb(effectiveDark ? DEFAULT_ACCENT_DARK : DEFAULT_ACCENT_LIGHT)!;
  vars['accent-rgb'] = `${rgb.r},${rgb.g},${rgb.b}`;
  vars['overlay-tint'] = effectiveDark
    ? `rgba(${Math.min(255, rgb.r + 20)},${Math.min(255, rgb.g + 25)},${Math.min(255, rgb.b + 30)},0.22)`
    : `rgba(${rgb.r},${rgb.g},${rgb.b},0.18)`;
  vars['overlay-bar-bg'] = effectiveDark
    ? `rgba(${Math.max(0, rgb.r - 40)},${Math.max(0, rgb.g - 35)},${Math.max(0, rgb.b - 30)},0.78)`
    : `rgba(${Math.min(255, rgb.r + 80)},${Math.min(255, rgb.g + 80)},${Math.min(255, rgb.b + 80)},0.82)`;
  vars['subtitle-glass'] = effectiveDark
    ? `rgba(12,14,18,0.82)`
    : `rgba(255,255,255,0.88)`;
  vars['subtitle-text'] = effectiveDark ? '#f4f4f5' : '#111827';
  vars['subtitle-translated'] = effectiveDark ? derived['accent-hover'] : darken(accent, 0.15);
  vars['history-translated'] = effectiveDark ? lighten(accent, 0.35) : darken(accent, 0.05);

  return {
    appearance: prefs.appearance,
    effectiveMode,
    accentSource: prefs.accentSource,
    vars,
  };
}
