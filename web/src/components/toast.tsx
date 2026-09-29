import { useSyncExternalStore } from 'react';
import { errorText } from '../api/client.ts';
import { cx } from './ui.tsx';

interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
}

let toasts: Toast[] = [];
let nextId = 0;
const subscribers = new Set<() => void>();

function emit(): void {
  for (const s of subscribers) s();
}

export function toast(text: string, kind: 'info' | 'error' = 'info'): void {
  const item = { id: ++nextId, text, kind };
  toasts = [...toasts.slice(-3), item];
  emit();
  setTimeout(
    () => {
      toasts = toasts.filter((t) => t.id !== item.id);
      emit();
    },
    kind === 'error' ? 7000 : 3200,
  );
}

export function toastError(err: unknown): void {
  toast(errorText(err), 'error');
}

export function Toaster() {
  const items = useSyncExternalStore(
    (cb) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    () => toasts,
  );
  return (
    <div className="toaster" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={cx('toast', t.kind === 'error' && 'error')}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
