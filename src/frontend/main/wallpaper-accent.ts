import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync, execSync } from 'child_process';
import { nativeImage } from 'electron';

/**
 * Best-effort desktop wallpaper path (no extra user setup).
 * Tries GNOME, Hyprland hyprpaper, KDE, Windows, macOS.
 */
export function getDesktopWallpaperPath(): string | null {
  return (
    tryGnome() ??
    tryHyprpaper() ??
    tryKde() ??
    tryNitrogen() ??
    tryWindows() ??
    tryMacOS() ??
    null
  );
}

function normalizePath(p: string): string {
  let s = p.trim().replace(/^['"]|['"]$/g, '');
  if (s.startsWith('file://')) {
    try {
      s = decodeURIComponent(s.replace(/^file:\/\//, ''));
    } catch {
      s = s.replace(/^file:\/\//, '');
    }
  }
  if (s.startsWith('~')) {
    s = path.join(os.homedir(), s.slice(1));
  }
  return path.resolve(s);
}

function tryGnome(): string | null {
  try {
    const out = execFileSync('gsettings', ['get', 'org.gnome.desktop.background', 'picture-uri'], {
      encoding: 'utf-8',
      timeout: 4000,
    }).trim();
    const raw = out.replace(/^'|'$/g, '');
    const p = normalizePath(raw);
    if (p && fs.existsSync(p)) return p;
  } catch {
    /* gsettings missing or not GNOME */
  }
  return null;
}

function tryHyprpaper(): string | null {
  const conf = path.join(os.homedir(), '.config', 'hypr', 'hyprpaper.conf');
  try {
    const text = fs.readFileSync(conf, 'utf-8');
    const preload = text.match(/^\s*preload\s*=\s*(.+)$/m);
    if (!preload) return null;
    let p = preload[1].trim();
    if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
      p = p.slice(1, -1);
    }
    p = normalizePath(p);
    if (p && fs.existsSync(p)) return p;
  } catch {
    /* */
  }
  return null;
}

function tryKde(): string | null {
  try {
    const out = execFileSync(
      'kreadconfig5',
      [
        '--file',
        path.join(os.homedir(), '.config', 'plasma-org.kde.plasma.desktop-appletsrc'),
        '--group',
        'Containments][1][Wallpaper][org.kde.image][General]',
        '--key',
        'Image',
      ],
      { encoding: 'utf-8', timeout: 4000 },
    ).trim();
    const p = normalizePath(out.replace(/^file:/, ''));
    if (p && fs.existsSync(p)) return p;
  } catch {
    /* kreadconfig5 missing or different Plasma layout */
  }
  return null;
}

function tryNitrogen(): string | null {
  const cfg = path.join(os.homedir(), '.config', 'nitrogen', 'bg-saved.cfg');
  try {
    const text = fs.readFileSync(cfg, 'utf-8');
    const m = text.match(/^\s*file\s*=\s*(.+)$/m);
    if (!m) return null;
    const p = normalizePath(m[1].trim());
    if (p && fs.existsSync(p)) return p;
  } catch {
    /* */
  }
  return null;
}

function tryWindows(): string | null {
  if (process.platform !== 'win32') return null;
  try {
    const out = execSync(
      'reg query "HKCU\\Control Panel\\Desktop" /v Wallpaper',
      { encoding: 'utf-8', timeout: 5000 },
    );
    const line = out.split('\n').find((l) => l.includes('Wallpaper'));
    if (!line) return null;
    const parts = line.trim().split(/\s+/);
    const p = parts.slice(-1)[0];
    if (p && fs.existsSync(p)) return p;
  } catch {
    /* */
  }
  return null;
}

function tryMacOS(): string | null {
  if (process.platform !== 'darwin') return null;
  try {
    const out = execFileSync(
      'osascript',
      ['-e', 'tell application "System Events" to tell every desktop to get picture'],
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
    const first = out.split(',')[0]?.trim().replace(/^'|'$/g, '') ?? '';
    const p = normalizePath(first);
    if (p && fs.existsSync(p)) return p;
  } catch {
    /* */
  }
  return null;
}

/** Electron `toBitmap()` format is platform-dependent; pick RGBA vs BGRA by saturation. */
function averageBitmapColor(buf: Buffer, width: number, height: number): { r: number; g: number; b: number } {
  const expected = width * height * 4;
  if (buf.length < expected || width < 2 || height < 2) {
    return { r: 45, g: 212, b: 191 };
  }

  const accumulate = (order: 'rgba' | 'bgra') => {
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    let sat = 0;
    for (let i = 0; i < expected; i += 4) {
      const a = buf[i + 3];
      if (a < 12) continue;
      let rr: number;
      let gg: number;
      let bb: number;
      if (order === 'rgba') {
        rr = buf[i];
        gg = buf[i + 1];
        bb = buf[i + 2];
      } else {
        bb = buf[i];
        gg = buf[i + 1];
        rr = buf[i + 2];
      }
      r += rr;
      g += gg;
      b += bb;
      sat += Math.max(rr, gg, bb) - Math.min(rr, gg, bb);
      n++;
    }
    if (n === 0) return { r: 45, g: 212, b: 191, sat: 0 };
    return { r: r / n, g: g / n, b: b / n, sat: sat / n };
  };

  const a = accumulate('rgba');
  const b = accumulate('bgra');
  const pick = a.sat >= b.sat ? a : b;
  return { r: pick.r, g: pick.g, b: pick.b };
}

/** If wallpaper is nearly gray, blend with a teal so the UI still has a clear accent. */
function enrichMutedAccent(r: number, g: number, b: number, dark: boolean): { r: number; g: number; b: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max - min;
  const tr = dark ? 45 : 13;
  const tg = dark ? 212 : 148;
  const tb = dark ? 191 : 136;
  if (sat < 28) {
    const t = 0.55;
    return {
      r: r * (1 - t) + tr * t,
      g: g * (1 - t) + tg * t,
      b: b * (1 - t) + tb * t,
    };
  }
  return { r, g, b };
}

function clamp255(x: number): number {
  return Math.max(0, Math.min(255, Math.round(x)));
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((x) => clamp255(x).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Load wallpaper image in-process and pick an average accent color (downscaled for speed).
 */
export function extractAccentHexFromWallpaperPath(absPath: string, effectiveDark: boolean): string | null {
  try {
    if (!fs.existsSync(absPath)) return null;
    const stat = fs.statSync(absPath);
    if (!stat.isFile() || stat.size < 32) return null;
    const lower = absPath.toLowerCase();
    if (lower.endsWith('.svg') || lower.endsWith('.xml')) return null;

    const img = nativeImage.createFromPath(absPath);
    if (img.isEmpty()) return null;

    const { width, height } = img.getSize();
    if (width < 2 || height < 2) return null;

    const maxDim = 96;
    const scale = Math.min(maxDim / width, maxDim / height, 1);
    const nw = Math.max(2, Math.round(width * scale));
    const nh = Math.max(2, Math.round(height * scale));
    const small = img.resize({ width: nw, height: nh });

    const bitmap = small.toBitmap();
    const sz = small.getSize();
    let { r, g, b } = averageBitmapColor(bitmap, sz.width, sz.height);
    const enriched = enrichMutedAccent(r, g, b, effectiveDark);
    return rgbToHex(enriched.r, enriched.g, enriched.b);
  } catch (err) {
    console.warn('wallpaper accent extraction failed:', err);
    return null;
  }
}

export function accentFromDesktopWallpaper(effectiveDark: boolean): string | null {
  const wp = getDesktopWallpaperPath();
  if (!wp) return null;
  return extractAccentHexFromWallpaperPath(wp, effectiveDark);
}
