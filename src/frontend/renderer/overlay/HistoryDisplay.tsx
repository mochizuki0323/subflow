import React, { useState, useEffect, useRef } from 'react';
import { useDragBarPointerDown } from './useWindowDrag';
import { createRoot } from 'react-dom/client';
import '../shared/styles/overlay.css';
import { applyUiThemePayload } from '../shared/apply-ui-theme';
import type { SubtitleMode, TranscriptEntry } from '../shared/types';
import { ResizeHandles } from './ResizeHandles';
import { setLang, t } from '../shared/i18n';

const SPEAKER_COLORS = [
  '#7ec8f4', '#f4c97e', '#7ef4a8', '#f47e7e',
  '#c47ef4', '#f4e07e', '#7ef4f4', '#f4a07e',
];



function HistoryDisplay() {
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [mode, setMode] = useState<SubtitleMode>('original');
  const [showPartials, setShowPartials] = useState(false);
  const [dragMode, setDragMode] = useState(false);
  const handleDragBarPointerDown = useDragBarPointerDown();
  const [, setI18nTick] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.electronAPI.getAppSettings().then((s) => {
      const lang = s.uiLanguage === 'en' ? 'en' : 'zh';
      setLang(lang);
      if (s.subtitleMode === 'original' || s.subtitleMode === 'translated' || s.subtitleMode === 'bilingual') {
        setMode(s.subtitleMode);
      }
      setShowPartials(!!s.showPartials);
      setI18nTick((n) => n + 1);
    });
    window.electronAPI.onUiLanguage((lang) => {
      setLang(lang);
      setI18nTick((n) => n + 1);
    });
    window.electronAPI.onShowPartials((show) => setShowPartials(show));
    return () => {
      window.electronAPI.removeListeners('ui-language');
      window.electronAPI.removeListeners('show-partials');
    };
  }, []);

  useEffect(() => {
    window.electronAPI.getUiTheme().then(applyUiThemePayload);
    window.electronAPI.onUiTheme(applyUiThemePayload);
  }, []);

  useEffect(() => {
    // Seeded from the main process's record, so this window and the control panel's
    // history tab can no longer drift apart in content, length or partial handling.
    window.electronAPI.getTranscriptLog().then(setEntries);
    window.electronAPI.onTranscriptCleared(() => setEntries([]));
    window.electronAPI.onSubtitle((segment) => {
      if (!segment.text) return;
      setEntries((prev) => {
        const entry: TranscriptEntry = {
          text: segment.text.trim(),
          translated: segment.translated_text?.trim() || undefined,
          speaker: segment.speaker,
          partial: !!segment.partial,
          t0: segment.t0 ?? 0,
          t1: segment.t1 ?? 0,
          at: Date.now(),
        };
        const last = prev[prev.length - 1];
        if (last?.partial) return [...prev.slice(0, -1), entry];
        return [...prev.slice(-1999), entry];
      });
    });

    window.electronAPI.onSubtitleMode((m) => setMode(m as SubtitleMode));
    window.electronAPI.onDragMode((enabled) => setDragMode(enabled));
  }, []);

  // Auto-scroll to bottom when new entries arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries]);

  const visibleEntries = showPartials ? entries : entries.filter((e) => !e.partial);

  return (
    <div className="history-container" style={{ position: 'relative' }}>
      {dragMode && <ResizeHandles />}
      {dragMode && (
        <div className="drag-bar" onPointerDown={handleDragBarPointerDown}>
          <span className="drag-title">{t('overlay.history')}</span>
          <button
            className="drag-lock-btn"
            onClick={() => window.electronAPI.exitDragMode()}
          >
            {t('overlay.lock')}
          </button>
        </div>
      )}
      <div className="history-scroll">
        {visibleEntries.length === 0 ? (
          <div className="history-empty">{t('overlay.noHistory')}</div>
        ) : (
          visibleEntries.map((entry, i) => {
            const hasSpeaker = entry.speaker !== undefined && entry.speaker >= 0;
            const color = hasSpeaker ? SPEAKER_COLORS[entry.speaker! % SPEAKER_COLORS.length] : undefined;
            return (
              <div key={i} className="history-entry" style={entry.partial ? { opacity: 0.5 } : undefined}>
                <span className="history-ts">{new Date(entry.at).toTimeString().slice(0, 8)}</span>
                {hasSpeaker && (
                  <span className="subtitle-speaker-label" style={{ color }}>
                    S{entry.speaker! + 1}
                  </span>
                )}
                {(mode === 'original' || mode === 'bilingual' || !entry.translated) && (
                  <span className="history-text">{entry.text}</span>
                )}
                {mode === 'translated' && entry.translated && (
                  <span className="history-text">{entry.translated}</span>
                )}
                {mode === 'bilingual' && entry.translated && (
                  <div className="history-translated">{entry.translated}</div>
                )}
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<HistoryDisplay />);
