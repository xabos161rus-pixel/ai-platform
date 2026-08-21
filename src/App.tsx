import { Component, Suspense, lazy, useEffect, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db/db';
import { ToastProvider } from './components/ui/Toast';
import { ChatPage } from './features/chat/ChatPage';
import { resolveLang, setLang, t } from './lib/i18n';
import { runSync } from './lib/sync/engine';

// Ленивая загрузка: настройки открываются заметно реже чата, и их код
// (форма провайдера, сниппетов, экспорт/импорт) не должен утяжелять первый
// экран — самый частый путь пользователя. ChatPage ничего из features/settings
// не импортирует, поэтому граница чанка проходит здесь чисто.
const SettingsPage = lazy(() => import('./features/settings/SettingsPage'));
// Статистика — тоже по клику и тоже вне первого экрана.
const StatsPage = lazy(() => import('./features/stats/StatsPage'));

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
      // Зеркало для стартового скрипта в index.html: он ставит класс до
      // первого кадра, пока Dexie ещё не ответила.
      try {
        localStorage.setItem('cc-theme', theme);
      } catch {
        /* приватный режим — просто останемся с вспышкой при загрузке */
      }
    };
    apply();
    if (theme === 'system') {
      mq.addEventListener('change', apply);
      return () => mq.removeEventListener('change', apply);
    }
  }, [theme]);
  return null;
}

/**
 * Язык интерфейса — модульная переменная в lib/i18n.ts, а не React state:
 * t() нужна и вне React (errorText, demoReply). setLang здесь — вызов внешнего
 * модуля с оповещением подписчиков, а не setState, поэтому правило
 * react-hooks/set-state-in-effect не нарушается.
 */
function LangApplier() {
  const settings = useLiveQuery(() => db.settings.get('app'), []);
  useEffect(() => {
    setLang(resolveLang(settings?.language));
  }, [settings?.language]);
  return null;
}

/**
 * Автосинк: старт приложения, возврат вкладки (visibilitychange→visible),
 * каждые 90 с при включённом синке. runSync сам no-op, пока синк не
 * настроен — накладных для пользователей без синка нет. Ошибки сети — тихо
 * в cfg.lastError (экран настроек), без тоста на каждый неудачный фоновый тик.
 */
function SyncRunner() {
  useEffect(() => {
    void runSync().catch(() => {});
    const onVis = () => {
      if (document.visibilityState === 'visible') void runSync().catch(() => {});
    };
    document.addEventListener('visibilitychange', onVis);
    const iv = setInterval(() => {
      void runSync().catch(() => {});
    }, 90_000);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      clearInterval(iv);
    };
  }, []);
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
          <p className="text-lg font-semibold">{t('app.errorTitle')}</p>
          <p className="text-sm text-muted">{t('app.errorHint')}</p>
          <button
            onClick={() => window.location.reload()}
            className="rounded-[var(--cc-radius)] bg-accent px-5 py-3 font-medium text-[var(--cc-on-accent)] active:opacity-80"
          >
            {t('app.reload')}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/** Заглушка страницы на время загрузки её чанка: три полосы в ритме шапки. */
function PageSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6 pt-[calc(env(safe-area-inset-top)+2.5rem)]">
      <div className="cc-skeleton h-7 w-40" />
      <div className="cc-skeleton h-20 w-full" />
      <div className="cc-skeleton h-20 w-full" />
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
      <ToastProvider>
        <ThemeApplier />
        <LangApplier />
        <SyncRunner />
        <ErrorBoundary>
          {/* Скелетон вместо null: на медленной сети чанк настроек грузится
              заметно, и пустой экран читался как поломка. */}
          <Suspense fallback={<PageSkeleton />}>
            <Routes>
              <Route path="/" element={<ChatPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/stats" element={<StatsPage />} />
              {/* Неизвестный путь возвращаем в чат, а не на пустой лист. */}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </ErrorBoundary>
      </ToastProvider>
    </BrowserRouter>
  );
}
