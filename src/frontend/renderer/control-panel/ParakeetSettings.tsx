import React, { useState, useEffect, useRef } from 'react';
import type { ParakeetConfig, ParakeetVadConfig, ParakeetModelInfo } from '../shared/types';
import { t, getLang } from '../shared/i18n';
import { usePending } from '../shared/pending';
import { PendingBar } from './PendingBar';

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const THREADS_MIN = 1;
const THREADS_MAX = 8;

function clampThreads(value: number): number {
  if (!Number.isFinite(value)) return 4;
  return Math.max(THREADS_MIN, Math.min(THREADS_MAX, Math.round(value)));
}

const VAD_DEFAULTS: ParakeetVadConfig = {
  threshold: 0.3,
  minSilence: 0.5,
  minSpeech: 0.25,
  maxSpeech: 15,
  partialInterval: 0.2,
};

const VAD_FIELDS: Array<{
  key: keyof ParakeetVadConfig;
  min: number;
  max: number;
  step: number;
  decimals: number;
}> = [
  { key: 'threshold', min: 0.1, max: 0.9, step: 0.05, decimals: 2 },
  { key: 'minSilence', min: 0.1, max: 3.0, step: 0.1, decimals: 1 },
  { key: 'minSpeech', min: 0.05, max: 1.0, step: 0.05, decimals: 2 },
  { key: 'maxSpeech', min: 5, max: 30, step: 1, decimals: 0 },
  { key: 'partialInterval', min: 0.1, max: 1.0, step: 0.05, decimals: 2 },
];

// t() with a dynamically-built key (every VAD field has matching i18n entries)
const tk = (key: string): string => t(key as Parameters<typeof t>[0]);

export function ParakeetSettings({ sourceLanguage }: { sourceLanguage: string }) {
  const [saved, setSaved] = useState<ParakeetConfig | null>(null);
  const { draft: config, edit, commit, discard, changed, dirty } = usePending<ParakeetConfig>('parakeet', saved);
  const [models, setModels] = useState<ParakeetModelInfo[]>([]);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [applying, setApplying] = useState(false);
  const [vadSaving, setVadSaving] = useState(false);
  const [downloadError, setDownloadError] = useState<{ modelId: string; message: string } | null>(null);
  const downloadingRef = useRef<string | null>(null);
  // The box holds text, not the number: mid-edit states ("", "1.") must survive
  // in the field without ever being handed to the draft, same as the nemotron
  // panel's. Re-synced from the draft so Discard also resets what is displayed.
  const [threadText, setThreadText] = useState('4');
  useEffect(() => {
    if (typeof config?.numThreads === 'number') setThreadText(String(config.numThreads));
  }, [config?.numThreads]);

  const loadData = async () => {
    const [cfg, mdls, dlStatus] = await Promise.all([
      window.electronAPI.getParakeetConfig(),
      window.electronAPI.getParakeetModels(),
      window.electronAPI.getParakeetDownloadStatus(),
    ]);
    setSaved(cfg);
    setModels(mdls);
    if (dlStatus.length > 0) {
      const active = dlStatus[0];
      setDownloading(active.modelId);
      downloadingRef.current = active.modelId;
      setDownloadProgress(active.percent);
      const result = await window.electronAPI.downloadParakeetModel(active.modelId);
      setDownloading(null);
      downloadingRef.current = null;
      if (result.success) {
        setModels(await window.electronAPI.getParakeetModels());
      } else {
        setDownloadError({ modelId: active.modelId, message: result.error || t('parakeet.downloadFailed') });
      }
    }
  };

  useEffect(() => { loadData(); }, []);

  useEffect(() => {
    window.electronAPI.onParakeetDownloadProgress(({ modelId, percent }) => {
      if (modelId === downloadingRef.current) setDownloadProgress(percent);
    });
    return () => window.electronAPI.removeListeners('parakeet-download-progress');
  }, []);

  const downloadedModels = models.filter(m => m.downloaded);

  const handleDownload = async (modelId: string) => {
    if (downloading) return;
    setDownloading(modelId);
    downloadingRef.current = modelId;
    setDownloadProgress(0);
    setDownloadError(null);
    const result = await window.electronAPI.downloadParakeetModel(modelId);
    setDownloading(null);
    downloadingRef.current = null;
    if (result.success) {
      const updatedModels = await window.electronAPI.getParakeetModels();
      setModels(updatedModels);
      if (!config.modelId) {
        edit({ modelId });
      }
    } else {
      setDownloadError({ modelId, message: result.error || t('parakeet.downloadFailed') });
    }
  };

  const handleDelete = async (modelId: string) => {
    await window.electronAPI.deleteParakeetModel(modelId);
    const updatedModels = await window.electronAPI.getParakeetModels();
    setModels(updatedModels);
    if (config.modelId === modelId) {
      const remaining = updatedModels.filter(m => m.downloaded);
      edit({ modelId: remaining.length > 0 ? remaining[0].id : '' });
    }
  };


  const updateVad = (key: keyof ParakeetVadConfig, value: number) => {
    edit({ vad: { ...config.vad, [key]: value } });
  };


  const handleResetVad = () => edit({ vad: { ...VAD_DEFAULTS } });

  // The model and the thread count are both baked into the recogniser at
  // creation, so either respawns the backend; the VAD is a live command.
  // Applying them together means the panel's one button can never leave half the
  // page behind.
  const respawns = changed.includes('modelId') || changed.includes('numThreads');
  const cost = respawns ? 'restart' : 'reconnect';

  const handleApply = async () => {
    setApplying(true);
    try {
      const threads = clampThreads(config.numThreads);
      // Sent as one call even when only one of them moved: the handler restarts
      // on the pair, so splitting it would spend two respawns on one Apply.
      if (respawns) {
        await window.electronAPI.setParakeetConfig({ modelId: config.modelId, numThreads: threads });
      }
      if (changed.includes('vad')) await window.electronAPI.setParakeetVadConfig(config.vad);
      commit({ ...config, numThreads: threads });
    } finally {
      setApplying(false);
    }
  };

  const lang = getLang();
  const selectedModel = models.find(m => m.id === config.modelId);
  const isDownloaded = selectedModel?.downloaded ?? false;
  // Against the draft, not the saved config: the warning has to appear while the
  // picker is still open on the model that would cause it.
  // Unset reads as auto here exactly as it does in the main process, or a
  // hand-edited config would paint this red while the rail stayed green.
  const covers = !sourceLanguage
    || sourceLanguage === 'auto'
    || !selectedModel
    || selectedModel.languages.includes(sourceLanguage);

  return (
    <>
      <PendingBar
        count={changed.length}
        cost={cost}
        applying={applying}
        onApply={handleApply}
        onDiscard={discard}
      />
      <h2>{t('parakeet.title')}</h2>
      <p className="hint">{t('parakeet.hint')}</p>

      {/* Model selection — only downloaded models */}
      <div className="form-row" style={{ marginTop: 16 }}>
        <label>{t('parakeet.model')}</label>
        {downloadedModels.length > 0 ? (
          <select
            className="select"
            value={config.modelId}
            onChange={(e) => edit({ modelId: e.target.value })}
          >
            {downloadedModels.map(m => (
              <option key={m.id} value={m.id}>
                {lang === 'zh' ? m.description_zh : m.description_en}
              </option>
            ))}
          </select>
        ) : (
          <p className="hint" style={{ color: 'var(--warning)' }}>
            {t('parakeet.needDownload')}
          </p>
        )}
        {selectedModel && (
          <p className="hint">
            {t('parakeet.languages')}: {selectedModel.languages.join(', ')}
          </p>
        )}
        {/* The list above is only useful if someone reads it against the language
            they picked. This model still loads and still reports ready — the only
            symptom is captions in the wrong script — so say it outright. */}
        {selectedModel && !covers && (
          <p className="hint" style={{ color: 'var(--error)', marginTop: 4 }}>
            {t('parakeet.langMismatch')}
          </p>
        )}
      </div>


      <div className="form-row" style={{ marginTop: 16 }}>
        <label>{t('parakeet.threads')}</label>
        <input
          type="number"
          className="input"
          min={THREADS_MIN}
          max={THREADS_MAX}
          step={1}
          value={threadText}
          onChange={(e) => {
            const raw = e.target.value;
            setThreadText(raw);
            const n = Number(raw);
            if (raw !== '' && Number.isInteger(n) && n >= THREADS_MIN && n <= THREADS_MAX) {
              edit({ numThreads: n });
            }
          }}
          onBlur={() => {
            const n = clampThreads(Number(threadText));
            setThreadText(String(n));
            edit({ numThreads: n });
          }}
        />
        <p className="hint">{t('parakeet.threads.hint')}</p>
      </div>

      <div className="divider" />

      {/* Advanced VAD settings — runtime, no restart */}
      <div className="vad-header">
        <h3 style={{ margin: 0 }}>{t('parakeet.vad.title')}</h3>
        <button
          className="btn-secondary btn-sm"
          onClick={() => setShowAdvanced(v => !v)}
        >
          {showAdvanced ? t('parakeet.vad.hide') : t('parakeet.vad.show')}
        </button>
      </div>
      <p className="hint" style={{ marginTop: 8 }}>{t('parakeet.vad.hint')}</p>

      {showAdvanced && (
        <div className="vad-section">
          {VAD_FIELDS.map(f => {
            const value = config.vad[f.key];
            const pct = ((value - f.min) / (f.max - f.min)) * 100;
            return (
              <div key={f.key} className="vad-field">
                <div className="vad-field-head">
                  <label>{tk(`parakeet.vad.${f.key}`)}</label>
                  <span className="vad-value">{value.toFixed(f.decimals)}</span>
                </div>
                <input
                  type="range"
                  className="vad-slider"
                  min={f.min}
                  max={f.max}
                  step={f.step}
                  value={value}
                  onChange={(e) => updateVad(f.key, parseFloat(e.target.value))}
                  style={{
                    background: `linear-gradient(to right, var(--accent) 0%, var(--accent) ${pct}%, var(--bg-hover) ${pct}%, var(--bg-hover) 100%)`,
                  }}
                />
                <p className="hint">{tk(`parakeet.vad.${f.key}.hint`)}</p>
              </div>
            );
          })}

          <div className="vad-actions">
            <button className="btn-secondary" onClick={handleResetVad} disabled={applying}>
              {t('parakeet.vad.reset')}
            </button>
          </div>
        </div>
      )}

      <div className="divider" />

      {/* Model library */}
      <h3 style={{ marginBottom: 12 }}>{t('parakeet.library')}</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {models.map(m => {
          const isDownloading = downloading === m.id;
          return (
            <div key={m.id} style={{
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: '10px 12px',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 500 }}>
                    {lang === 'zh' ? m.description_zh : m.description_en}
                  </div>
                  <div className="hint" style={{ marginTop: 2 }}>
                    {m.type === 'nemo_ctc' ? 'CTC' : 'Transducer'} · {formatSize(m.archive_size_bytes)} · {m.languages.length} {t('parakeet.langCount')}
                  </div>
                </div>
                <div style={{ flexShrink: 0, marginLeft: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
                  {m.downloaded ? (
                    <>
                      <span className="badge badge-success">{t('parakeet.downloaded')}</span>
                      <button
                        className="btn-secondary btn-sm"
                        onClick={() => handleDelete(m.id)}
                        title={t('parakeet.delete')}
                        style={{ padding: '2px 8px', fontSize: 12 }}
                      >
                        {t('parakeet.delete')}
                      </button>
                    </>
                  ) : isDownloading ? (
                    <span className="hint" style={{ marginTop: 0 }}>
                      {downloadProgress < 90
                        ? `${t('parakeet.downloading')} ${downloadProgress}%`
                        : t('parakeet.extracting')}
                    </span>
                  ) : (
                    <button
                      className="btn-secondary btn-sm"
                      onClick={() => handleDownload(m.id)}
                      disabled={!!downloading}
                    >
                      {t('parakeet.download')}
                    </button>
                  )}
                </div>
              </div>
              {isDownloading && (
                <div style={{ marginTop: 8, height: 4, background: 'var(--bg-tertiary)', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{
                    height: '100%',
                    width: `${downloadProgress}%`,
                    background: 'var(--accent)',
                    transition: 'width 0.3s ease',
                  }} />
                </div>
              )}
              {downloadError && downloadError.modelId === m.id && (
                <p className="hint" style={{ color: 'var(--error)', marginTop: 4 }}>{downloadError.message}</p>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
