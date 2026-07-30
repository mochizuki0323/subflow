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

const ACCENT_STATUS_KEY: Record<string, string> = {
  wallpaper: 'theme.accentFrom.wallpaper',
  'desktop-accent': 'theme.accentFrom.desktopAccent',
  'no-wallpaper': 'theme.accentFrom.noWallpaper',
  'decode-failed': 'theme.accentFrom.decodeFailed',
  'low-chroma': 'theme.accentFrom.lowChroma',
};

const STATUS_KEY: Record<string, string> = {
  idle: 'status.idle',
  running: 'status.running',
  capturing: 'status.capturing',
};

const TAB_META: Record<Tab, { titleKey: string; navKey: string }> = {
  sources: { titleKey: 'tab.sources', navKey: 'tab.sources.nav' },
  deepgram: { titleKey: 'tab.deepgram', navKey: 'tab.deepgram.nav' },
  denoise: { titleKey: 'tab.denoise', navKey: 'tab.denoise.nav' },
  language: { titleKey: 'tab.language', navKey: 'tab.language.nav' },
  history: { titleKey: 'tab.history', navKey: 'tab.history.nav' },
  logs: { titleKey: 'tab.logs', navKey: 'tab.logs.nav' },
  about: { titleKey: 'tab.about', navKey: 'tab.about.nav' },
};

/**
 * These four are not categories, they are the stages audio actually passes through,
 * in order — which is why they are numbered and drawn on a bus. The rest are tools
 * and get no number, because they are not part of any sequence.
 */
const PIPELINE: Tab[] = ['sources', 'denoise', 'deepgram', 'language'];
const TOOLS: Tab[] = ['history', 'logs', 'about'];

const SCOPE_BARS = 150;
const dbLabel = (v: number) => (v <= 0.0005 ? '—' : `${(20 * Math.log10(v)).toFixed(1)}`);

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
  const [audioLevel, setAudioLevel] = useState(0);
  const [peak, setPeak] = useState(0);
  const [denoiser, setDenoiser] = useState<{ enabled: boolean; modelId: string } | null>(null);
  const [translator, setTranslator] = useState<{ enabled: boolean; apiKey: string; targetLanguage: string; apiFormat: string } | null>(null);
  const scopeRef = useRef<HTMLDivElement>(null);
  const barsRef = useRef<HTMLElement[]>([]);
  const traceRef = useRef<number[]>(new Array(SCOPE_BARS).fill(0));
  const [uiLang, setUiLang] = useState<UiLanguage>('zh');
  const [localAppearance, setLocalAppearance] = useState<AppearanceMode>('system');
  const [localAccentSource, setLocalAccentSource] = useState<AccentSource>('default');
  const [localUiLang, setLocalUiLang] = useState<UiLanguage>('zh');
  const [showPartials, setShowPartials] = useState(false);

  useEffect(() => {
    window.electronAPI.getSttProvider().then(setSttProvider);
  }, []);

  useEffect(() => {
    window.electronAPI.getAppSettings().then((s) => {
      const lang: UiLanguage = s.uiLanguage === 'en' ? 'en' : 'zh';
      setLang(lang);
      setUiLang(lang);
      setLocalUiLang(lang);
      setShowPartials(!!s.showPartials);
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

  const capturing = status?.state === 'capturing';

  /** Repaints the scope imperatively — pushing 150 nodes through React on every audio
   *  frame would cost far more than the trace is worth. */
  const paintScope = () => {
    const bars = barsRef.current;
    const trace = traceRef.current;
    for (let i = 0; i < bars.length; i++) {
      const height = 1 + Math.min(1, trace[i] / 0.3) * 46;
      bars[i].style.height = `${height.toFixed(1)}px`;
      // Colour marks recency, not amplitude: only the live edge is warm, and the
      // trace behind it decays like phosphor.
      if (i > bars.length - 4) {
        bars[i].style.background = 'var(--accent)';
        bars[i].style.opacity = '1';
      } else {
        bars[i].style.background = 'var(--text-secondary)';
        bars[i].style.opacity = (0.1 + 0.9 * (i / bars.length) ** 3).toFixed(3);
      }
    }
  };

  useEffect(() => {
    const el = scopeRef.current;
    if (!el) return;
    el.replaceChildren();
    barsRef.current = Array.from({ length: SCOPE_BARS }, () => {
      const bar = document.createElement('i');
      el.appendChild(bar);
      return bar;
    });
    paintScope();
  }, []);

  useEffect(() => {
    window.electronAPI.removeListeners('audio_level');
    window.electronAPI.onAudioLevel(({ level }) => {
      setAudioLevel(level);
      setPeak((prev) => Math.max(prev * 0.985, level));
      const trace = traceRef.current;
      trace.push(level);
      trace.shift();
      paintScope();
    });
    return () => window.electronAPI.removeListeners('audio_level');
  }, []);

  // Stopping drains the trace instead of blanking it, so the signal is seen to leave.
  useEffect(() => {
    if (capturing) return;
    setPeak(0);
    const drain = setInterval(() => {
      const trace = traceRef.current;
      trace.push(0);
      trace.shift();
      paintScope();
    }, 40);
    const done = setTimeout(() => clearInterval(drain), SCOPE_BARS * 40 + 200);
    return () => {
      clearInterval(drain);
      clearTimeout(done);
    };
  }, [capturing]);

  // The settings tabs own these; poll so the rail keeps telling the truth about the
  // chain without threading a change event through every one of them.
  useEffect(() => {
    const load = () => {
      window.electronAPI.getDenoiserConfig().then((c) =>
        setDenoiser({ enabled: !!c.enabled, modelId: c.modelId }),
      );
      window.electronAPI.getTranslatorConfig().then((c) =>
        setTranslator({
          enabled: !!c.enabled,
          apiKey: c.apiKey,
          targetLanguage: c.targetLanguage,
          apiFormat: c.apiFormat,
        }),
      );
    };
    load();
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, []);

  const errorCount = logs.filter((l) => l.level === 'error').length;
  const finalCount = history.filter((h) => !h.partial).length;
  const latest = history[history.length - 1];

  /** What a pipeline stage is currently doing, and whether the signal reaches it. */
  const stageInfo = (id: Tab): { cls: string; state: string } => {
    switch (id) {
      case 'sources': {
        const name = status?.capture_source_name;
        if (!name) return { cls: 'off', state: t('rail.noSource') };
        return { cls: capturing ? 'done armed' : 'done', state: name };
      }
      case 'denoise':
        return denoiser?.enabled
          ? { cls: 'done', state: denoiser.modelId }
          : { cls: 'off', state: t('rail.off') };
      case 'deepgram': {
        const label = `${sttProvider}${status?.language ? ` · ${status.language}` : ''}`;
        if (!deepgramConnected) return { cls: 'pending', state: label };
        return { cls: capturing ? 'done armed' : 'done', state: label };
      }
      case 'language': {
        if (!translator?.enabled) return { cls: 'off', state: t('rail.off') };
        if (!translator.apiKey) return { cls: 'pending', state: t('rail.noKey') };
        return { cls: 'done', state: `${translator.apiFormat} · →${translator.targetLanguage}` };
      }
      default:
        return { cls: '', state: '' };
    }
  };

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

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="sidebar-brand-title">SubFlow</span>
          <span className="sidebar-version">{appVersion}</span>
        </div>

        <div className="rail-key">{t('rail.pipeline')}</div>
        <nav className="sidebar-nav" aria-label={t('nav.label')}>
          {PIPELINE.map((id, i) => {
            const info = stageInfo(id);
            return (
              <button
                key={id}
                type="button"
                className={`nav-item ${info.cls} ${i === PIPELINE.length - 1 ? 'tail' : ''} ${tab === id ? 'active' : ''}`}
                onClick={() => setTab(id)}
              >
                <span className="nav-icon" aria-hidden />
                <span className="nav-body">
                  <span className="nav-head">
                    <span className="nav-num">{String(i + 1).padStart(2, '0')}</span>
                    <span className="nav-name">{t(TAB_META[id].navKey as any)}</span>
                  </span>
                  <span className="nav-state" title={info.state}>{info.state}</span>
                </span>
              </button>
            );
          })}

          <div className="rail-key rail-key-inline">{t('rail.tools')}</div>
          {TOOLS.map((id) => (
            <button
              key={id}
              type="button"
              className={`nav-item tool ${tab === id ? 'active' : ''}`}
              onClick={() => setTab(id)}
            >
              <span className="nav-icon" aria-hidden />
              <span className="nav-body">
                <span className="nav-head">
                  <span className="nav-name">{t(TAB_META[id].navKey as any)}</span>
                  {id === 'history' && finalCount > 0 && <span className="nav-num">{finalCount}</span>}
                  {id === 'logs' && errorCount > 0 && <span className="error-count">{errorCount}</span>}
                </span>
              </span>
            </button>
          ))}
        </nav>

        <div className="sidebar-theme">
          <div className="theme-row">
            <span className="theme-label">{t('ui.interfaceLanguage')}</span>
            <span className="segmented-inline">
              {(['zh', 'en'] as const).map((l) => (
                <button
                  key={l}
                  type="button"
                  className={`segment-btn ${localUiLang === l ? 'active' : ''}`}
                  onClick={() => changeUiLanguage(l)}
                >
                  {l === 'zh' ? '中文' : 'EN'}
                </button>
              ))}
            </span>
          </div>
          <div className="theme-row">
            <span className="theme-label">{t('theme.appearance')}</span>
            <span className="segmented-inline">
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
            </span>
          </div>
          <div className="theme-row">
            <span className="theme-label">{t('theme.accent')}</span>
            <span className="segmented-inline">
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
            </span>
          </div>
          <button
            type="button"
            className="btn-refresh-wal"
            onClick={refreshWallpaper}
            title={t('theme.refreshWallpaper.title')}
          >
            {t('theme.refreshWallpaper')}
          </button>
          {localAccentSource === 'wallpaper' && themeInfo?.accentResolution && (
            <div
              className={`theme-accent-status ${themeInfo.accentResolution.status === 'wallpaper' ? 'ok' : 'warn'}`}
              title={
                'path' in themeInfo.accentResolution ? themeInfo.accentResolution.path : undefined
              }
            >
              {t(ACCENT_STATUS_KEY[themeInfo.accentResolution.status] as any)}
            </div>
          )}
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
                    : sttProvider === 'remote_parakeet' ? t('remoteParakeet.connected.title')
                    : sttProvider === 'gladia' ? t('gladia.connected.title')
                    : t('deepgram.connected.title')
                  }>
                    {sttProvider === 'parakeet' ? t('parakeet.connected')
                    : sttProvider === 'remote_parakeet' ? t('remoteParakeet.connected')
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

        {/* The product's own output, made visible: the failure this app hides worst is
            "it stopped working and nobody noticed". */}
        <section className="monitor cut">
          <span className="bracket tr" aria-hidden />
          <span className="bracket bl" aria-hidden />
          <div className="mon-top">
            <div>
              <div className="mon-state">
                <span className={`status-dot ${capturing ? 'capturing' : 'idle'}`} />
                <span className={`mon-word ${capturing ? '' : 'off'}`}>
                  {capturing ? t('mon.capturing') : t('mon.idle')}
                </span>
              </div>
              <div className="mon-src">{status?.capture_source_name || t('rail.noSource')}</div>
            </div>
            <div className="tele">
              <div className="cell">
                <div className="cell-k">{t('mon.level')}</div>
                <div className="cell-v">{capturing ? dbLabel(audioLevel) : '—'}</div>
              </div>
              <div className="cell">
                <div className="cell-k">{t('mon.peak')}</div>
                <div className="cell-v">{capturing ? dbLabel(peak) : '—'}</div>
              </div>
              <div className="cell">
                <div className="cell-k">{t('mon.rate')}</div>
                <div className="cell-v">{capturing ? '16k' : '—'}</div>
              </div>
              <div className="cell">
                <div className="cell-k">{t('mon.lines')}</div>
                <div className={`cell-v ${finalCount > 0 ? 'warn' : ''}`}>{finalCount}</div>
              </div>
            </div>
          </div>

          <div className="scope">
            <div className="grat" aria-hidden>
              <span data-db="0" style={{ top: '6%' }} />
              <span data-db="−12" style={{ top: '28%' }} />
              <span className="mid" style={{ top: '50%' }} />
              <span data-db="−12" style={{ top: '72%' }} />
              <span data-db="0" style={{ top: '94%' }} />
            </div>
            <div className="meter" ref={scopeRef} aria-hidden />
          </div>

          <div className="cap">
            <span className="cap-time">{latest ? latest.ts : '--:--:--'}</span>
            <div>
              <div className={`cap-text ${latest?.partial ? 'interim' : 'settled'}`}>
                {latest ? latest.text : <span style={{ color: 'var(--text-muted)' }}>{t('mon.waiting')}</span>}
                {latest?.partial && <span className="caret" aria-hidden />}
              </div>
              {latest?.translated && <div className="cap-sub">{latest.translated}</div>}
            </div>
          </div>
        </section>

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
              showPartials={showPartials}
              onToggleShowPartials={(v) => {
                setShowPartials(v);
                window.electronAPI.setShowPartials(v);
              }}
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

      {/* Output is a real stage of the chain but has no settings page of its own, so it
          reports here rather than being invisible. */}
      <div className="chain-bar">
        <span className={overlayVisible ? 'on' : ''}>
          {t('out.overlay')} {overlayVisible ? t('out.on') : t('out.off')}
        </span>
        <span className={historyVisible ? 'on' : ''}>
          {t('out.history')} {historyVisible ? t('out.on') : t('out.off')}
        </span>
        <span className={showPartials ? 'on' : ''}>
          {t('out.partials')} {showPartials ? t('out.on') : t('out.off')}
        </span>
        <span className="spacer" />
        {capturing && <span>16 kHz · MONO</span>}
        <span>{finalCount}</span>
      </div>
    </div>
  );
}
