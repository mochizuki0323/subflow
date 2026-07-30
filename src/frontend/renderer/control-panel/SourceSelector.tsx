import React, { useState, useEffect } from 'react';
import type { AudioSource, BackendStatus } from '../shared/types';
import { t } from '../shared/i18n';

interface Props {
  sources: AudioSource[];
  status: BackendStatus | null;
  /** Owned by App so the monitor, the rail and this list cannot disagree. */
  capturing: boolean;
}

/** A sink mixes every application; an application stream is only that application. */
const isDevice = (source: AudioSource) => source.class.includes('Audio/Sink');

export function SourceSelector({
  sources,
  status,
  capturing,
}: Props) {
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // Sync selectedId from backend status
  useEffect(() => {
    if (status?.capture_source_id && status.capture_source_id > 0) {
      setSelectedId(status.capture_source_id);
    }
  }, [status?.capture_source_id]);

  const handleRefresh = () => {
    window.electronAPI.listSources();
  };

  const handleSelect = (id: number) => {
    setSelectedId(id);
    window.electronAPI.selectSource(id);
  };

  const handleStop = () => {
    window.electronAPI.stopCapture();
  };


  const renderGroup = (label: string, list: AudioSource[], hint?: string) =>
    list.length === 0 ? null : (
      <div className="section" key={label}>
        <div className="block-key">{label}</div>
        <ul className="source-list">
          {list.map((source) => (
            <li
              key={source.id}
              className={`source-item ${selectedId === source.id ? 'selected' : ''} ${capturing && selectedId === source.id ? 'live' : ''}`}
              onClick={() => handleSelect(source.id)}
            >
              <span className="bracket tr" aria-hidden />
              <span className="bracket bl" aria-hidden />
              <span>
                <div className="source-name">{source.name}</div>
                <div className="source-desc">
                  {source.desc}
                  {hint ? ` · ${hint}` : ''}
                </div>
              </span>
              <span className="source-id">NODE {source.id}</span>
              {capturing && selectedId === source.id && (
                <span className="chip">{t('source.capturingBadge')}</span>
              )}
            </li>
          ))}
        </ul>
      </div>
    );

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>{t('source.title')}</h2>
        <button onClick={handleRefresh} className="btn-secondary btn-sm">
          {t('source.refresh')}
        </button>
      </div>

      {capturing && status && !status.model_loaded && (
        <div className="current-model-banner warn">{t('source.modelNotLoaded')}</div>
      )}

      {sources.length === 0 ? (
        <p className="empty-state">
          {status ? t('source.noSources') : t('source.backendDisconnected')}
        </p>
      ) : (
        <>
          {renderGroup(t('src.apps'), sources.filter((s) => !isDevice(s)))}
          {renderGroup(t('src.devices'), sources.filter(isDevice), t('src.deviceHint'))}
        </>
      )}

      <div className="controls">
        <button onClick={handleStop} disabled={!capturing} className="btn-danger">
          {t('source.stop')}
        </button>
      </div>
    </div>
  );
}
