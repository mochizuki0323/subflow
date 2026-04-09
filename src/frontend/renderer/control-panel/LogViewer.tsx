import React, { useState, useRef, useEffect } from 'react';
import type { LogEntry } from '../shared/types';
import { t } from '../shared/i18n';

interface Props {
  logs: LogEntry[];
  onClear: () => void;
}

export function LogViewer({ logs, onClear }: Props) {
  const [filter, setFilter] = useState<string>('all');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const filtered = filter === 'all' ? logs : logs.filter((l) => l.level === filter);

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>{t('log.title')}</h2>
        <div className="log-controls">
          <select value={filter} onChange={(e) => setFilter(e.target.value)} className="select select-sm">
            <option value="all">{t('log.all')}</option>
            <option value="error">{t('log.error')}</option>
            <option value="warn">{t('log.warn')}</option>
            <option value="info">{t('log.info')}</option>
            <option value="debug">{t('log.debug')}</option>
          </select>
          <button onClick={onClear} className="btn-secondary btn-sm">
            {t('log.clear')}
          </button>
        </div>
      </div>

      <div className="log-list">
        {filtered.length === 0 ? (
          <p className="empty-state">{t('log.empty')}</p>
        ) : (
          filtered.map((log, i) => (
            <div key={i} className={`log-entry log-${log.level}`}>
              <span className="log-time">{log.timestamp?.split('T')[1]?.slice(0, 8) || ''}</span>
              <span className={`log-level level-${log.level}`}>{log.level.toUpperCase()}</span>
              <span className="log-message">{log.message}</span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
