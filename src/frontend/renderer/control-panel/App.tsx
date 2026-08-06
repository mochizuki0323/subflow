import React, { useState, useEffect, useRef } from 'react';
import { SourceSelector } from './SourceSelector';
import { ModelManager } from './ModelManager';
import { DenoiserSettings } from './DenoiserSettings';
import { LanguageSettings } from './LanguageSettings';
import { OutputSettings } from './OutputSettings';
import { LogViewer } from './LogViewer';
import { applyUiThemePayload } from '../shared/apply-ui-theme';
import { setLang, t } from '../shared/i18n';
import { pendingTotal } from '../shared/pending';
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
  TranscriptEntry,
  LanguageSupport,
  UpdateStatus,
} from '../shared/types';

type Tab = 'sources' | 'denoise' | 'recognition' | 'translation' | 'output' | 'history' | 'logs' | 'about';

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
  recognition: { titleKey: 'tab.recognition', navKey: 'tab.recognition.nav' },
  denoise: { titleKey: 'tab.denoise', navKey: 'tab.denoise.nav' },
  translation: { titleKey: 'tab.translation', navKey: 'tab.translation.nav' },
  output: { titleKey: 'tab.output', navKey: 'tab.output.nav' },
  history: { titleKey: 'tab.history', navKey: 'tab.history.nav' },
  logs: { titleKey: 'tab.logs', navKey: 'tab.logs.nav' },
  about: { titleKey: 'tab.about', navKey: 'tab.about.nav' },
};

/**
 * These five are not categories, they are the stages audio actually passes through,
 * in order — which is why they are numbered and drawn on a bus. The rest are tools
 * and get no number, because they are not part of any sequence.
 */
const PIPELINE: Tab[] = ['sources', 'denoise', 'recognition', 'translation', 'output'];
const TOOLS: Tab[] = ['history', 'logs', 'about'];

const SCOPE_BARS = 150;
/** Gap between stages lighting up, in ms. */
const RAIL_STAGGER = 130;
/** Must match the bus-flow animation duration in CSS. */
const FLOW_PERIOD = 1400;
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
  const [recognizerReady, setRecognizerReady] = useState(false);
  const [sttProvider, setSttProvider] = useState<string>('parakeet');
  const [languageSupport, setLanguageSupport] = useState<LanguageSupport | null>(null);
  const [history, setHistory] = useState<TranscriptEntry[]>([]);
  const historyRef = useRef<HTMLDivElement>(null);
  const [themeInfo, setThemeInfo] = useState<UiThemePayload | null>(null);
  const [backendState, setBackendState] = useState<string>('connecting');
  const [railPhase, setRailPhase] = useState<'' | 'arming' | 'draining'>('');
  const [audioLevel, setAudioLevel] = useState(0);
  const [peak, setPeak] = useState(0);
  const [latency, setLatency] = useState<number | null>(null);
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
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [autoCheckUpdates, setAutoCheckUpdates] = useState(true);

  useEffect(() => {
    window.electronAPI.getSttProvider().then(setSttProvider);
  }, []);

  // Re-asked whenever any of its three inputs can have moved: the model and the
  // provider (both via the respawn this triggers, watched on `backend-state`)
  // and the language (no respawn, so the panel says so itself). Nothing polls —
  // a mismatch cannot appear on its own.
  const refreshLanguageSupport = () => {
    window.electronAPI.getLanguageSupport().then(setLanguageSupport);
  };
  useEffect(refreshLanguageSupport, []);

  useEffect(() => {
    window.electronAPI.getAppSettings().then((s) => {
      const lang: UiLanguage = s.uiLanguage === 'en' ? 'en' : 'zh';
      setLang(lang);
      setUiLang(lang);
      setLocalUiLang(lang);
      setShowPartials(!!s.showPartials);
      setAutoCheckUpdates(s.checkUpdatesOnStartup !== false);
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
    // The record lives in the main process; this mirrors it rather than keeping a
    // second, subtly different copy.
    window.electronAPI.getTranscriptLog().then(setHistory);
    window.electronAPI.onTranscriptCleared(() => setHistory([]));
    window.electronAPI.onSubtitle((data: TranscriptSegment) => {
      if (!data.text) return;
      const entry: TranscriptEntry = {
        text: data.text.trim(),
        translated: data.translated_text?.trim() || undefined,
        speaker: data.speaker,
        partial: !!data.partial,
        t0: data.t0 ?? 0,
        t1: data.t1 ?? 0,
        at: Date.now(),
      };
      if (typeof data.latency_ms === 'number') setLatency(data.latency_ms);
      setHistory((prev) => {
        const last = prev[prev.length - 1];
        if (last?.partial) return [...prev.slice(0, -1), entry];
        return [...prev.slice(-1999), entry];
      });
    });

    window.electronAPI.onSources((data) => {
      setSources(Array.isArray(data) ? data : []);
    });

    window.electronAPI.onStatus((data) => {
      setStatus(data);
      setRecognizerReady(!!data?.model_loaded);
    });

    window.electronAPI.onLog((data) => {
      setLogs((prev) => [...prev.slice(-500), { ...data, timestamp: new Date().toISOString() }]);
    });

    window.electronAPI.onModelLoaded(() => {
      setRecognizerReady(true);
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

  // Drafts survive tab switches, so leaving a page costs nothing. Closing the window
  // is the one exit that would still discard them.
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      if (pendingTotal() === 0) return undefined;
      if (window.confirm(t('pending.onClose'))) return undefined;
      e.preventDefault();
      e.returnValue = false;
      return false;
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, []);

  useEffect(() => {
    if (tab === 'history' && historyRef.current) {
      historyRef.current.scrollTop = historyRef.current.scrollHeight;
    }
  }, [history, tab]);

  // One definition, used by the monitor, the rail and the source list alike — they
  // used to disagree about whether `running` counted, so the monitor said "idle"
  // while the page below it said "capturing".
  const backendUp = backendState === 'connected';
  const capturing = backendUp && (status?.state === 'capturing' || status?.state === 'running');

  // Run the rail's sequence on the transition, not on every render: starting capture
  // draws the chain in from the source, stopping it retracts from the output back.
  const wasCapturing = useRef(capturing);
  useEffect(() => {
    if (capturing === wasCapturing.current) return;
    wasCapturing.current = capturing;
    setRailPhase(capturing ? 'arming' : 'draining');
    const timer = setTimeout(() => setRailPhase(''), PIPELINE.length * RAIL_STAGGER + 700);
    return () => clearTimeout(timer);
  }, [capturing]);

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
    setLatency(null);
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

  // Reload the chain's configuration on the events that can actually change it —
  // leaving a settings tab, and the backend coming back — instead of polling on a
  // timer, which showed stale state for seconds right after a save.
  useEffect(() => {
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
  }, [tab, backendState]);

  // Backend liveness is pushed, not inferred. Without it a dead backend left the UI
  // showing "connected / capturing" from the last status frame, forever.
  useEffect(() => {
    // Seed first: the socket connects before this window exists, so the initial
    // event has already been emitted by the time we subscribe.
    window.electronAPI.getBackendState().then(({ state }) => setBackendState(state));
    window.electronAPI.onBackendState(({ state }) => {
      setBackendState(state);
      if (state !== 'connected') setRecognizerReady(false);
      // Every model and provider change goes through a respawn, so this one
      // transition covers both. `model_loaded` looks like the natural hook and is
      // not: the backend only ever reports that as a field of the status frame,
      // never as a message, so the listener of that name never fires.
      if (state === 'connected') refreshLanguageSupport();
    });
    return () => window.electronAPI.removeListeners('backend-state');
  }, []);

  const errorCount = logs.filter((l) => l.level === 'error').length;
  const finalCount = history.filter((h) => !h.partial).length;
  const dropped = status?.dropped_ms ?? 0;
  const latest = history[history.length - 1];

  /**
   * A stage is doing one of four things, and only one of them is a break.
   *
   *  active   — enabled and configured; it processes the signal
   *  bypass   — switched off on purpose; the signal passes through untouched
   *  waiting  — nothing chosen yet, so there is nothing to pass on
   *  fault    — switched on but unusable, which is the only case that stops output
   *
   * Turning denoising or translation off is a configuration, not a failure: the
   * captions still come out, so the chain must stay unbroken through them.
   */
  type StageMode = 'active' | 'bypass' | 'waiting' | 'fault';

  const stageInfo = (id: Tab): { mode: StageMode; state: string } => {
    switch (id) {
      case 'sources': {
        const name = status?.capture_source_name;
        return name ? { mode: 'active', state: name } : { mode: 'waiting', state: t('rail.noSource') };
      }
      case 'denoise':
        return denoiser?.enabled
          ? { mode: 'active', state: denoiser.modelId }
          : { mode: 'bypass', state: t('rail.off') };
      case 'recognition': {
        const label = `${sttProvider}${status?.language ? ` · ${status.language}` : ''}`;
        // A backend that is down is not a misconfigured stage; only accuse the stage
        // once the backend is up and still reports no usable model.
        if (!backendUp) return { mode: 'waiting', state: t('rail.backendDown') };
        // A model that does not cover the chosen language is loaded, ready, and
        // useless — it decodes confidently into the wrong script. Checked before
        // readiness because nothing else about the stage looks wrong.
        if (languageSupport && !languageSupport.supported) {
          return { mode: 'fault', state: t('rail.langUnsupported') };
        }
        if (recognizerReady) return { mode: 'active', state: label };
        return { mode: 'fault', state: t('rail.modelNotReady') };
      }
      case 'translation': {
        if (!translator?.enabled) return { mode: 'bypass', state: t('rail.off') };
        if (!translator.apiKey) return { mode: 'fault', state: t('rail.noKey') };
        // Enabling translation now switches the subtitle mode off "original" for
        // you, so this only trips if it was deliberately set back afterwards.
        if (subtitleMode === 'original') return { mode: 'fault', state: t('rail.needSubtitleMode') };
        return { mode: 'active', state: `${translator.apiFormat} · →${translator.targetLanguage}` };
      }
      case 'output': {
        const on = [overlayVisible && t('out.overlay'), historyVisible && t('out.history')].filter(Boolean);
        // Both windows closed means nothing reaches the screen — the single most
        // common reason someone thinks the app is broken.
        if (on.length === 0) return { mode: 'fault', state: t('rail.noOutput') };
        return { mode: 'active', state: on.join(' · ') };
      }
      default:
        return { mode: 'bypass', state: '' };
    }
  };

  /**
   * Each stage reports only on itself: its line is intact unless *it* is what stops
   * the signal. Propagating a break downstream would paint the whole rail dashed for
   * one unset stage and hide where the actual problem is.
   */
  const rail = PIPELINE.map((id) => {
    const info = stageInfo(id);
    return {
      id,
      ...info,
      carries: info.mode !== 'fault' && info.mode !== 'waiting',
      live: capturing && info.mode === 'active',
    };
  });

  // The dashes and the moving pulse answer different questions. A dash is local —
  // "is this stage's own path intact" — so one unset stage does not blank the rest.
  // The pulse is cumulative: data that cannot get past a broken stage is not
  // flowing downstream of it, and drawing it there would be a lie.
  let reached = capturing;
  const railFlow = rail.map((stage) => {
    const flows = reached;
    reached = reached && stage.carries;
    return flows;
  });

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
    // Asked once and then listened for: the startup check usually completes
    // before this window exists, and a later one arrives while it is open.
    window.electronAPI.getUpdateStatus().then(setUpdate);
    window.electronAPI.onUpdateStatus(setUpdate);
    return () => window.electronAPI.removeListeners('update-status');
  }, []);

  const checkForUpdates = () => {
    void window.electronAPI.checkForUpdates().then(setUpdate);
  };

  const toggleAutoCheckUpdates = () => {
    const next = !autoCheckUpdates;
    setAutoCheckUpdates(next);
    void window.electronAPI.setCheckUpdatesOnStartup(next);
  };

  const updateLine = ((): string => {
    switch (update?.state) {
      case 'checking':
        return t('about.update.checking');
      case 'available':
        return `${t('about.update.available')} v${update.latestVersion}`;
      case 'current':
        return t('about.update.current');
      case 'error': {
        const reason = t(`about.update.err.${update.error ?? 'offline'}` as any);
        const code = update.httpStatus ? ` (${update.httpStatus})` : '';
        return `${t('about.update.failed')} · ${reason}${code}`;
      }
      default:
        return t('about.update.never');
    }
  })();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="sidebar-brand-title">SubFlow</span>
          <span className="sidebar-version">{appVersion}</span>
        </div>

        <div className="rail-key">{t('rail.pipeline')}</div>
        <nav className={`sidebar-nav ${railPhase} ${capturing ? 'flowing' : ''}`} aria-label={t('nav.label')}>
          {rail.map((stage, i) => (
            <button
              key={stage.id}
              type="button"
              className={[
                'nav-item',
                `is-${stage.mode}`,
                stage.carries ? 'carries' : '',
                railFlow[i] ? 'reaches' : '',
                stage.live ? 'live' : '',
                i === rail.length - 1 ? 'tail' : '',
                tab === stage.id ? 'active' : '',
              ].join(' ')}
              onClick={() => setTab(stage.id)}
              style={{
                // Draining runs the other way, so the stage that loses the signal
                // last is the one closest to the source.
                ['--arm-delay' as string]:
                  `${(railPhase === 'draining' ? rail.length - 1 - i : i) * RAIL_STAGGER}ms`,
                // Spread one flow period across the stages so the pulse looks
                // continuous instead of five separate blinks.
                ['--flow-delay' as string]: `${(i * FLOW_PERIOD) / rail.length}ms`,
              } as React.CSSProperties}
            >
              <span className="nav-icon" aria-hidden />
              <span className="nav-body">
                <span className="nav-head">
                  <span className="nav-num">{String(i + 1).padStart(2, '0')}</span>
                  <span className="nav-name">{t(TAB_META[stage.id].navKey as any)}</span>
                </span>
                <span className="nav-state" title={stage.state}>{stage.state}</span>
              </span>
            </button>
          ))}

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
                  {/* A newer version is not a fault and not signal, so it gets no
                      colour — the version number itself, sitting where a count
                      sits, is the whole notification. */}
                  {id === 'about' && update?.state === 'available' && (
                    <span className="nav-num">{update.latestVersion}</span>
                  )}
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
            {!backendUp ? (
              <>
                <span className={`status-dot ${backendState === 'exited' ? 'fault' : 'idle'}`} />
                <span className="status-text">
                  {backendState === 'exited'
                    ? t('status.backendExited')
                    : backendState === 'restarting'
                      ? t('status.backendRestarting')
                      : t('status.connecting')}
                </span>
              </>
            ) : status ? (
              <>
                <span className={`status-dot ${status.state}`} />
                <span className="status-text">{t((STATUS_KEY[status.state] || status.state) as any)}</span>
                {/* The badge used to name Deepgram whatever the engine was, so a
                    local-model user was told "Deepgram not connected". */}
                <span className={`badge ${recognizerReady ? 'badge-loaded' : ''}`}>
                  {recognizerReady ? t('recognizer.ready') : t('recognizer.notReady')}
                </span>
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
                <div className="cell-k">{t('mon.latency')}</div>
                <div className="cell-v">{latency === null ? '—' : `${latency}`}</div>
              </div>
              <div className="cell">
                <div className="cell-k">{t('mon.dropped')}</div>
                {/* Anything above zero means the recogniser fell behind the input. */}
                <div className={`cell-v ${dropped > 0 ? 'fault' : ''}`}>
                  {capturing ? dropped : '—'}
                </div>
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
            <span className="cap-time">{latest ? new Date(latest.at).toTimeString().slice(0, 8) : '--:--:--'}</span>
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
            <SourceSelector sources={sources} status={status} capturing={capturing} />
          )}
          {tab === 'recognition' && (
            <ModelManager
              onProviderChange={(p) => { setSttProvider(p); refreshLanguageSupport(); }}
              onLanguageChange={refreshLanguageSupport}
            />
          )}
          {tab === 'denoise' && <DenoiserSettings />}
          {tab === 'translation' && <LanguageSettings status={status} />}
          {tab === 'output' && (
            <OutputSettings
              overlayVisible={overlayVisible}
              onToggleOverlay={setOverlayVisible}
              historyVisible={historyVisible}
              onToggleHistory={setHistoryVisible}
              showPartials={showPartials}
              onToggleShowPartials={(v) => {
                setShowPartials(v);
                window.electronAPI.setShowPartials(v);
              }}
              dragMode={dragMode}
              onToggleDragMode={setDragMode}
              subtitleMode={subtitleMode}
              onSubtitleModeChange={(mode) => {
                setSubtitleMode(mode);
                window.electronAPI.setSubtitleMode(mode);
              }}
              translatorEnabled={!!translator?.enabled}
            />
          )}
          {tab === 'history' && (
            <div className="panel" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <h2 style={{ margin: 0 }}>{t('history.title')}</h2>
                <span style={{ display: 'flex', gap: 6 }}>
                  <button type="button" className="btn-secondary btn-sm" onClick={() => window.electronAPI.exportTranscript('srt')}>
                    {t('history.exportSrt')}
                  </button>
                  <button type="button" className="btn-secondary btn-sm" onClick={() => window.electronAPI.exportTranscript('txt')}>
                    {t('history.exportTxt')}
                  </button>
                  <button type="button" className="btn-secondary btn-sm" onClick={() => window.electronAPI.clearTranscriptLog()}>
                    {t('history.clear')}
                  </button>
                </span>
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
                        <span style={{ color: 'var(--text-muted)', fontSize: 11, marginRight: 8 }}>
                          {new Date(item.at).toTimeString().slice(0, 8)}
                        </span>
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

              {/* Checking is all this does. Neither the Windows portable exe nor a
                  deb/rpm can be replaced from inside the running process, so the
                  app names the new version and opens the page rather than
                  pretending to install it on the three targets where it cannot. */}
              <div className="section">
                <div className="block-key">{t('about.updates')}</div>
                <div className="form-row">
                  <label>{t('about.update.status')}</label>
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: update?.state === 'available' ? 600 : 400,
                      color: update?.state === 'available' ? 'var(--text-primary)' : 'var(--text-secondary)',
                    }}
                  >
                    {updateLine}
                  </span>
                </div>
                {update?.state === 'available' && update.publishedAt && (
                  <div className="form-row">
                    <label>{t('about.update.released')}</label>
                    <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                      {new Date(update.publishedAt).toLocaleDateString()}
                    </span>
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={checkForUpdates}
                    disabled={update?.state === 'checking'}
                  >
                    {update?.state === 'checking' ? t('about.update.checking') : t('about.update.check')}
                  </button>
                  {update?.state === 'available' && update.releaseUrl && (
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => window.electronAPI.openExternal(update.releaseUrl!)}
                    >
                      {t('about.update.open')}
                    </button>
                  )}
                </div>
                {update?.state === 'available' && (
                  <p className="hint" style={{ marginTop: 8 }}>{t('about.update.manual')}</p>
                )}
                {update?.state === 'available' && update.releaseNotes && (
                  <div style={{ marginTop: 10 }}>
                    <div className="block-key">{t('about.update.notes')}</div>
                    <div
                      style={{
                        maxHeight: 200,
                        overflowY: 'auto',
                        whiteSpace: 'pre-wrap',
                        fontSize: 12,
                        lineHeight: 1.6,
                        color: 'var(--text-secondary)',
                      }}
                    >
                      {update.releaseNotes}
                    </div>
                  </div>
                )}
                <div className="toggle-row" onClick={toggleAutoCheckUpdates} style={{ marginTop: 12 }}>
                  <div>
                    <div className="toggle-label">{t('about.update.autoCheck')}</div>
                    <div className="toggle-desc">{t('about.update.autoCheck.desc')}</div>
                  </div>
                  <label className="switch" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={autoCheckUpdates} onChange={toggleAutoCheckUpdates} />
                    <span className="switch-slider" />
                  </label>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* The rail carries configuration; this line carries what is happening right
          now, including the one mode that is otherwise invisible from every page. */}
      <div className="chain-bar">
        <span className={capturing ? 'on' : ''}>
          {capturing ? `${t('mon.capturing')} · ${status?.capture_source_name ?? ''}` : t('mon.idle')}
        </span>
        {capturing && <span>16 kHz · MONO</span>}
        <span>{t('mon.lines')} {finalCount}</span>
        {dragMode && (
          <span className="bad" onClick={() => window.electronAPI.exitDragMode()} style={{ cursor: 'pointer' }}>
            {t('out.placement.active')}
          </span>
        )}
        <span className="spacer" />
        {errorCount > 0 && <span className="bad">{errorCount}</span>}
      </div>
    </div>
  );
}
