import React, { useState, useEffect } from 'react';
import type { RemoteParakeetConfig } from '../shared/types';
import { t } from '../shared/i18n';

export function RemoteParakeetSettings() {
  const [config, setConfig] = useState<RemoteParakeetConfig>({ serverUrl: '', apiKey: '' });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);

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
      });
      setSaveMsg({ ok: true, text: t('remoteParakeet.saved') });
      setDirty(false);
    } catch {
      setSaveMsg({ ok: false, text: t('remoteParakeet.saveFailed') });
    } finally {
      setSaving(false);
    }
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
    </>
  );
}
