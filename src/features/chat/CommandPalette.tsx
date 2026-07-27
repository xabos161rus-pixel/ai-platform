import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Columns2, CornerDownLeft, MessageSquare, MessageSquarePlus, Moon, Search, Settings, Sun } from 'lucide-react';
import type { Chat, Provider } from '../../db/types';
import { modelLabel } from '../../lib/ai/models';

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
}: Props) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const commands = useMemo<Command[]>(() => {
    const base: Command[] = [
      { id: 'new', label: 'Новый чат', hint: '⌘N', icon: MessageSquarePlus, run: onNewChat },
      { id: 'compare', label: 'Режим сравнения моделей', icon: Columns2, run: onToggleCompare },
      { id: 'theme', label: 'Переключить тему', icon: Moon, run: onToggleTheme },
      { id: 'settings', label: 'Настройки', icon: Settings, run: onOpenSettings },
    ];
    const models: Command[] = providers.flatMap((p) =>
      p.models.map((m) => ({
        id: `model:${p.id}:${m}`,
        label: `Модель: ${modelLabel(m)}`,
        hint: p.name,
        icon: Sun,
        run: () => onPickModel(p.id, m),
      })),
    );
    const recent: Command[] = chats.slice(0, 12).map((c) => ({
      id: `chat:${c.id}`,
      label: c.title,
      hint: 'чат',
      icon: MessageSquare,
      run: () => onPickChat(c.id),
    }));
    return [...base, ...models, ...recent];
  }, [chats, providers, onNewChat, onPickChat, onPickModel, onToggleTheme, onToggleCompare, onOpenSettings]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => `${c.label} ${c.hint ?? ''}`.toLowerCase().includes(q));
  }, [commands, query]);

  // Держим подсвеченный пункт в видимой части списка при навигации с клавиш.
  useEffect(() => {
    listRef.current?.querySelector('[data-active="1"]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const clamp = (i: number) => (filtered.length ? (i + filtered.length) % filtered.length : 0);

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-start justify-center pt-[12vh]">
      <button aria-label="Закрыть" className="animate-fade-in absolute inset-0 bg-black/50" onClick={onClose} />
      <div
        role="dialog"
        className="animate-fade-in relative w-[92vw] max-w-lg overflow-hidden rounded-[var(--cc-radius)] border border-hairline bg-elevated shadow-[var(--shadow-pop)]"
      >
        <div className="flex items-center gap-2 border-b border-hairline px-3">
          <Search size={16} className="shrink-0 text-muted" />
          <input
            autoFocus
            value={query}
            placeholder="Команда, чат или модель…"
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
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto p-1.5">
          {!filtered.length && <p className="px-3 py-6 text-center text-sm text-muted">Ничего не найдено</p>}
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
