import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createApi } from './api';
import { createAppStore } from './store';
import { initTheme } from './theme';
// Brand type, bundled so the app needs no network: IBM Plex Sans (UI), JetBrains Mono (URLs, bodies, code), Archivo Black (wordmark).
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-sans/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/600.css';
import '@fontsource/jetbrains-mono/700.css';
import '@fontsource/archivo-black/400.css';
import './styles.css';

// Applied before the first render, so the window never shows the wrong theme.
initTheme();

const store = createAppStore(createApi(window.apijanus));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App store={store} />
  </StrictMode>,
);
