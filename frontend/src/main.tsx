import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';
import { playInApp } from './lib/native';

// Opened at a /watch/ URL inside the Android app: its own player takes over.
if (playInApp(window.location.pathname + window.location.search)) window.history.replaceState(null, '', '/');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
