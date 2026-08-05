import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import '../shared/styles/overlay.css';
import { applyUiThemePayload } from '../shared/apply-ui-theme';
import type { SubtitleMode } from '../shared/types';
import { ResizeHandles } from './ResizeHandles';
import { useDragBarPointerDown } from './useWindowGesture';
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
  partial?: boolean;
}

function SubtitleDisplay() {
  const [lines, setLines] = useState<SubtitleLine[]>([]);
  const [mode, setMode] = useState<SubtitleMode>('original');
  const [showPartials, setShowPartials] = useState(false);
  const [dragMode, setDragMode] = useState(false);
  const handleDragBarPointerDown = useDragBarPointerDown();
  const [, setI18nTick] = useState(0);
  const tickRef = useRef<HTMLSpanElement>(null);

  // The tick is written straight to the DOM: a level event should never cost a render
  // in the window the user is actually watching.
  useEffect(() => {
    window.electronAPI.onAudioLevel(({ level }) => {
      const el = tickRef.current;
      if (!el) return;
      const v = Math.min(1, level / 0.3);
      el.style.transform = `scale(${(0.6 + v * 2.2).toFixed(2)})`;
      el.style.opacity = (0.35 + v * 0.65).toFixed(2);
    });
    return () => window.electronAPI.removeListeners('audio_level');
  }, []);

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
    window.electronAPI.onDragMode((enabled) => setDragMode(enabled));

    window.electronAPI.onSubtitle((segment) => {
      if (!segment.text || segment.text.trim().length === 0) return;

      setLines((prev) => {
        const text = segment.text.trim();
        const translatedText = segment.translated_text?.trim() || '';
        const speaker = segment.speaker;
        const partial = !!segment.partial;
        const line: SubtitleLine = { text, translatedText, speaker, partial };

        // Avoid duplicating the same line from the same speaker
        const last = prev[prev.length - 1];
        if (last && last.text === text && last.speaker === speaker) return prev;

        // Replace previous partial with current segment (partial or final)
        if (last?.partial) return [...prev.slice(0, -1), line].slice(-3);

        return [...prev, line].slice(-3);
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

  const visible = lines.filter((l) => showPartials || !l.partial);

  return (
    <div className="subtitle-container">
      {dragMode && <ResizeHandles />}
      {dragMode && (
        <div className="drag-bar" onPointerDown={handleDragBarPointerDown}>
          <span className="drag-title">{t('overlay.subtitle')}</span>
          <button
            className="drag-lock-btn"
            onClick={() => window.electronAPI.exitDragMode()}
          >
            {t('overlay.lock')}
          </button>
        </div>
      )}
      {/* No speech, no scrim: an empty overlay should be nothing at all. */}
      {(visible.length > 0 || dragMode) && (
        <div className="subtitle-lines">
          <span className="subtitle-tick" ref={tickRef} aria-hidden />
          {visible.map((line, i) => {
            const hasSpeaker = line.speaker !== undefined && line.speaker >= 0;
            const color = hasSpeaker ? speakerColor(line.speaker!) : undefined;
            const label = hasSpeaker ? `S${line.speaker! + 1}` : undefined;
            const isLast = i === visible.length - 1;
            const speakerTag = label && (
              <span className="subtitle-speaker-label" style={{ color }}>
                {label}
              </span>
            );
            return (
              <div
                key={`${i}-${line.text.slice(0, 20)}`}
                className={`subtitle-group ${line.partial ? 'interim' : 'settled'}`}
              >
                {(mode === 'original' || mode === 'bilingual' || !line.translatedText) && (
                  <div className="subtitle-line subtitle-original">
                    {speakerTag}
                    {line.text}
                    {/* the caret marks text the recogniser has not committed to yet */}
                    {line.partial && isLast && <span className="subtitle-caret" aria-hidden />}
                  </div>
                )}
                {(mode === 'translated' || mode === 'bilingual') && line.translatedText && (
                  <div className="subtitle-line subtitle-translated">
                    {mode === 'translated' && speakerTag}
                    {line.translatedText}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<SubtitleDisplay />);
