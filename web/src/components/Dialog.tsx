import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button, cx } from './ui.tsx';

export function Dialog({
  open,
  title,
  onClose,
  children,
  footer,
  size = 'md',
  dismissable = true,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'md' | 'lg';
  dismissable?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => {
      const target = ref.current?.querySelector<HTMLElement>('[data-autofocus]') ?? ref.current?.querySelector<HTMLElement>('input, textarea, select, button');
      target?.focus();
    });
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && dismissable) {
        event.stopPropagation();
        onClose();
      }
      if (event.key === 'Tab' && ref.current) {
        const focusable = [...ref.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(
          (el) => !el.hasAttribute('disabled'),
        );
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable.at(-1)!;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      previous?.focus?.();
    };
  }, [open, dismissable, onClose]);

  if (!open) return null;
  return createPortal(
    <div
      className="dialog-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && dismissable) onClose();
      }}
    >
      <div ref={ref} className={cx('dialog', size === 'lg' && 'lg')} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="dialog-header" id={titleId}>
          {title}
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

type Request =
  | { kind: 'confirm'; title: string; message: ReactNode; confirmLabel: string; danger: boolean; resolve: (value: boolean) => void }
  | { kind: 'prompt'; title: string; label: string; initial: string; confirmLabel: string; resolve: (value: string | null) => void };

let current: Request | null = null;
const subscribers = new Set<() => void>();
const emit = (): void => subscribers.forEach((s) => s());

export function confirmDialog(options: { title: string; message: ReactNode; confirmLabel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    current = { kind: 'confirm', title: options.title, message: options.message, confirmLabel: options.confirmLabel ?? 'Confirm', danger: options.danger ?? false, resolve };
    emit();
  });
}

export function promptDialog(options: { title: string; label: string; initial?: string; confirmLabel?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    current = { kind: 'prompt', title: options.title, label: options.label, initial: options.initial ?? '', confirmLabel: options.confirmLabel ?? 'Save', resolve };
    emit();
  });
}

function PromptBody({ request, onDone }: { request: Extract<Request, { kind: 'prompt' }>; onDone: (value: string | null) => void }) {
  const [value, setValue] = useState(request.initial);
  const inputId = useId();
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim()) onDone(value.trim());
      }}
    >
      <label htmlFor={inputId} className="visually-hidden">
        {request.label}
      </label>
      <input
        id={inputId}
        className="input"
        data-autofocus
        value={value}
        placeholder={request.label}
        onChange={(e) => setValue(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
      />
      <div className="dialog-footer flush">
        <Button onClick={() => onDone(null)}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!value.trim()}>
          {request.confirmLabel}
        </Button>
      </div>
    </form>
  );
}

export function DialogHost() {
  const request = useSyncExternalStore(
    (cb) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    () => current,
  );
  if (!request) return null;
  const finish = (value: boolean | string | null): void => {
    current = null;
    emit();
    (request.resolve as (v: typeof value) => void)(value);
  };
  if (request.kind === 'prompt') {
    return (
      <Dialog open title={request.title} onClose={() => finish(null)}>
        <PromptBody request={request} onDone={finish} />
      </Dialog>
    );
  }
  return (
    <Dialog
      open
      title={request.title}
      onClose={() => finish(false)}
      footer={
        <>
          <Button onClick={() => finish(false)}>Cancel</Button>
          <Button variant={request.danger ? 'danger-solid' : 'primary'} data-autofocus onClick={() => finish(true)}>
            {request.confirmLabel}
          </Button>
        </>
      }
    >
      {request.message}
    </Dialog>
  );
}
