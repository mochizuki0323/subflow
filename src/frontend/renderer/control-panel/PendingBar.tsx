import React from 'react';
import type { ApplyCost } from '../shared/pending';
import { t } from '../shared/i18n';

interface Props {
  count: number;
  cost: ApplyCost;
  applying?: boolean;
  onApply: () => void;
  onDiscard: () => void;
}

/**
 * States the cost before the click, not after.
 *
 * Saving used to reveal "backend is restarting" only in the success message, so the
 * user found out that their live captions had just been interrupted once it had
 * already happened.
 */
export function PendingBar({ count, cost, applying, onApply, onDiscard }: Props) {
  if (count === 0) return null;
  return (
    <div className="pending-bar">
      <span className="pending-count">{t('pending.count').replace('{n}', String(count))}</span>
      <span className="pending-cost">{t(`pending.cost.${cost}` as any)}</span>
      <span className="spacer" />
      <button type="button" className="btn-secondary btn-sm" onClick={onDiscard} disabled={applying}>
        {t('pending.discard')}
      </button>
      <button type="button" className="btn-primary btn-sm" onClick={onApply} disabled={applying}>
        {applying ? t('pending.applying') : t('pending.apply')}
      </button>
    </div>
  );
}
