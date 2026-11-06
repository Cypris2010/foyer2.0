// Light/dark switch for the nav. Icons from Tabler Icons (MIT), outline set.
import { useState, type ReactNode } from 'react';
import { applyTheme, storedTheme, themes, type Theme } from './theme.ts';

const icons: Record<Theme, ReactNode> = {
  light: (
    <>
      <path d="M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0" />
      <path d="M3 12h1m8 -9v1m8 8h1m-9 8v1m-6.4 -15.4l.7 .7m12.1 -.7l-.7 .7m0 11.4l.7 .7m-12.1 -.7l-.7 .7" />
    </>
  ),
  dark: <path d="M12 3c.132 0 .263 0 .393 0a7.5 7.5 0 0 0 7.92 12.446a9 9 0 1 1 -8.313 -12.454z" />,
  auto: (
    <>
      <path d="M3 5a1 1 0 0 1 1 -1h16a1 1 0 0 1 1 1v10a1 1 0 0 1 -1 1h-16a1 1 0 0 1 -1 -1v-10z" />
      <path d="M7 20h10" />
      <path d="M9 16v4" />
      <path d="M15 16v4" />
    </>
  ),
};

export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(storedTheme());
  const change = (next: Theme) => {
    applyTheme(next);
    setTheme(next);
  };
  return (
    <div className="theme-switch" role="group" aria-label="Darstellung">
      {(Object.keys(themes) as Theme[]).map((t) => (
        <button key={t} type="button" title={themes[t]} aria-label={themes[t]} aria-pressed={theme === t} className={theme === t ? 'active' : ''} onClick={() => change(t)}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {icons[t]}
          </svg>
        </button>
      ))}
    </div>
  );
}
