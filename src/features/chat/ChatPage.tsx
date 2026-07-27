import { useCallback, useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link, useNavigate } from 'react-router';
import { ArrowUp, Copy, Download, PanelLeft, RotateCcw, Settings, Sparkles, Square } from 'lucide-react';
import { db } from '../../db/db';
import type { Message, Provider } from '../../db/types';
import { useToast } from '../../components/ui/toastContext';
import { streamChat, errorText } from '../../lib/ai/client';
import { formatCost, modelLabel } from '../../lib/ai/models';
import {
  addAssistantMessage,
  addErrorMessage,
  addUserMessage,
  chatMessages,
  createChat,
  exportMarkdown,
  listChats,
  patchChat,
  removeMessage,
  toContext,
} from '../../lib/ai/chatRepo';
import { Markdown } from './Markdown';
import { Sidebar } from './Sidebar';
import { ModelPicker } from './ModelPicker';
import { CompareGroup } from './CompareGroup';
import { CompareBar } from './CompareBar';
import { CommandPalette } from './CommandPalette';
import { groupRuns } from '../../lib/ai/chatRepo';
import { uid } from '../../lib/repo';

export function ChatPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  // Текст ответа во время генерации живёт в состоянии React, а НЕ в Dexie:
  // запись каждого чанка в наблюдаемую таблицу перечитывала бы весь чат и
  // перерисовывала ленту десятки раз в секунду. В базу уходит один раз, в конце.
  const [streamText, setStreamText] = useState('');
  // Потоки колонок сравнения: индекс колонки → накопленный текст.
  const [compareStream, setCompareStream] = useState<Record<number, string>>({});
  const [paletteOpen, setPaletteOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const creating = useRef(false);
  const atBottom = useRef(true);

  const settings = useLiveQuery(() => db.settings.get('app'), []);
  const providers = useLiveQuery(async () => db.providers.toArray(), [], [] as Provider[]);
  // БЕЗ значения по умолчанию: undefined = «ещё грузится», [] = «чатов нет».
  // С дефолтом [] эти состояния неразличимы, и эффект ниже успевает завести
  // лишний пустой чат до того, как подтянутся существующие.
  const chats = useLiveQuery(() => listChats(), []);
  const list = chats ?? [];
  // Активный чат — производное значение, а не состояние из эффекта:
  // синхронный setState в эффекте даёт каскадные рендеры.
  const chat = (pickedId ? list.find((c) => c.id === pickedId) : null) ?? list[0] ?? null;
  const chatId = chat?.id ?? null;
  const messages = useLiveQuery(
    () => (chatId ? chatMessages(chatId) : Promise.resolve([])),
    [chatId],
    [] as Message[],
  );
  const provider = providers.find((p) => p.id === (chat?.providerId ?? settings?.activeProviderId)) ?? null;

  useEffect(() => {
    if (chats === undefined || chats.length || creating.current || !settings) return;
    creating.current = true;
    void createChat(settings.activeProviderId ?? 'demo', settings.defaultModel).finally(() => {
      creating.current = false;
    });
  }, [chats, settings]);

  // Автопрокрутка — только если человек и так внизу. Иначе лента выдёргивает
  // из середины прошлого ответа, который он читает.
  // Через rAF: на момент эффекта браузер ещё не пересчитал высоту ленты, и
  // скролл «до конца» останавливался чуть выше — последняя строка пряталась
  // за композером.
  useEffect(() => {
    if (!atBottom.current) return;
    const id = requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: 'end' }));
    return () => cancelAnimationFrame(id);
  }, [messages.length, streamText, busy]);

  // Уход с экрана обрывает запрос: иначе платим за токены впустую.
  useEffect(() => () => abortRef.current?.abort(), []);

  const ask = useCallback(
    async (afterRemove?: string) => {
      if (!chat || !settings) return;
      setBusy(true);
      setStreamText('');
      const ac = new AbortController();
      abortRef.current = ac;
      // Накопленный текст держим в замыкании, а не в ref: он нужен и для
      // отрисовки, и в обработчике остановки, а ref пришлось бы обновлять
      // во время рендера.
      let partial = '';
      try {
        if (afterRemove) await removeMessage(afterRemove);
        const history = toContext(await chatMessages(chat.id), settings.historyLimit);
        const reply = await streamChat({
          provider,
          messages: history,
          systemPrompt: chat.systemPrompt,
          model: chat.model,
          signal: ac.signal,
          onDelta: (piece) => {
            partial += piece;
            setStreamText(partial);
          },
        });
        await addAssistantMessage(chat.id, reply);
      } catch (e) {
        // Прерванный ответ не выбрасываем: сохраняем то, что успело прийти —
        // иначе человек теряет полезный текст из-за случайного «стоп».
        if ((e as { code?: string })?.code === 'aborted' && partial.trim()) {
          await addAssistantMessage(chat.id, {
            content: `${partial}\n\n_(остановлено)_`,
            model: chat.model,
            usage: { in: 0, out: 0 },
          });
        } else {
          await addErrorMessage(chat.id, errorText(e));
        }
      } finally {
        abortRef.current = null;
        setStreamText('');
        setBusy(false);
      }
    },
    [chat, settings, provider],
  );

  /**
   * Сравнение: один вопрос уходит в несколько моделей ОДНОВРЕМЕННО, ответы
   * печатаются параллельно в своих колонках. Колонка, которая упала, не рушит
   * остальные — каждая обрабатывается отдельно.
   */
  const askCompare = useCallback(
    async (picks: { providerId: string; model: string }[]) => {
      if (!chat || !settings) return;
      setBusy(true);
      setCompareStream({});
      const ac = new AbortController();
      abortRef.current = ac;
      const runId = uid();
      const history = toContext(await chatMessages(chat.id), settings.historyLimit);
      try {
        await Promise.all(
          picks.map(async (pick, i) => {
            const prov = providers.find((p) => p.id === pick.providerId) ?? null;
            let partial = '';
            try {
              const reply = await streamChat({
                provider: prov,
                messages: history,
                systemPrompt: chat.systemPrompt,
                model: pick.model,
                signal: ac.signal,
                onDelta: (piece) => {
                  partial += piece;
                  setCompareStream((s) => ({ ...s, [i]: partial }));
                },
              });
              // Первая колонка становится выбранной по умолчанию: контекст
              // не должен оставаться пустым, если человек не нажал «выбрать».
              await addAssistantMessage(chat.id, reply, { runId, runIndex: i, chosen: i === 0 });
            } catch (e) {
              await addErrorMessage(chat.id, errorText(e), { runId, runIndex: i });
            }
          }),
        );
      } finally {
        abortRef.current = null;
        setCompareStream({});
        setBusy(false);
      }
    },
    [chat, settings, providers],
  );

  async function handleSend() {
    const text = draft.trim();
    if (!text || busy || !chat) return;
    setDraft('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
    atBottom.current = true;
    await addUserMessage(chat, text);
    if (comparePicks.length > 1) await askCompare(comparePicks);
    else await ask();
    inputRef.current?.focus();
  }

  async function handleNewChat() {
    if (!settings) return;
    const c = await createChat(settings.activeProviderId ?? 'demo', settings.defaultModel);
    setPickedId(c.id);
    setNavOpen(false);
    setDraft('');
    inputRef.current?.focus();
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Скопировано');
    } catch {
      toast('Не удалось скопировать');
    }
  }

  function handleExport() {
    if (!chat) return;
    const md = exportMarkdown(chat, messages);
    const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${chat.title.replace(/[^\wа-яА-ЯёЁ -]/g, '')}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ⌘K — палитра, ⌘N — новый чат, ⌘/ — фокус в поле. Без клавиатуры
  // платформа на маке ощущается медленной, сколько бы кнопок ни было видно.
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
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const comparePicks = (settings?.compareModels ?? [])
    .map((k) => {
      const [providerId, ...rest] = k.split(':');
      return { providerId, model: rest.join(':') };
    })
    .filter((x) => providers.some((p) => p.id === x.providerId));

  async function setComparePicks(keys: string[]) {
    await db.settings.update('app', { compareModels: keys, updatedAt: new Date().toISOString() });
  }

  return (
    <div className="fixed inset-0 flex bg-bg">
      <Sidebar chats={list} activeId={chatId} onPick={setPickedId} onNew={() => void handleNewChat()} />

      {/* Мобильная панель поверх экрана */}
      {navOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <button aria-label="Закрыть" className="animate-fade-in absolute inset-0 bg-black/50" onClick={() => setNavOpen(false)} />
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

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-1 border-b border-hairline px-2 pt-[calc(env(safe-area-inset-top)+8px)] pb-2">
          <button
            aria-label="Чаты"
            onClick={() => setNavOpen(true)}
            className="grid size-[var(--cc-touch)] shrink-0 place-items-center rounded-[var(--cc-radius)] text-muted active:opacity-60 lg:hidden"
          >
            <PanelLeft size={20} />
          </button>
          <div className="min-w-0 flex-1 px-1">
            <h1 className="truncate text-[0.95rem] font-semibold">{chat?.title ?? 'AI Platform'}</h1>
            {chat && (
              <ModelPicker
                providers={providers}
                providerId={chat.providerId}
                model={chat.model}
                onChange={(providerId, model) => void patchChat(chat.id, { providerId, model })}
              />
            )}
          </div>
          <button
            aria-label="Экспорт"
            onClick={handleExport}
            disabled={!messages.length}
            className="grid size-[var(--cc-touch)] shrink-0 place-items-center rounded-[var(--cc-radius)] text-muted transition-colors hover:text-text active:opacity-60 disabled:opacity-25"
          >
            <Download size={18} />
          </button>
          <Link
            to="/settings"
            aria-label="Настройки"
            className="grid size-[var(--cc-touch)] shrink-0 place-items-center rounded-[var(--cc-radius)] text-muted transition-colors hover:text-text active:opacity-60 lg:hidden"
          >
            <Settings size={18} />
          </Link>
        </header>

        <div
          className="min-h-0 flex-1 overflow-y-auto"
          onScroll={(e) => {
            const el = e.currentTarget;
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          <div className="mx-auto w-full max-w-3xl space-y-5 px-4 py-5">
            {!messages.length && !streamText && <Welcome demo={provider?.isDemo ?? false} />}
            {groupRuns(messages).map((item) =>
              Array.isArray(item) ? (
                <CompareGroup key={item[0].id} group={item} onCopy={(t) => void copyText(t)} />
              ) : item.role === 'user' ? (
                <UserBubble key={item.id} message={item} />
              ) : (
                <AssistantBlock
                  key={item.id}
                  message={item}
                  busy={busy}
                  onCopy={() => void copyText(item.content)}
                  onRetry={() => void ask(item.id)}
                />
              ),
            )}
            {busy &&
              (comparePicks.length > 1 ? (
                <StreamingCompare picks={comparePicks} texts={compareStream} />
              ) : (
                <Streaming text={streamText} />
              ))}
            <div ref={bottomRef} />
          </div>
        </div>

        <div className="shrink-0 border-t border-hairline bg-bg">
          <div className="mx-auto w-full max-w-3xl px-4 pt-2">
            <CompareBar
              providers={providers}
              picks={settings?.compareModels ?? []}
              onChange={(keys) => void setComparePicks(keys)}
            />
          </div>
          <div className="mx-auto flex w-full max-w-3xl items-end gap-2 px-4 pt-2 pb-[calc(env(safe-area-inset-bottom)+10px)]">
            <textarea
              ref={inputRef}
              value={draft}
              rows={1}
              placeholder="Спросите что угодно…"
              className="max-h-44 min-h-[var(--cc-touch)] flex-1 resize-none rounded-[var(--cc-radius)] bg-surface-2 px-3.5 py-2.5 outline-none transition-shadow placeholder:text-muted focus:shadow-[0_0_0_1px_var(--app-accent)]"
              onChange={(e) => {
                setDraft(e.target.value);
                // Авторост: сбрасываем высоту перед замером, иначе не сжимается.
                e.target.style.height = 'auto';
                e.target.style.height = `${Math.min(e.target.scrollHeight, 176)}px`;
              }}
              onKeyDown={(e) => {
                // Enter отправляет только с физической клавиатурой: на телефоне
                // это перевод строки, иначе многострочное не написать.
                if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(pointer: fine)').matches) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
            />
            {busy ? (
              <button
                aria-label="Остановить"
                className="grid size-[var(--cc-touch)] shrink-0 place-items-center rounded-full bg-surface-2 transition-opacity active:opacity-70"
                onClick={() => abortRef.current?.abort()}
              >
                <Square size={15} />
              </button>
            ) : (
              <button
                aria-label="Отправить"
                disabled={!draft.trim()}
                className="grid size-[var(--cc-touch)] shrink-0 place-items-center rounded-full bg-accent text-white transition-all active:scale-95 active:opacity-80 disabled:opacity-25"
                onClick={() => void handleSend()}
              >
                <ArrowUp size={19} />
              </button>
            )}
          </div>
        </div>
      </div>

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
          const all = providers.flatMap((p) => p.models.map((m) => `${p.id}:${m}`));
          void setComparePicks(settings?.compareModels?.length ? [] : all.slice(0, 2));
        }}
        onOpenSettings={() => navigate('/settings')}
      />
    </div>
  );
}

function Welcome({ demo }: { demo: boolean }) {
  return (
    <div className="flex flex-col items-center gap-3 py-24 text-center">
      <div className="grid size-14 place-items-center rounded-[var(--cc-radius)] bg-surface-2 text-accent">
        <Sparkles size={26} />
      </div>
      <p className="font-medium">Спросите что угодно</p>
      <p className="max-w-xs text-sm leading-relaxed text-muted">
        {demo
          ? 'Сейчас отвечает встроенная заглушка. Чтобы получать настоящие ответы, добавьте провайдера в настройках.'
          : 'Ключи хранятся только на этом устройстве и уходят напрямую провайдеру.'}
      </p>
    </div>
  );
}

/** Вопрос — пузырь справа. Ответ пузырём НЕ оформляем: в Claude Code это
 *  поток на всю ширину с маркером, и эта асимметрия узнаётся сразу. */
function UserBubble({ message }: { message: Message }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-[var(--cc-radius)] bg-surface-2 px-3.5 py-2.5 text-[var(--cc-text-body)] whitespace-pre-wrap">
        {message.content}
      </div>
    </div>
  );
}

function AssistantBlock({
  message,
  busy,
  onCopy,
  onRetry,
}: {
  message: Message;
  busy: boolean;
  onCopy: () => void;
  onRetry: () => void;
}) {
  const failed = message.status === 'error';
  const cost = formatCost(message.costRub);
  return (
    <div className="group grid grid-cols-[var(--cc-marker-col)_1fr]">
      <div aria-hidden className="pt-[0.55rem]">
        <span className={`block size-1.5 rounded-full ${failed ? 'bg-danger' : 'bg-accent'}`} />
      </div>
      <div className="min-w-0">
        {failed ? <p className="text-sm text-danger">{message.error}</p> : <Markdown text={message.content} />}
        <div className="mt-2 flex items-center gap-3 font-mono text-[var(--cc-text-caption)] text-muted opacity-0 transition-opacity duration-150 group-hover:opacity-100 lg:opacity-0 max-lg:opacity-100">
          {!failed && message.tokensIn !== null && (message.tokensIn > 0 || message.tokensOut) ? (
            <span>
              {message.tokensIn}→{message.tokensOut}
              {cost && ` · ${cost}`}
            </span>
          ) : null}
          {!failed && message.model && <span className="truncate">{modelLabel(message.model)}</span>}
          {!failed && (
            <button aria-label="Скопировать" className="p-1 active:opacity-60" onClick={onCopy}>
              <Copy size={13} />
            </button>
          )}
          <button
            aria-label="Повторить"
            disabled={busy}
            className="p-1 active:opacity-60 disabled:opacity-25"
            onClick={onRetry}
          >
            <RotateCcw size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}

/** Колонки сравнения во время генерации: все потоки печатаются одновременно. */
function StreamingCompare({
  picks,
  texts,
}: {
  picks: { providerId: string; model: string }[];
  texts: Record<number, string>;
}) {
  return (
    <div className="grid grid-cols-[var(--cc-marker-col)_1fr]">
      <div aria-hidden className="pt-[0.55rem]">
        <span className="block size-1.5 animate-pulse rounded-full bg-accent" />
      </div>
      <div className="min-w-0">
        <p className="mb-2 font-mono text-[var(--cc-text-caption)] text-muted">сравнение · {picks.length}</p>
        <div
          className="space-y-2 lg:grid lg:gap-3 lg:space-y-0"
          style={{ gridTemplateColumns: `repeat(${picks.length}, minmax(0, 1fr))` }}
        >
          {picks.map((pick, i) => (
            <article key={`${pick.providerId}:${pick.model}`} className="rounded-[var(--cc-radius)] border border-hairline p-3">
              <header className="mb-2 border-b border-hairline pb-2 font-mono text-[var(--cc-text-caption)] text-muted">
                {modelLabel(pick.model)}
              </header>
              {texts[i] ? (
                <>
                  <Markdown text={texts[i]} />
                  <span className="animate-caret -mt-1 inline-block text-accent">▍</span>
                </>
              ) : (
                <p className="font-mono text-[var(--cc-text-caption)] text-muted">
                  ждёт<span className="animate-caret">▍</span>
                </p>
              )}
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Ответ во время генерации: тот же рендер, что и у готового, плюс каретка. */
function Streaming({ text }: { text: string }) {
  return (
    <div className="grid grid-cols-[var(--cc-marker-col)_1fr]">
      <div aria-hidden className="pt-[0.55rem]">
        <span className="block size-1.5 animate-pulse rounded-full bg-accent" />
      </div>
      <div className="min-w-0">
        {text ? (
          <>
            <Markdown text={text} />
            <span className="animate-caret -mt-1 inline-block text-accent">▍</span>
          </>
        ) : (
          <p className="font-mono text-[var(--cc-text-meta)] text-muted">
            думает<span className="animate-caret">▍</span>
          </p>
        )}
      </div>
    </div>
  );
}
