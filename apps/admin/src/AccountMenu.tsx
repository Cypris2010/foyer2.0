// Menu behind the user's name in the nav: own account and sign out.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { User } from './api.ts';
import { roleLabel } from './Users.tsx';

export function AccountMenu({ user, active, onLogout }: { user: User; active: boolean; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  // The name sits on the right of a wide nav and on the left when the nav
  // wraps: the menu lines up with the name on the side it is on and is
  // pushed back into the window if it would stick out.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const el = list.current;
      const anchor = root.current?.getBoundingClientRect();
      if (!el || !anchor) return;
      // Phones: the menu sits in the folded-out nav, not floating.
      if (getComputedStyle(el).position !== 'absolute') return el.style.removeProperty('left');
      const margin = 8;
      const width = el.offsetWidth;
      const onRight = anchor.left + anchor.width / 2 > window.innerWidth / 2;
      let left = onRight ? anchor.right - width : anchor.left;
      left = Math.min(Math.max(left, margin), window.innerWidth - width - margin);
      el.style.left = `${left - anchor.left}px`;
    };
    place();
    // After layout, unlike "resize": the nav may just have wrapped the name to the other side.
    const resize = new ResizeObserver(place);
    resize.observe(document.documentElement);
    return () => resize.disconnect();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onHash = () => setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    window.addEventListener('hashchange', onHash);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
      window.removeEventListener('hashchange', onHash);
    };
  }, [open]);

  return (
    <div className="account-menu" ref={root}>
      <button
        type="button"
        className={active ? 'account-menu__toggle active' : 'account-menu__toggle'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="account-menu"
        onClick={() => setOpen(!open)}
      >
        <span>{user.name}</span>
        <span className="account-menu__role">{roleLabel(user.role)}</span>
        <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="M5 8l5 5 5-5" /></svg>
      </button>
      {open && (
        <div className="account-menu__list" id="account-menu" role="menu" ref={list}>
          <div className="account-menu__who">{user.email}</div>
          <a role="menuitem" href="#account">Mein Konto</a>
          <button role="menuitem" type="button" onClick={onLogout}>Abmelden</button>
        </div>
      )}
    </div>
  );
}
