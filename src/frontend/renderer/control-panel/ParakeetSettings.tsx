import React, { useState, useEffect, useRef } from 'react';
import type { ParakeetConfig, ParakeetModelInfo } from '../shared/types';
import { t, getLang } from '../shared/i18n';

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function ParakeetSettings() {
  const [config, setConfig] = useState<ParakeetConfig>({ modelId: '' });
  const [models, setModels] = useState<ParakeetModelInfo[]>([]);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [downloadError, setDownloadError] = useState<{ modelId: string; message: string } | null>(null);
  const downloadingRef = useRef<string | null>(null);

  const loadData = async () => {
    const [cfg, mdls, dlStatus] = await Promise.all([
      window.electronAPI.getParakeetConfig(),
      window.electronAPI.getParakeetModels(),
      window.electronAPI.getParakeetDownloadStatus(),
    ]);
    setConfig(cfg);
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
        setConfig(prev => ({ ...prev, modelId }));
        setDirty(true);
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
      setConfig(prev => ({ ...prev, modelId: remaining.length > 0 ? remaining[0].id : '' }));
      setDirty(true);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      await window.electronAPI.setParakeetConfig(config);
      setSaveMsg({ ok: true, text: t('parakeet.saved') });
      setDirty(false);
    } catch {
      setSaveMsg({ ok: false, text: t('parakeet.saveFailed') });
    } finally {
      setSaving(false);
    }
  };

  const lang = getLang();
  const selectedModel = models.find(m => m.id === config.modelId);
  const isDownloaded = selectedModel?.downloaded ?? false;

  return (
    <>
      <h2>{t('parakeet.title')}</h2>
      <p className="hint">{t('parakeet.hint')}</p>

      {/* Model selection — only downloaded models */}
      <div className="form-row" style={{ marginTop: 16 }}>
        <label>{t('parakeet.model')}</label>
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
            {t('parakeet.needDownload')}
          </p>
        )}
        {selectedModel && (
          <p className="hint">
            {t('parakeet.languages')}: {selectedModel.languages.join(', ')}
          </p>
        )}
      </div>

      {/* Save button */}
      <div className="form-group" style={{ marginTop: 16 }}>
        <button
          className="btn-primary"
          onClick={handleSave}
          disabled={saving || !dirty || !isDownloaded}
        >
          {saving ? t('parakeet.saving') : t('parakeet.save')}
        </button>
        {saveMsg && (
          <div className={`test-result ${saveMsg.ok ? 'test-success' : 'test-error'}`} style={{ marginTop: 8 }}>
            {saveMsg.text}
          </div>
        )}
      </div>

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
