// Light/dark choice for the admin, remembered per browser. 'auto' follows the system setting.
export type Theme = 'auto' | 'light' | 'dark';

export const themes: Record<Theme, string> = { light: 'Hell', dark: 'Dunkel', auto: 'Automatisch (wie das System)' };

const STORED_THEME = 'foyer.theme';

export function storedTheme(): Theme {
  try {
    const value = localStorage.getItem(STORED_THEME);
    return value === 'light' || value === 'dark' ? value : 'auto';
  } catch {
    return 'auto';
  }
}

/** Sets data-theme on <html> (read by styles.css) and remembers the choice. */
export function applyTheme(theme: Theme) {
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    if (theme === 'auto') localStorage.removeItem(STORED_THEME);
    else localStorage.setItem(STORED_THEME, theme);
  } catch {
    // private window: just not remembered
  }
}
