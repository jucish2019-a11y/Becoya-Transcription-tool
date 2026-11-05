import { ReactNode, useEffect, useRef, useState } from 'react';

interface PopoverProps {
  /** Renders the trigger button contents. */
  label: ReactNode;
  title?: string;
  ariaLabel: string;
  disabled?: boolean;
  align?: 'left' | 'right';
  widthClass?: string;
  buttonClassName?: string;
  children: (close: () => void) => ReactNode;
}

const DEFAULT_BUTTON =
  'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-700 hover:bg-zinc-100 hover:text-zinc-900 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none';

export function Popover({
  label,
  title,
  ariaLabel,
  disabled,
  align = 'right',
  widthClass = 'w-72',
  buttonClassName = DEFAULT_BUTTON,
  children,
}: PopoverProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="true"
        aria-expanded={open}
        className={buttonClassName}
      >
        {label}
      </button>
      {open && (
        <div
          className={`absolute top-full mt-1.5 ${align === 'right' ? 'right-0' : 'left-0'} ${widthClass} bg-white border border-zinc-200 rounded-xl shadow-lg z-50 p-3`}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
