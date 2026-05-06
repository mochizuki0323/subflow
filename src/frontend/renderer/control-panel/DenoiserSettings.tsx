import React, { useState, useEffect, useRef } from 'react';
import type { DenoiserConfig, DenoiseModelInfo } from '../shared/types';
import { t, getLang } from '../shared/i18n';

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DenoiserSettings() {
  const [config, setConfig] = useState<DenoiserConfig>({ enabled: false, modelId: 'dpdfnet8' });
  const [models, setModels] = useState<DenoiseModelInfo[]>([]);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [downloadError, setDownloadError] = useState<{ modelId: string; message: string } | null>(null);
  const downloadingRef = useRef<string | null>(null);

  const loadData = async () => {
    const [cfg, mdls, dlStatus] = await Promise.all([
      window.electronAPI.getDenoiserConfig(),
      window.electronAPI.getDenoiserModels(),
      window.electronAPI.getDownloadStatus(),
    ]);
    setConfig(cfg);
    setModels(mdls);
    if (dlStatus.length > 0) {
      const active = dlStatus[0];
      setDownloading(active.modelId);
      downloadingRef.current = active.modelId;
      setDownloadProgress(active.percent);
      const result = await window.electronAPI.downloadDenoiserModel(active.modelId);
      setDownloading(null);
      downloadingRef.current = null;
      if (result.success) {
        setModels(await window.electronAPI.getDenoiserModels());
      } else {
        setDownloadError({ modelId: active.modelId, message: result.error || t('denoise.downloadFailed') });
      }
    }
  };

  useEffect(() => { loadData(); }, []);

  useEffect(() => {
    window.electronAPI.onDenoiserDownloadProgress(({ modelId, percent }) => {
      if (modelId === downloadingRef.current) setDownloadProgress(percent);
    });
    return () => window.electronAPI.removeListeners('denoiser-download-progress');
  }, []);

  const downloadedModels = models.filter(m => m.downloaded);

  const handleDownload = async (modelId: string) => {
    if (downloading) return;
    setDownloading(modelId);
    downloadingRef.current = modelId;
    setDownloadProgress(0);
    setDownloadError(null);
    const result = await window.electronAPI.downloadDenoiserModel(modelId);
    setDownloading(null);
    downloadingRef.current = null;
    if (result.success) {
      setModels(await window.electronAPI.getDenoiserModels());
    } else {
      setDownloadError({ modelId, message: result.error || t('denoise.downloadFailed') });
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      await window.electronAPI.setDenoiserConfig(config);
      setSaveMsg({ ok: true, text: t('denoise.saved') });
      setDirty(false);
    } catch {
      setSaveMsg({ ok: false, text: t('denoise.saveFailed') });
    } finally {
      setSaving(false);
    }
  };

  const lang = getLang();
  const selectedModel = models.find(m => m.id === config.modelId);
  const isDownloaded = selectedModel?.downloaded ?? false;

  return (
    <div className="panel">
      <h2>{t('denoise.title')}</h2>
      <p className="hint">{t('denoise.hint')}</p>

      {/* Enable toggle */}
      <div className="toggle-row" style={{ marginBottom: 16, marginTop: 16 }}>
        <div>
          <div className="toggle-label">{t('denoise.enable')}</div>
          <div className="toggle-desc">
            {config.enabled ? t('denoise.enabled') : t('denoise.disabled')}
          </div>
        </div>
        <label className="switch">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => {
              setConfig(prev => ({ ...prev, enabled: e.target.checked }));
              setDirty(true);
              setSaveMsg(null);
            }}
          />
          <span className="switch-slider" />
        </label>
      </div>

      <div className="divider" />

      {/* Model selection — only downloaded models */}
      <div className="form-row">
        <label>{t('denoise.model')}</label>
        {downloadedModels.length > 0 ? (
          <select
            className="select"
            value={config.modelId}
            onChange={(e) => {
              setConfig(prev => ({ ...prev, modelId: e.target.value }));
              setDirty(true);
              setSaveMsg(null);
            }}
          >
            {downloadedModels.map(m => (
              <option key={m.id} value={m.id}>
                {lang === 'zh' ? m.description_zh : m.description_en}
              </option>
            ))}
          </select>
        ) : (
          <p className="hint" style={{ color: 'var(--warning)' }}>
            {t('denoise.needDownload')}
          </p>
        )}
        <p className="hint">{t('denoise.model.hint')}</p>
      </div>

      {/* Save button */}
      <div className="form-group" style={{ marginTop: 16 }}>
        <button
          className="btn-primary"
          onClick={handleSave}
          disabled={saving || !dirty || (config.enabled && !isDownloaded)}
        >
          {saving ? t('denoise.saving') : t('denoise.save')}
        </button>
        {saveMsg && (
          <div className={`test-result ${saveMsg.ok ? 'test-success' : 'test-error'}`} style={{ marginTop: 8 }}>
            {saveMsg.text}
          </div>
        )}
      </div>

      <div className="divider" />

      {/* Model library */}
      <h3 style={{ marginBottom: 12 }}>{t('denoise.library')}</h3>
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
                    {m.architecture} · {formatSize(m.size_bytes)} · {m.sample_rate / 1000}kHz
                  </div>
                </div>
                <div style={{ flexShrink: 0, marginLeft: 12 }}>
                  {m.downloaded ? (
                    <span className="badge badge-success">{t('denoise.downloaded')}</span>
                  ) : isDownloading ? (
                    <span className="hint" style={{ marginTop: 0 }}>{downloadProgress}%</span>
                  ) : (
                    <button
                      className="btn-secondary btn-sm"
                      onClick={() => handleDownload(m.id)}
                      disabled={!!downloading}
                    >
                      {t('denoise.download')}
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
    </div>
  );
}
