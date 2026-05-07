import React, { useState, useEffect } from 'react';
import type { BackendStatus, TranslatorConfig, SubtitleMode, ApiFormat, AppSettings, SttProvider } from '../shared/types';
import { BUILTIN_HISTORY_SYSTEM_HINT_BODY } from '../../main/translator-defaults';
import { t } from '../shared/i18n';

const SOURCE_LANG_CODES = [
  'auto', 'zh', 'en', 'ja', 'ko', 'de', 'fr', 'es', 'pt', 'ru',
  'it', 'nl', 'pl', 'tr', 'ar', 'hi', 'th', 'vi', 'uk', 'sv',
] as const;

const TARGET_LANG_CODES = ['zh', 'en', 'ja', 'ko', 'de', 'fr', 'es', 'pt', 'ru'] as const;

interface Props {
  status: BackendStatus | null;
  subtitleMode: SubtitleMode;
  onSubtitleModeChange: (mode: SubtitleMode) => void;
}

type TestState = null | 'testing' | 'success' | 'error';

interface VerifyResult {
  language: { ui: string; backend: string; match: boolean };
  subtitleMode: { ui: string; backend: string; match: boolean };
  modelLoaded: boolean;
}

export function LanguageSettings({ status, subtitleMode: initialMode, onSubtitleModeChange }: Props) {
  const [sttProvider, setSttProvider] = useState<SttProvider>('deepgram');
  const [language, setLanguage] = useState('auto');
  const [localMode, setLocalMode] = useState<SubtitleMode>(initialMode);
  const [showApiKey, setShowApiKey] = useState(false);
  const [translatorConfig, setTranslatorConfig] = useState<TranslatorConfig>({
    baseUrl: 'https://openrouter.ai/api',
    apiKey: '',
    model: 'google/gemma-4-31b-it',
    apiFormat: 'openai',
    targetLanguage: 'zh',
    enabled: false,
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
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);

  // Snapshot of saved values for dirty tracking
  const [savedLanguage, setSavedLanguage] = useState('auto');
  const [savedMode, setSavedMode] = useState<SubtitleMode>(initialMode);
  const [savedTranslatorConfig, setSavedTranslatorConfig] = useState<TranslatorConfig | null>(null);

  useEffect(() => {
    window.electronAPI.getTranslatorConfig().then((config) => {
      setTranslatorConfig(config);
      setSavedTranslatorConfig(config);
    });
    window.electronAPI.getAppSettings().then((s: AppSettings) => {
      setLanguage(s.sourceLanguage);
      setSavedLanguage(s.sourceLanguage);
      setLocalMode(s.subtitleMode);
      setSavedMode(s.subtitleMode);
    });
    window.electronAPI.getSttProvider().then(setSttProvider);
  }, []);

  useEffect(() => {
    setLocalMode(initialMode);
  }, [initialMode]);

  const handleLanguageChange = (lang: string) => {
    setLanguage(lang);
    setDirty(true);
    setSaveMsg('');
  };

  const handleModeChange = (mode: SubtitleMode) => {
    setLocalMode(mode);
    setDirty(true);
    setSaveMsg('');
  };

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

  const handleSave = async () => {
    setSaving(true);
    setSaveMsg('');
    try {
      if (language !== savedLanguage) {
        window.electronAPI.setLanguage(language);
      }
      if (localMode !== savedMode) {
        window.electronAPI.setSubtitleMode(localMode);
        window.electronAPI.setTranslate(false);
        onSubtitleModeChange(localMode);
      }
      window.electronAPI.setTranslatorConfig(translatorConfig);
      setSavedLanguage(language);
      setSavedMode(localMode);
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

  const handleVerify = async () => {
    const saved = await window.electronAPI.getAppSettings();
    if (!status) {
      setVerifyResult(null);
      return;
    }
    setVerifyResult({
      language: {
        ui: saved.sourceLanguage,
        backend: status.language || 'auto',
        match: saved.sourceLanguage === (status.language || 'auto'),
      },
      subtitleMode: {
        ui: saved.subtitleMode,
        backend: status.subtitle_mode || 'original',
        match: saved.subtitleMode === (status.subtitle_mode || 'original'),
      },
      modelLoaded: !!status.model_loaded,
    });
  };

  const canTest = translatorConfig.enabled && translatorConfig.apiKey && translatorConfig.baseUrl;

  return (
    <div className="panel">
      <h2>{t('lang.title')}</h2>

      <div className="form-group">
        <label htmlFor="language">{t('lang.source')}</label>
        <select
          id="language"
          value={language}
          onChange={(e) => handleLanguageChange(e.target.value)}
          className="select"
        >
          {SOURCE_LANG_CODES.map((code) => (
            <option key={code} value={code}>
              {t(`lang.${code}` as any)}
            </option>
          ))}
        </select>
        <p className="hint">{t('lang.source.hint')}</p>
      </div>

      <div className="form-group">
        <label>{t('lang.subtitleMode')}</label>
        <div className="radio-group">
          {([
            { value: 'original' as const, labelKey: 'lang.mode.original' },
            { value: 'translated' as const, labelKey: 'lang.mode.translated' },
            { value: 'bilingual' as const, labelKey: 'lang.mode.bilingual' },
          ]).map(({ value, labelKey }) => (
            <label
              key={value}
              className={localMode === value ? 'active' : ''}
              onClick={() => handleModeChange(value)}
            >
              <span>{t(labelKey as any)}</span>
            </label>
          ))}
        </div>
        <p className="hint">
          {localMode === 'original' && t('lang.mode.original.desc')}
          {localMode === 'translated' && t('lang.mode.translated.desc')}
          {localMode === 'bilingual' && t('lang.mode.bilingual.desc')}
        </p>
      </div>

      <div className="divider" />

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
          ]).map(({ value, labelKey, label }) => (
            <label
              key={value}
              className={translatorConfig.apiFormat === value ? 'active' : ''}
              onClick={() => updateTranslatorConfig({ apiFormat: value })}
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
          placeholder="https://openrouter.ai/api"
        />
      </div>

      <div className="form-row">
        <label>API Key</label>
        <div className="input-with-action">
          <input
            type={showApiKey ? 'text' : 'password'}
            className="input input-password"
            value={translatorConfig.apiKey}
            onChange={(e) => updateTranslatorConfig({ apiKey: e.target.value })}
            placeholder="sk-ai-v1-..."
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
          placeholder="google/gemma-4-31b-it"
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

        <button
          onClick={handleVerify}
          className="btn-secondary"
        >
          {t('lang.verify')}
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

      {verifyResult && (
        <div className="verify-result" style={{ marginTop: 12 }}>
          <div className={verifyResult.language.match ? 'test-result test-success' : 'test-result test-error'}>
            {t('lang.verify.language')}: {verifyResult.language.match ? t('lang.verify.match') : `${t('lang.verify.mismatch')} (UI: ${verifyResult.language.ui}, ${t('lang.verify.backend')}: ${verifyResult.language.backend})`}
          </div>
          <div className={verifyResult.subtitleMode.match ? 'test-result test-success' : 'test-result test-error'} style={{ marginTop: 4 }}>
            {t('lang.verify.subtitleMode')}: {verifyResult.subtitleMode.match ? t('lang.verify.match') : `${t('lang.verify.mismatch')} (UI: ${verifyResult.subtitleMode.ui}, ${t('lang.verify.backend')}: ${verifyResult.subtitleMode.backend})`}
          </div>
          <div className={verifyResult.modelLoaded ? 'test-result test-success' : 'test-result test-error'} style={{ marginTop: 4 }}>
            {t(sttProvider === 'parakeet' ? 'lang.verify.stt' : sttProvider === 'gladia' ? 'lang.verify.gladia' : 'lang.verify.deepgram')}: {verifyResult.modelLoaded ? t('lang.verify.match') : t('lang.verify.mismatch')}
          </div>
        </div>
      )}
    </div>
  );
}
