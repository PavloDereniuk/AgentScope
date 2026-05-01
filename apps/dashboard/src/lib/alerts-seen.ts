import { useSyncExternalStore } from 'react';

// Persists the timestamp (ms epoch) at which the user last viewed the
// /alerts page. The sidebar uses it to compute "unseen critical
// alerts", which is what the count badge actually reflects — visiting
// the alerts feed should drop the badge to 0, and only newly-triggered
// critical alerts should make it light up again.
const STORAGE_KEY = 'agentscope:alerts-seen-at';

const listeners = new Set<() => void>();

function read(): number {
  if (typeof window === 'undefined') return 0;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function emit(): void {
  for (const cb of listeners) cb();
}

export function markAlertsSeen(timestamp: number = Date.now()): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, String(timestamp));
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  // Cross-tab sync — react to writes made in another tab.
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) cb();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener('storage', onStorage);
  };
}

export function useAlertsSeenAt(): number {
  return useSyncExternalStore(subscribe, read, () => 0);
}
