import React, { useState, useEffect } from 'react';
import { ParakeetSettings } from './ParakeetSettings';
import { RemoteParakeetSettings } from './RemoteParakeetSettings';
import type { SttProvider } from '../shared/types';
import { t } from '../shared/i18n';

const SOURCE_LANG_CODES = [
  'auto', 'zh', 'en', 'ja', 'ko', 'de', 'fr', 'es', 'pt', 'ru',
  'it', 'nl', 'pl', 'tr', 'ar', 'hi', 'th', 'vi', 'uk', 'sv',
] as const;

const ENGINES: Array<{ id: SttProvider; labelKey: string; noteKey: string }> = [
  { id: 'parakeet', labelKey: 'provider.parakeet', noteKey: 'provider.parakeet.note' },
  { id: 'remote_parakeet', labelKey: 'provider.remoteParakeet', noteKey: 'provider.remoteParakeet.note' },
];

export function ModelManager({ onProviderChange }: { onProviderChange?: (p: SttProvider) => void }) {
  const [provider, setProvider] = useState<SttProvider>('parakeet');
  const [switching, setSwitching] = useState(false);
  const [language, setLanguage] = useState('auto');

  useEffect(() => {
    window.electronAPI.getSttProvider().then(setProvider);
    window.electronAPI.getAppSettings().then((s) => setLanguage(s.sourceLanguage));
  }, []);

  // The spoken language is what the recogniser is told to expect, so it belongs to
  // this stage — it used to sit on the translation page, which does not use it.
  // Applying it only reconnects the socket, so there is nothing to defer.
  const handleLanguageChange = (lang: string) => {
    setLanguage(lang);
    window.electronAPI.setLanguage(lang);
  };

  const handleProviderChange = async (next: SttProvider) => {
    if (next === provider || switching) return;
    setSwitching(true);
    try {
      const res = await window.electronAPI.setSttProvider(next);
      // Only move the UI if the main process accepted it; it used to advance
      // regardless of the returned success flag.
      if (res.success) {
        setProvider(next);
        onProviderChange?.(next);
      }
    } finally {
      setSwitching(false);
    }
  };

  const active = ENGINES.find((e) => e.id === provider) ?? ENGINES[0];

  return (
    <div className="panel">
      <div className="section">
        <div className="block-key">{t('provider.title')}</div>
        <div className="segmented-inline">
          {ENGINES.map((engine) => (
            <button
              key={engine.id}
              type="button"
              className={`segment-btn ${provider === engine.id ? 'active' : ''}`}
              onClick={() => handleProviderChange(engine.id)}
              disabled={switching}
            >
              {t(engine.labelKey as any)}
            </button>
          ))}
        </div>
        {/* One runs on this machine, the other ships your audio to a host. That is
            the whole reason to pick one over the other, so it is stated outright
            instead of being implied by the word "server". */}
        <p className="hint">{t(active.noteKey as any)}</p>
      </div>

      <div className="section">
        <div className="block-key">{t('lang.source')}</div>
        <select
          id="source-language"
          value={language}
          onChange={(e) => handleLanguageChange(e.target.value)}
          className="select"
        >
          {SOURCE_LANG_CODES.map((code) => (
            <option key={code} value={code}>{t(`lang.${code}` as any)}</option>
          ))}
        </select>
        <p className="hint">{t('lang.source.hint')}</p>
      </div>

      <div className="divider" />

      {provider === 'remote_parakeet' ? <RemoteParakeetSettings /> : <ParakeetSettings />}
    </div>
  );
}
