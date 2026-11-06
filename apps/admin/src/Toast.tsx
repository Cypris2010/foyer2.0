// Error notification in the top right corner. Icons from Tabler Icons (MIT), outline set.
import { useEffect, type ReactNode } from 'react';
import { ApiError } from './api.ts';

export interface Toast {
  id: number;
  message: string;
  /** Foyer did not answer at all; stays until closed. */
  unreachable: boolean;
}

/** Ordinary errors close themselves after this long. */
const AUTO_CLOSE_MS = 8000;

let nextId = 1;

export function toastFor(err: unknown): Toast {
  return { id: nextId++, message: (err as Error).message, unreachable: err instanceof ApiError && err.unreachable };
}

const alertIcon = (
  <>
    <path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0" />
    <path d="M12 8v4" />
    <path d="M12 16h.01" />
  </>
);

const serverOffIcon = (
  <>
    <path d="M12 12h-6a3 3 0 0 1 -3 -3v-2c0 -1.083 .574 -2.033 1.435 -2.56m3.565 -.44h10a3 3 0 0 1 3 3v2a3 3 0 0 1 -3 3h-2" />
    <path d="M16 12h2a3 3 0 0 1 3 3v2m-1.448 2.568a2.986 2.986 0 0 1 -1.552 .432h-12a3 3 0 0 1 -3 -3v-2a3 3 0 0 1 3 -3h6" />
    <path d="M7 8v.01" />
    <path d="M7 16v.01" />
    <path d="M3 3l18 18" />
  </>
);

function Icon({ children, size }: { children: ReactNode; size: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

/** Render with key={toast.id} so a new error restarts the timer. */
export function ErrorToast({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  useEffect(() => {
    if (toast.unreachable) return;
    const timer = setTimeout(onClose, AUTO_CLOSE_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  return (
    <div className="toast" role="alert">
      <span className="toast__icon">
        <Icon size={22}>{toast.unreachable ? serverOffIcon : alertIcon}</Icon>
      </span>
      <div className="toast__body">
        <strong>{toast.unreachable ? 'Keine Verbindung zum Server' : 'Das hat nicht geklappt'}</strong>
        <span>{toast.message}</span>
      </div>
      <button type="button" className="toast__close" aria-label="Schließen" onClick={onClose}>
        <Icon size={16}>
          <path d="M18 6l-12 12" />
          <path d="M6 6l12 12" />
        </Icon>
      </button>
    </div>
  );
}
