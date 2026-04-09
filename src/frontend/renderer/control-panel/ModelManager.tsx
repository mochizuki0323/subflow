import React, { useState, useEffect } from 'react';
import type { DeepgramConfig, DeepgramFeatures } from '../shared/types';
import { t } from '../shared/i18n';

const DEFAULT_FEATURES: DeepgramFeatures = {
  smart_format: true,
  punctuate: true,
  interim_results: true,
  endpointing: 10,
  utterance_end_ms: 1000,
  diarize: false,
  vad_events: true,
  numerals: false,
};

const FEATURE_DEFS: Array<{
  key: keyof DeepgramFeatures;
  labelKey: string;
  descKey: string;
  type: 'bool' | 'endpointing';
}> = [
  { key: 'interim_results', labelKey: 'feature.interim_results', type: 'bool', descKey: 'feature.interim_results.desc' },
  { key: 'smart_format', labelKey: 'feature.smart_format', type: 'bool', descKey: 'feature.smart_format.desc' },
  { key: 'punctuate', labelKey: 'feature.punctuate', type: 'bool', descKey: 'feature.punctuate.desc' },
  { key: 'endpointing', labelKey: 'feature.endpointing', type: 'endpointing', descKey: 'feature.endpointing.desc' },
  { key: 'utterance_end_ms', labelKey: 'feature.utterance_end_ms', type: 'endpointing', descKey: 'feature.utterance_end_ms.desc' },
  { key: 'diarize', labelKey: 'feature.diarize', type: 'bool', descKey: 'feature.diarize.desc' },
  { key: 'vad_events', labelKey: 'feature.vad_events', type: 'bool', descKey: 'feature.vad_events.desc' },
  { key: 'numerals', labelKey: 'feature.numerals', type: 'bool', descKey: 'feature.numerals.desc' },
];

export function ModelManager() {
  const [config, setConfig] = useState<DeepgramConfig>({
    apiKey: '',
    model: 'nova-3',
    features: { ...DEFAULT_FEATURES },
  });
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [dirty, setDirty] = useState(false);

  const [modelOptions, setModelOptions] = useState<Array<{ name: string; canonical_name: string; version: string }>>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchError, setFetchError] = useState('');

  useEffect(() => {
    window.electronAPI.getDeepgramConfig().then((cfg) => {
      setConfig({
        ...cfg,
        features: { ...DEFAULT_FEATURES, ...(cfg.features || {}) },
      });
    });
  }, []);

  const update = (partial: Partial<DeepgramConfig>) => {
    setConfig(prev => ({ ...prev, ...partial }));
    setDirty(true);
    setSaveMsg(null);
  };

  const updateFeature = (key: keyof DeepgramFeatures, value: any) => {
    setConfig(prev => ({
      ...prev,
      features: { ...prev.features, [key]: value },
    }));
    setDirty(true);
    setSaveMsg(null);
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      await window.electronAPI.setDeepgramConfig(config);
      setSaveMsg({ ok: true, text: t('model.saved') });
      setDirty(false);
    } catch {
      setSaveMsg({ ok: false, text: t('model.saveFailed') });
    } finally {
      setSaving(false);
    }
  };

  const handleFetchModels = async () => {
    setFetchingModels(true);
    setFetchError('');
    const result = await window.electronAPI.fetchDeepgramModels();
    setFetchingModels(false);
    if (result.success && result.models) {
      setModelOptions(result.models);
    } else {
      setFetchError(result.error || t('model.fetchFailed'));
    }
  };

  return (
    <div className="panel">
      <h2>{t('model.title')}</h2>
      <p className="hint">
        {t('model.hint')}{' '}
        <a href="https://console.deepgram.com/" target="_blank" rel="noreferrer">
          console.deepgram.com
        </a>{' '}
        {t('model.hint.suffix')}
      </p>

      {/* API Key */}
      <div className="form-row">
        <label>API Key</label>
        <div className="input-with-action">
          <input
            type={showKey ? 'text' : 'password'}
            className="input input-password"
            value={config.apiKey}
            onChange={(e) => update({ apiKey: e.target.value })}
            placeholder="deepgram_api_key_..."
          />
          <button type="button" className="btn-icon" onClick={() => setShowKey(!showKey)}>
            {showKey ? t('model.hide') : t('model.show')}
          </button>
        </div>
        {!config.apiKey && (
          <p className="hint" style={{ color: 'var(--warning)', marginTop: 4 }}>
            {t('model.noKey')}
          </p>
        )}
      </div>

      {/* Model */}
      <div className="form-row">
        <label>{t('model.model')}</label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {modelOptions.length > 0 ? (
            <select
              className="select"
              style={{ flex: 1 }}
              value={config.model}
              onChange={(e) => update({ model: e.target.value })}
            >
              {modelOptions.map(m => (
                <option key={m.canonical_name} value={m.canonical_name}>
                  {m.canonical_name}{m.version ? ` (${m.version})` : ''}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              className="input"
              style={{ flex: 1 }}
              value={config.model}
              onChange={(e) => update({ model: e.target.value })}
              placeholder="nova-3"
            />
          )}
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={handleFetchModels}
            disabled={fetchingModels || !config.apiKey}
            title={t('model.fetchModels.title')}
          >
            {fetchingModels ? t('model.fetchingModels') : t('model.fetchModels')}
          </button>
        </div>
        {fetchError && (
          <p className="hint" style={{ color: 'var(--error)', marginTop: 4 }}>{fetchError}</p>
        )}
        <p className="hint">{t('model.modelHint')}</p>
      </div>

      <div className="divider" />
      <h3 style={{ marginBottom: 12 }}>{t('model.features')}</h3>

      {FEATURE_DEFS.map(({ key, labelKey, descKey, type }) => {
        if (type === 'endpointing') {
          const val = config.features[key] as number | false;
          const defaultVal = key === 'utterance_end_ms' ? 1000 : 300;
          return (
            <div key={key} className="form-row">
              <label>{t(labelKey as any)}</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={val !== false}
                    onChange={(e) => updateFeature(key, e.target.checked ? defaultVal : false)}
                  />
                  {t('model.enable')}
                </label>
                {val !== false && (
                  <input
                    type="number"
                    className="input"
                    style={{ width: 80 }}
                    min={0}
                    max={10000}
                    value={val}
                    onChange={(e) => updateFeature(key, parseInt(e.target.value) || defaultVal)}
                  />
                )}
                {val !== false && <span className="hint" style={{ marginTop: 0 }}>ms</span>}
              </div>
              <p className="hint">{t(descKey as any)}</p>
            </div>
          );
        }
        const checked = config.features[key] as boolean;
        return (
          <div key={key} className="toggle-row" style={{ marginBottom: 8 }}>
            <div>
              <div className="toggle-label">{t(labelKey as any)}</div>
              <div className="toggle-desc">{t(descKey as any)}</div>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => updateFeature(key, e.target.checked)}
              />
              <span className="switch-slider" />
            </label>
          </div>
        );
      })}

      <div className="form-group" style={{ marginTop: 16 }}>
        <button
          className="btn-primary"
          onClick={handleSave}
          disabled={saving || !dirty}
        >
          {saving ? t('model.saving') : t('model.save')}
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
