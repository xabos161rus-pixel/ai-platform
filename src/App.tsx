import { Component, useEffect, type ReactNode } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db/db';
import { ToastProvider } from './components/ui/Toast';
import { ChatPage } from './features/chat/ChatPage';
import { SettingsPage } from './features/settings/SettingsPage';

function ThemeApplier() {
  const settings = useLiveQuery(() => db.settings.get('app'), []);
  const theme = settings?.theme ?? 'dark';
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const apply = () => {
      const light = theme === 'light' || (theme === 'system' && mq.matches);
      document.documentElement.classList.toggle('light', light);
      // theme-color держим в согласии с фоном каркаса: иначе в standalone на
      // iOS у краёв видна полоса чужого оттенка.
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', light ? '#faf9f5' : '#1a1917');
    };
    apply();
    if (theme === 'system') {
      mq.addEventListener('change', apply);
      return () => mq.removeEventListener('change', apply);
    }
  }, [theme]);
  return null;
}

/** Ловит throw при рендере — вместо белого экрана показывает fallback.
 *  Данные в IndexedDB при этом целы. */
class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
          <p className="text-lg font-semibold">Что-то пошло не так</p>
          <p className="text-sm text-muted">Перезагрузите приложение — чаты сохранены на устройстве.</p>
          <button
            onClick={() => window.location.reload()}
            className="rounded-[var(--cc-radius)] bg-accent px-5 py-3 font-medium text-white active:opacity-80"
          >
            Перезагрузить
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
      <ToastProvider>
        <ThemeApplier />
        <ErrorBoundary>
          <Routes>
            <Route path="/" element={<ChatPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </ErrorBoundary>
      </ToastProvider>
    </BrowserRouter>
  );
}
