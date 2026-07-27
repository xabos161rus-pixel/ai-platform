import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Columns2, CornerDownLeft, Keyboard, MessageSquare, MessageSquarePlus, Moon, Search, Settings, Sun } from 'lucide-react';
import type { Chat, Provider } from '../../db/types';
import { modelIds, modelLabel } from '../../lib/ai/models';
import { searchAll, type SearchHit } from '../../lib/search';
import { useT } from '../../lib/i18n';

export interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  run: () => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
  chats: Chat[];
  providers: Provider[];
  onPickChat: (id: string) => void;
  onNewChat: () => void;
  onPickModel: (providerId: string, model: string) => void;
  onToggleTheme: () => void;
  onToggleCompare: () => void;
  onOpenSettings: () => void;
  onOpenShortcuts: () => void;
}

/**
 * Командная палитра (⌘K): переход к чату, смена модели, действия — без
 * мыши и без ухода с экрана. На маке инструмент без неё ощущается медленным,
 * сколько бы кнопок ни было на виду.
 */
/**
 * Обёртка нужна, чтобы содержимое МОНТИРОВАЛОСЬ заново на каждое открытие:
 * так поиск и подсветка сбрасываются сами, без setState в эффекте (он даёт
 * каскадные рендеры).
 */
export function CommandPalette(props: Props) {
  if (!props.open) return null;
  return <Palette {...props} />;
}

function Palette({
  onClose,
  chats,
  providers,
  onPickChat,
  onNewChat,
  onPickModel,
  onToggleTheme,
  onToggleCompare,
  onOpenSettings,
  onOpenShortcuts,
}: Props) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [chatHits, setChatHits] = useState<SearchHit[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

  // Поиск по содержимому чатов — debounce 200мс, только при запросе от двух
  // символов; setState исключительно в колбэке таймера. Короче двух символов —
  // показываем обычные последние чаты (см. chatCommands ниже), без похода в БД.
  useEffect(() => {
    const id = setTimeout(() => {
      const q = query.trim();
      if (q.length < 2) {
        setChatHits([]);
        return;
      }
      void searchAll(q).then(setChatHits);
    }, 200);
    return () => clearTimeout(id);
  }, [query]);

  const commands = useMemo<Command[]>(() => {
    const base: Command[] = [
      { id: 'new', label: t('chat.newChat'), hint: '⌘N', icon: MessageSquarePlus, run: onNewChat },
      { id: 'compare', label: t('palette.compareMode'), icon: Columns2, run: onToggleCompare },
      { id: 'theme', label: t('palette.toggleTheme'), icon: Moon, run: onToggleTheme },
      { id: 'settings', label: t('nav.settings'), icon: Settings, run: onOpenSettings },
      { id: 'shortcuts', label: t('shortcuts.title'), icon: Keyboard, run: onOpenShortcuts },
    ];
    const models: Command[] = providers.flatMap((p) =>
      modelIds(p.models).map((m) => ({
        id: `model:${p.id}:${m}`,
        label: t('palette.modelPrefix', { name: modelLabel(m) }),
        hint: p.name,
        icon: Sun,
        run: () => onPickModel(p.id, m),
      })),
    );
    return [...base, ...models];
  }, [providers, onNewChat, onPickModel, onToggleTheme, onToggleCompare, onOpenSettings, onOpenShortcuts, t]);

  const filteredCommands = useMemo(() => {
    const q = query.trim().toLowerCase();
    // «?» — классический вызов справки по клавишам: поднимаем её первой
    // строкой вместо обычной подстрочной фильтрации (иначе "?" ничего не
    // находит — символа нет ни в одной подписи команды).
    if (q === '?') {
      const shortcuts = commands.find((c) => c.id === 'shortcuts');
      if (!shortcuts) return commands;
      return [shortcuts, ...commands.filter((c) => c.id !== 'shortcuts')];
    }
    if (!q) return commands;
    return commands.filter((c) => `${c.label} ${c.hint ?? ''}`.toLowerCase().includes(q));
  }, [commands, query]);

  // Чат-хиты идут ПОСЛЕ команд: короткий/пустой запрос — последние чаты без
  // фильтра (как раньше), запрос от двух символов — результаты searchAll по
  // содержимому (заголовок + текст сообщений), см. эффект выше.
  const chatCommands = useMemo<Command[]>(() => {
    const q = query.trim();
    if (q.length >= 2) {
      return chatHits.map((h) => ({
        id: `chat:${h.chat.id}`,
        label: h.chat.title || t('chat.newChat'),
        hint: h.fragment ?? t('palette.chat'),
        icon: MessageSquare,
        run: () => onPickChat(h.chat.id),
      }));
    }
    return chats.slice(0, 12).map((c) => ({
      id: `chat:${c.id}`,
      label: c.title || t('chat.newChat'),
      hint: t('palette.chat'),
      icon: MessageSquare,
      run: () => onPickChat(c.id),
    }));
  }, [chats, chatHits, query, onPickChat, t]);

  const filtered = useMemo(() => [...filteredCommands, ...chatCommands], [filteredCommands, chatCommands]);

  // Держим подсвеченный пункт в видимой части списка при навигации с клавиш.
  useEffect(() => {
    listRef.current?.querySelector('[data-active="1"]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const clamp = (i: number) => (filtered.length ? (i + filtered.length) % filtered.length : 0);

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-start justify-center pt-[12vh]">
      <button aria-label={t('common.close')} className="animate-fade-in absolute inset-0 bg-black/50" onClick={onClose} />
      <div
        role="dialog"
        className="animate-fade-in relative w-[92vw] max-w-lg overflow-hidden rounded-[var(--cc-radius)] border border-hairline bg-elevated shadow-[var(--shadow-pop)]"
      >
        <div className="flex items-center gap-2 border-b border-hairline px-3">
          <Search size={16} className="shrink-0 text-muted" />
          <input
            autoFocus
            value={query}
            placeholder={t('palette.placeholder')}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setCursor((i) => clamp(i + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setCursor((i) => clamp(i - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                filtered[cursor]?.run();
                onClose();
              } else if (e.key === 'Escape') {
                onClose();
              }
            }}
            className="min-w-0 flex-1 bg-transparent py-3 outline-none placeholder:text-muted"
          />
        </div>
        <div ref={listRef} className="cc-scroll max-h-[50vh] overflow-y-auto p-1.5">
          {!filtered.length && <p className="px-3 py-6 text-center text-sm text-muted">{t('common.notFound')}</p>}
          {filtered.map((c, i) => {
            const Icon = c.icon;
            return (
              <button
                key={c.id}
                data-active={i === cursor ? '1' : undefined}
                onMouseEnter={() => setCursor(i)}
                onClick={() => {
                  c.run();
                  onClose();
                }}
                className={`flex w-full items-center gap-2.5 rounded-[var(--cc-radius-sm)] px-2.5 py-2 text-left transition-colors ${
                  i === cursor ? 'bg-[var(--cc-fill-control)]' : ''
                }`}
              >
                <Icon size={15} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate text-sm">{c.label}</span>
                {c.hint && <span className="shrink-0 font-mono text-[var(--cc-text-caption)] text-muted">{c.hint}</span>}
                {i === cursor && <CornerDownLeft size={13} className="shrink-0 text-muted" />}
              </button>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
