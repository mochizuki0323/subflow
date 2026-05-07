import React, { useState, useEffect, useRef } from 'react';
import { SourceSelector } from './SourceSelector';
import { ModelManager } from './ModelManager';
import { DenoiserSettings } from './DenoiserSettings';
import { LanguageSettings } from './LanguageSettings';
import { LogViewer } from './LogViewer';
import { applyUiThemePayload } from '../shared/apply-ui-theme';
import { setLang, t } from '../shared/i18n';
import type {
  AudioSource,
  BackendStatus,
  LogEntry,
  TranscriptSegment,
  AppearanceMode,
  AccentSource,
  SubtitleMode,
  UiLanguage,
  UiThemePayload,
} from '../shared/types';

type Tab = 'sources' | 'deepgram' | 'denoise' | 'language' | 'history' | 'logs' | 'about';

const STATUS_KEY: Record<string, string> = {
  idle: 'status.idle',
  running: 'status.running',
  capturing: 'status.capturing',
};

const TAB_META: Record<Tab, { titleKey: string; navKey: string; icon: string }> = {
  sources: { titleKey: 'tab.sources', navKey: 'tab.sources.nav', icon: '◆' },
  deepgram: { titleKey: 'tab.deepgram', navKey: 'tab.deepgram.nav', icon: '◎' },
  denoise: { titleKey: 'tab.denoise', navKey: 'tab.denoise.nav', icon: '◈' },
  language: { titleKey: 'tab.language', navKey: 'tab.language.nav', icon: '◇' },
  history: { titleKey: 'tab.history', navKey: 'tab.history.nav', icon: '☰' },
  logs: { titleKey: 'tab.logs', navKey: 'tab.logs.nav', icon: '※' },
  about: { titleKey: 'tab.about', navKey: 'tab.about.nav', icon: 'ⓘ' },
};

export function App() {
  const [tab, setTab] = useState<Tab>('sources');
  const [sources, setSources] = useState<AudioSource[]>([]);
  const [status, setStatus] = useState<BackendStatus | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [subtitleMode, setSubtitleMode] = useState<SubtitleMode>('original');
  const [overlayVisible, setOverlayVisible] = useState(false);
  const [historyVisible, setHistoryVisible] = useState(false);
  const [dragMode, setDragMode] = useState(false);
  const [deepgramConnected, setDeepgramConnected] = useState(false);
  const [sttProvider, setSttProvider] = useState<string>('deepgram');
  const [history, setHistory] = useState<Array<{ text: string; translated?: string; speaker?: number; ts: string; partial: boolean }>>([]);
  const historyRef = useRef<HTMLDivElement>(null);
  const [themeInfo, setThemeInfo] = useState<UiThemePayload | null>(null);
  const [uiLang, setUiLang] = useState<UiLanguage>('zh');
  const [localAppearance, setLocalAppearance] = useState<AppearanceMode>('system');
  const [localAccentSource, setLocalAccentSource] = useState<AccentSource>('default');
  const [localUiLang, setLocalUiLang] = useState<UiLanguage>('zh');

  useEffect(() => {
    window.electronAPI.getSttProvider().then(setSttProvider);
  }, []);

  useEffect(() => {
    window.electronAPI.getAppSettings().then((s) => {
      const lang: UiLanguage = s.uiLanguage === 'en' ? 'en' : 'zh';
      setLang(lang);
      setUiLang(lang);
      setLocalUiLang(lang);
      if (s.subtitleMode === 'original' || s.subtitleMode === 'translated' || s.subtitleMode === 'bilingual') {
        setSubtitleMode(s.subtitleMode);
      }
    });
    window.electronAPI.onUiLanguage((lang) => {
      setLang(lang);
      setUiLang(lang);
      setLocalUiLang(lang);
    });
  }, []);

  useEffect(() => {
    window.electronAPI.getUiTheme().then((payload) => {
      applyUiThemePayload(payload);
      setThemeInfo(payload);
      setLocalAppearance(payload.appearance);
      setLocalAccentSource(payload.accentSource);
    });
    window.electronAPI.onUiTheme((payload) => {
      applyUiThemePayload(payload);
      setThemeInfo(payload);
    });
  }, []);

  useEffect(() => {
    window.electronAPI.onSubtitle((data: TranscriptSegment) => {
      if (!data.text) return;
      const ts = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      setHistory((prev) => {
        const last = prev[prev.length - 1];
        const entry = { text: data.text, translated: data.translated_text, speaker: data.speaker, ts, partial: data.partial };
        if (last?.partial) {
          return [...prev.slice(0, -1), entry];
        }
        return [...prev.slice(-199), entry];
      });
    });

    window.electronAPI.onSources((data) => {
      setSources(Array.isArray(data) ? data : []);
    });

    window.electronAPI.onStatus((data) => {
      setStatus(data);
      setDeepgramConnected(!!data?.model_loaded);
    });

    window.electronAPI.onLog((data) => {
      setLogs((prev) => [...prev.slice(-500), { ...data, timestamp: new Date().toISOString() }]);
    });

    window.electronAPI.onModelLoaded(() => {
      setDeepgramConnected(true);
    });

    window.electronAPI.onDragMode((enabled) => setDragMode(enabled));

    window.electronAPI.onTranslatorError((error) => {
      setLogs((prev) => [...prev.slice(-500), {
        level: 'error',
        message: `${t('log.translation')} ${error}`,
        timestamp: new Date().toISOString(),
      }]);
    });

    window.electronAPI.listSources();
  }, []);

  useEffect(() => {
    if (tab === 'history' && historyRef.current) {
      historyRef.current.scrollTop = historyRef.current.scrollHeight;
    }
  }, [history, tab]);

  const errorCount = logs.filter((l) => l.level === 'error').length;

  const setAppearance = async (appearance: AppearanceMode) => {
    setLocalAppearance(appearance);
    const payload = await window.electronAPI.setUiTheme({ appearance });
    applyUiThemePayload(payload);
    setThemeInfo(payload);
  };

  const setAccentSource = async (accentSource: AccentSource) => {
    setLocalAccentSource(accentSource);
    const payload = await window.electronAPI.setUiTheme({ accentSource });
    applyUiThemePayload(payload);
    setThemeInfo(payload);
  };

  const refreshWallpaper = async () => {
    const payload = await window.electronAPI.refreshWallpaperColors();
    applyUiThemePayload(payload);
    setThemeInfo(payload);
  };

  const changeUiLanguage = async (lang: UiLanguage) => {
    setLang(lang);
    setLocalUiLang(lang);
    setUiLang(lang);
    await window.electronAPI.setUiLanguage(lang);
  };

  const [appVersion, setAppVersion] = useState('');

  useEffect(() => {
    window.electronAPI.getAppVersion().then(setAppVersion);
  }, []);

  const tabs: Tab[] = ['sources', 'deepgram', 'denoise', 'language', 'history', 'logs', 'about'];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <img src={new URL('../../../../resources/icon.svg', import.meta.url).href} alt="SubFlow" style={{ width: 96, height: 96, flexShrink: 0 }} />
            <div className="sidebar-brand-title">SubFlow</div>
          </div>
        </div>
        <nav className="sidebar-nav" aria-label={t('nav.label')}>
          {tabs.map((id) => (
            <button
              key={id}
              type="button"
              className={`nav-item ${tab === id ? 'active' : ''}`}
              onClick={() => setTab(id)}
            >
              <span className="nav-icon" aria-hidden>{TAB_META[id].icon}</span>
              <span>{t(TAB_META[id].navKey as any)}</span>
              {id === 'history' && history.length > 0 && (
                <span className="badge" style={{ marginLeft: 'auto', fontSize: 10 }}>
                  {history.filter((h) => !h.partial).length}
                </span>
              )}
              {id === 'logs' && errorCount > 0 && (
                <span className="error-count" style={{ marginLeft: 'auto' }}>{errorCount}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-theme">
          <div className="theme-label">{t('ui.interfaceLanguage')}</div>
          <div className="segmented-inline" style={{ marginBottom: 12 }}>
            <button
              type="button"
              className={`segment-btn ${localUiLang === 'zh' ? 'active' : ''}`}
              onClick={() => changeUiLanguage('zh')}
            >
              中文
            </button>
            <button
              type="button"
              className={`segment-btn ${localUiLang === 'en' ? 'active' : ''}`}
              onClick={() => changeUiLanguage('en')}
            >
              English
            </button>
          </div>
          <div className="theme-label">{t('theme.appearance')}</div>
          <div className="segmented">
            <div className="segmented-inline">
              {(['light', 'dark', 'system'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`segment-btn ${localAppearance === m ? 'active' : ''}`}
                  onClick={() => setAppearance(m)}
                >
                  {t(`theme.${m}` as any)}
                </button>
              ))}
            </div>
          </div>
          <div className="theme-label">{t('theme.accent')}</div>
          <div className="segmented-inline">
            <button
              type="button"
              className={`segment-btn ${localAccentSource === 'default' ? 'active' : ''}`}
              onClick={() => setAccentSource('default')}
            >
              {t('theme.default')}
            </button>
            <button
              type="button"
              className={`segment-btn ${localAccentSource === 'wallpaper' ? 'active' : ''}`}
              onClick={() => setAccentSource('wallpaper')}
              title={t('theme.wallpaper.title')}
            >
              {t('theme.wallpaper')}
            </button>
          </div>
          <button
            type="button"
            className="btn-refresh-wal"
            onClick={refreshWallpaper}
            title={t('theme.refreshWallpaper.title')}
          >
            {t('theme.refreshWallpaper')}
          </button>
        </div>
      </aside>

      <div className="main-column">
        <header className="main-header">
          <div className="main-header-title">{t(TAB_META[tab].titleKey as any)}</div>
          <div className="status-bar">
            {status ? (
              <>
                <span className={`status-dot ${status.state}`} />
                <span className="status-text">{t((STATUS_KEY[status.state] || status.state) as any)}</span>
                {deepgramConnected ? (
                  <span className="badge badge-success" title={
                    sttProvider === 'parakeet' ? t('parakeet.connected.title')
                    : sttProvider === 'gladia' ? t('gladia.connected.title')
                    : t('deepgram.connected.title')
                  }>
                    {sttProvider === 'parakeet' ? t('parakeet.connected')
                    : sttProvider === 'gladia' ? t('gladia.connected')
                    : t('deepgram.connected')}
                  </span>
                ) : (
                  <span className="badge" title={t('deepgram.disconnected.title')}>{t('deepgram.disconnected')}</span>
                )}
              </>
            ) : (
              <span className="status-text">{t('status.connecting')}</span>
            )}
          </div>
        </header>

        <main className="content-card tab-content">
          {tab === 'sources' && (
            <SourceSelector
              sources={sources}
              status={status}
              overlayVisible={overlayVisible}
              onToggleOverlay={setOverlayVisible}
              historyVisible={historyVisible}
              onToggleHistory={setHistoryVisible}
              dragMode={dragMode}
              onToggleDragMode={setDragMode}
            />
          )}
          {tab === 'deepgram' && <ModelManager onProviderChange={setSttProvider} />}
          {tab === 'denoise' && <DenoiserSettings />}
          {tab === 'language' && (
            <LanguageSettings
              status={status}
              subtitleMode={subtitleMode}
              onSubtitleModeChange={setSubtitleMode}
            />
          )}
          {tab === 'history' && (
            <div className="panel" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <h2 style={{ margin: 0 }}>{t('history.title')}</h2>
                <button type="button" className="btn-secondary btn-sm" onClick={() => setHistory([])}>{t('history.clear')}</button>
              </div>
              {history.length === 0 ? (
                <p className="hint">{t('history.empty')}</p>
              ) : (
                <div
                  ref={historyRef}
                  style={{ flex: 1, overflowY: 'auto', fontFamily: 'ui-monospace, monospace', fontSize: 13, lineHeight: 1.6 }}
                >
                  {history.map((item, i) => {
                    const SPEAKER_COLORS = ['#4a9eda', '#d4a017', '#2eaa5c', '#d94f4f', '#9b59b6', '#c8a800', '#17a2b8', '#e07a2a'];
                    const hasSpeaker = item.speaker !== undefined && item.speaker >= 0;
                    const speakerColor = hasSpeaker ? SPEAKER_COLORS[item.speaker! % SPEAKER_COLORS.length] : undefined;
                    return (
                      <div key={i} style={{ marginBottom: 6, opacity: item.partial ? 0.5 : 1 }}>
                        <span style={{ color: 'var(--text-muted)', fontSize: 11, marginRight: 8 }}>{item.ts}</span>
                        {hasSpeaker && (
                          <span style={{ color: speakerColor, fontWeight: 700, fontSize: 11, marginRight: 6 }}>
                            S{item.speaker! + 1}
                          </span>
                        )}
                        {item.partial && <span style={{ color: 'var(--warning)', fontSize: 10, marginRight: 6 }}>{t('history.partial')}</span>}
                        <span>{item.text}</span>
                        {item.translated && (
                          <div style={{ paddingLeft: 60, color: 'var(--text-secondary)', fontSize: 12 }}>
                            {item.translated}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {tab === 'logs' && <LogViewer logs={logs} onClear={() => setLogs([])} />}
          {tab === 'about' && (
            <div className="panel">
              <h2>{t('about.title')}</h2>
              <div className="form-row" style={{ marginTop: 16 }}>
                <label>{t('about.version')}</label>
                <span style={{ fontSize: 14, fontWeight: 600 }}>v{appVersion}</span>
              </div>
              <div className="form-row">
                <label>{t('about.project')}</label>
                <a
                  href="#"
                  onClick={(e) => { e.preventDefault(); window.electronAPI.openExternal('https://github.com/mochizuki0323/subflow'); }}
                  style={{ fontSize: 14 }}
                >
                  github.com/mochizuki0323/subflow
                </a>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
