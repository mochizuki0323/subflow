import React, { useState, useEffect } from 'react';
import type { NemotronConfig, NemotronModelInfo } from '../shared/types';
import { usePending } from '../shared/pending';
import { PendingBar } from './PendingBar';
import { t, getLang } from '../shared/i18n';

function formatSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

// Same bounds the config layer and the backend enforce. Past 8 the thread pool
// is only oversubscribing whatever the machine has, and this workload was
// already getting worse per core well before that.
const THREADS_MIN = 1;
const THREADS_MAX = 8;

function clampThreads(value: number): number {
  if (!Number.isFinite(value)) return 2;
  return Math.max(THREADS_MIN, Math.min(THREADS_MAX, Math.round(value)));
}

// Endpoint rules, not VAD: the streaming decoder counts its own trailing
// blanks, these set how much of that silence closes a caption. Same ranges the
// config layer clamps to.
const ENDPOINT_FIELDS: Array<{
  key: 'minSilence' | 'maxUtterance';
  min: number;
  max: number;
  step: number;
  decimals: number;
}> = [
  { key: 'minSilence', min: 0.1, max: 3.0, step: 0.1, decimals: 1 },
  { key: 'maxUtterance', min: 5, max: 30, step: 1, decimals: 0 },
];

// t() with a dynamically-built key (both endpoint fields have i18n entries)
const tk = (key: string): string => t(key as Parameters<typeof t>[0]);

export function NemotronSettings() {
  const [saved, setSaved] = useState<NemotronConfig | null>(null);
  const { draft: config, edit, commit, discard, changed } =
    usePending<NemotronConfig>('nemotron', saved);
  const [models, setModels] = useState<NemotronModelInfo[]>([]);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [applying, setApplying] = useState(false);
  const [downloadError, setDownloadError] = useState<{ modelId: string; message: string } | null>(null);
  // The field keeps its own text so a half-typed value is not forced through
  // Number() on every keystroke.
  const [threadText, setThreadText] = useState('2');

  useEffect(() => {
    Promise.all([
      window.electronAPI.getNemotronConfig(),
      window.electronAPI.getNemotronModels(),
      window.electronAPI.getNemotronDownloadStatus(),
    ]).then(([cfg, list, active]) => {
      setSaved(cfg);
      setModels(list);
      setProgress(Object.fromEntries(active.map((d) => [d.modelId, d.percent])));
      // Rejoin any download that outlived a previous mount: re-invoking joins
      // the tracker's existing promise, same as the Parakeet panel. Without
      // this, nobody clears the progress entry when the download finishes and
      // the row shows "extracting" forever with every other button disabled.
      active.forEach(async ({ modelId }) => {
        const res = await window.electronAPI.downloadNemotronModel(modelId);
        setProgress((p) => { const n = { ...p }; delete n[modelId]; return n; });
        if (!res.success) setDownloadError({ modelId, message: res.error || t('nemotron.downloadFailed') });
        await refresh();
      });
    });

    window.electronAPI.onNemotronDownloadProgress(({ modelId, percent }) => {
      setProgress((p) => ({ ...p, [modelId]: percent }));
    });
    return () => window.electronAPI.removeListeners('nemotron-download-progress');
  }, []);

  // The box's text is local state (so a half-typed value survives keystrokes),
  // but the number it shadows lives in the draft, which persists across
  // unmounts and reverts on Discard. Follow it, or the field shows one value
  // while Apply would write another.
  useEffect(() => {
    if (typeof config?.numThreads === 'number') setThreadText(String(config.numThreads));
  }, [config?.numThreads]);

  const refresh = async () => setModels(await window.electronAPI.getNemotronModels());

  // The picker only lists downloaded models, so a modelId naming one that is not
  // on disk renders a select whose value is absent from its own options — and,
  // worse, leaves the backend with no --nemotron-model-dir at all, which reads in
  // the UI as "model not ready" with nothing obviously wrong. Downloading a
  // variant other than the default put every new install in exactly that state.
  useEffect(() => {
    if (!config) return;
    const downloaded = models.filter((m) => m.downloaded);
    if (downloaded.length === 0) return;
    if (!downloaded.some((m) => m.id === config.modelId)) {
      edit({ modelId: downloaded[0].id });
    }
  }, [models, config?.modelId]);

  const handleDownload = async (modelId: string) => {
    setDownloadError(null);
    setProgress((p) => ({ ...p, [modelId]: 0 }));
    const res = await window.electronAPI.downloadNemotronModel(modelId);
    setProgress((p) => { const n = { ...p }; delete n[modelId]; return n; });
    if (!res.success) setDownloadError({ modelId, message: res.error || t('nemotron.downloadFailed') });
    await refresh();
  };

  const handleDelete = async (modelId: string) => {
    await window.electronAPI.deleteNemotronModel(modelId);
    await refresh();
  };

  // Both settings decide what the recogniser is built with, so both respawn it.
  const handleApply = async () => {
    if (!config) return;
    setApplying(true);
    try {
      const threads = clampThreads(config.numThreads);
      await window.electronAPI.setNemotronConfig({
        modelId: config.modelId,
        numThreads: threads,
        minSilence: config.minSilence,
        maxUtterance: config.maxUtterance,
      });
      setSaved(await window.electronAPI.getNemotronConfig());
      commit({ ...config, numThreads: threads });
    } finally {
      setApplying(false);
    }
  };

  if (!saved || !config) return null;
  const lang = getLang();
  const downloadedModels = models.filter((m) => m.downloaded);
  const anyDownloading = Object.keys(progress).length > 0;

  return (
    <>
      <PendingBar
        count={changed.length}
        cost="restart"
        applying={applying}
        onApply={handleApply}
        onDiscard={discard}
      />
      <h2>{t('nemotron.title')}</h2>
      <p className="hint">{t('nemotron.hint')}</p>

      {/* Only downloaded models are selectable, same as the Parakeet panel: the
          picker is what the recogniser will load, not a wish list. */}
      <div className="form-row" style={{ marginTop: 16 }}>
        <label>{t('nemotron.model')}</label>
        {downloadedModels.length > 0 ? (
          <select
            className="select"
            value={config.modelId}
            onChange={(e) => edit({ modelId: e.target.value })}
          >
            {downloadedModels.map((m) => (
              <option key={m.id} value={m.id}>
                {lang === 'zh' ? m.description_zh : m.description_en}
              </option>
            ))}
          </select>
        ) : (
          <p className="hint" style={{ color: 'var(--warning)' }}>
            {t('nemotron.needDownload')}
          </p>
        )}
      </div>

      <div className="form-row" style={{ marginTop: 16 }}>
        <label>{t('nemotron.threads')}</label>
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
            // Only push a value the whole chain accepts. Mid-edit states — empty
            // field, a lone "-", "2." — stay in the box and are settled on blur,
            // so typing never commits a draft the backend would have to reject.
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
      </div>

      {ENDPOINT_FIELDS.map((f) => {
        const value = config[f.key];
        const pct = ((value - f.min) / (f.max - f.min)) * 100;
        return (
          <div key={f.key} className="vad-field" style={{ marginTop: 16 }}>
            <div className="vad-field-head">
              <label>{tk(`nemotron.${f.key}`)}</label>
              <span className="vad-value">{value.toFixed(f.decimals)}</span>
            </div>
            <input
              type="range"
              className="vad-slider"
              min={f.min}
              max={f.max}
              step={f.step}
              value={value}
              onChange={(e) => edit({ [f.key]: parseFloat(e.target.value) })}
              style={{
                background: `linear-gradient(to right, var(--accent) 0%, var(--accent) ${pct}%, var(--bg-hover) ${pct}%, var(--bg-hover) 100%)`,
              }}
            />
            <p className="hint">{tk(`nemotron.${f.key}.hint`)}</p>
          </div>
        );
      })}

      <div className="divider" />

      <h3 style={{ marginBottom: 12 }}>{t('nemotron.library')}</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {models.map((m) => {
          const pct = progress[m.id];
          const isDownloading = pct !== undefined;
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
                    {m.chunk_ms} ms · {formatSize(m.archive_size_bytes)} · {t('nemotron.localeCount')}
                  </div>
                </div>
                <div style={{ flexShrink: 0, marginLeft: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
                  {m.downloaded ? (
                    <>
                      <span className="badge badge-success">{t('nemotron.downloaded')}</span>
                      <button
                        className="btn-secondary btn-sm"
                        onClick={() => handleDelete(m.id)}
                        title={t('nemotron.delete')}
                        style={{ padding: '2px 8px', fontSize: 12 }}
                      >
                        {t('nemotron.delete')}
                      </button>
                    </>
                  ) : isDownloading ? (
                    <span className="hint" style={{ marginTop: 0 }}>
                      {pct < 90
                        ? `${t('nemotron.downloading')} ${pct}%`
                        : t('nemotron.extracting')}
                    </span>
                  ) : (
                    <button
                      className="btn-secondary btn-sm"
                      onClick={() => handleDownload(m.id)}
                      disabled={anyDownloading}
                    >
                      {t('nemotron.download')}
                    </button>
                  )}
                </div>
              </div>
              {isDownloading && (
                <div style={{ marginTop: 8, height: 4, background: 'var(--bg-tertiary)', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{
                    height: '100%',
                    width: `${pct}%`,
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
