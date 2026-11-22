import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './index.css';
import { registerPortalServiceWorker } from './lib/pwa-install.js';

registerPortalServiceWorker();

if (typeof window !== 'undefined') {
  window.addEventListener('vite:preloadError', event => {
    event.preventDefault();
    try {
      const key = 'rit_chunk_reloaded_at';
      const last = Number(sessionStorage.getItem(key) || 0);
      if (Date.now() - last > 15000) {
        sessionStorage.setItem(key, String(Date.now()));
        window.location.reload();
      }
    } catch {
      window.location.reload();
    }
  });
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);

