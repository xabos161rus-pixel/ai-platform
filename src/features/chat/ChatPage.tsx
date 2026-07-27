import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router';
import { ArrowUp, Copy, Download, MessageSquarePlus, PanelLeft, RotateCcw, Settings, Sparkles, Square } from 'lucide-react';
import { db } from '../../db/db';
import type { Message, Provider } from '../../db/types';
import { useToast } from '../../components/ui/toastContext';
import { requestChat, errorText } from '../../lib/ai/client';
import { formatCost, modelLabel } from '../../lib/ai/models';
import {
  addAssistantMessage,
  addErrorMessage,
  addUserMessage,
  chatMessages,
  createChat,
  exportMarkdown,
  listChats,
  removeMessage,
  toContext,
} from '../../lib/ai/chatRepo';
import { Markdown } from './Markdown';
import { ChatListSheet } from './ChatListSheet';

export function ChatPage() {
  const toast = useToast();
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const creating = useRef(false);

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

  // 'auto', а не 'smooth': плавная прокрутка на каждый ответ конфликтует с
  // инерцией iOS и дёргает ленту.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, busy]);

  // Уход с экрана обрывает запрос: иначе платим за токены впустую.
  useEffect(() => () => abortRef.current?.abort(), []);

  async function ask(afterRemove?: string) {
    if (!chat || !settings) return;
    setBusy(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      if (afterRemove) await removeMessage(afterRemove);
      const history = toContext(await chatMessages(chat.id), settings.historyLimit);
      const reply = await requestChat({
        provider,
        messages: history,
        systemPrompt: chat.systemPrompt,
        model: chat.model,
        signal: ac.signal,
      });
      await addAssistantMessage(chat.id, reply);
    } catch (e) {
      await addErrorMessage(chat.id, errorText(e));
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }

  async function handleSend() {
    const text = draft.trim();
    if (!text || busy || !chat) return;
    setDraft('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
    await addUserMessage(chat, text);
    await ask();
    inputRef.current?.focus();
  }

  async function handleNewChat() {
    if (!settings) return;
    const c = await createChat(settings.activeProviderId ?? 'demo', settings.defaultModel);
    setPickedId(c.id);
    setListOpen(false);
    setDraft('');
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

  return (
    <div className="fixed inset-0 flex flex-col bg-bg">
      <header className="flex shrink-0 items-center gap-1 border-b border-hairline px-2 pt-[calc(env(safe-area-inset-top)+8px)] pb-2">
        <IconButton label="Чаты" onClick={() => setListOpen(true)}>
          <PanelLeft size={20} />
        </IconButton>
        <div className="min-w-0 flex-1 px-1">
          <h1 className="truncate text-[0.95rem] font-semibold">{chat?.title ?? 'AI Platform'}</h1>
          <p className="truncate font-mono text-[var(--cc-text-caption)] text-muted">
            {provider?.isDemo ? 'демо · без ключа' : (provider?.name ?? 'провайдер не выбран')}
            {chat && ` · ${modelLabel(chat.model)}`}
          </p>
        </div>
        <IconButton label="Экспорт" onClick={handleExport} disabled={!messages.length}>
          <Download size={19} />
        </IconButton>
        <IconButton label="Новый чат" onClick={() => void handleNewChat()}>
          <MessageSquarePlus size={20} />
        </IconButton>
        <Link
          to="/settings"
          aria-label="Настройки"
          className="grid size-[var(--cc-touch)] shrink-0 place-items-center rounded-[var(--cc-radius)] text-muted active:opacity-60"
        >
          <Settings size={19} />
        </Link>
      </header>

      <div className="mx-auto min-h-0 w-full max-w-3xl flex-1 space-y-5 overflow-y-auto px-4 py-4">
        {!messages.length && <Welcome demo={provider?.isDemo ?? false} />}
        {messages.map((m) =>
          m.role === 'user' ? (
            <UserBubble key={m.id} message={m} />
          ) : (
            <AssistantBlock
              key={m.id}
              message={m}
              busy={busy}
              onCopy={() => void copyText(m.content)}
              onRetry={() => void ask(m.id)}
            />
          ),
        )}
        {busy && <Pending />}
        <div ref={bottomRef} />
      </div>

      <div className="shrink-0 border-t border-hairline bg-bg">
        <div className="mx-auto flex w-full max-w-3xl items-end gap-2 px-4 pt-2.5 pb-[calc(env(safe-area-inset-bottom)+10px)]">
          <textarea
            ref={inputRef}
            value={draft}
            rows={1}
            placeholder="Спросите что угодно…"
            className="max-h-44 min-h-[var(--cc-touch)] flex-1 resize-none rounded-[var(--cc-radius)] bg-surface-2 px-3.5 py-2.5 outline-none placeholder:text-muted"
            onChange={(e) => {
              setDraft(e.target.value);
              // Авторост: сбрасываем высоту перед замером, иначе поле не сжимается.
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
              className="grid size-[var(--cc-touch)] shrink-0 place-items-center rounded-full bg-surface-2 active:opacity-70"
              onClick={() => abortRef.current?.abort()}
            >
              <Square size={15} />
            </button>
          ) : (
            <button
              aria-label="Отправить"
              disabled={!draft.trim()}
              className="grid size-[var(--cc-touch)] shrink-0 place-items-center rounded-full bg-accent text-white transition-opacity active:opacity-80 disabled:opacity-25"
              onClick={() => void handleSend()}
            >
              <ArrowUp size={19} />
            </button>
          )}
        </div>
      </div>

      <ChatListSheet
        open={listOpen}
        chats={list}
        activeId={chatId}
        onClose={() => setListOpen(false)}
        onPick={(id) => {
          setPickedId(id);
          setListOpen(false);
        }}
        onNew={() => void handleNewChat()}
      />
    </div>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-[var(--cc-touch)] shrink-0 place-items-center rounded-[var(--cc-radius)] text-muted active:opacity-60 disabled:opacity-25"
    >
      {children}
    </button>
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
    <div className="grid grid-cols-[var(--cc-marker-col)_1fr]">
      <div aria-hidden className="pt-[0.55rem]">
        <span className={`block size-1.5 rounded-full ${failed ? 'bg-danger' : 'bg-accent'}`} />
      </div>
      <div className="min-w-0">
        {failed ? <p className="text-sm text-danger">{message.error}</p> : <Markdown text={message.content} />}
        <div className="mt-2 flex items-center gap-3 font-mono text-[var(--cc-text-caption)] text-muted">
          {!failed && message.tokensIn !== null && (
            <span>
              {message.tokensIn}→{message.tokensOut}
              {cost && ` · ${cost}`}
            </span>
          )}
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

function Pending() {
  return (
    <div className="grid grid-cols-[var(--cc-marker-col)_1fr]">
      <div aria-hidden className="pt-[0.55rem]">
        <span className="block size-1.5 animate-pulse rounded-full bg-accent" />
      </div>
      <p className="font-mono text-[var(--cc-text-meta)] text-muted">
        думает<span className="animate-caret">▍</span>
      </p>
    </div>
  );
}
