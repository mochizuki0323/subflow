import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync, execSync } from 'child_process';
import { app, BrowserWindow, nativeImage, systemPreferences } from 'electron';

/** How the accent shown in the UI was actually obtained. Surfaced to the renderer. */
export type AccentResolution =
  | { status: 'wallpaper'; path: string }
  | { status: 'desktop-accent'; name: string }
  | { status: 'no-wallpaper' }
  | { status: 'decode-failed'; path: string }
  | { status: 'low-chroma'; path: string };

export interface WallpaperAccent {
  /** null means "nothing usable found" — the caller keeps its own default accent. */
  hex: string | null;
  resolution: AccentResolution;
}

/** Longest edge of the sampling buffer. 128 keeps ~16k pixels: plenty for a hue histogram. */
const SAMPLE_DIM = 128;
const MAX_WALLPAPER_BYTES = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Wallpaper path discovery
// ---------------------------------------------------------------------------

/**
 * Best-effort desktop wallpaper path (no extra user setup).
 * `effectiveDark` picks the dark variant on desktops that keep a separate one.
 */
export function getDesktopWallpaperPath(effectiveDark: boolean): string | null {
  return (
    tryGnome(effectiveDark) ??
    tryHyprpaper() ??
    tryKde() ??
    tryNitrogen() ??
    tryFeh() ??
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

function usableFile(p: string | null | undefined): string | null {
  if (!p) return null;
  try {
    const abs = normalizePath(p);
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size < 32) return null;
    return abs;
  } catch {
    return null;
  }
}

function tryGnome(effectiveDark: boolean): string | null {
  // GNOME keeps light/dark wallpapers under separate keys; fall back to the other one.
  const keys = effectiveDark
    ? ['picture-uri-dark', 'picture-uri']
    : ['picture-uri', 'picture-uri-dark'];
  for (const key of keys) {
    try {
      const out = execFileSync('gsettings', ['get', 'org.gnome.desktop.background', key], {
        encoding: 'utf-8',
        timeout: 4000,
      }).trim();
      const raw = out.replace(/^'|'$/g, '');
      if (!raw) continue;
      const p = usableFile(raw);
      if (p) return p;
    } catch {
      /* gsettings missing, not GNOME, or key absent on this version */
    }
  }
  return null;
}

function tryHyprpaper(): string | null {
  // Prefer the live state; the config file can list several preloads.
  try {
    const out = execFileSync('hyprctl', ['hyprpaper', 'listloaded'], {
      encoding: 'utf-8',
      timeout: 4000,
    });
    for (const line of out.split('\n')) {
      const p = usableFile(line);
      if (p) return p;
    }
  } catch {
    /* hyprctl missing or hyprpaper not running */
  }

  const conf = path.join(os.homedir(), '.config', 'hypr', 'hyprpaper.conf');
  try {
    const text = fs.readFileSync(conf, 'utf-8');
    // `wallpaper = <monitor>,<path>` is what is actually shown; `preload` only loads it.
    for (const m of text.matchAll(/^\s*wallpaper\s*=\s*(.+)$/gm)) {
      const p = usableFile(m[1].split(',').slice(1).join(',') || m[1]);
      if (p) return p;
    }
    for (const m of text.matchAll(/^\s*preload\s*=\s*(.+)$/gm)) {
      const p = usableFile(m[1]);
      if (p) return p;
    }
  } catch {
    /* */
  }
  return null;
}

function tryKde(): string | null {
  const appletsrc = path.join(os.homedir(), '.config', 'plasma-org.kde.plasma.desktop-appletsrc');
  // The wallpaper lives under whichever containment is the desktop; probe the first few.
  for (const bin of ['kreadconfig6', 'kreadconfig5']) {
    for (let containment = 1; containment <= 4; containment++) {
      try {
        const out = execFileSync(
          bin,
          [
            '--file',
            appletsrc,
            '--group',
            `Containments][${containment}][Wallpaper][org.kde.image][General`,
            '--key',
            'Image',
          ],
          { encoding: 'utf-8', timeout: 4000 },
        ).trim();
        const p = usableFile(out.replace(/^file:/, ''));
        if (p) return p;
      } catch {
        /* kreadconfig missing or different Plasma layout */
      }
    }
  }
  return null;
}

function tryNitrogen(): string | null {
  const cfg = path.join(os.homedir(), '.config', 'nitrogen', 'bg-saved.cfg');
  try {
    const text = fs.readFileSync(cfg, 'utf-8');
    const m = text.match(/^\s*file\s*=\s*(.+)$/m);
    return usableFile(m?.[1]);
  } catch {
    return null;
  }
}

function tryFeh(): string | null {
  // `.fehbg` is a shell script whose last argument is the wallpaper path.
  try {
    const text = fs.readFileSync(path.join(os.homedir(), '.fehbg'), 'utf-8');
    for (const m of text.matchAll(/'([^']+)'|"([^"]+)"/g)) {
      const p = usableFile(m[1] ?? m[2]);
      if (p) return p;
    }
  } catch {
    /* */
  }
  return null;
}

function expandWindowsEnv(value: string): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => process.env[name] ?? whole);
}

function tryWindows(): string | null {
  if (process.platform !== 'win32') return null;
  const candidates: string[] = [];
  try {
    // `chcp 65001` first: reg.exe writes in the console code page, so a non-ASCII
    // path (e.g. a Chinese user name) comes back mojibake on a GBK console.
    const out = execSync('chcp 65001>nul && reg query "HKCU\\Control Panel\\Desktop" /v Wallpaper', {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    });
    // Take everything after the type token — paths contain spaces.
    const m = out.match(/\bWallpaper\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m);
    if (m) candidates.push(expandWindowsEnv(m[1]));
  } catch {
    /* */
  }
  // Windows re-encodes the active wallpaper here (Spotlight, slideshows, scaled copies).
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper'));
  }
  for (const candidate of candidates) {
    const p = usableFile(candidate);
    if (p) return p;
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
    return usableFile(out.split(',')[0]);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pixel access
// ---------------------------------------------------------------------------

interface Pixels {
  /** Straight (non-premultiplied) RGBA. */
  data: Uint8Array;
  width: number;
  height: number;
}

/** Formats Chromium's image decoders can handle. Anything else is not worth a window. */
const CHROMIUM_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jpe': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

/**
 * `nativeImage` only decodes PNG and JPEG, and `toBitmap()` hands back **BGRA**
 * (verified: a pure-red PNG yields bytes `00 00 FF FF`). Normalise to RGBA here so
 * nothing downstream has to care which decoder produced the buffer.
 */
function readPixelsViaNativeImage(absPath: string): Pixels | null {
  const img = nativeImage.createFromPath(absPath);
  if (img.isEmpty()) return null;

  const { width, height } = img.getSize();
  if (width < 2 || height < 2) return null;

  const scale = Math.min(SAMPLE_DIM / width, SAMPLE_DIM / height, 1);
  const small = img.resize({
    width: Math.max(2, Math.round(width * scale)),
    height: Math.max(2, Math.round(height * scale)),
  });
  const size = small.getSize();
  const bitmap = small.toBitmap();
  const expected = size.width * size.height * 4;
  if (bitmap.length < expected) return null;

  const data = new Uint8Array(expected);
  for (let i = 0; i < expected; i += 4) {
    const a = bitmap[i + 3];
    // Skia keeps premultiplied alpha; undo it so translucent wallpapers keep their hue.
    const unmul = a === 0 || a === 255 ? 1 : 255 / a;
    data[i] = Math.min(255, Math.round(bitmap[i + 2] * unmul));
    data[i + 1] = Math.min(255, Math.round(bitmap[i + 1] * unmul));
    data[i + 2] = Math.min(255, Math.round(bitmap[i] * unmul));
    data[i + 3] = a;
  }
  return { data, width: size.width, height: size.height };
}

let decoderWindow: BrowserWindow | null = null;
let decoderIdleTimer: NodeJS.Timeout | null = null;

/**
 * One reusable offscreen window for all decodes. Creating and destroying a window per
 * image is what breaks on software-GL setups (the second `loadURL` fails with
 * ERR_FAILED and the churn can take the process down), and offscreen mode keeps us off
 * the native surface path entirely.
 */
async function getDecoderWindow(): Promise<BrowserWindow | null> {
  if (decoderWindow && !decoderWindow.isDestroyed()) return decoderWindow;
  const win = new BrowserWindow({
    show: false,
    width: 64,
    height: 64,
    skipTaskbar: true,
    webPreferences: {
      offscreen: true,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  try {
    await win.loadURL('about:blank');
  } catch (err) {
    console.warn('wallpaper decoder window failed to load:', err);
    if (!win.isDestroyed()) win.destroy();
    return null;
  }
  decoderWindow = win;
  return win;
}

/** Keep the decoder around for bursts of work, then let it go. */
function scheduleDecoderRelease(): void {
  if (decoderIdleTimer) clearTimeout(decoderIdleTimer);
  decoderIdleTimer = setTimeout(() => {
    decoderIdleTimer = null;
    if (decoderWindow && !decoderWindow.isDestroyed()) decoderWindow.destroy();
    decoderWindow = null;
  }, 30_000);
  decoderIdleTimer.unref?.();
}

/**
 * Fallback decoder for formats `nativeImage` refuses (WebP, AVIF, GIF, BMP, SVG…).
 * The renderer gets the bytes as a data URL rather than a `file://` reference so no
 * origin/taint rules apply, and canvas `getImageData()` is already straight RGBA.
 */
async function readPixelsViaChromium(absPath: string): Promise<Pixels | null> {
  if (!app.isReady()) return null;
  const mime = CHROMIUM_MIME[path.extname(absPath).toLowerCase()];
  if (!mime) return null;

  let file: Buffer;
  try {
    if (fs.statSync(absPath).size > MAX_WALLPAPER_BYTES) return null;
    file = fs.readFileSync(absPath);
  } catch {
    return null;
  }

  const dataUrl = `data:${mime};base64,${file.toString('base64')}`;
  const script = `(async () => {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('decode failed'));
      img.src = ${JSON.stringify(dataUrl)};
    });
    // A sizeless SVG reports 0; pick an arbitrary raster size for it.
    const iw = img.naturalWidth || img.width || 512;
    const ih = img.naturalHeight || img.height || 512;
    const scale = Math.min(${SAMPLE_DIM} / iw, ${SAMPLE_DIM} / ih, 1);
    const w = Math.max(2, Math.round(iw * scale));
    const h = Math.max(2, Math.round(ih * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const bytes = ctx.getImageData(0, 0, w, h).data;
    let binary = '';
    for (let i = 0; i < bytes.length; i += 4096) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 4096, bytes.length)));
    }
    return { width: w, height: h, base64: btoa(binary) };
  })()`;

  try {
    const win = await getDecoderWindow();
    if (!win) return null;
    const result = (await Promise.race([
      win.webContents.executeJavaScript(script, true),
      new Promise((_, reject) => setTimeout(() => reject(new Error('decode timed out')), 10_000)),
    ])) as { width: number; height: number; base64: string };

    const data = new Uint8Array(Buffer.from(result.base64, 'base64'));
    if (data.length < result.width * result.height * 4) return null;
    return { data, width: result.width, height: result.height };
  } catch (err) {
    console.warn('wallpaper decode via Chromium failed:', err);
    return null;
  } finally {
    scheduleDecoderRelease();
  }
}

async function readWallpaperPixels(absPath: string): Promise<Pixels | null> {
  return readPixelsViaNativeImage(absPath) ?? (await readPixelsViaChromium(absPath));
}

// ---------------------------------------------------------------------------
// Colour maths
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let rgb: [number, number, number];
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const m = l - c / 2;
  return `#${rgb
    .map((v) => clamp(Math.round((v + m) * 255), 0, 255).toString(16).padStart(2, '0'))
    .join('')}`;
}

/**
 * Pull saturation/lightness into a band that reads as an accent against the current
 * background, keeping the wallpaper's hue. Without this a dark wallpaper yields an
 * accent that vanishes on a dark surface (and vice versa).
 */
function toAccentBand(h: number, s: number, l: number, dark: boolean): string {
  const sat = clamp(s, dark ? 0.45 : 0.42, dark ? 0.85 : 0.78);
  const lit = clamp(l, dark ? 0.55 : 0.32, dark ? 0.72 : 0.45);
  return hslToHex(h, sat, lit);
}

const HUE_BINS = 24;
/**
 * Minimum chromatic weight (summed saturation × mid-tone weighting, per considered
 * pixel) for the dominant hue to count as a real accent rather than noise.
 *
 * Measured over the stock GNOME wallpapers: colourful ones score 0.029 (balls) to 0.79
 * (adwaita), while greyscale ones — including desaturated and re-compressed images —
 * score exactly 0, because the per-pixel `s < 0.12` gate already drops them. The gap is
 * wide enough to sit well below the lowest real wallpaper and still catch a small but
 * genuine splash of colour.
 */
const MIN_CHROMA_WEIGHT = 0.004;

/**
 * Pick the wallpaper's dominant *accent* hue.
 *
 * Averaging the whole image (the previous approach) is wrong: opposing hues cancel and
 * every photo collapses to the same muddy grey. Instead, bin pixels by hue, weight each
 * by saturation and mid-tone-ness, and take the circular mean of the winning bin and its
 * neighbours (a gradient often straddles a bin edge).
 */
function dominantAccentHex(px: Pixels, dark: boolean): string | null {
  const weight = new Float64Array(HUE_BINS);
  const cosAcc = new Float64Array(HUE_BINS);
  const sinAcc = new Float64Array(HUE_BINS);
  const satAcc = new Float64Array(HUE_BINS);
  const litAcc = new Float64Array(HUE_BINS);
  let considered = 0;

  for (let i = 0; i + 3 < px.data.length; i += 4) {
    if (px.data[i + 3] < 12) continue;
    considered++;
    const { h, s, l } = rgbToHsl(px.data[i], px.data[i + 1], px.data[i + 2]);
    if (s < 0.12) continue;
    // Near-black and near-white pixels carry an unreliable hue.
    const midTone = 1 - Math.abs(l - 0.5) * 1.6;
    if (midTone <= 0) continue;

    const w = s * midTone;
    const bin = Math.min(HUE_BINS - 1, Math.floor((h / 360) * HUE_BINS));
    const rad = (h * Math.PI) / 180;
    weight[bin] += w;
    cosAcc[bin] += w * Math.cos(rad);
    sinAcc[bin] += w * Math.sin(rad);
    satAcc[bin] += w * s;
    litAcc[bin] += w * l;
  }
  if (considered === 0) return null;

  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < HUE_BINS; i++) {
    const score =
      weight[i] +
      0.5 * (weight[(i + 1) % HUE_BINS] + weight[(i + HUE_BINS - 1) % HUE_BINS]);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  if (best < 0) return null;

  let w = 0;
  let cos = 0;
  let sin = 0;
  let sat = 0;
  let lit = 0;
  for (const offset of [-1, 0, 1]) {
    const i = (best + offset + HUE_BINS) % HUE_BINS;
    w += weight[i];
    cos += cosAcc[i];
    sin += sinAcc[i];
    sat += satAcc[i];
    lit += litAcc[i];
  }
  if (w <= 0 || w / considered < MIN_CHROMA_WEIGHT) return null;

  let hue = (Math.atan2(sin / w, cos / w) * 180) / Math.PI;
  if (hue < 0) hue += 360;
  return toAccentBand(hue, sat / w, lit / w, dark);
}

// ---------------------------------------------------------------------------
// Desktop accent fallback (used when the wallpaper itself is unusable)
// ---------------------------------------------------------------------------

/** libadwaita's named accent colours, as exposed by `org.gnome.desktop.interface`. */
const GNOME_ACCENTS: Record<string, string> = {
  blue: '#3584e4',
  teal: '#2190a4',
  green: '#3a944a',
  yellow: '#c88800',
  orange: '#ed5b00',
  red: '#e62d42',
  pink: '#d56199',
  purple: '#9141ac',
  slate: '#6f8396',
};

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const h = hex.replace(/^#/, '');
  if (h.length !== 6) return null;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return [r, g, b].some(Number.isNaN) ? null : { r, g, b };
}

function desktopAccent(dark: boolean): { name: string; hex: string } | null {
  if (process.platform === 'linux') {
    try {
      const out = execFileSync('gsettings', ['get', 'org.gnome.desktop.interface', 'accent-color'], {
        encoding: 'utf-8',
        timeout: 4000,
      })
        .trim()
        .replace(/^'|'$/g, '');
      const base = GNOME_ACCENTS[out];
      if (!base) return null;
      const rgb = hexToRgb(base)!;
      const { h, s, l } = rgbToHsl(rgb.r, rgb.g, rgb.b);
      return { name: out, hex: toAccentBand(h, s, l, dark) };
    } catch {
      return null;
    }
  }
  // Windows and macOS expose the system accent directly.
  try {
    const raw = systemPreferences.getAccentColor?.();
    const rgb = raw ? hexToRgb(`#${raw.slice(0, 6)}`) : null;
    if (!rgb) return null;
    const { h, s, l } = rgbToHsl(rgb.r, rgb.g, rgb.b);
    return { name: 'system', hex: toAccentBand(h, s, l, dark) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

let cache: { key: string; value: WallpaperAccent } | null = null;

/** Drop the memoised accent so the next resolve re-reads the wallpaper from disk. */
export function invalidateWallpaperAccentCache(): void {
  cache = null;
}

/** Load a wallpaper image and pick an accent from it. Exported for reuse/testing. */
export async function extractAccentHexFromWallpaperPath(
  absPath: string,
  effectiveDark: boolean,
): Promise<string | null> {
  try {
    if (!usableFile(absPath)) return null;
    const px = await readWallpaperPixels(absPath);
    if (!px) return null;
    return dominantAccentHex(px, effectiveDark);
  } catch (err) {
    console.warn('wallpaper accent extraction failed:', err);
    return null;
  }
}

/**
 * Resolve an accent from the desktop wallpaper, degrading to the system accent colour
 * when the wallpaper cannot be used (JXL/HEIC wallpapers, greyscale images, no wallpaper).
 * The reason is reported so the UI can explain itself instead of silently doing nothing.
 */
export async function accentFromDesktopWallpaper(effectiveDark: boolean): Promise<WallpaperAccent> {
  const wallpaper = getDesktopWallpaperPath(effectiveDark);

  let mtime = 0;
  if (wallpaper) {
    try {
      mtime = fs.statSync(wallpaper).mtimeMs;
    } catch {
      /* raced with a wallpaper change; treat as uncached */
    }
  }
  const key = `${wallpaper ?? ''}|${mtime}|${effectiveDark ? 'd' : 'l'}`;
  if (cache?.key === key) return cache.value;

  const degrade = (resolution: AccentResolution): WallpaperAccent => {
    const system = desktopAccent(effectiveDark);
    return system
      ? { hex: system.hex, resolution: { status: 'desktop-accent', name: system.name } }
      : { hex: null, resolution };
  };

  let value: WallpaperAccent;
  if (!wallpaper) {
    value = degrade({ status: 'no-wallpaper' });
  } else {
    const px = await readWallpaperPixels(wallpaper).catch(() => null);
    if (!px) {
      value = degrade({ status: 'decode-failed', path: wallpaper });
    } else {
      const hex = dominantAccentHex(px, effectiveDark);
      value = hex
        ? { hex, resolution: { status: 'wallpaper', path: wallpaper } }
        : degrade({ status: 'low-chroma', path: wallpaper });
    }
  }

  cache = { key, value };
  return value;
}
