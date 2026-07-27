import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import './index.css';
import App from './App';
import { ensureSeed } from './db/db';

// Демо-провайдер и настройки создаём ДО первого рендера: иначе экран чата
// успевает увидеть пустую базу и завести чат без провайдера.
await ensureSeed();

registerSW({ immediate: true });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
