import type { BrowserWindow } from 'electron';
import type { BackendManager } from '../backend-manager';
import type { WsClient } from '../ws-client';
import type { Translator } from '../translator';
import type { UnifiedConfigManager } from '../unified-config';
import type { AppSettings } from '../app-settings';
import type { UpdateChecker } from '../updater';

export type BackendRestartOptions = Parameters<BackendManager['restart']>[0];

/** Shared dependencies handed to each IPC registration module. */
export interface IpcContext {
  configDir: string;
  config: UnifiedConfigManager;
  backend: BackendManager;
  ws: WsClient;
  translator: Translator;
  updates: UpdateChecker;
  mainWindow(): BrowserWindow | null;
  overlayWindow(): BrowserWindow | null;
  historyWindow(): BrowserWindow | null;
  safeSend(win: BrowserWindow | null, channel: string, ...args: unknown[]): void;
  appSettings(): AppSettings;
  /** Merge into in-memory settings and persist the same partial to config. */
  updateAppSettings(partial: Partial<AppSettings>): void;
  setLastCaptureSourceId(id: number): void;
  /** Disconnect the backend WS, restart the backend process, reconnect after 2s. */
  restartBackend(opts: BackendRestartOptions): void;
}
