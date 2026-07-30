import React, { useState, useEffect } from 'react';
import type { RemoteParakeetConfig, RemoteParakeetModelInfo, ParakeetVadConfig } from '../shared/types';
import { t } from '../shared/i18n';

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
  const [config, setConfig] = useState<RemoteParakeetConfig>({ serverUrl: '', apiKey: '', model: '', vad: { ...VAD_DEFAULTS } });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [modelOptions, setModelOptions] = useState<RemoteParakeetModelInfo[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchError, setFetchError] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [vadDirty, setVadDirty] = useState(false);
  const [vadSaving, setVadSaving] = useState(false);
  const [vadMsg, setVadMsg] = useState<string | null>(null);

  useEffect(() => {
    window.electronAPI.getRemoteParakeetConfig().then(setConfig);
  }, []);

  const update = (patch: Partial<RemoteParakeetConfig>) => {
    setConfig(prev => ({ ...prev, ...patch }));
    setDirty(true);
    setSaveMsg(null);
  };

  const urlValid = /^wss?:\/\/.+/i.test(config.serverUrl.trim());

  const handleSave = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      await window.electronAPI.setRemoteParakeetConfig({
        serverUrl: config.serverUrl.trim(),
        apiKey: config.apiKey,
        model: config.model,
      });
      setSaveMsg({ ok: true, text: t('remoteParakeet.saved') });
      setDirty(false);
    } catch {
      setSaveMsg({ ok: false, text: t('remoteParakeet.saveFailed') });
    } finally {
      setSaving(false);
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
    setConfig(prev => ({ ...prev, vad: { ...prev.vad, [key]: value } }));
    setVadDirty(true);
    setVadMsg(null);
  };

  const handleApplyVad = async () => {
    setVadSaving(true);
    setVadMsg(null);
    try {
      const res = await window.electronAPI.setRemoteParakeetVadConfig(config.vad);
      setVadMsg(res.applied === false ? t('settings.queued') : t('parakeet.vad.applied'));
      setVadDirty(false);
    } finally {
      setVadSaving(false);
    }
  };

  const handleResetVad = () => {
    setConfig(prev => ({ ...prev, vad: { ...VAD_DEFAULTS } }));
    setVadDirty(true);
    setVadMsg(null);
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
        <button className="btn-primary" onClick={handleSave} disabled={saving || !dirty || !urlValid}>
          {saving ? t('remoteParakeet.saving') : t('remoteParakeet.save')}
        </button>
        <button className="btn-secondary" onClick={handleTest} disabled={testing || !urlValid}>
          {testing ? t('remoteParakeet.testing') : t('remoteParakeet.test')}
        </button>
      </div>

      {saveMsg && (
        <div className={`test-result ${saveMsg.ok ? 'test-success' : 'test-error'}`} style={{ marginTop: 8 }}>
          {saveMsg.text}
        </div>
      )}
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
            <button className="btn-primary" onClick={handleApplyVad} disabled={vadSaving || !vadDirty}>
              {t('parakeet.vad.apply')}
            </button>
            <button className="btn-secondary" onClick={handleResetVad} disabled={vadSaving}>
              {t('parakeet.vad.reset')}
            </button>
            {vadMsg && <span className="vad-applied">{vadMsg}</span>}
          </div>
        </div>
      )}
    </>
  );
}
