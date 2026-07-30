import React, { useState, useEffect } from 'react';
import type { RemoteParakeetConfig, RemoteParakeetModelInfo, ParakeetVadConfig } from '../shared/types';
import { t } from '../shared/i18n';
import { usePending } from '../shared/pending';
import { PendingBar } from './PendingBar';

const VAD_DEFAULTS: ParakeetVadConfig = {
  threshold: 0.3,
  minSilence: 0.5,
  minSpeech: 0.25,
  maxSpeech: 15,
  partialInterval: 0.2,
};

const VAD_FIELDS: Array<{ key: keyof ParakeetVadConfig; min: number; max: number; step: number; decimals: number }> = [
  { key: 'threshold', min: 0.1, max: 0.9, step: 0.05, decimals: 2 },
  { key: 'minSilence', min: 0.1, max: 3.0, step: 0.1, decimals: 1 },
  { key: 'minSpeech', min: 0.05, max: 1.0, step: 0.05, decimals: 2 },
  { key: 'maxSpeech', min: 5, max: 30, step: 1, decimals: 0 },
  { key: 'partialInterval', min: 0.1, max: 1.0, step: 0.05, decimals: 2 },
];

// t() with a dynamically-built key (every VAD field has matching i18n entries)
const tk = (key: string): string => t(key as Parameters<typeof t>[0]);

export function RemoteParakeetSettings() {
  const [saved, setSaved] = useState<RemoteParakeetConfig | null>(null);
  const { draft: config, edit, commit, discard, changed } = usePending<RemoteParakeetConfig>('remoteParakeet', saved);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [modelOptions, setModelOptions] = useState<RemoteParakeetModelInfo[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchError, setFetchError] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [applying, setApplying] = useState(false);
  const [vadSaving, setVadSaving] = useState(false);

  useEffect(() => {
    window.electronAPI.getRemoteParakeetConfig().then(setSaved);
  }, []);

  const update = (patch: Partial<RemoteParakeetConfig>) => edit(patch);

  const urlValid = /^wss?:\/\/.+/i.test((config.serverUrl || '').trim());

  // Only the connection fields respawn the backend; the VAD is a live command.
  const restartKeys: Array<keyof RemoteParakeetConfig> = ['serverUrl', 'apiKey', 'model'];
  const needsRestart = changed.some((k) => restartKeys.includes(k));
  const cost = needsRestart ? 'restart' : 'reconnect';

  const handleApply = async () => {
    setApplying(true);
    try {
      if (needsRestart) {
        await window.electronAPI.setRemoteParakeetConfig({
          serverUrl: (config.serverUrl || '').trim(),
          apiKey: config.apiKey,
          model: config.model,
        });
      }
      if (changed.includes('vad')) await window.electronAPI.setRemoteParakeetVadConfig(config.vad);
      commit(config);
    } finally {
      setApplying(false);
    }
  };


  const handleFetchModels = async () => {
    setFetchingModels(true);
    setFetchError('');
    try {
      const r = await window.electronAPI.fetchRemoteParakeetModels(config.serverUrl.trim(), config.apiKey);
      if (r.success && r.models) {
        setModelOptions(r.models);
        // Auto-select the first model when none is chosen yet.
        if (!config.model && r.models.length > 0) update({ model: r.models[0].id });
      } else {
        setFetchError(r.error || t('remoteParakeet.fetchFailed'));
      }
    } catch {
      setFetchError(t('remoteParakeet.fetchFailed'));
    } finally {
      setFetchingModels(false);
    }
  };

  const updateVad = (key: keyof ParakeetVadConfig, value: number) => {
    edit({ vad: { ...config.vad, [key]: value } });
  };


  const handleResetVad = () => {
    edit({ vad: { ...VAD_DEFAULTS } });
  };

  const handleTest = async () => {
    setTesting(true);
    setTestMsg(null);
    try {
      const r = await window.electronAPI.testRemoteParakeet(config.serverUrl.trim(), config.apiKey);
      setTestMsg(r.success
        ? { ok: true, text: t('remoteParakeet.testOk') }
        : { ok: false, text: `${t('remoteParakeet.testFailed')}${r.error ? ` (${r.error})` : ''}` });
    } catch {
      setTestMsg({ ok: false, text: t('remoteParakeet.testFailed') });
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <PendingBar
        count={changed.length}
        cost={cost}
        applying={applying}
        onApply={handleApply}
        onDiscard={discard}
      />
      <h2>{t('remoteParakeet.title')}</h2>
      <p className="hint">{t('remoteParakeet.hint')}</p>

      <div className="form-row" style={{ marginTop: 16 }}>
        <label>{t('remoteParakeet.serverUrl')}</label>
        <input
          className="input"
          type="text"
          placeholder="wss://your-server.example.com"
          value={config.serverUrl}
          onChange={(e) => update({ serverUrl: e.target.value })}
        />
        <p className="hint">{t('remoteParakeet.serverUrlHint')}</p>
      </div>

      <div className="form-row" style={{ marginTop: 12 }}>
        <label>{t('remoteParakeet.apiKey')}</label>
        <input
          className="input"
          type="password"
          placeholder={t('remoteParakeet.apiKeyPlaceholder')}
          value={config.apiKey}
          onChange={(e) => update({ apiKey: e.target.value })}
        />
        <p className="hint">{t('remoteParakeet.apiKeyHint')}</p>
      </div>

      <div className="form-row" style={{ marginTop: 12 }}>
        <label>{t('remoteParakeet.model')}</label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {modelOptions.length > 0 ? (
            <select
              className="select"
              style={{ flex: 1 }}
              value={config.model}
              onChange={(e) => update({ model: e.target.value })}
            >
              {modelOptions.map(m => (
                <option key={m.id} value={m.id}>
                  {m.id}{m.type ? ` (${m.type})` : ''}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              className="input"
              style={{ flex: 1 }}
              value={config.model}
              placeholder={t('remoteParakeet.modelPlaceholder')}
              onChange={(e) => update({ model: e.target.value })}
            />
          )}
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={handleFetchModels}
            disabled={fetchingModels || !urlValid}
          >
            {fetchingModels ? t('remoteParakeet.fetchingModels') : t('remoteParakeet.fetchModels')}
          </button>
        </div>
        {fetchError && (
          <p className="hint" style={{ color: 'var(--error)', marginTop: 4 }}>{fetchError}</p>
        )}
        <p className="hint">{t('remoteParakeet.modelHint')}</p>
      </div>

      <div className="form-group" style={{ marginTop: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="btn-secondary" onClick={handleTest} disabled={testing || !urlValid}>
          {testing ? t('remoteParakeet.testing') : t('remoteParakeet.test')}
        </button>
      </div>

      {testMsg && (
        <div className={`test-result ${testMsg.ok ? 'test-success' : 'test-error'}`} style={{ marginTop: 8 }}>
          {testMsg.text}
        </div>
      )}

      <div className="divider" />

      {/* Advanced VAD settings — runtime, no reconnect (server-side, per client) */}
      <div className="vad-header">
        <h3 style={{ margin: 0 }}>{t('parakeet.vad.title')}</h3>
        <button className="btn-secondary btn-sm" onClick={() => setShowAdvanced(v => !v)}>
          {showAdvanced ? t('parakeet.vad.hide') : t('parakeet.vad.show')}
        </button>
      </div>
      <p className="hint" style={{ marginTop: 8 }}>{t('remoteParakeet.vad.hint')}</p>

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
    </>
  );
}
