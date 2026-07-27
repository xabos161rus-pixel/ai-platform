import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { MessageSquarePlus, Pin, PinOff, Search, Settings, Trash2, X } from 'lucide-react';
import type { Chat } from '../../db/types';
import { patchChat, removeChat } from '../../lib/ai/chatRepo';

interface Props {
  chats: Chat[];
  activeId: string | null;
  onPick: (id: string) => void;
  onNew: () => void;
  /** Мобильный режим: панель поверх экрана, с кнопкой закрытия. */
  overlay?: boolean;
  onClose?: () => void;
}

function groupLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const diff = startOfToday - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const day = 86_400_000;
  if (diff <= 0) return 'Сегодня';
  if (diff <= day) return 'Вчера';
  if (diff <= 7 * day) return 'На этой неделе';
  if (diff <= 30 * day) return 'В этом месяце';
  return 'Раньше';
}

/**
 * Список чатов. На широком экране — постоянная колонка слева, на телефоне
 * выезжает поверх. Одинаковый вид на обоих устройствах выдаёт прототип:
 * на маке нижняя панель вместо колонки ощущается как мобильное приложение,
 * растянутое на десктоп.
 */
export function Sidebar({ chats, activeId, onPick, onNew, overlay = false, onClose }: Props) {
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q ? chats.filter((c) => c.title.toLowerCase().includes(q)) : chats;
    const pinned = filtered.filter((c) => c.pinned);
    const rest = filtered.filter((c) => !c.pinned);
    const out: { label: string; items: Chat[] }[] = [];
    if (pinned.length) out.push({ label: 'Закреплённые', items: pinned });
    for (const c of rest) {
      const label = groupLabel(c.lastMessageAt ?? c.createdAt);
      const bucket = out.find((g) => g.label === label && g.label !== 'Закреплённые');
      if (bucket) bucket.items.push(c);
      else out.push({ label, items: [c] });
    }
    return out;
  }, [chats, query]);

  return (
    <aside
      className={`flex w-72 shrink-0 flex-col border-r border-hairline bg-surface ${
        overlay ? 'h-full' : 'hidden lg:flex'
      }`}
    >
      <div className="flex items-center gap-2 px-3 pt-[calc(env(safe-area-inset-top)+10px)] pb-2">
        {/* Сдержанная, а не залитая акцентом: кнопка не должна кричать громче
            содержимого — акцент в этом языке работает точечно. */}
        <button
          onClick={onNew}
          className="flex min-h-[var(--cc-touch)] flex-1 items-center gap-2 rounded-[var(--cc-radius)] border border-hairline px-3 text-sm font-medium transition-colors hover:border-accent hover:text-accent active:opacity-70"
        >
          <MessageSquarePlus size={17} />
          Новый чат
        </button>
        {overlay && (
          <button
            aria-label="Закрыть"
            onClick={onClose}
            className="grid size-[var(--cc-touch)] place-items-center rounded-[var(--cc-radius)] text-muted active:opacity-60"
          >
            <X size={19} />
          </button>
        )}
      </div>

      <div className="px-3 pb-2">
        <div className="flex items-center gap-2 rounded-[var(--cc-radius)] bg-surface-2 px-2.5">
          <Search size={15} className="shrink-0 text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск"
            className="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none placeholder:text-muted"
          />
          {query && (
            <button aria-label="Очистить" onClick={() => setQuery('')} className="text-muted active:opacity-60">
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {!groups.length && (
          <p className="px-2 py-6 text-center text-sm text-muted">
            {query ? 'Ничего не найдено' : 'Пока нет чатов'}
          </p>
        )}
        {groups.map((g) => (
          <div key={g.label} className="mb-1">
            <p className="px-2 pt-3 pb-1 font-mono text-[var(--cc-text-caption)] tracking-wide text-muted uppercase">
              {g.label}
            </p>
            {g.items.map((c) => (
              <ChatRow key={c.id} chat={c} active={c.id === activeId} onPick={() => onPick(c.id)} />
            ))}
          </div>
        ))}
      </nav>

      <Link
        to="/settings"
        className="flex min-h-[var(--cc-touch)] items-center gap-2 border-t border-hairline px-4 text-sm text-muted transition-colors hover:text-text"
      >
        <Settings size={17} />
        Настройки
      </Link>
    </aside>
  );
}

function ChatRow({ chat, active, onPick }: { chat: Chat; active: boolean; onPick: () => void }) {
  return (
    <div
      className={`group flex items-center gap-0.5 rounded-[var(--cc-radius)] px-1 transition-colors ${
        active ? 'bg-[var(--cc-fill-control)]' : 'hover:bg-[var(--cc-fill-ghost-hover)]'
      }`}
    >
      <button onClick={onPick} className="min-w-0 flex-1 truncate py-2 pl-2 text-left text-sm active:opacity-60">
        {chat.title}
      </button>
      {/* Действия появляются по наведению — на телефоне видны всегда, там
          наведения нет и прятать их некуда. */}
      <button
        aria-label={chat.pinned ? 'Открепить' : 'Закрепить'}
        onClick={() => void patchChat(chat.id, { pinned: !chat.pinned })}
        className={`grid size-8 shrink-0 place-items-center rounded-[var(--cc-radius-sm)] text-muted transition-opacity active:opacity-60 lg:opacity-0 lg:group-hover:opacity-100 ${
          chat.pinned ? 'lg:opacity-100' : ''
        }`}
      >
        {chat.pinned ? <PinOff size={14} /> : <Pin size={14} />}
      </button>
      <button
        aria-label="Удалить чат"
        onClick={() => {
          if (window.confirm(`Удалить чат «${chat.title}» со всей перепиской?`)) void removeChat(chat.id);
        }}
        className="grid size-8 shrink-0 place-items-center rounded-[var(--cc-radius-sm)] text-muted transition-opacity active:opacity-60 lg:opacity-0 lg:group-hover:opacity-100"
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}
