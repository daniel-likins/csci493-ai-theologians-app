import { Check } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { cx } from './ui.tsx';

export type Placement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';

export function usePopover<T extends HTMLElement = HTMLButtonElement>() {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<T>(null);
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((o) => !o), []);
  return { open, setOpen, close, toggle, anchorRef };
}

export function Popover({
  open,
  onClose,
  anchorRef,
  children,
  placement = 'bottom-start',
  className,
  style,
  role = 'dialog',
  label,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  placement?: Placement;
  className?: string;
  style?: CSSProperties;
  role?: string;
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const place = (): void => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      const el = ref.current;
      if (!anchor || !el) return;
      const width = el.offsetWidth;
      const height = el.scrollHeight;
      let [side, align] = placement.split('-') as ['bottom' | 'top', 'start' | 'end'];
      const below = window.innerHeight - anchor.bottom - 12;
      const above = anchor.top - 12;
      if (side === 'bottom' && height > below && above > below) side = 'top';
      if (side === 'top' && height > above && below > above) side = 'bottom';
      const maxHeight = Math.max(160, Math.min(side === 'bottom' ? below : above, window.innerHeight * 0.75));
      const top = side === 'bottom' ? anchor.bottom + 6 : Math.max(8, anchor.top - 6 - Math.min(height, maxHeight));
      const rawLeft = align === 'end' ? anchor.right - width : anchor.left;
      setPosition({ top, left: Math.min(Math.max(8, rawLeft), window.innerWidth - width - 8), maxHeight });
    };
    place();
    const observer = new ResizeObserver(place);
    if (ref.current) observer.observe(ref.current);
    window.addEventListener('resize', place);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [open, placement, anchorRef]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    };
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        anchorRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, onClose, anchorRef]);

  // Move focus into the popover as soon as it is positioned and visible (before paint), so keyboard
  // navigation works immediately after opening.
  const focusedOnOpen = useRef(false);
  useLayoutEffect(() => {
    if (!open) {
      focusedOnOpen.current = false;
      return;
    }
    if (!position || focusedOnOpen.current) return;
    focusedOnOpen.current = true;
    const target =
      ref.current?.querySelector<HTMLElement>('[data-autofocus]') ??
      ref.current?.querySelector<HTMLElement>('[aria-checked="true"][role^="menuitem"]') ??
      ref.current?.querySelector<HTMLElement>('[role^="menuitem"]:not([disabled]), input, button:not([disabled])');
    target?.focus();
  }, [open, position]);

  if (!open) return null;
  return createPortal(
    <div
      ref={ref}
      role={role}
      aria-label={label}
      className={cx('popover', className)}
      style={{ ...style, top: position?.top ?? -9999, left: position?.left ?? -9999, maxHeight: position?.maxHeight, visibility: position ? 'visible' : 'hidden' }}
    >
      {children}
    </div>,
    document.body,
  );
}

export type MenuNode =
  | {
      type?: 'item';
      id: string;
      label: ReactNode;
      description?: ReactNode;
      icon?: ReactNode;
      trailing?: ReactNode;
      checked?: boolean;
      danger?: boolean;
      disabled?: boolean;
      keepOpen?: boolean;
      onSelect: () => void;
    }
  | { type: 'separator'; id: string }
  | { type: 'label'; id: string; label: ReactNode };

export function MenuList({ nodes, onClose, label }: { nodes: MenuNode[]; onClose: () => void; label: string }) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not([disabled])')];
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const move = (i: number): void => {
      event.preventDefault();
      items[(i + items.length) % items.length]?.focus();
    };
    if (event.key === 'ArrowDown') move(index + 1);
    else if (event.key === 'ArrowUp') move(index - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(items.length - 1);
    else if (event.key === 'Tab') onClose();
  };
  return (
    <div role="menu" aria-label={label} onKeyDown={onKeyDown} className="menu">
      {nodes.map((node) => {
        if (node.type === 'separator') return <div key={node.id} role="separator" className="menu-sep" />;
        if (node.type === 'label') {
          return (
            <div key={node.id} className="menu-label" role="presentation">
              {node.label}
            </div>
          );
        }
        return (
          <button
            key={node.id}
            type="button"
            role={node.checked !== undefined ? 'menuitemradio' : 'menuitem'}
            aria-checked={node.checked}
            disabled={node.disabled}
            tabIndex={-1}
            className={cx('menu-item', node.danger && 'danger')}
            onClick={() => {
              node.onSelect();
              if (!node.keepOpen) onClose();
            }}
          >
            {node.icon && <span className="menu-icon">{node.icon}</span>}
            <span className="menu-text">
              <span className="menu-title">{node.label}</span>
              {node.description && <span className="desc">{node.description}</span>}
            </span>
            {node.trailing}
            <span className="menu-check" aria-hidden="true">
              {node.checked && <Check size={15} />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** A trigger button plus its dropdown menu. */
export function MenuButton({
  label,
  nodes,
  children,
  className,
  placement = 'bottom-start',
  title,
  menuClassName,
}: {
  label: string;
  nodes: MenuNode[] | (() => MenuNode[]);
  children: ReactNode;
  className?: string;
  placement?: Placement;
  title?: string;
  menuClassName?: string;
}) {
  const { open, close, toggle, anchorRef } = usePopover();
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={className}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={title ?? label}
        onClick={(event) => {
          event.stopPropagation();
          toggle();
        }}
      >
        {children}
      </button>
      <Popover open={open} onClose={close} anchorRef={anchorRef} placement={placement} role="presentation" className={menuClassName}>
        <MenuList nodes={typeof nodes === 'function' ? nodes() : nodes} onClose={close} label={label} />
      </Popover>
    </>
  );
}
