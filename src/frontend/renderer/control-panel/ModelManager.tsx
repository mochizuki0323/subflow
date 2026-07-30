import React, { useState, useEffect } from 'react';
import { ParakeetSettings } from './ParakeetSettings';
import { RemoteParakeetSettings } from './RemoteParakeetSettings';
import type { SttProvider } from '../shared/types';
import { t } from '../shared/i18n';

const ENGINES: Array<{ id: SttProvider; labelKey: string; noteKey: string }> = [
  { id: 'parakeet', labelKey: 'provider.parakeet', noteKey: 'provider.parakeet.note' },
  { id: 'remote_parakeet', labelKey: 'provider.remoteParakeet', noteKey: 'provider.remoteParakeet.note' },
];

export function ModelManager({ onProviderChange }: { onProviderChange?: (p: SttProvider) => void }) {
  const [provider, setProvider] = useState<SttProvider>('parakeet');
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    window.electronAPI.getSttProvider().then(setProvider);
  }, []);

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

      <div className="divider" />

      {provider === 'remote_parakeet' ? <RemoteParakeetSettings /> : <ParakeetSettings />}
    </div>
  );
}
