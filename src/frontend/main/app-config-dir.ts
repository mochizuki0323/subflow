import path from 'path';
import fs from 'fs';
import { app } from 'electron';

/** Config file names migrated from legacy userData (excludes app-settings.json which is new) */
const LEGACY_CONFIG_FILES = [
  'translator-config.json',
  'window-positions.json',
  'ui-preferences.json',
] as const;

/** Packaged Linux: also migrate app-settings.json from next-to-exec layout */
const LINUX_EXEC_MIGRATE_FILES = [...LEGACY_CONFIG_FILES, 'app-settings.json'] as const;

/**
 * Directory for JSON config files.
 * Dev: repository root.
 * Packaged Windows: directory of the executable (portable-friendly).
 * Packaged Linux: $XDG_CONFIG_HOME/subflow_settings (default ~/.config/subflow_settings).
 * Packaged macOS: userData (app bundle directory is usually read-only).
 */
export function getAppConfigDir(): string {
  if (!app.isPackaged) {
    return path.join(__dirname, '../..');
  }
  if (process.platform === 'darwin') {
    return app.getPath('userData');
  }
  if (process.platform === 'linux') {
    const xdg =
      process.env.XDG_CONFIG_HOME?.trim() || path.join(app.getPath('home'), '.config');
    return path.join(xdg, 'subflow_settings');
  }
  return path.dirname(process.execPath);
}

export function ensureConfigDirExists(configDir: string): void {
  try {
    fs.mkdirSync(configDir, { recursive: true });
  } catch (err) {
    console.error('Failed to create config directory:', err);
  }
}

/** Packaged Linux only: copy JSON configs from next to executable if new XDG dir has no file yet. */
export function migrateConfigsFromLinuxExecDir(configDir: string): void {
  if (!app.isPackaged || process.platform !== 'linux') return;
  const oldDir = path.dirname(process.execPath);
  if (path.resolve(oldDir) === path.resolve(configDir)) return;

  for (const name of LINUX_EXEC_MIGRATE_FILES) {
    const oldPath = path.join(oldDir, name);
    const newPath = path.join(configDir, name);
    try {
      if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
        fs.copyFileSync(oldPath, newPath);
      }
    } catch (err) {
      console.warn(`Config migration skipped for ${name}:`, err);
    }
  }
}

/** If the new config dir differs from legacy userData and no file exists at the new path, copy from userData. */
export function migrateConfigsFromUserData(configDir: string): void {
  if (!app.isPackaged) return;
  const oldDir = app.getPath('userData');
  if (path.resolve(oldDir) === path.resolve(configDir)) return;

  for (const name of LEGACY_CONFIG_FILES) {
    const oldPath = path.join(oldDir, name);
    const newPath = path.join(configDir, name);
    try {
      if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
        fs.copyFileSync(oldPath, newPath);
      }
    } catch (err) {
      console.warn(`Config migration skipped for ${name}:`, err);
    }
  }
}
