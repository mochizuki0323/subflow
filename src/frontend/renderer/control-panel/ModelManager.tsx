import React, { useState, useEffect } from 'react';
import type { DeepgramConfig, DeepgramFeatures, GladiaConfig, GladiaFeatures, CustomVocabularyItem, SttProvider } from '../shared/types';
import { t } from '../shared/i18n';
import { ParakeetSettings } from './ParakeetSettings';
import { RemoteParakeetSettings } from './RemoteParakeetSettings';

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

function DeepgramSettings() {
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
    <>
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
    </>
  );
}

const DEFAULT_GLADIA_FEATURES: GladiaFeatures = {
  code_switching: false,
  speech_threshold: 0.8,
  audio_enhancer: false,
  endpointing: 0.01,
  max_duration_without_endpointing: 5,
  partial_transcripts: true,
  custom_vocabulary: false,
  custom_vocabulary_config: { vocabulary: [], default_intensity: 0.4 },
  custom_spelling: false,
  custom_spelling_config: { spelling_dictionary: {} },
};

const GLADIA_BOOL_FEATURES: Array<{
  key: keyof GladiaFeatures;
  labelKey: string;
  descKey: string;
}> = [
  { key: 'partial_transcripts', labelKey: 'gladia.partial_transcripts', descKey: 'gladia.partial_transcripts.desc' },
  { key: 'code_switching', labelKey: 'gladia.code_switching', descKey: 'gladia.code_switching.desc' },
  { key: 'audio_enhancer', labelKey: 'gladia.audio_enhancer', descKey: 'gladia.audio_enhancer.desc' },
  { key: 'custom_vocabulary', labelKey: 'gladia.custom_vocabulary', descKey: 'gladia.custom_vocabulary.desc' },
  { key: 'custom_spelling', labelKey: 'gladia.custom_spelling', descKey: 'gladia.custom_spelling.desc' },
];

function GladiaSettings() {
  const [config, setConfig] = useState<GladiaConfig>({
    apiKey: '',
    model: 'solaria-1',
    features: { ...DEFAULT_GLADIA_FEATURES },
  });
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [dirty, setDirty] = useState(false);

  const [modelOptions, setModelOptions] = useState<Array<{ name: string; description: string }>>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchError, setFetchError] = useState('');

  useEffect(() => {
    window.electronAPI.getGladiaConfig().then((cfg) => {
      setConfig({
        ...cfg,
        features: { ...DEFAULT_GLADIA_FEATURES, ...(cfg.features || {}) },
      });
    });
  }, []);

  const update = (partial: Partial<GladiaConfig>) => {
    setConfig(prev => ({ ...prev, ...partial }));
    setDirty(true);
    setSaveMsg(null);
  };

  const updateFeature = (key: keyof GladiaFeatures, value: any) => {
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
      await window.electronAPI.setGladiaConfig(config);
      setSaveMsg({ ok: true, text: t('gladia.saved') });
      setDirty(false);
    } catch {
      setSaveMsg({ ok: false, text: t('gladia.saveFailed') });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <h2>{t('gladia.title')}</h2>
      <p className="hint">
        {t('gladia.hint')}{' '}
        <a href="https://app.gladia.io/" target="_blank" rel="noreferrer">
          app.gladia.io
        </a>{' '}
        {t('gladia.hint.suffix')}
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
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
          />
          <button type="button" className="btn-icon" onClick={() => setShowKey(!showKey)}>
            {showKey ? t('model.hide') : t('model.show')}
          </button>
        </div>
        {!config.apiKey && (
          <p className="hint" style={{ color: 'var(--warning)', marginTop: 4 }}>
            {t('gladia.noKey')}
          </p>
        )}
      </div>

      {/* Model */}
      <div className="form-row">
        <label>{t('gladia.model')}</label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {modelOptions.length > 0 ? (
            <select
              className="select"
              style={{ flex: 1 }}
              value={config.model}
              onChange={(e) => update({ model: e.target.value })}
            >
              {modelOptions.map(m => (
                <option key={m.name} value={m.name}>
                  {m.name}{m.description ? ` — ${m.description}` : ''}
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
              placeholder="solaria-1"
            />
          )}
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={async () => {
              setFetchingModels(true);
              setFetchError('');
              const result = await window.electronAPI.fetchGladiaModels();
              setFetchingModels(false);
              if (result.success && result.models) {
                setModelOptions(result.models);
              } else {
                setFetchError(result.error || t('gladia.fetchFailed'));
              }
            }}
            disabled={fetchingModels || !config.apiKey}
            title={t('gladia.fetchModels.title')}
          >
            {fetchingModels ? t('gladia.fetchingModels') : t('gladia.fetchModels')}
          </button>
        </div>
        {fetchError && (
          <p className="hint" style={{ color: 'var(--error)', marginTop: 4 }}>{fetchError}</p>
        )}
        <p className="hint">{t('gladia.modelHint')}</p>
      </div>

      <div className="divider" />
      <h3 style={{ marginBottom: 12 }}>{t('gladia.features')}</h3>

      {/* Speech threshold */}
      <div className="form-row">
        <label>{t('gladia.speech_threshold')}</label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="number"
            className="input"
            style={{ width: 80 }}
            min={0}
            max={1}
            step={0.01}
            value={config.features.speech_threshold}
            onChange={(e) => updateFeature('speech_threshold', parseFloat(e.target.value) || 0.8)}
          />
        </div>
        <p className="hint">{t('gladia.speech_threshold.desc')}</p>
      </div>

      {/* Endpointing */}
      <div className="form-row">
        <label>{t('gladia.endpointing')}</label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="number"
            className="input"
            style={{ width: 80 }}
            min={0.01}
            max={10}
            step={0.01}
            value={config.features.endpointing}
            onChange={(e) => updateFeature('endpointing', parseFloat(e.target.value) || 0.01)}
          />
          <span className="hint" style={{ marginTop: 0 }}>s</span>
        </div>
        <p className="hint">{t('gladia.endpointing.desc')}</p>
      </div>

      {/* Max duration */}
      <div className="form-row">
        <label>{t('gladia.max_duration')}</label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="number"
            className="input"
            style={{ width: 80 }}
            min={1}
            max={60}
            step={1}
            value={config.features.max_duration_without_endpointing}
            onChange={(e) => updateFeature('max_duration_without_endpointing', parseFloat(e.target.value) || 5)}
          />
          <span className="hint" style={{ marginTop: 0 }}>s</span>
        </div>
        <p className="hint">{t('gladia.max_duration.desc')}</p>
      </div>

      {/* Boolean feature toggles */}
      {GLADIA_BOOL_FEATURES.map(({ key, labelKey, descKey }) => {
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

      {/* Custom Vocabulary config */}
      {config.features.custom_vocabulary && (
        <div style={{ marginTop: 8, marginBottom: 8 }}>
          {/* Default intensity */}
          <div className="form-row">
            <label>{t('gladia.custom_vocabulary.default_intensity')}</label>
            <input
              type="number"
              className="input"
              style={{ width: 80 }}
              min={0} max={1} step={0.1}
              value={config.features.custom_vocabulary_config.default_intensity}
              onChange={(e) => updateFeature('custom_vocabulary_config', {
                ...config.features.custom_vocabulary_config,
                default_intensity: parseFloat(e.target.value) || 0.4,
              })}
            />
            <p className="hint">{t('gladia.custom_vocabulary.default_intensity.hint')}</p>
          </div>

          {/* Vocabulary items */}
          {(config.features.custom_vocabulary_config.vocabulary as (string | CustomVocabularyItem)[]).map((item, idx) => {
            const obj: CustomVocabularyItem = typeof item === 'string' ? { value: item } : item;
            const updateItem = (patch: Partial<CustomVocabularyItem>) => {
              const list = [...config.features.custom_vocabulary_config.vocabulary] as (string | CustomVocabularyItem)[];
              list[idx] = { ...obj, ...patch };
              updateFeature('custom_vocabulary_config', {
                ...config.features.custom_vocabulary_config,
                vocabulary: list,
              });
            };
            const removeItem = () => {
              const list = [...config.features.custom_vocabulary_config.vocabulary] as (string | CustomVocabularyItem)[];
              list.splice(idx, 1);
              updateFeature('custom_vocabulary_config', {
                ...config.features.custom_vocabulary_config,
                vocabulary: list,
              });
            };
            return (
              <div key={idx} style={{
                border: '1px solid var(--border)',
                borderRadius: 6,
                padding: '8px 10px',
                marginBottom: 6,
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}>
                {/* Row 1: Word + Language + Delete */}
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input
                    type="text"
                    className="input"
                    style={{ flex: 1 }}
                    value={obj.value}
                    onChange={(e) => updateItem({ value: e.target.value })}
                    placeholder={t('gladia.custom_vocabulary.word.placeholder')}
                  />
                  <select
                    className="select"
                    style={{ width: 100 }}
                    value={obj.language || ''}
                    onChange={(e) => updateItem({ language: e.target.value || undefined })}
                  >
                    <option value="">{t('gladia.custom_vocabulary.language')}</option>
                    <option value="en">English</option>
                    <option value="zh">中文</option>
                    <option value="ja">日本語</option>
                    <option value="ko">한국어</option>
                    <option value="de">Deutsch</option>
                    <option value="fr">Français</option>
                    <option value="es">Español</option>
                    <option value="pt">Português</option>
                    <option value="ru">Русский</option>
                    <option value="it">Italiano</option>
                  </select>
                  <button
                    type="button"
                    className="btn-icon"
                    style={{ flexShrink: 0 }}
                    onClick={removeItem}
                    title="Remove"
                  >✕</button>
                </div>
                {/* Row 2: Pronunciations + Intensity */}
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input
                    type="text"
                    className="input"
                    style={{ flex: 1 }}
                    value={(obj.pronunciations || []).join(', ')}
                    onChange={(e) => {
                      const prons = e.target.value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
                      updateItem({ pronunciations: prons.length ? prons : undefined });
                    }}
                    placeholder={t('gladia.custom_vocabulary.pronunciations.placeholder')}
                  />
                  <label className="hint" style={{ marginTop: 0, flexShrink: 0 }}>{t('gladia.custom_vocabulary.intensity')}</label>
                  <input
                    type="number"
                    className="input"
                    style={{ width: 64 }}
                    min={0} max={1} step={0.1}
                    value={obj.intensity ?? ''}
                    onChange={(e) => {
                      const v = e.target.value;
                      updateItem({ intensity: v ? parseFloat(v) : undefined });
                    }}
                    placeholder="—"
                  />
                </div>
              </div>
            );
          })}

          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={() => {
              const list = [...config.features.custom_vocabulary_config.vocabulary, { value: '' }] as (string | CustomVocabularyItem)[];
              updateFeature('custom_vocabulary_config', {
                ...config.features.custom_vocabulary_config,
                vocabulary: list,
              });
            }}
          >
            {t('gladia.custom_vocabulary.add')}
          </button>
        </div>
      )}

      {/* Custom Spelling config */}
      {config.features.custom_spelling && (
        <div className="form-row" style={{ marginTop: 8 }}>
          <label>{t('gladia.custom_spelling.dict')}</label>
          <textarea
            className="input"
            rows={4}
            value={Object.entries(config.features.custom_spelling_config.spelling_dictionary)
              .map(([correct, variants]) => `${correct}: ${variants.join(', ')}`)
              .join('\n')}
            onChange={(e) => {
              const dict: Record<string, string[]> = {};
              for (const line of e.target.value.split('\n')) {
                const sep = line.indexOf(':');
                if (sep < 1) continue;
                const key = line.slice(0, sep).trim();
                const vals = line.slice(sep + 1).split(/[,，]/).map(s => s.trim()).filter(Boolean);
                if (key && vals.length) dict[key] = vals;
              }
              updateFeature('custom_spelling_config', { spelling_dictionary: dict });
            }}
            placeholder={t('gladia.custom_spelling.dict.placeholder')}
          />
          <p className="hint">{t('gladia.custom_spelling.dict.hint')}</p>
        </div>
      )}

      <div className="form-group" style={{ marginTop: 16 }}>
        <button
          className="btn-primary"
          onClick={handleSave}
          disabled={saving || !dirty}
        >
          {saving ? t('gladia.saving') : t('gladia.save')}
        </button>
        {saveMsg && (
          <div className={`test-result ${saveMsg.ok ? 'test-success' : 'test-error'}`} style={{ marginTop: 8 }}>
            {saveMsg.text}
          </div>
        )}
      </div>
    </>
  );
}

export function ModelManager({ onProviderChange }: { onProviderChange?: (p: SttProvider) => void }) {
  const [provider, setProvider] = useState<SttProvider>('deepgram');
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    window.electronAPI.getSttProvider().then(setProvider);
  }, []);

  const handleProviderChange = async (newProvider: SttProvider) => {
    if (newProvider === provider) return;
    setSwitching(true);
    try {
      await window.electronAPI.setSttProvider(newProvider);
      setProvider(newProvider);
      onProviderChange?.(newProvider);
    } finally {
      setSwitching(false);
    }
  };

  const renderProviderSettings = () => {
    switch (provider) {
      case 'parakeet': return <ParakeetSettings />;
      case 'remote_parakeet': return <RemoteParakeetSettings />;
      case 'gladia': return <GladiaSettings />;
      default: return <DeepgramSettings />;
    }
  };

  return (
    <div className="panel">
      {/* Provider selector */}
      <div className="form-row" style={{ marginBottom: 16 }}>
        <label>{t('provider.title')}</label>
        <div className="segmented-inline">
          <button
            type="button"
            className={`segment-btn ${provider === 'deepgram' ? 'active' : ''}`}
            onClick={() => handleProviderChange('deepgram')}
            disabled={switching}
          >
            {t('provider.deepgram')}
          </button>
          <button
            type="button"
            className={`segment-btn ${provider === 'gladia' ? 'active' : ''}`}
            onClick={() => handleProviderChange('gladia')}
            disabled={switching}
          >
            {t('provider.gladia')}
          </button>
          <button
            type="button"
            className={`segment-btn ${provider === 'parakeet' ? 'active' : ''}`}
            onClick={() => handleProviderChange('parakeet')}
            disabled={switching}
          >
            {t('provider.parakeet')}
          </button>
          <button
            type="button"
            className={`segment-btn ${provider === 'remote_parakeet' ? 'active' : ''}`}
            onClick={() => handleProviderChange('remote_parakeet')}
            disabled={switching}
          >
            {t('provider.remoteParakeet')}
          </button>
        </div>
      </div>

      <div className="divider" />

      {renderProviderSettings()}
    </div>
  );
}
