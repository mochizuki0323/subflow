import fs from 'fs';
import path from 'path';

import { accentFromDesktopWallpaper, type AccentResolution } from './wallpaper-accent';

export type { AccentResolution };

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
  /** Where the accent actually came from; only meaningful when accentSource is 'wallpaper'. */
  accentResolution: AccentResolution | null;
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

/**
 * Only two chromatic roles exist: the accent is the signal (live, armed, selected)
 * and `fault` is a break in it. Everything the UI calls "success" or "warning" is
 * really "the signal is present", so it tracks the accent rather than introducing
 * more hues — the discipline is what makes a colour mean something.
 */
const SEMANTIC_DARK: Record<string, string> = {
  danger: '#e8503c',
  'danger-subtle': 'rgba(232,80,60,0.14)',
  error: '#e8503c',
  fault: '#e8503c',
  success: 'var(--accent)',
  'success-subtle': 'var(--accent-subtle)',
  warning: 'var(--accent)',
  'warning-subtle': 'var(--accent-subtle)',
};

const SEMANTIC_LIGHT: Record<string, string> = {
  danger: '#b33320',
  'danger-subtle': 'rgba(179,51,32,0.12)',
  error: '#b33320',
  fault: '#b33320',
  success: 'var(--accent)',
  'success-subtle': 'var(--accent-subtle)',
  warning: 'var(--accent)',
  'warning-subtle': 'var(--accent-subtle)',
};

/**
 * Cool graphite rather than warm neutrals: the accent is a lamp, and a lamp only
 * reads as one against a cold surface. `ink` is phosphor grey, never pure white.
 */
const BASE_DARK: Record<string, string> = {
  void: '#0a0c0b',
  surface: '#0f1211',
  'surface-2': '#151917',
  rule: '#232825',
  'rule-2': '#1a1e1c',
  ink: '#c6cdc7',
  'ink-2': '#8a928c',
  mute: '#565e58',
  // legacy names, kept so every existing component inherits the new palette
  'bg-primary': '#0a0c0b',
  'bg-secondary': '#0f1211',
  'bg-card': '#151917',
  'bg-hover': '#1b201d',
  'text-primary': '#c6cdc7',
  'text-secondary': '#8a928c',
  'text-muted': '#565e58',
  border: '#232825',
  'border-subtle': '#1a1e1c',
  ...SEMANTIC_DARK,
};

const BASE_LIGHT: Record<string, string> = {
  void: '#dde1dc',
  surface: '#f0f2ee',
  'surface-2': '#fafbf8',
  rule: '#c2c9be',
  'rule-2': '#d9ded4',
  ink: '#141714',
  'ink-2': '#424a44',
  mute: '#6d756e',
  'bg-primary': '#dde1dc',
  'bg-secondary': '#f0f2ee',
  'bg-card': '#fafbf8',
  'bg-hover': '#e7ebe4',
  'text-primary': '#141714',
  'text-secondary': '#424a44',
  'text-muted': '#6d756e',
  border: '#c2c9be',
  'border-subtle': '#d9ded4',
  ...SEMANTIC_LIGHT,
};

/** Lamp amber. Reserved for signal; replaced wholesale by the wallpaper accent. */
const DEFAULT_ACCENT_DARK = '#ffa724';
const DEFAULT_ACCENT_LIGHT = '#96500a';

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

export async function resolveUiTheme(
  prefs: UiPreferences,
  shouldUseDarkColors: boolean,
): Promise<UiThemePayload> {
  const effectiveDark =
    prefs.appearance === 'system' ? shouldUseDarkColors : prefs.appearance === 'dark';
  const effectiveMode: 'light' | 'dark' = effectiveDark ? 'dark' : 'light';
  const base = effectiveDark ? BASE_DARK : BASE_LIGHT;
  let accent = effectiveDark ? DEFAULT_ACCENT_DARK : DEFAULT_ACCENT_LIGHT;
  let accentResolution: AccentResolution | null = null;

  if (prefs.accentSource === 'wallpaper') {
    const fromWall = await accentFromDesktopWallpaper(effectiveDark);
    accentResolution = fromWall.resolution;
    if (fromWall.hex) {
      accent = fromWall.hex;
    }
  }

  const derived = accentDerived(accent, effectiveMode);
  const vars: Record<string, string> = { ...base, ...derived };

  const rgb =
    hexToRgb(accent) ??
    hexToRgb(effectiveDark ? DEFAULT_ACCENT_DARK : DEFAULT_ACCENT_LIGHT)!;
  vars['accent-rgb'] = `${rgb.r},${rgb.g},${rgb.b}`;
  vars['overlay-tint'] = `rgba(${rgb.r},${rgb.g},${rgb.b},0.14)`;
  vars['overlay-bar-bg'] = effectiveDark ? 'rgba(6,8,7,0.70)' : 'rgba(247,248,245,0.78)';
  // A single scrim behind the whole caption block rather than a box per line.
  vars['subtitle-glass'] = effectiveDark ? 'rgba(6,8,7,0.86)' : 'rgba(247,248,245,0.90)';
  vars['subtitle-text'] = effectiveDark ? '#f4f6f2' : '#141714';
  // The translation is quieter, not a different hue — colour stays reserved for signal.
  vars['subtitle-translated'] = effectiveDark ? 'rgba(244,246,242,0.62)' : 'rgba(20,23,20,0.66)';
  vars['history-translated'] = effectiveDark ? 'rgba(244,246,242,0.62)' : 'rgba(20,23,20,0.66)';

  return {
    appearance: prefs.appearance,
    effectiveMode,
    accentSource: prefs.accentSource,
    accentResolution,
    vars,
  };
}
