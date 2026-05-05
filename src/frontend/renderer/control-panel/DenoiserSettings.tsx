import React, { useState, useEffect } from 'react';
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
  const [downloadError, setDownloadError] = useState('');

  const loadData = async () => {
    const [cfg, mdls] = await Promise.all([
      window.electronAPI.getDenoiserConfig(),
      window.electronAPI.getDenoiserModels(),
    ]);
    setConfig(cfg);
    setModels(mdls);
  };

  useEffect(() => { loadData(); }, []);

  useEffect(() => {
    window.electronAPI.onDenoiserDownloadProgress(({ modelId, percent }) => {
      if (modelId === downloading) setDownloadProgress(percent);
    });
    return () => window.electronAPI.removeListeners('denoiser-download-progress');
  }, [downloading]);

  const selectedModel = models.find(m => m.id === config.modelId);
  const isDownloaded = selectedModel?.downloaded ?? false;

  const handleDownload = async () => {
    if (!config.modelId) return;
    setDownloading(config.modelId);
    setDownloadProgress(0);
    setDownloadError('');
    const result = await window.electronAPI.downloadDenoiserModel(config.modelId);
    setDownloading(null);
    if (result.success) {
      const mdls = await window.electronAPI.getDenoiserModels();
      setModels(mdls);
    } else {
      setDownloadError(result.error || t('denoise.downloadFailed'));
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

      {/* Model selection */}
      <div className="form-row">
        <label>{t('denoise.model')}</label>
        <select
          className="select"
          value={config.modelId}
          onChange={(e) => {
            setConfig(prev => ({ ...prev, modelId: e.target.value }));
            setDirty(true);
            setSaveMsg(null);
            setDownloadError('');
          }}
        >
          {models.map(m => (
            <option key={m.id} value={m.id}>
              {lang === 'zh' ? m.description_zh : m.description_en}
              {' '}({formatSize(m.size_bytes)})
              {m.downloaded ? ` ✓` : ''}
            </option>
          ))}
        </select>
        <p className="hint">{t('denoise.model.hint')}</p>
      </div>

      {/* Download button */}
      {!isDownloaded && (
        <div className="form-row">
          <button
            className="btn-secondary"
            onClick={handleDownload}
            disabled={!!downloading}
          >
            {downloading ? `${t('denoise.downloading')} ${downloadProgress}%` : t('denoise.download')}
          </button>
          {downloading && (
            <div style={{ marginTop: 8, height: 4, background: 'var(--bg-tertiary)', borderRadius: 2, overflow: 'hidden' }}>
              <div
                style={{
                  height: '100%',
                  width: `${downloadProgress}%`,
                  background: 'var(--accent)',
                  transition: 'width 0.3s ease',
                }}
              />
            </div>
          )}
          {downloadError && (
            <p className="hint" style={{ color: 'var(--error)', marginTop: 4 }}>{downloadError}</p>
          )}
        </div>
      )}

      {isDownloaded && (
        <div className="form-row">
          <span className="badge badge-success">{t('denoise.downloaded')}</span>
        </div>
      )}

      {/* Warning if enabled but not downloaded */}
      {config.enabled && !isDownloaded && !downloading && (
        <p className="hint" style={{ color: 'var(--warning)', marginTop: 8 }}>
          {t('denoise.needDownload')}
        </p>
      )}

      {/* Save button */}
      <div className="form-group" style={{ marginTop: 16 }}>
        <button
          className="btn-primary"
          onClick={handleSave}
          disabled={saving || !dirty}
        >
          {saving ? t('denoise.saving') : t('denoise.save')}
        </button>
        {saveMsg && (
          <div className={`test-result ${saveMsg.ok ? 'test-success' : 'test-error'}`} style={{ marginTop: 8 }}>
            {saveMsg.text}
          </div>
        )}
      </div>
    </div>
  );
}
