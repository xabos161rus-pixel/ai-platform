import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import {
  Check,
  ChevronRight,
  Folder,
  FolderInput,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Search,
  Settings,
  Trash2,
  X,
} from 'lucide-react';
import type { Chat } from '../../db/types';
import { listFolders, patchChat, removeChat } from '../../lib/ai/chatRepo';

interface Props {
  chats: Chat[];
  activeId: string | null;
  onPick: (id: string) => void;
  onNew: () => void;
  /** Мобильный режим: панель поверх экрана, с кнопкой закрытия. */
  overlay?: boolean;
  onClose?: () => void;
}

/** Строка меню, открытого над конкретным чатом: сам чат + место клика для позиционирования портала. */
interface MenuTarget {
  chat: Chat;
  rect: DOMRect;
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

const COLLAPSED_KEY = 'ai-platform.collapsedFolders';

/**
 * Список чатов. На широком экране — постоянная колонка слева, на телефоне
 * выезжает поверх. Одинаковый вид на обоих устройствах выдаёт прототип:
 * на маке нижняя панель вместо колонки ощущается как мобильное приложение,
 * растянутое на десктоп.
 */
export function Sidebar({ chats, activeId, onPick, onNew, overlay = false, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]'));
    } catch {
      return new Set();
    }
  });
  const [menuFor, setMenuFor] = useState<MenuTarget | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const toggleFolder = (name: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q) {
      // Плоский список без секций: во время поиска заголовок группы только мешал бы
      // сопоставлять совпадение с контекстом «когда» или «в какой папке».
      const items = chats.filter((c) => c.title.toLowerCase().includes(q));
      return items.length ? [{ kind: 'label' as const, label: '', items }] : [];
    }
    const pinned = chats.filter((c) => c.pinned);
    // Не-pinned дальше распределяются по папкам и датам — pin приоритетнее папки.
    const rest = chats.filter((c) => !c.pinned);
    const out: { kind: 'label' | 'folder'; label: string; items: Chat[] }[] = [];
    if (pinned.length) out.push({ kind: 'label', label: 'Закреплённые', items: pinned });
    for (const name of listFolders(rest)) {
      const items = rest.filter((c) => c.folder === name);
      if (items.length) out.push({ kind: 'folder', label: name, items });
    }
    const withoutFolder = rest.filter((c) => !c.folder);
    for (const c of withoutFolder) {
      const label = groupLabel(c.lastMessageAt ?? c.createdAt);
      const bucket = out.find((g) => g.kind === 'label' && g.label === label);
      if (bucket) bucket.items.push(c);
      else out.push({ kind: 'label', label, items: [c] });
    }
    return out;
  }, [chats, query]);

  const folderNames = useMemo(() => listFolders(chats), [chats]);

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

      <nav
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-2"
        onScroll={() => setMenuFor(null)}
      >
        {!groups.length && (
          <p className="px-2 py-6 text-center text-sm text-muted">
            {query ? 'Ничего не найдено' : 'Пока нет чатов'}
          </p>
        )}
        {groups.map((g) => {
          if (g.kind === 'folder') {
            const isCollapsed = collapsed.has(g.label);
            return (
              <div key={`folder:${g.label}`} className="mb-1">
                <button
                  onClick={() => toggleFolder(g.label)}
                  className="flex min-h-[var(--cc-touch)] w-full items-center gap-1.5 px-2 text-left"
                >
                  <ChevronRight
                    size={14}
                    className={`shrink-0 text-muted transition-transform ${isCollapsed ? '' : 'rotate-90'}`}
                  />
                  <Folder size={14} className="shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate text-sm">{g.label}</span>
                  <span className="ml-auto shrink-0 font-mono text-[var(--cc-text-caption)] text-muted">
                    {g.items.length}
                  </span>
                </button>
                {!isCollapsed &&
                  g.items.map((c) => (
                    <ChatRow
                      key={c.id}
                      chat={c}
                      active={c.id === activeId}
                      renaming={renamingId === c.id}
                      menuOpen={menuFor?.chat.id === c.id}
                      onPick={() => onPick(c.id)}
                      onMenu={(rect) => setMenuFor({ chat: c, rect })}
                      onEndRename={() => setRenamingId(null)}
                    />
                  ))}
              </div>
            );
          }
          return (
            <div key={`label:${g.label || 'flat'}`} className="mb-1">
              {g.label && (
                <p className="px-2 pt-3 pb-1 font-mono text-[var(--cc-text-caption)] tracking-wide text-muted uppercase">
                  {g.label}
                </p>
              )}
              {g.items.map((c) => (
                <ChatRow
                  key={c.id}
                  chat={c}
                  active={c.id === activeId}
                  renaming={renamingId === c.id}
                  menuOpen={menuFor?.chat.id === c.id}
                  onPick={() => onPick(c.id)}
                  onMenu={(rect) => setMenuFor({ chat: c, rect })}
                  onEndRename={() => setRenamingId(null)}
                />
              ))}
            </div>
          );
        })}
      </nav>

      <Link
        to="/settings"
        className="flex min-h-[var(--cc-touch)] items-center gap-2 border-t border-hairline px-4 text-sm text-muted transition-colors hover:text-text"
      >
        <Settings size={17} />
        Настройки
      </Link>

      {menuFor && (
        <RowMenu
          key={menuFor.chat.id}
          chat={menuFor.chat}
          rect={menuFor.rect}
          folderNames={folderNames}
          onClose={() => setMenuFor(null)}
          onRename={() => setRenamingId(menuFor.chat.id)}
        />
      )}
    </aside>
  );
}

function ChatRow({
  chat,
  active,
  renaming,
  menuOpen,
  onPick,
  onMenu,
  onEndRename,
}: {
  chat: Chat;
  active: boolean;
  renaming: boolean;
  menuOpen: boolean;
  onPick: () => void;
  onMenu: (rect: DOMRect) => void;
  onEndRename: () => void;
}) {
  return (
    <div
      className={`group flex items-center gap-0.5 rounded-[var(--cc-radius)] px-1 transition-colors ${
        active ? 'bg-[var(--cc-fill-control)]' : 'hover:bg-[var(--cc-fill-ghost-hover)]'
      }`}
    >
      {renaming ? (
        <input
          defaultValue={chat.title}
          autoFocus
          aria-label="Новое название"
          className="min-w-0 flex-1 bg-transparent py-2 pl-2 text-base outline-none"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              // Отмена: помечаем инпут флагом, чтобы blur ниже не сохранял значение.
              e.currentTarget.dataset.cancel = '1';
              e.currentTarget.blur();
            }
          }}
          onBlur={(e) => {
            const cancelled = e.currentTarget.dataset.cancel === '1';
            const value = e.currentTarget.value.trim();
            if (!cancelled && value && value !== chat.title) void patchChat(chat.id, { title: value });
            onEndRename();
          }}
        />
      ) : (
        <button onClick={onPick} className="min-w-0 flex-1 truncate py-2 pl-2 text-left text-sm active:opacity-60">
          {chat.title}
        </button>
      )}
      {/* Кнопка появляется по наведению — на телефоне видна всегда, там
          наведения нет и прятать её некуда. */}
      <button
        aria-label="Действия с чатом"
        onClick={(e) => onMenu(e.currentTarget.getBoundingClientRect())}
        className={`grid size-8 shrink-0 place-items-center rounded-[var(--cc-radius-sm)] text-muted transition-opacity active:opacity-60 lg:opacity-0 lg:group-hover:opacity-100 ${
          menuOpen ? 'lg:opacity-100' : ''
        }`}
      >
        <MoreHorizontal size={14} />
      </button>
    </div>
  );
}

/** Поповер действий над строкой чата: позиционируется через портал, чтобы не резаться overflow списка. */
function RowMenu({
  chat,
  rect,
  folderNames,
  onClose,
  onRename,
}: {
  chat: Chat;
  rect: DOMRect;
  folderNames: string[];
  onClose: () => void;
  onRename: () => void;
}) {
  const [view, setView] = useState<'root' | 'folders'>('root');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const left = Math.max(8, Math.min(rect.right - 224, window.innerWidth - 232));
  const openDown = rect.bottom + 280 < window.innerHeight;
  const style: React.CSSProperties = openDown
    ? { left, top: rect.bottom + 4 }
    : { left, bottom: window.innerHeight - rect.top + 4 };

  const itemClass =
    'flex w-full items-center gap-2.5 rounded-[var(--cc-radius-sm)] px-2.5 py-2.5 text-left text-sm hover:bg-[var(--cc-fill-ghost-hover)] active:opacity-60';

  return createPortal(
    <>
      <button aria-label="Закрыть" className="fixed inset-0 z-[60]" onClick={onClose} />
      <div
        style={style}
        className="animate-fade-in fixed z-[61] w-56 rounded-[var(--cc-radius)] border border-hairline bg-elevated p-1 shadow-[var(--shadow-pop)]"
      >
        {view === 'root' ? (
          <>
            <button
              className={itemClass}
              onClick={() => {
                void patchChat(chat.id, { pinned: !chat.pinned });
                onClose();
              }}
            >
              {chat.pinned ? <PinOff size={15} className="text-muted" /> : <Pin size={15} className="text-muted" />}
              {chat.pinned ? 'Открепить' : 'Закрепить'}
            </button>
            <button
              className={itemClass}
              onClick={() => {
                onRename();
                onClose();
              }}
            >
              <Pencil size={15} className="text-muted" />
              Переименовать
            </button>
            <button className={itemClass} onClick={() => setView('folders')}>
              <FolderInput size={15} className="text-muted" />
              В папку…
            </button>
            <div className="my-1 border-t border-hairline" />
            <button
              className={itemClass}
              onClick={() => {
                if (window.confirm(`Удалить чат «${chat.title}» со всей перепиской?`)) void removeChat(chat.id);
                onClose();
              }}
            >
              <Trash2 size={15} className="text-danger" />
              <span className="text-danger">Удалить</span>
            </button>
          </>
        ) : (
          <>
            {chat.folder && (
              <button
                className={itemClass}
                onClick={() => {
                  void patchChat(chat.id, { folder: null });
                  onClose();
                }}
              >
                <Folder size={15} className="text-muted" />
                Без папки
              </button>
            )}
            {folderNames.map((name) => (
              <button
                key={name}
                className={itemClass}
                onClick={() => {
                  void patchChat(chat.id, { folder: name });
                  onClose();
                }}
              >
                <Folder size={15} className="text-muted" />
                <span className="min-w-0 flex-1 truncate">{name}</span>
                {chat.folder === name && <Check size={14} className="shrink-0 text-accent" />}
              </button>
            ))}
            <input
              placeholder="Новая папка"
              autoFocus
              className="mx-1 mb-1 w-[calc(100%-8px)] rounded-[var(--cc-radius-sm)] bg-surface-2 px-2.5 py-2 text-base outline-none placeholder:text-muted"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const value = e.currentTarget.value.trim();
                  if (value) {
                    void patchChat(chat.id, { folder: value });
                    onClose();
                  }
                }
              }}
            />
          </>
        )}
      </div>
    </>,
    document.body,
  );
}
