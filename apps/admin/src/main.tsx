import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { applyTheme, storedTheme } from './theme.ts';
import './styles.css';

applyTheme(storedTheme());
createRoot(document.getElementById('root')!).render(<App />);
