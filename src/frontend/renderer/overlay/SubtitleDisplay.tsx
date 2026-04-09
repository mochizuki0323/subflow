import React, { useState, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import '../shared/styles/overlay.css';
import { applyUiThemePayload } from '../shared/apply-ui-theme';
import type { SubtitleMode } from '../shared/types';
import { ResizeHandles } from './ResizeHandles';
import { setLang, t } from '../shared/i18n';

// Distinct hues for up to 8 speakers; cycles beyond that.
const SPEAKER_COLORS = [
  '#7ec8f4', // 0  blue
  '#f4c97e', // 1  amber
  '#7ef4a8', // 2  green
  '#f47e7e', // 3  red
  '#c47ef4', // 4  purple
  '#f4e07e', // 5  yellow
  '#7ef4f4', // 6  cyan
  '#f4a07e', // 7  orange
];

function speakerColor(speaker: number): string {
  return SPEAKER_COLORS[speaker % SPEAKER_COLORS.length];
}

interface SubtitleLine {
  text: string;
  translatedText?: string;
  speaker?: number;
}

function SubtitleDisplay() {
  const [lines, setLines] = useState<SubtitleLine[]>([]);
  const [mode, setMode] = useState<SubtitleMode>('original');
  const [dragMode, setDragMode] = useState(false);
  const [, setI18nTick] = useState(0);

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
    window.electronAPI.onDragMode((enabled) => setDragMode(enabled));

    window.electronAPI.onSubtitle((segment) => {
      if (!segment.text || segment.text.trim().length === 0) return;

      setLines((prev) => {
        const text = segment.text.trim();
        const translatedText = segment.translated_text?.trim() || '';
        const speaker = segment.speaker;

        // Avoid duplicating the same line from the same speaker
        const last = prev[prev.length - 1];
        if (last && last.text === text && last.speaker === speaker) return prev;

        const next = [...prev, { text, translatedText, speaker }];
        // Keep last 3 lines visible
        return next.slice(-3);
      });
    });

    // Listen for subtitle mode changes from control panel
    window.electronAPI.onSubtitleMode((m: string) => {
      setMode(m as SubtitleMode);
    });
  }, []);

  // Auto-clear old subtitles after 8 seconds of no new input
  useEffect(() => {
    if (lines.length === 0) return;
    const timer = setTimeout(() => setLines([]), 8000);
    return () => clearTimeout(timer);
  }, [lines]);

  return (
    <div className="subtitle-container" style={{ position: 'relative' }}>
      {dragMode && <ResizeHandles />}
      {dragMode && (
        <div className="drag-bar" onMouseDown={handleDragBarMouseDown}>
          <span className="drag-title">{t('overlay.subtitle')}</span>
          <button
            className="drag-lock-btn"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => window.electronAPI.exitDragMode()}
          >
            {t('overlay.lock')}
          </button>
        </div>
      )}
      <div className="subtitle-lines">
      {lines.map((line, i) => {
        const hasSpeaker = line.speaker !== undefined && line.speaker >= 0;
        const color = hasSpeaker ? speakerColor(line.speaker!) : undefined;
        const label = hasSpeaker ? `S${line.speaker! + 1}` : undefined;
        return (
          <div key={`${i}-${line.text.slice(0, 20)}`} className="subtitle-group">
            {(mode === 'original' || mode === 'bilingual') && (
              <div className="subtitle-line subtitle-original">
                {label && (
                  <span className="subtitle-speaker-label" style={{ color }}>
                    {label}
                  </span>
                )}
                {line.text}
              </div>
            )}
            {(mode === 'translated' || mode === 'bilingual') && line.translatedText && (
              <div className="subtitle-line subtitle-translated">
                {label && (
                  <span className="subtitle-speaker-label" style={{ color }}>
                    {label}
                  </span>
                )}
                {line.translatedText}
              </div>
            )}
            {mode === 'translated' && !line.translatedText && (
              <div className="subtitle-line subtitle-original">
                {label && (
                  <span className="subtitle-speaker-label" style={{ color }}>
                    {label}
                  </span>
                )}
                {line.text}
              </div>
            )}
          </div>
        );
      })}
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<SubtitleDisplay />);
