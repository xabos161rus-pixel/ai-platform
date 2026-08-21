import { useCallback, useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate } from 'react-router';
import { db } from '../../db/db';
import type { Provider } from '../../db/types';
import { createChat, listChats, patchChat } from '../../lib/ai/chatRepo';
import { modelIds } from '../../lib/ai/models';
import { alive } from '../../lib/repo';
import { useT } from '../../lib/i18n';
import { Sidebar } from './Sidebar';
import { CommandPalette } from './CommandPalette';
import { ShortcutsSheet } from './ShortcutsSheet';
import { ChatPane, type ChatPaneHandle } from './ChatPane';

/**
 * Страница чатов — оркестратор: сайдбар, глобальные хоткеи, палитра и выбор
 * «какие чаты открыты». Вся жизнь одного чата (лента, стримы, композер) — в
 * ChatPane; сплит — это просто вторая панель с другим chatId.
 */
export function ChatPage() {
  const navigate = useNavigate();
  const t = useT();
  const [pickedId, setPickedId] = useState<string | null>(null);
  // Второй чат рядом (десктоп). Переживает перезагрузку: рабочая пара чатов —
  // это состояние рабочего места, а не сессии.
  const [splitId, setSplitId] = useState<string | null>(() => localStorage.getItem('ai-platform.splitId'));
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('ai-platform.sidebarCollapsed') === 'true',
  );
  const paneRef = useRef<ChatPaneHandle>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const creating = useRef(false);

  const settings = useLiveQuery(() => db.settings.get('app'), []);
  const providers = useLiveQuery(async () => alive(await db.providers.toArray()), [], [] as Provider[]);
  const chats = useLiveQuery(() => listChats(), []);
  const list = chats ?? [];
  // Активный чат — производное значение, а не состояние из эффекта:
  // синхронный setState в эффекте даёт каскадные рендеры.
  const chat = (pickedId ? list.find((c) => c.id === pickedId) : null) ?? list[0] ?? null;
  const chatId = chat?.id ?? null;
  // Сплит-чат обязан существовать и быть живым — иначе панель закрывается.
  const splitChat = splitId ? (list.find((c) => c.id === splitId) ?? null) : null;

  useEffect(() => {
    if (chats === undefined || chats.length || creating.current || !settings) return;
    creating.current = true;
    void createChat(settings.activeProviderId ?? 'demo', settings.defaultModel).finally(() => {
      creating.current = false;
    });
  }, [chats, settings]);

  const openSplit = useCallback(
    (id: string) => {
      // Один и тот же чат в двух панелях — бессмысленно и опасно гонками.
      if (id === chatId) return;
      setSplitId(id);
      localStorage.setItem('ai-platform.splitId', id);
      setNavOpen(false);
    },
    [chatId],
  );
  const closeSplit = useCallback(() => {
    setSplitId(null);
    localStorage.removeItem('ai-platform.splitId');
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((v) => {
      const next = !v;
      localStorage.setItem('ai-platform.sidebarCollapsed', String(next));
      return next;
    });
  }, []);

  async function handleNewChat() {
    if (!settings) return;
    const c = await createChat(settings.activeProviderId ?? 'demo', settings.defaultModel);
    setPickedId(c.id);
    setNavOpen(false);
    // Черновик — внутреннее состояние композера главной панели.
    paneRef.current?.insertText('');
  }

  async function setComparePicks(keys: string[]) {
    await db.settings.update('app', { compareModels: keys, updatedAt: new Date().toISOString() });
  }

  // ⌘K — палитра, ⌘N — новый чат, ⌘/ — фокус в поле, ⌘B — сайдбар. Esc
  // обрабатывают сами панели (стоп своей генерации / свой просмотрщик).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (meta && e.key === 'n') {
        e.preventDefault();
        void handleNewChat();
      } else if (meta && e.key === '/') {
        e.preventDefault();
        paneRef.current?.focusComposer();
      } else if (meta && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Клавиатура на iOS ужимает visualViewport, но layout viewport остаётся
  // прежним: каркас fixed inset-0 продолжает считать себя во весь экран.
  // Отдаём каркасу фактическую высоту видимой области — тогда ужимается и
  // лента, и композер поднимается сам, без transform поверх ленты.
  // Пишем в DOM напрямую: события сыплются на каждый кадр появления
  // клавиатуры, ререндер React на каждом был бы рваным.
  useEffect(() => {
    const vv = window.visualViewport;
    const frame = frameRef.current;
    if (!vv || !frame) return;
    const apply = () => {
      const hidden = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      frame.style.bottom = hidden ? `${hidden}px` : '';
    };
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    apply();
    return () => {
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
      frame.style.bottom = '';
    };
  }, []);

  return (
    <div ref={frameRef} className="fixed inset-0 flex bg-bg">
      {/* Аврора: fixed-слой позади всего контента, вне потока — скролл ленты
          его не задевает. Позиционированные (fixed) потомки красятся ПОСЛЕ
          обычных статичных — без z-index на контент-обёртке ниже аврора легла
          бы поверх сайдбара и текста, а не под ними. */}
      <div aria-hidden className="cc-aurora pointer-events-none fixed inset-0" />

      <div className="relative z-10 flex w-full">
        <Sidebar
          chats={list}
          activeId={chatId}
          onPick={setPickedId}
          onNew={() => void handleNewChat()}
          onOpenSplit={openSplit}
          sidebarCollapsed={sidebarCollapsed}
        />

        {/* Мобильная панель поверх экрана */}
        {navOpen && (
          <div className="fixed inset-0 z-50 flex lg:hidden">
            <button aria-label={t('common.close')} className="animate-fade-in absolute inset-0 bg-black/50" onClick={() => setNavOpen(false)} />
            <div className="relative animate-fade-in">
              <Sidebar
                chats={list}
                activeId={chatId}
                onPick={(id) => {
                  setPickedId(id);
                  setNavOpen(false);
                }}
                onNew={() => void handleNewChat()}
                overlay
                onClose={() => setNavOpen(false)}
              />
            </div>
          </div>
        )}

        <ChatPane
          ref={paneRef}
          chatId={chatId}
          primary
          sidebarCollapsed={sidebarCollapsed}
          onOpenNav={() => setNavOpen(true)}
          onToggleSidebar={toggleSidebar}
        />

        {/* Вторая панель — только широкий экран: на узком две колонки чата
            нечитаемы. Каждая панель полностью самостоятельна. */}
        {splitChat && (
          <div className="hidden min-w-0 flex-1 border-l border-hairline xl:flex">
            <ChatPane chatId={splitChat.id} onClose={closeSplit} />
          </div>
        )}
      </div>

      <ShortcutsSheet open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        chats={list}
        providers={providers}
        onPickChat={setPickedId}
        onNewChat={() => void handleNewChat()}
        onPickModel={(providerId, model) => chat && void patchChat(chat.id, { providerId, model })}
        onToggleTheme={() =>
          void db.settings.update('app', {
            theme: settings?.theme === 'light' ? 'dark' : 'light',
            updatedAt: new Date().toISOString(),
          })
        }
        onToggleCompare={() => {
          const active = providers.find((p) => p.id === (chat?.providerId ?? settings?.activeProviderId)) ?? null;
          const pool = active && !active.isDemo ? providers.filter((p) => !p.isDemo) : providers;
          const all = pool.flatMap((p) => modelIds(p.models).map((m) => `${p.id}:${m}`));
          void setComparePicks(settings?.compareModels?.length ? [] : all.slice(0, 2));
        }}
        onOpenSettings={() => navigate('/settings')}
        onOpenShortcuts={() => {
          setPaletteOpen(false);
          setShortcutsOpen(true);
        }}
      />
    </div>
  );
}

export default ChatPage;
