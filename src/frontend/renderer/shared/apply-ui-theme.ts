import type { UiThemePayload } from './types';

export function applyUiThemePayload(payload: UiThemePayload): void {
  document.documentElement.dataset.theme = payload.effectiveMode;
  for (const [k, v] of Object.entries(payload.vars)) {
    document.documentElement.style.setProperty(`--${k}`, v);
  }
}
