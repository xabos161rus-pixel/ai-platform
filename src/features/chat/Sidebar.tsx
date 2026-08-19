import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import {
  ChartBars,
  Check,
  ChevronRight,
  Folder,
  FolderInput,
  FolderPlus,
  SquarePen,
  Columns2,
  MoreHorizontal,
  Plus,
  Pencil,
  Pin,
  PinOff,
  Search,
  Settings,
  Trash2,
  X,
} from '../../components/ui/glyphs';
import type { Chat } from '../../db/types';
import { listFolders, patchChat, removeChat } from '../../lib/ai/chatRepo';
import { searchAll, type SearchHit } from '../../lib/search';
import { t, useT } from '../../lib/i18n';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/db';

interface Props {
  chats: Chat[];
  activeId: string | null;
  onPick: (id: string) => void;
  onNew: () => void;
  /** Мобильный режим: панель поверх экрана, с кнопкой закрытия. */
  overlay?: boolean;
  onClose?: () => void;
  /** Свёрнута ли постоянная колонка на широком экране (⌘B). Оверлей не касается. */
  sidebarCollapsed?: boolean;
  /** Открыть чат второй панелью (сплит). Нет пропа — пункта меню нет. */
  onOpenSplit?: (id: string) => void;
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
  // t() — модульная функция, читает текущий язык на момент вызова; сам
  // компонент подписан на смену языка через useT() ниже, так что при её смене
  // groupLabel пересчитывается вместе со всем рендером.
  if (diff <= 0) return t('sidebar.today');
  if (diff <= day) return t('sidebar.yesterday');
  if (diff <= 7 * day) return t('sidebar.thisWeek');
  if (diff <= 30 * day) return t('sidebar.thisMonth');
  return t('sidebar.earlier');
}

/** Экранирование спецсимволов regex — запрос поиска может содержать что угодно. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Фрагмент с подсветкой совпавшего куска (регистронезависимо). */
function Highlighted({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const parts = text.split(new RegExp(`(${escapeRegExp(query)})`, 'ig'));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase() ? (
          <span key={i} className="rounded-[2px] bg-[var(--cc-fill-control)] text-accent">
            {part}
          </span>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

const COLLAPSED_KEY = 'ai-platform.collapsedFolders';

/**
 * Список чатов. На широком экране — постоянная колонка слева, на телефоне
 * выезжает поверх. Одинаковый вид на обоих устройствах выдаёт прототип:
 * на маке нижняя панель вместо колонки ощущается как мобильное приложение,
 * растянутое на десктоп.
 */
export function Sidebar({ chats, activeId, onPick, onNew, overlay = false, onClose, sidebarCollapsed = false, onOpenSplit }: Props) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]'));
    } catch {
      return new Set();
    }
  });
  const [menuFor, setMenuFor] = useState<MenuTarget | null>(null);
  // Инлайн-создание папки кнопкой в шапке сайдбара; пустые папки живут в
  // settings.customFolders, пока в них не положили чат.
  const [creatingFolder, setCreatingFolder] = useState(false);
  const customFolders = useLiveQuery(async () => (await db.settings.get('app'))?.customFolders ?? [], [], [] as string[]);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  // Поиск по заголовку и содержимому — debounce 200мс. setState только в
  // колбэке таймера (правило react-hooks/set-state-in-effect запрещает
  // синхронный setState прямо в теле эффекта); пустой запрос сам резолвится
  // в [] внутри searchAll, отдельного вью для него заводить не нужно.
  useEffect(() => {
    const id = setTimeout(() => {
      void searchAll(query).then(setHits);
    }, 200);
    return () => clearTimeout(id);
  }, [query]);

  const toggleFolder = (name: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  const searching = query.trim().length > 0;

  const groups = useMemo(() => {
    if (searching) return []; // во время поиска рендерим hits отдельной веткой ниже
    const pinned = chats.filter((c) => c.pinned);
    // Не-pinned дальше распределяются по папкам и датам — pin приоритетнее папки.
    const rest = chats.filter((c) => !c.pinned);
    const out: { kind: 'label' | 'folder'; label: string; items: Chat[]; children?: { label: string; path: string; items: Chat[] }[] }[] = [];
    if (pinned.length) out.push({ kind: 'label', label: t('sidebar.pinned'), items: pinned });
    // Папка — путь «Родитель/Дитя», глубина два уровня: чаты с folder
    // 'Работа' лежат в корне папки, 'Работа/Клиенты' — в её подпапке.
    const roots = new Map<string, { items: Chat[]; children: Map<string, Chat[]> }>();
    for (const c of rest) {
      if (!c.folder) continue;
      const [root, ...tail] = c.folder.split('/');
      const sub = tail.join('/');
      const node = roots.get(root) ?? { items: [], children: new Map<string, Chat[]>() };
      if (sub) node.children.set(sub, [...(node.children.get(sub) ?? []), c]);
      else node.items.push(c);
      roots.set(root, node);
    }
    // Пустые созданные папки — тоже узлы дерева (счётчик 0).
    for (const name of customFolders) {
      const [root, ...tail] = name.split('/');
      const sub = tail.join('/');
      const node = roots.get(root) ?? { items: [], children: new Map<string, Chat[]>() };
      if (sub && !node.children.has(sub)) node.children.set(sub, []);
      roots.set(root, node);
    }
    for (const root of [...roots.keys()].sort((a, b) => a.localeCompare(b, 'ru'))) {
      const node = roots.get(root)!;
      out.push({
        kind: 'folder',
        label: root,
        items: node.items,
        children: [...node.children.keys()]
          .sort((a, b) => a.localeCompare(b, 'ru'))
          .map((subName) => ({ label: subName, path: `${root}/${subName}`, items: node.children.get(subName)! })),
      });
    }
    const withoutFolder = rest.filter((c) => !c.folder);
    for (const c of withoutFolder) {
      const label = groupLabel(c.lastMessageAt ?? c.createdAt);
      const bucket = out.find((g) => g.kind === 'label' && g.label === label);
      if (bucket) bucket.items.push(c);
      else out.push({ kind: 'label', label, items: [c] });
    }
    return out;
  }, [chats, searching, customFolders, t]);

  const folderNames = useMemo(() => [...new Set([...listFolders(chats), ...customFolders])].sort((a, b) => a.localeCompare(b, 'ru')), [chats, customFolders]);

  return (
    <aside
      className={`flex w-72 shrink-0 flex-col border-r border-hairline bg-surface ${
        overlay ? 'h-full' : sidebarCollapsed ? 'hidden' : 'hidden lg:flex'
      }`}
    >
      <div className="flex items-center gap-2 px-3 pt-[calc(env(safe-area-inset-top)+10px)] pb-2">
        {/* Лёгкая строка, а не рамочная плита: рамка на всю ширину сайдбара
            весила больше содержимого. Ховер — мягкий фон, перо подкрашивается
            акцентом, хоткей — тихой подписью справа (только с клавиатурой). */}
        <button
          onClick={onNew}
          className="group flex min-h-[var(--cc-touch)] flex-1 items-center gap-2.5 rounded-[var(--cc-radius)] px-2.5 text-sm font-medium transition-colors hover:bg-[var(--cc-fill-ghost-hover)] active:opacity-70"
        >
          <SquarePen size={16} className="text-muted transition-colors group-hover:text-accent" />
          {t('chat.newChat')}
          <kbd className="ml-auto hidden font-mono text-[length:var(--cc-text-caption)] font-normal text-muted/50 lg:inline">⌘N</kbd>
        </button>
        <button
          aria-label={t('sidebar.newFolderAria')}
          title={t('sidebar.newFolderAria')}
          onClick={() => setCreatingFolder((v) => !v)}
          className="grid size-9 shrink-0 place-items-center rounded-[var(--cc-radius)] text-muted transition-colors hover:bg-[var(--cc-fill-ghost-hover)] hover:text-text active:opacity-70"
        >
          <FolderPlus size={17} />
        </button>
        {overlay && (
          <button
            aria-label={t('common.close')}
            onClick={onClose}
            className="grid size-[var(--cc-touch)] place-items-center rounded-[var(--cc-radius)] text-muted active:opacity-60"
          >
            <X size={19} />
          </button>
        )}
      </div>

      {creatingFolder && (
        <div className="px-3 pb-1">
          <input
            autoFocus
            placeholder={t('sidebar.newFolderPlaceholder')}
            className="w-full rounded-[var(--cc-radius-sm)] bg-surface-2 px-2.5 py-2 text-sm outline-none placeholder:text-muted"
            onKeyDown={(e) => {
              if (e.key === 'Escape') setCreatingFolder(false);
              if (e.key !== 'Enter') return;
              const value = e.currentTarget.value
                .split('/')
                .map((part) => part.trim())
                .filter(Boolean)
                .slice(0, 2)
                .join('/');
              if (!value) return;
              void db.settings.get('app').then((st) => {
                const setFolders = new Set([...(st?.customFolders ?? []), value]);
                return db.settings.update('app', { customFolders: [...setFolders], updatedAt: new Date().toISOString() });
              });
              setCreatingFolder(false);
            }}
            onBlur={() => setCreatingFolder(false)}
          />
        </div>
      )}
      <div className="px-3 pb-2">
        <div className="flex items-center gap-2 rounded-[var(--cc-radius)] bg-surface-2 px-2.5">
          <Search size={15} className="shrink-0 text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('sidebar.search')}
            className="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none placeholder:text-muted"
          />
          {query && (
            <button aria-label={t('sidebar.clearAria')} onClick={() => setQuery('')} className="text-muted active:opacity-60">
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      <nav
        className="cc-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-2"
        onScroll={() => setMenuFor(null)}
      >
        {searching ? (
          <>
            {!hits.length && (
              <p className="px-2 py-6 text-center text-sm text-muted">{t('sidebar.notFound')}</p>
            )}
            {hits.map((h) => (
              <ChatRow
                key={h.chat.id}
                chat={h.chat}
                fragment={h.fragment}
                highlightQuery={query.trim()}
                active={h.chat.id === activeId}
                renaming={renamingId === h.chat.id}
                menuOpen={menuFor?.chat.id === h.chat.id}
                onPick={() => onPick(h.chat.id)}
                onMenu={(rect) => setMenuFor({ chat: h.chat, rect })}
                onEndRename={() => setRenamingId(null)}
              />
            ))}
          </>
        ) : (
          <>
            {!groups.length && (
              <p className="px-2 py-6 text-center text-sm text-muted">{t('sidebar.noChats')}</p>
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
                      {(() => {
                        const total = g.items.length + (g.children ?? []).reduce((n, sub) => n + sub.items.length, 0);
                        return total > 0 ? (
                          <span className="ml-auto shrink-0 font-mono text-[length:var(--cc-text-caption)] text-muted">{total}</span>
                        ) : (
                          <span
                            role="button"
                            tabIndex={0}
                            aria-label={t('sidebar.removeFolderAria', { name: g.label })}
                            title={t('sidebar.removeFolderAria', { name: g.label })}
                            className="ml-auto grid size-7 shrink-0 place-items-center rounded-[var(--cc-radius-sm)] text-muted transition-colors hover:text-danger"
                            onClick={(e) => {
                              e.stopPropagation();
                              void db.settings.get('app').then((st) =>
                                db.settings.update('app', {
                                  customFolders: (st?.customFolders ?? []).filter((f) => f !== g.label && !f.startsWith(`${g.label}/`)),
                                  updatedAt: new Date().toISOString(),
                                }),
                              );
                            }}
                          >
                            <Trash2 size={13} />
                          </span>
                        );
                      })()}
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
                    {!isCollapsed &&
                      (g.children ?? []).map((sub) => {
                        const subCollapsed = collapsed.has(sub.path);
                        return (
                          <div key={`sub:${sub.path}`} className="pl-3">
                            <button
                              onClick={() => toggleFolder(sub.path)}
                              className="flex min-h-9 w-full items-center gap-1.5 px-2 text-left"
                            >
                              <ChevronRight
                                size={13}
                                className={`shrink-0 text-muted transition-transform ${subCollapsed ? '' : 'rotate-90'}`}
                              />
                              <Folder size={13} className="shrink-0 text-muted" />
                              <span className="min-w-0 flex-1 truncate text-sm">{sub.label}</span>
                              <span className="ml-auto shrink-0 font-mono text-[length:var(--cc-text-caption)] text-muted">
                                {sub.items.length}
                              </span>
                            </button>
                            {!subCollapsed &&
                              sub.items.map((c) => (
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
                  </div>
                );
              }
              return (
                <div key={`label:${g.label || 'flat'}`} className="mb-1">
                  {g.label && (
                    <p className="px-2 pt-3 pb-1 text-[length:var(--cc-text-caption)] font-medium text-muted">
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
          </>
        )}
      </nav>

      <div className="border-t border-hairline">
        <Link
          to="/stats"
          className="flex min-h-[var(--cc-touch)] items-center gap-2 px-4 text-sm text-muted transition-colors hover:text-text"
        >
          <ChartBars size={17} />
          {t('nav.stats')}
        </Link>
        <Link
          to="/settings"
          className="flex min-h-[var(--cc-touch)] items-center gap-2 px-4 text-sm text-muted transition-colors hover:text-text"
        >
          <Settings size={17} />
          {t('nav.settings')}
        </Link>
      </div>

      {menuFor && (
        <RowMenu
          key={menuFor.chat.id}
          chat={menuFor.chat}
          rect={menuFor.rect}
          folderNames={folderNames}
          onClose={() => setMenuFor(null)}
          onRename={() => setRenamingId(menuFor.chat.id)}
          onOpenSplit={onOpenSplit}
        />
      )}
    </aside>
  );
}

function ChatRow({
  chat,
  fragment,
  highlightQuery,
  active,
  renaming,
  menuOpen,
  onPick,
  onMenu,
  onEndRename,
}: {
  chat: Chat;
  /** Совпадение по содержимому — вторая строка-подпись под заголовком, только в режиме поиска. */
  fragment?: string;
  highlightQuery?: string;
  active: boolean;
  renaming: boolean;
  menuOpen: boolean;
  onPick: () => void;
  onMenu: (rect: DOMRect) => void;
  onEndRename: () => void;
}) {
  const t = useT();
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
          aria-label={t('sidebar.renameAria')}
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
        <button onClick={onPick} className="min-w-0 flex-1 py-1.5 pl-2 text-left active:opacity-60">
          <span className="block truncate text-sm">{chat.title || t('chat.newChat')}</span>
          {fragment && (
            <span className="block truncate text-[length:var(--cc-text-caption)] text-muted">
              <Highlighted text={fragment} query={highlightQuery ?? ''} />
            </span>
          )}
        </button>
      )}
      {/* Кнопка появляется по наведению — на телефоне видна всегда, там
          наведения нет и прятать её некуда. */}
      <button
        aria-label={t('sidebar.actionsAria')}
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
  onOpenSplit,
}: {
  chat: Chat;
  rect: DOMRect;
  folderNames: string[];
  onClose: () => void;
  onRename: () => void;
  onOpenSplit?: (id: string) => void;
}) {
  const t = useT();
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
      <button aria-label={t('common.close')} className="fixed inset-0 z-[60]" onClick={onClose} />
      <div
        style={style}
        className="animate-fade-in fixed z-[61] w-56 rounded-[var(--cc-radius)] border border-hairline bg-elevated p-1 shadow-[var(--shadow-pop)]"
      >
        {view === 'root' ? (
          <>
            {/* Сплит — только широкий экран: на узком второй панели некуда встать. */}
            {onOpenSplit && (
              <button
                className={`${itemClass} max-xl:hidden`}
                onClick={() => {
                  onOpenSplit(chat.id);
                  onClose();
                }}
              >
                <Columns2 size={15} className="text-muted" />
                {t('split.openAria')}
              </button>
            )}
            <button
              className={itemClass}
              onClick={() => {
                void patchChat(chat.id, { pinned: !chat.pinned });
                onClose();
              }}
            >
              {chat.pinned ? <PinOff size={15} className="text-muted" /> : <Pin size={15} className="text-muted" />}
              {chat.pinned ? t('sidebar.unpin') : t('sidebar.pin')}
            </button>
            <button
              className={itemClass}
              onClick={() => {
                onRename();
                onClose();
              }}
            >
              <Pencil size={15} className="text-muted" />
              {t('sidebar.rename')}
            </button>
            <button className={itemClass} onClick={() => setView('folders')}>
              <FolderInput size={15} className="text-muted" />
              {t('sidebar.moveToFolder')}
            </button>
            <div className="my-1 border-t border-hairline" />
            <button
              className={itemClass}
              onClick={() => {
                if (window.confirm(t('sidebar.deleteConfirm', { title: chat.title || t('chat.newChat') })))
                  void removeChat(chat.id);
                onClose();
              }}
            >
              <Trash2 size={15} className="text-danger" />
              <span className="text-danger">{t('sidebar.delete')}</span>
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
                {t('sidebar.noFolder')}
              </button>
            )}
            {folderNames.map((name) => {
              const depth = name.split('/').length - 1;
              const leaf = name.split('/').pop() ?? name;
              return (
                <div key={name} className={`flex items-center ${depth ? 'pl-5' : ''}`}>
                  <button
                    className={`${itemClass} min-w-0 flex-1`}
                    onClick={() => {
                      void patchChat(chat.id, { folder: name });
                      onClose();
                    }}
                  >
                    <Folder size={15} className="shrink-0 text-muted" />
                    <span className="min-w-0 flex-1 truncate">{leaf}</span>
                    {chat.folder === name && <Check size={14} className="shrink-0 text-accent" />}
                  </button>
                  {/* Подпапку заводят от корневой: «+» подставляет «Имя/» в поле
                      ниже — путь дописывается руками, глубина остаётся двумя
                      уровнями без отдельного диалога. */}
                  {!depth && (
                    <button
                      aria-label={t('sidebar.newSubfolderAria', { name: leaf })}
                      title={t('sidebar.newSubfolderAria', { name: leaf })}
                      className="grid size-8 shrink-0 place-items-center rounded-[var(--cc-radius-sm)] text-muted transition-colors hover:text-text"
                      onClick={(e) => {
                        const input = e.currentTarget.closest('div.animate-fade-in')?.querySelector('input');
                        if (input instanceof HTMLInputElement) {
                          input.value = `${name}/`;
                          input.focus();
                        }
                      }}
                    >
                      <Plus size={14} />
                    </button>
                  )}
                </div>
              );
            })}
            <input
              placeholder={t('sidebar.newFolderPlaceholder')}
              autoFocus
              className="mx-1 mb-1 w-[calc(100%-8px)] rounded-[var(--cc-radius-sm)] bg-surface-2 px-2.5 py-2 text-base outline-none placeholder:text-muted"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  // Путь «Родитель/Дитя»: нормализуем и держим глубину в два
                  // уровня — глубже раскладка превращается в свалку.
                  const value = e.currentTarget.value
                    .split('/')
                    .map((part) => part.trim())
                    .filter(Boolean)
                    .slice(0, 2)
                    .join('/');
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
