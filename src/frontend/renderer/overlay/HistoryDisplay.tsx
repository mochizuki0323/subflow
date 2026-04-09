import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import '../shared/styles/overlay.css';
import { applyUiThemePayload } from '../shared/apply-ui-theme';
import type { SubtitleMode } from '../shared/types';
import { ResizeHandles } from './ResizeHandles';
import { setLang, t } from '../shared/i18n';

const SPEAKER_COLORS = [
  '#7ec8f4', '#f4c97e', '#7ef4a8', '#f47e7e',
  '#c47ef4', '#f4e07e', '#7ef4f4', '#f4a07e',
];

interface HistoryEntry {
  text: string;
  translatedText?: string;
  speaker?: number;
  ts: string;
  partial: boolean;
}

function HistoryDisplay() {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [mode, setMode] = useState<SubtitleMode>('original');
  const [dragMode, setDragMode] = useState(false);
  const [, setI18nTick] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);

  const handleDragBarMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    window.electronAPI.startWindowDrag(e.screenX, e.screenY);
    const onMouseUp = () => {
      window.electronAPI.stopWindowDrag();
      window.removeEventListener('mouseup', onMouseUp);
    };
    window.addEventListener('mouseup', onMouseUp);
  }, []);

  useEffect(() => {
    window.electronAPI.getAppSettings().then((s) => {
      const lang = s.uiLanguage === 'en' ? 'en' : 'zh';
      setLang(lang);
      if (s.subtitleMode === 'original' || s.subtitleMode === 'translated' || s.subtitleMode === 'bilingual') {
        setMode(s.subtitleMode);
      }
      setI18nTick((n) => n + 1);
    });
    window.electronAPI.onUiLanguage((lang) => {
      setLang(lang);
      setI18nTick((n) => n + 1);
    });
    return () => {
      window.electronAPI.removeListeners('ui-language');
    };
  }, []);

  useEffect(() => {
    window.electronAPI.getUiTheme().then(applyUiThemePayload);
    window.electronAPI.onUiTheme(applyUiThemePayload);
  }, []);

  useEffect(() => {
    window.electronAPI.onSubtitle((segment) => {
      if (!segment.text) return;
      const ts = new Date().toLocaleTimeString('zh-CN', {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
      setEntries((prev) => {
        const entry: HistoryEntry = {
          text: segment.text.trim(),
          translatedText: segment.translated_text?.trim(),
          speaker: segment.speaker,
          ts,
          partial: segment.partial,
        };
        const last = prev[prev.length - 1];
        if (last?.partial) return [...prev.slice(0, -1), entry];
        return [...prev.slice(-99), entry];
      });
    });

    window.electronAPI.onSubtitleMode((m) => setMode(m as SubtitleMode));
    window.electronAPI.onDragMode((enabled) => setDragMode(enabled));
  }, []);

  // Auto-scroll to bottom when new entries arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries]);

  const visibleEntries = entries.filter((e) => !e.partial);

  return (
    <div className="history-container" style={{ position: 'relative' }}>
      {dragMode && <ResizeHandles />}
      {dragMode && (
        <div className="drag-bar" onMouseDown={handleDragBarMouseDown}>
          <span className="drag-title">{t('overlay.history')}</span>
          <button
            className="drag-lock-btn"
            onMouseDown={(e) => e.stopPropagation()}
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
              <div key={i} className="history-entry">
                <span className="history-ts">{entry.ts}</span>
                {hasSpeaker && (
                  <span className="subtitle-speaker-label" style={{ color }}>
                    S{entry.speaker! + 1}
                  </span>
                )}
                {(mode === 'original' || mode === 'bilingual' || !entry.translatedText) && (
                  <span className="history-text">{entry.text}</span>
                )}
                {mode === 'translated' && entry.translatedText && (
                  <span className="history-text">{entry.translatedText}</span>
                )}
                {mode === 'bilingual' && entry.translatedText && (
                  <div className="history-translated">{entry.translatedText}</div>
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
