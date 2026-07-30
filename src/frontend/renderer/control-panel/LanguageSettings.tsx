import React, { useState, useEffect } from 'react';
import type { BackendStatus, TranslatorConfig, SubtitleMode, ApiFormat, AppSettings, SttProvider } from '../shared/types';
import { BUILTIN_HISTORY_SYSTEM_HINT_BODY } from '../../main/translator-defaults';
import { t } from '../shared/i18n';

const TARGET_LANG_CODES = ['zh', 'en', 'ja', 'ko', 'de', 'fr', 'es', 'pt', 'ru'] as const;

// Per-format API endpoint + default model. Switching format auto-fills these
// unless the user has customized the field to a non-default value.
const API_FORMAT_DEFAULTS: Record<ApiFormat, { baseUrl: string; model: string }> = {
  openai: { baseUrl: 'https://openrouter.ai/api', model: 'google/gemma-4-31b-it' },
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-3-5-haiku-latest' },
  google: { baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemma-4-31b-it' },
};

const KNOWN_BASE_URLS = new Set(Object.values(API_FORMAT_DEFAULTS).map((d) => d.baseUrl));
const KNOWN_MODELS = new Set(Object.values(API_FORMAT_DEFAULTS).map((d) => d.model));

const API_KEY_PLACEHOLDERS: Record<ApiFormat, string> = {
  openai: 'sk-...',
  anthropic: 'sk-ant-...',
  google: 'AIza...',
};

interface Props {
  status: BackendStatus | null;
}

type TestState = null | 'testing' | 'success' | 'error';


export function LanguageSettings({ status }: Props) {
  const [sttProvider, setSttProvider] = useState<SttProvider>('parakeet');
  const [showApiKey, setShowApiKey] = useState(false);
  const [translatorConfig, setTranslatorConfig] = useState<TranslatorConfig>({
    baseUrl: 'https://openrouter.ai/api',
    apiKey: '',
    apiKeys: { openai: '', anthropic: '', google: '' },
    model: 'google/gemma-4-31b-it',
    apiFormat: 'openai',
    targetLanguage: 'zh',
    enabled: false,
    translatePartials: false,
    contextPrompt: '',
    useHistory: false,
    historyMaxPairs: 10,
    historyMaxCharsPerEntry: 0,
    historySystemHint: '',
  });
  const [testState, setTestState] = useState<TestState>(null);
  const [testError, setTestError] = useState('');

  // Deferred save state
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');

  // Verify state

  // Snapshot of saved values for dirty tracking
  const [savedTranslatorConfig, setSavedTranslatorConfig] = useState<TranslatorConfig | null>(null);

  useEffect(() => {
    window.electronAPI.getTranslatorConfig().then((config) => {
      setTranslatorConfig(config);
      setSavedTranslatorConfig(config);
    });
    window.electronAPI.getAppSettings().then((s: AppSettings) => {
    });
    window.electronAPI.getSttProvider().then(setSttProvider);
  }, []);



  const updateTranslatorConfig = (partial: Partial<TranslatorConfig>) => {
    const updated = { ...translatorConfig, ...partial };
    setTranslatorConfig(updated);
    setDirty(true);
    setSaveMsg('');
    if (testState === 'success' || testState === 'error') {
      setTestState(null);
      setTestError('');
    }
  };

  // The API key shown/edited is the one stored for the active format.
  const currentApiKey = translatorConfig.apiKeys?.[translatorConfig.apiFormat] ?? '';

  const setCurrentApiKey = (key: string) => {
    updateTranslatorConfig({
      apiKeys: { ...translatorConfig.apiKeys, [translatorConfig.apiFormat]: key },
      apiKey: key, // keep the flat mirror in sync with the active format
    });
  };

  // Switching API format swaps the endpoint, default model, and the active key,
  // but only auto-fills URL/model when they are untouched defaults — never
  // clobber a custom URL/model. Per-format keys are remembered independently.
  const handleApiFormatChange = (format: ApiFormat) => {
    if (format === translatorConfig.apiFormat) return;
    const partial: Partial<TranslatorConfig> = {
      apiFormat: format,
      apiKey: translatorConfig.apiKeys?.[format] ?? '',
    };
    if (!translatorConfig.baseUrl || KNOWN_BASE_URLS.has(translatorConfig.baseUrl)) {
      partial.baseUrl = API_FORMAT_DEFAULTS[format].baseUrl;
    }
    if (!translatorConfig.model || KNOWN_MODELS.has(translatorConfig.model)) {
      partial.model = API_FORMAT_DEFAULTS[format].model;
    }
    updateTranslatorConfig(partial);
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveMsg('');
    try {
      window.electronAPI.setTranslatorConfig(translatorConfig);
      setSavedTranslatorConfig({ ...translatorConfig });
      setDirty(false);
      setSaveMsg('success');
    } catch {
      setSaveMsg('error');
    }
    setSaving(false);
  };

  const handleTestConnection = async () => {
    setTestState('testing');
    setTestError('');
    try {
      const result = await (window.electronAPI as any).testTranslatorWithConfig(translatorConfig);
      if (result.success) {
        setTestState('success');
      } else {
        setTestState('error');
        setTestError(result.error || t('lang.translator.unknownError'));
      }
    } catch (err: any) {
      setTestState('error');
      setTestError(err?.message || t('lang.translator.connFailed'));
    }
  };


  const canTest = translatorConfig.enabled && currentApiKey && translatorConfig.baseUrl;

  return (
    <div className="panel">
      <h2>{t('lang.translator.title')}</h2>
      <p className="hint">{t('lang.translator.hint')}</p>

      <div className="toggle-row">
        <div>
          <div className="toggle-label">{t('lang.translator.enable')}</div>
          <div className="toggle-desc">
            {translatorConfig.enabled ? t('lang.translator.enabled') : t('lang.translator.disabled')}
          </div>
        </div>
        <label className="switch">
          <input
            type="checkbox"
            checked={translatorConfig.enabled}
            onChange={(e) => updateTranslatorConfig({ enabled: e.target.checked })}
          />
          <span className="switch-slider" />
        </label>
      </div>

      <div className="form-row">
        <label>{t('lang.translator.apiFormat')}</label>
        <div className="radio-group">
          {([
            { value: 'openai' as ApiFormat, labelKey: 'lang.translator.openaiCompat' },
            { value: 'anthropic' as ApiFormat, label: 'Anthropic' },
            { value: 'google' as ApiFormat, labelKey: 'lang.translator.googleAiStudio' },
          ]).map(({ value, labelKey, label }) => (
            <label
              key={value}
              className={translatorConfig.apiFormat === value ? 'active' : ''}
              onClick={() => handleApiFormatChange(value)}
            >
              <span>{labelKey ? t(labelKey as any) : label}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="form-row">
        <label>{t('lang.translator.apiUrl')}</label>
        <input
          type="text"
          className="input"
          value={translatorConfig.baseUrl}
          onChange={(e) => updateTranslatorConfig({ baseUrl: e.target.value })}
          placeholder={API_FORMAT_DEFAULTS[translatorConfig.apiFormat].baseUrl}
        />
      </div>

      <div className="form-row">
        <label>API Key</label>
        <div className="input-with-action">
          <input
            type={showApiKey ? 'text' : 'password'}
            className="input input-password"
            value={currentApiKey}
            onChange={(e) => setCurrentApiKey(e.target.value)}
            placeholder={API_KEY_PLACEHOLDERS[translatorConfig.apiFormat]}
          />
          <button
            type="button"
            className="btn-icon"
            onClick={() => setShowApiKey(!showApiKey)}
            title={showApiKey ? t('lang.hide') : t('lang.show')}
          >
            {showApiKey ? t('lang.hide') : t('lang.show')}
          </button>
        </div>
      </div>

      <div className="form-row">
        <label>{t('lang.translator.model')}</label>
        <input
          type="text"
          className="input"
          value={translatorConfig.model}
          onChange={(e) => updateTranslatorConfig({ model: e.target.value })}
          placeholder={API_FORMAT_DEFAULTS[translatorConfig.apiFormat].model}
        />
      </div>

      <div className="form-row">
        <label>{t('lang.translator.targetLang')}</label>
        <select
          value={translatorConfig.targetLanguage}
          onChange={(e) => updateTranslatorConfig({ targetLanguage: e.target.value })}
          className="select"
        >
          {TARGET_LANG_CODES.map((code) => (
            <option key={code} value={code}>
              {t(`lang.${code}` as any)}
            </option>
          ))}
        </select>
      </div>

      <div className="form-row">
        <label>{t('lang.translator.contextPrompt')}</label>
        <textarea
          className="input"
          rows={3}
          value={translatorConfig.contextPrompt}
          onChange={(e) => updateTranslatorConfig({ contextPrompt: e.target.value })}
          placeholder={t('lang.translator.contextPrompt.placeholder')}
          style={{ resize: 'vertical', fontFamily: 'inherit' }}
        />
        <p className="hint">{t('lang.translator.contextPrompt.hint')}</p>
      </div>

      <div className="toggle-row">
        <div>
          <div className="toggle-label">{t('lang.translator.history')}</div>
          <div className="toggle-desc">
            {translatorConfig.useHistory
              ? t('lang.translator.history.on')
              : t('lang.translator.history.off')}
          </div>
        </div>
        <label className="switch">
          <input
            type="checkbox"
            checked={translatorConfig.useHistory}
            onChange={(e) => updateTranslatorConfig({ useHistory: e.target.checked })}
          />
          <span className="switch-slider" />
        </label>
      </div>

      {translatorConfig.useHistory && (
        <>
          <div className="form-row">
            <label>{t('lang.translator.historyMax')}</label>
            <input
              type="number"
              className="input"
              min={1}
              max={100}
              value={translatorConfig.historyMaxPairs}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                updateTranslatorConfig({
                  historyMaxPairs: Number.isFinite(v) ? v : 10,
                });
              }}
            />
            <p className="hint">{t('lang.translator.historyMax.hint')}</p>
          </div>

          <div className="form-row">
            <label>{t('lang.translator.maxChars')}</label>
            <input
              type="number"
              className="input"
              min={0}
              value={translatorConfig.historyMaxCharsPerEntry}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                updateTranslatorConfig({
                  historyMaxCharsPerEntry: Number.isFinite(v) && v >= 0 ? v : 0,
                });
              }}
            />
            <p className="hint">
              {t('lang.translator.maxChars.hint')}
            </p>
          </div>

          <div className="form-row">
            <label>{t('lang.translator.historyHint')}</label>
            <textarea
              className="input"
              rows={3}
              value={translatorConfig.historySystemHint}
              onChange={(e) => updateTranslatorConfig({ historySystemHint: e.target.value })}
              placeholder={`${t('lang.translator.historyHint.placeholder')} ${BUILTIN_HISTORY_SYSTEM_HINT_BODY}`}
              style={{ resize: 'vertical', fontFamily: 'inherit' }}
            />
            <p className="hint">
              {t('lang.translator.historyHint.hint')}
            </p>
          </div>
        </>
      )}

      <div className="toggle-row">
        <div>
          <div className="toggle-label">{t('lang.translator.translatePartials')}</div>
          <div className="toggle-desc">
            {translatorConfig.translatePartials
              ? t('lang.translator.translatePartials.on')
              : t('lang.translator.translatePartials.off')}
          </div>
        </div>
        <label className="switch">
          <input
            type="checkbox"
            checked={translatorConfig.translatePartials}
            onChange={(e) => updateTranslatorConfig({ translatePartials: e.target.checked })}
          />
          <span className="switch-slider" />
        </label>
      </div>

      <div className="form-group" style={{ marginTop: 16, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          onClick={handleSave}
          disabled={!dirty || saving}
          className="btn-primary"
        >
          {saving ? t('lang.saving') : t('lang.save')}
        </button>

        <button
          onClick={handleTestConnection}
          disabled={!canTest || testState === 'testing'}
          className="btn-secondary"
        >
          {testState === 'testing' ? t('lang.translator.testing') : t('lang.translator.testConnection')}
        </button>

      </div>

      {saveMsg === 'success' && (
        <div className="test-result test-success">{t('lang.saved')}</div>
      )}
      {saveMsg === 'error' && (
        <div className="test-result test-error">{t('lang.saveFailed')}</div>
      )}

      {testState === 'success' && (
        <div className="test-result test-success">{t('lang.translator.testSuccess')}</div>
      )}
      {testState === 'error' && (
        <div className="test-result test-error">
          {t('lang.translator.testFail')} {testError}
        </div>
      )}
      {!canTest && translatorConfig.enabled && (
        <p className="hint" style={{ marginTop: 6, color: 'var(--warning)' }}>
          {t('lang.translator.fillRequired')}
        </p>
      )}

    </div>
  );
}
