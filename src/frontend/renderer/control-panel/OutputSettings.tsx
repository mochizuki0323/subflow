import React from 'react';
import type { SubtitleMode } from '../shared/types';
import { t } from '../shared/i18n';

interface Props {
  overlayVisible: boolean;
  onToggleOverlay: (visible: boolean) => void;
  historyVisible: boolean;
  onToggleHistory: (visible: boolean) => void;
  showPartials: boolean;
  onToggleShowPartials: (show: boolean) => void;
  dragMode: boolean;
  onToggleDragMode: (active: boolean) => void;
  subtitleMode: SubtitleMode;
  onSubtitleModeChange: (mode: SubtitleMode) => void;
  translatorEnabled: boolean;
}

const MODES: Array<{ value: SubtitleMode; labelKey: string; descKey: string }> = [
  { value: 'original', labelKey: 'lang.mode.original', descKey: 'lang.mode.original.desc' },
  { value: 'translated', labelKey: 'lang.mode.translated', descKey: 'lang.mode.translated.desc' },
  { value: 'bilingual', labelKey: 'lang.mode.bilingual', descKey: 'lang.mode.bilingual.desc' },
];

/**
 * Output is the last stage of the chain. Its controls used to live at the bottom of
 * the Sources page, which owns none of them, and its display mode lived on the
 * Translation page — so nothing in the app ever presented "what comes out" as one
 * thing. This page is that thing.
 */
export function OutputSettings({
  overlayVisible,
  onToggleOverlay,
  historyVisible,
  onToggleHistory,
  showPartials,
  onToggleShowPartials,
  dragMode,
  onToggleDragMode,
  subtitleMode,
  onSubtitleModeChange,
  translatorEnabled,
}: Props) {
  const handleToggleOverlay = async () => onToggleOverlay(await window.electronAPI.toggleOverlay());
  const handleToggleHistory = async () => onToggleHistory(await window.electronAPI.toggleHistory());
  const handleToggleDragMode = async () => onToggleDragMode(await window.electronAPI.toggleDragMode());

  const row = (
    labelKey: string,
    descKey: string,
    checked: boolean,
    onChange: () => void,
  ) => (
    <div className="toggle-row" onClick={onChange}>
      <div>
        <div className="toggle-label">{t(labelKey as any)}</div>
        <div className="toggle-desc">{t(descKey as any)}</div>
      </div>
      <label className="switch" onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={checked} onChange={onChange} />
        <span className="switch-slider" />
      </label>
    </div>
  );

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>{t('out.title')}</h2>
      </div>

      <div className="section">
        <div className="block-key">{t('out.windows')}</div>
        {row('out.overlay', 'out.overlay.desc', overlayVisible, handleToggleOverlay)}
        {row('out.history', 'out.history.desc', historyVisible, handleToggleHistory)}
      </div>

      <div className="section">
        <div className="block-key">{t('out.content')}</div>
        <div className="form-group">
          <label>{t('lang.subtitleMode')}</label>
          <div className="radio-group">
            {MODES.map(({ value, labelKey }) => (
              <label
                key={value}
                className={subtitleMode === value ? 'active' : ''}
                onClick={() => onSubtitleModeChange(value)}
              >
                <span>{t(labelKey as any)}</span>
              </label>
            ))}
          </div>
          <p className="hint">
            {t((MODES.find((m) => m.value === subtitleMode) ?? MODES[0]).descKey as any)}
          </p>
          {/* Naming the missing piece beats letting the user pick a mode that can
              never render anything. */}
          {!translatorEnabled && subtitleMode !== 'original' && (
            <p className="hint" style={{ color: 'var(--fault)' }}>{t('out.needsTranslator')}</p>
          )}
        </div>
        {row('out.partials', 'out.partials.desc', showPartials, () => onToggleShowPartials(!showPartials))}
      </div>

      <div className="section">
        <div className="block-key">{t('out.placement')}</div>
        <p className="hint" style={{ marginBottom: 8 }}>{t('source.dragMode.title')}</p>
        <button
          type="button"
          onClick={handleToggleDragMode}
          className={dragMode ? 'btn-overlay-on' : 'btn-secondary'}
        >
          {dragMode ? t('out.placement.exit') : t('out.placement.enter')}
        </button>
      </div>
    </div>
  );
}
