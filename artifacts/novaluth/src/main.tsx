import { createRoot } from 'react-dom/client';

import App from './App';
import { ErrorBoundary } from '@/components/error-boundary';

import './index.css';

// Keep the published Replit alias from being exposed as the canonical URL.
// The development preview uses a .replit.dev hostname and remains untouched.
if (import.meta.env.PROD && window.location.hostname === 'novaluth.replit.app') {
  window.location.replace(
    `https://novaluth.com${window.location.pathname}${window.location.search}${window.location.hash}`,
  );
}

createRoot(document.getElementById('root')!, {
  // Keeps caught errors off reportError(), which would raise the dev overlay.
  onCaughtError: (error, errorInfo) => {
    console.error(error, errorInfo.componentStack);
  },
}).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch((error) => {
      console.warn("Le mode hors connexion n'a pas pu être activé.", error);
    });
  });
}
