import React, { useState, useEffect } from 'react';
import type { AudioSource, BackendStatus } from '../shared/types';
import { t } from '../shared/i18n';

interface Props {
  sources: AudioSource[];
  status: BackendStatus | null;
  overlayVisible: boolean;
  onToggleOverlay: (visible: boolean) => void;
  historyVisible: boolean;
  onToggleHistory: (visible: boolean) => void;
  dragMode: boolean;
  onToggleDragMode: (active: boolean) => void;
}

export function SourceSelector({ sources, status, overlayVisible, onToggleOverlay, historyVisible, onToggleHistory, dragMode, onToggleDragMode }: Props) {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);

  // Sync selectedId from backend status
  useEffect(() => {
    if (status?.capture_source_id && status.capture_source_id > 0) {
      setSelectedId(status.capture_source_id);
    }
  }, [status?.capture_source_id]);

  useEffect(() => {
    // Remove any stale listeners from previous mounts before adding a new one.
    window.electronAPI.removeListeners('audio_level');
    window.electronAPI.onAudioLevel((data) => {
      setAudioLevel(data.level);
    });
    return () => {
      window.electronAPI.removeListeners('audio_level');
    };
  }, []);

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

  const handleToggleOverlay = async () => {
    const newState = await window.electronAPI.toggleOverlay();
    onToggleOverlay(newState);
  };

  const handleToggleHistory = async () => {
    const newState = await window.electronAPI.toggleHistory();
    onToggleHistory(newState);
  };

  const handleToggleDragMode = async () => {
    const newState = await window.electronAPI.toggleDragMode();
    onToggleDragMode(newState);
  };

  const isCapturing = status?.state === 'capturing' || status?.state === 'running';
  const captureName = status?.capture_source_name;
  // Map RMS to 0-100 percentage (RMS 0.0-0.3 range mapped to visual bar)
  const levelPercent = Math.min(100, Math.round(audioLevel / 0.3 * 100));

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>{t('source.title')}</h2>
        <button onClick={handleRefresh} className="btn-secondary btn-sm">
          {t('source.refresh')}
        </button>
      </div>

      {/* Model not loaded warning */}
      {isCapturing && status && !status.model_loaded && (
        <div className="current-model-banner warn" style={{ marginBottom: 8 }}>
          {t('source.modelNotLoaded')}
        </div>
      )}

      {/* Capture status banner */}
      {isCapturing && captureName ? (
        <div className="current-model-banner">
          {t('source.capturing')} <strong>{captureName}</strong>
          <div className="audio-level-bar" style={{ marginTop: 6 }}>
            <div className="audio-level-label">{t('source.volume')}</div>
            <div className="audio-level-track">
              <div
                className={`audio-level-fill ${levelPercent > 5 ? 'active' : ''}`}
                style={{ width: `${levelPercent}%` }}
              />
            </div>
            <div className="audio-level-value">{levelPercent}%</div>
          </div>
        </div>
      ) : (
        <div className="current-model-banner warn">
          {t('source.notCapturing')}
        </div>
      )}

      {sources.length === 0 ? (
        <p className="empty-state">
          {status
            ? t('source.noSources')
            : t('source.backendDisconnected')}
        </p>
      ) : (
        <ul className="source-list">
          {sources.map((source) => {
            const isActive = isCapturing && selectedId === source.id;
            return (
              <li
                key={source.id}
                className={`source-item ${selectedId === source.id ? 'selected' : ''} ${isActive ? 'source-active' : ''}`}
                onClick={() => handleSelect(source.id)}
              >
                <div className="source-name">
                  {source.name}
                  {isActive && <span className="badge badge-loaded" style={{ marginLeft: 8 }}>{t('source.capturingBadge')}</span>}
                </div>
                <div className="source-desc">{source.desc}</div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="controls">
        <button onClick={handleStop} disabled={!isCapturing} className="btn-danger">
          {t('source.stop')}
        </button>
        <button
          onClick={handleToggleOverlay}
          className={overlayVisible ? 'btn-overlay-on' : 'btn-secondary'}
        >
          {overlayVisible ? t('source.overlay.on') : t('source.overlay.off')}
        </button>
        <button
          onClick={handleToggleHistory}
          className={historyVisible ? 'btn-overlay-on' : 'btn-secondary'}
        >
          {historyVisible ? t('source.history.on') : t('source.history.off')}
        </button>
      </div>
      <div className="controls" style={{ marginTop: 6 }}>
        <button
          onClick={handleToggleDragMode}
          className={dragMode ? 'btn-overlay-on' : 'btn-secondary'}
          title={t('source.dragMode.title')}
        >
          {dragMode ? t('source.dragMode.unlocked') : t('source.dragMode.adjust')}
        </button>
      </div>
    </div>
  );
}
