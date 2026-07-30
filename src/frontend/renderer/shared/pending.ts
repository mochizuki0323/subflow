import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * How a setting reaches the backend, and therefore what applying it costs.
 *
 *  live     stored and sent immediately; nothing to defer
 *  reconnect  applied over the open socket, or replayed when it returns
 *  restart  respawns the C++ backend, so capture stops for a couple of seconds
 */
export type ApplyCost = 'live' | 'reconnect' | 'restart';

/**
 * Drafts live outside React so switching tabs cannot destroy them.
 *
 * Every settings panel is conditionally mounted, so a half-typed API key used to be
 * thrown away the moment the user looked at another page — with no warning, and no
 * way to get it back. Keeping the draft here means leaving a page is free.
 */
const drafts = new Map<string, unknown>();
const pendingCounts = new Map<string, number>();

export function pendingTotal(): number {
  let total = 0;
  pendingCounts.forEach((n) => { total += n; });
  return total;
}

function changedKeys<T extends object>(draft: T, saved: T): Array<keyof T> {
  return (Object.keys(draft) as Array<keyof T>).filter(
    (k) => JSON.stringify(draft[k]) !== JSON.stringify(saved[k]),
  );
}

export interface Pending<T extends object> {
  draft: T;
  /** Merge a partial into the draft. */
  edit: (partial: Partial<T>) => void;
  /** Replace both draft and baseline, e.g. after a successful apply or a reload. */
  commit: (value: T) => void;
  /** Throw the draft away and go back to what is stored. */
  discard: () => void;
  changed: Array<keyof T>;
  dirty: boolean;
}

/**
 * A draft over a saved value, with `dirty` derived by comparison rather than set by
 * a flag. Panels used to mark themselves dirty on any keystroke, so toggling a
 * switch twice and pressing Save restarted the backend for a byte-identical config.
 */
export function usePending<T extends object>(key: string, saved: T | null): Pending<T> {
  const [, force] = useState(0);
  const draftRef = useRef<T | null>((drafts.get(key) as T) ?? null);
  const savedRef = useRef<T | null>(saved);

  // Adopt the stored value the first time it arrives, but never clobber an edit in
  // progress — the load can land after the user has started typing.
  useEffect(() => {
    if (!saved) return;
    savedRef.current = saved;
    if (draftRef.current === null) {
      draftRef.current = saved;
      drafts.set(key, saved);
      force((n) => n + 1);
    }
  }, [key, saved]);

  const draft = (draftRef.current ?? saved ?? ({} as T));
  const base = savedRef.current ?? saved ?? ({} as T);
  const changed = changedKeys(draft, base);

  useEffect(() => {
    pendingCounts.set(key, changed.length);
    return () => { pendingCounts.set(key, 0); };
  }, [key, changed.length]);

  const edit = useCallback((partial: Partial<T>) => {
    const next = { ...(draftRef.current ?? ({} as T)), ...partial } as T;
    draftRef.current = next;
    drafts.set(key, next);
    force((n) => n + 1);
  }, [key]);

  const commit = useCallback((value: T) => {
    savedRef.current = value;
    draftRef.current = value;
    drafts.set(key, value);
    force((n) => n + 1);
  }, [key]);

  const discard = useCallback(() => {
    draftRef.current = savedRef.current;
    drafts.set(key, savedRef.current as T);
    force((n) => n + 1);
  }, [key]);

  return { draft, edit, commit, discard, changed, dirty: changed.length > 0 };
}
