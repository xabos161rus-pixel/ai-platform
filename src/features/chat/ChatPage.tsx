import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link, useNavigate } from 'react-router';
import {
  Copy,
  Download,
  FileText,
  PanelLeft,
  Pencil,
  RotateCcw,
  ScrollText,
  Settings,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { db } from '../../db/db';
import type { Message, Provider, ToolStep } from '../../db/types';
import { useToast } from '../../components/ui/toastContext';
import { streamChat, errorText, type Reply } from '../../lib/ai/client';
import { runAgent, RESEARCH_SYSTEM } from '../../lib/ai/agentLoop';
import { buildTools } from '../../lib/ai/tools';
import { estimateTokens, formatCost, formatTokens, modelIds, modelLabel, priceInFor } from '../../lib/ai/models';
import {
  addAssistantMessage,
  addErrorMessage,
  addUserMessage,
  chatMessages,
  monthSpendRub,
  createChat,
  editUserMessage,
  exportMarkdown,
  listChats,
  patchChat,
  removeBranch,
  toContext,
} from '../../lib/ai/chatRepo';
import { buildPath, nodeOf, parentMap } from '../../lib/ai/tree';
import { useT } from '../../lib/i18n';
import type { AttachedFile } from '../../lib/files';
import { Markdown } from './Markdown';
import { LiveReasoning, ReasoningBlock } from './ReasoningBlock';
import { ToolTrace } from './ToolTrace';
import { Sidebar } from './Sidebar';
import { ModelPicker } from './ModelPicker';
import { CompareGroup } from './CompareGroup';
import { CompareBar } from './CompareBar';
import { CommandPalette } from './CommandPalette';
import { PersonaSheet } from './PersonaSheet';
import { VersionNav } from './VersionNav';
import { RegenerateMenu } from './RegenerateMenu';
import { Composer, type ComposerHandle } from './Composer';
import { ShortcutsSheet } from './ShortcutsSheet';
import { groupRuns } from '../../lib/ai/chatRepo';
import { alive, uid } from '../../lib/repo';
import { scheduleSyncSoon } from '../../lib/sync/engine';

/**
 * Куда уйдёт регенерация ответа: обычно это прямой родитель (вопрос) узла —
 * тогда buildPath до него даёт контекст без старого ответа. Родитель null
 * (узел — корень после повреждённых/legacy данных) — ищем ближайший
 * user-вопрос назад по текущему активному пути; не нашли — регенерация
 * недоступна.
 */
function regenerateLeafFor(messages: Message[], path: Message[], message: Message): string | null {
  const node = nodeOf(messages, message);
  const direct = parentMap(messages).get(node.id) ?? null;
  if (direct) return direct;
  const idx = path.findIndex((m) => m.id === node.id);
  for (let i = idx - 1; i >= 0; i--) {
    if (path[i].role === 'user') return nodeOf(messages, path[i]).id;
  }
  return null;
}

export function ChatPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const t = useT();
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  // Правка своего сообщения: id вопроса, вместо пузыря которого сейчас textarea.
  const [editingId, setEditingId] = useState<string | null>(null);
  // Текст ответа во время генерации живёт в состоянии React, а НЕ в Dexie:
  // запись каждого чанка в наблюдаемую таблицу перечитывала бы весь чат и
  // перерисовывала ленту десятки раз в секунду. В базу уходит один раз, в конце.
  const [streamText, setStreamText] = useState('');
  // Мысли модели во время генерации — отдельно от текста ответа, тоже вне
  // Dexie, по той же причине (частота обновлений).
  const [streamThink, setStreamThink] = useState('');
  // Живые шаги агентского цикла (toolMode!=='off') — тоже вне Dexie, пишутся
  // в итоговый Message.toolTrace одной записью только в конце прогона.
  const [agentSteps, setAgentSteps] = useState<ToolStep[]>([]);
  // Потоки колонок сравнения: индекс колонки → накопленный текст.
  const [compareStream, setCompareStream] = useState<Record<number, string>>({});
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [viewer, setViewer] = useState<string | null>(null);
  // Свёрнутый сайдбар на широком экране (⌘B) — переживает перезагрузку.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('ai-platform.sidebarCollapsed') === 'true',
  );
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const creating = useRef(false);
  const atBottom = useRef(true);

  const settings = useLiveQuery(() => db.settings.get('app'), []);
  // Конфиг синка (T2) — используется ниже, чтобы web_search замыкался на свой
  // воркер вместо Jina, пока синк включён.
  const syncCfg = useLiveQuery(() => db.syncConfig.get('sync'), []);
  // alive(): мягко удалённый провайдер (решение 12) не должен всплывать в выборе модели/чата.
  const providers = useLiveQuery(async () => alive(await db.providers.toArray()), [], [] as Provider[]);
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
  // Активный путь дерева версий — от корня до activeLeafId чата. Для старых
  // линейных чатов (все parentId===undefined) совпадает с messages целиком.
  const path = useMemo(() => buildPath(messages, chat?.activeLeafId), [messages, chat?.activeLeafId]);
  // Примитивы вместо целого объекта settings в зависимостях ask/askCompare:
  // settings — один Dexie-объект, и смена ЛЮБОГО его поля (тема, язык) даёт
  // новую ссылку целиком. Если зависеть от объекта, ask/askCompare
  // пересоздавались бы на каждый такой чих и рвали React.memo у сообщений
  // ленты ниже — они получают ask через handleRegenerate/handleSubmitEdit.
  const historyLimit = settings?.historyLimit ?? 20;
  const monthlyBudgetRub = settings?.monthlyBudgetRub ?? 0;
  const jinaKey = settings?.jinaKey;
  const hasSettings = !!settings;
  // Та же логика примитивов — теперь для syncCfg: lastSyncAt/lastError там
  // меняются каждые 90 с фоновым автосинком (engine.ts), и если бы ask зависел
  // от объекта целиком, он пересоздавался бы на каждый такой тик.
  const syncSearchOn = !!syncCfg?.enabled && !!syncCfg.serverUrl;
  const syncServerUrl = syncCfg?.serverUrl ?? '';
  const syncSpaceId = syncCfg?.spaceId ?? '';
  const syncAuthToken = syncCfg?.authToken ?? '';

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

  // ≈токены уже сидящего в контексте (история по лимиту + системный промпт):
  // база для счётчика у композера. Та же выборка toContext, что уйдёт в запрос.
  const baseTokens = useMemo(() => {
    if (!chat) return 0;
    const ctx = toContext(messages, historyLimit, chat.activeLeafId ?? null);
    const history = ctx.reduce((n, m) => n + estimateTokens(m.content), 0);
    return history + estimateTokens(chat.systemPrompt || '');
  }, [messages, historyLimit, chat]);
  const activePriceIn = useMemo(
    () => (chat ? priceInFor(chat.model, provider) : null),
    [chat, provider],
  );

  // Разовое предупреждение «бюджет почти исчерпан» — раз на сессию, не спамим.
  const budgetWarned = useRef(false);

  /** Гейт месячного бюджета перед платным запросом. true — можно отправлять.
   *  Демо не гейтится: он бесплатный и должен работать всегда. */
  const passBudget = useCallback(
    async (prov: Provider | null): Promise<boolean> => {
      if (!monthlyBudgetRub || !prov || prov.isDemo) return true;
      const spend = await monthSpendRub();
      if (spend >= monthlyBudgetRub) {
        toast(t('chat.budgetBlocked'));
        return false;
      }
      if (spend >= monthlyBudgetRub * 0.8 && !budgetWarned.current) {
        budgetWarned.current = true;
        toast(t('chat.budgetWarning'));
      }
      return true;
    },
    [monthlyBudgetRub, toast, t],
  );

  const ask = useCallback(
    async (opts?: { leafId?: string; model?: string; providerId?: string }) => {
      if (!chat || !hasSettings) return;
      if (!(await passBudget(providers.find((p) => p.id === (opts?.providerId ?? chat.providerId)) ?? null))) return;
      setBusy(true);
      setStreamText('');
      setStreamThink('');
      setAgentSteps([]);
      const ac = new AbortController();
      abortRef.current = ac;
      // Накопленный текст держим в замыкании, а не в ref: он нужен и для
      // отрисовки, и в обработчике остановки, а ref пришлось бы обновлять
      // во время рендера. Шаги агентского цикла — по той же причине: ветка
      // aborted должна сохранить трейс, не читая React state.
      let partial = '';
      let think = '';
      let stepsAcc: ToolStep[] = [];
      // Свежий чат из БД: activeLeafId мог только что смениться (правка,
      // переключение версии) прямо перед вызовом — chat из useLiveQuery мог
      // ещё не перечитаться.
      const freshChat = (await db.chats.get(chat.id)) ?? chat;
      const leafId = opts?.leafId ?? freshChat.activeLeafId ?? null;
      const useModel = opts?.model ?? chat.model;
      const useProviderId = opts?.providerId ?? chat.providerId;
      const useProvider = providers.find((p) => p.id === useProviderId) ?? null;
      const toolMode = chat.toolMode ?? 'off';
      try {
        const history = toContext(await chatMessages(chat.id), historyLimit, leafId);
        const onDelta = (piece: string) => {
          partial += piece;
          setStreamText(partial);
        };
        const onReasoning = (piece: string) => {
          think += piece;
          setStreamThink(think);
        };
        let reply: Reply & { toolTrace?: ToolStep[] };
        if (toolMode === 'off') {
          // Путь без инструментов — byte-в-byte прежний streamChat, ничего не меняем.
          reply = await streamChat({
            provider: useProvider,
            messages: history,
            systemPrompt: chat.systemPrompt,
            model: useModel,
            signal: ac.signal,
            temperature: typeof chat.temperature === 'number' ? chat.temperature : undefined,
            maxTokens: typeof chat.maxTokens === 'number' ? chat.maxTokens : undefined,
            onDelta,
            onReasoning,
          });
        } else {
          // Синк включён и адрес сервера задан → web_search ходит через свой
          // воркер (Serper), с молчаливым фолбэком на Jina внутри самого
          // инструмента; иначе — undefined, и поведение ровно прежнее.
          const tools = buildTools({
            jinaKey,
            sync: syncSearchOn ? { serverUrl: syncServerUrl, spaceId: syncSpaceId, authToken: syncAuthToken } : undefined,
          });
          reply = await runAgent({
            provider: useProvider,
            messages: history,
            systemPrompt:
              toolMode === 'research' ? `${chat.systemPrompt ? `${chat.systemPrompt}\n\n` : ''}${RESEARCH_SYSTEM}` : chat.systemPrompt,
            model: useModel,
            tools,
            maxSteps: toolMode === 'research' ? 12 : 8,
            jinaKey,
            signal: ac.signal,
            temperature: typeof chat.temperature === 'number' ? chat.temperature : undefined,
            maxTokens: typeof chat.maxTokens === 'number' ? chat.maxTokens : undefined,
            onDelta,
            onReasoning,
            onStep: (step) => {
              const i = stepsAcc.findIndex((s) => s.id === step.id);
              stepsAcc = i < 0 ? [...stepsAcc, step] : stepsAcc.map((s, idx) => (idx === i ? step : s));
              setAgentSteps(stepsAcc);
            },
            onToolsUnsupported: () => toast(t('agent.toolsUnsupported')),
          });
        }
        await addAssistantMessage(chat.id, reply, { parentId: leafId ?? null, provider: useProvider, toolTrace: reply.toolTrace });
      } catch (e) {
        // Прерванный ответ не выбрасываем: сохраняем то, что успело прийти —
        // иначе человек теряет полезный текст из-за случайного «стоп».
        // Частичные мысли не сохраняем: недописанные мысли не несут ценности
        // и усложняют ветку аборта.
        if ((e as { code?: string })?.code === 'aborted' && partial.trim()) {
          // Незавершённые шаги на момент остановки — законный error, не «running» навсегда.
          const abortedSteps = stepsAcc.map((s) =>
            s.status === 'running' ? { ...s, status: 'error' as const, result: t('agent.stepAborted') } : s,
          );
          await addAssistantMessage(
            chat.id,
            { content: `${partial}\n\n${t('chat.stoppedNote')}`, model: useModel, usage: { in: 0, out: 0 } },
            { parentId: leafId ?? null, toolTrace: abortedSteps },
          );
        } else {
          // Раунд мог упасть уже после успешных tool-вызовов (web_search/read_page
          // видны в живом трейсе) — не даём им бесследно исчезнуть вместе с ошибкой.
          // Незавершённый (running) шаг на момент падения — законный error, не
          // «навсегда running», аналогично ветке partial-текста выше.
          const errorSteps = stepsAcc.map((s) =>
            s.status === 'running' ? { ...s, status: 'error' as const, result: t('agent.stepInterrupted') } : s,
          );
          await addErrorMessage(chat.id, errorText(e), { parentId: leafId ?? null, toolTrace: errorSteps });
        }
      } finally {
        abortRef.current = null;
        setStreamText('');
        setStreamThink('');
        setAgentSteps([]);
        setBusy(false);
        // Ответ записан — новые сообщения уезжают на второе устройство, не
        // дожидаясь 90-секундного тика фонового автосинка.
        scheduleSyncSoon();
      }
    },
    [chat, hasSettings, historyLimit, providers, jinaKey, syncSearchOn, syncServerUrl, syncSpaceId, syncAuthToken, toast, t, passBudget],
  );

  /**
   * Сравнение: один вопрос уходит в несколько моделей ОДНОВРЕМЕННО, ответы
   * печатаются параллельно в своих колонках. Колонка, которая упала, не рушит
   * остальные — каждая обрабатывается отдельно.
   */
  const askCompare = useCallback(
    async (picks: { providerId: string; model: string }[], opts?: { leafId?: string }) => {
      if (!chat || !hasSettings) return;
      // Сравнение — сразу N платных запросов: гейт по первому платному провайдеру.
      const paid = picks.map((pk) => providers.find((p) => p.id === pk.providerId) ?? null).find((p) => p && !p.isDemo);
      if (paid && !(await passBudget(paid))) return;
      setBusy(true);
      setCompareStream({});
      const ac = new AbortController();
      abortRef.current = ac;
      const runId = uid();
      const freshChat = (await db.chats.get(chat.id)) ?? chat;
      const leafId = opts?.leafId ?? freshChat.activeLeafId ?? null;
      const history = toContext(await chatMessages(chat.id), historyLimit, leafId);
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
                temperature: typeof chat.temperature === 'number' ? chat.temperature : undefined,
                maxTokens: typeof chat.maxTokens === 'number' ? chat.maxTokens : undefined,
                onDelta: (piece) => {
                  partial += piece;
                  setCompareStream((s) => ({ ...s, [i]: partial }));
                },
              });
              // Первая колонка становится выбранной по умолчанию: контекст
              // не должен оставаться пустым, если человек не нажал «выбрать».
              await addAssistantMessage(chat.id, reply, {
                run: { runId, runIndex: i, chosen: i === 0 },
                provider: prov,
                parentId: leafId ?? null,
              });
            } catch (e) {
              await addErrorMessage(chat.id, errorText(e), { run: { runId, runIndex: i }, parentId: leafId ?? null });
            }
          }),
        );
      } finally {
        abortRef.current = null;
        setCompareStream({});
        setBusy(false);
        // Ответы записаны — новые сообщения уезжают на второе устройство, не
        // дожидаясь 90-секундного тика фонового автосинка.
        scheduleSyncSoon();
      }
    },
    [chat, hasSettings, historyLimit, providers, passBudget],
  );

  /** Отправка из композера: черновик, картинки и файлы уже очищены им самим. */
  async function handleSend(text: string, images: string[], files: AttachedFile[]) {
    if (!chat) return;
    atBottom.current = true;
    const msg = await addUserMessage(chat, text, {
      images: images.length ? images : undefined,
      files: files.length ? files : undefined,
    });
    if (comparePicks.length > 1) await askCompare(comparePicks, { leafId: msg.id });
    else await ask({ leafId: msg.id });
    composerRef.current?.focus();
  }

  /** Отмена правки вопроса — стабильная ссылка для onCancelEdit в UserBubble. */
  const cancelEdit = useCallback(() => setEditingId(null), []);

  /** Переключить активный лист чата — общий обработчик для VersionNav везде в ленте. */
  const switchLeaf = useCallback(
    (leafId: string) => {
      if (!chat) return;
      void patchChat(chat.id, { activeLeafId: leafId });
    },
    [chat],
  );

  /** Правка вопроса: новый сиблинг-вопрос + запрос ответа от его имени. */
  const handleSubmitEdit = useCallback(
    async (message: Message, text: string) => {
      if (!chat) return;
      const trimmed = text.trim();
      if (!trimmed && !message.images?.length && !message.files?.length) return;
      setEditingId(null);
      const msg = await editUserMessage(chat, message, trimmed);
      await ask({ leafId: msg.id });
    },
    [chat, ask],
  );

  /** Регенерация ответа: «та же модель» (opts не передан) либо конкретная модель из меню. */
  const handleRegenerate = useCallback(
    async (message: Message, opts?: { model: string; providerId: string }) => {
      const leafId = regenerateLeafFor(messages, path, message);
      if (!leafId) return;
      await ask({ leafId, model: opts?.model, providerId: opts?.providerId });
    },
    [messages, path, ask],
  );

  /** ⌘B: свернуть/развернуть постоянную боковую панель на широком экране. */
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((v) => {
      const next = !v;
      localStorage.setItem('ai-platform.sidebarCollapsed', String(next));
      return next;
    });
  }, []);

  /** ↑ в пустом композере: правка последнего своего вопроса активного пути. */
  const handleEditLast = useCallback(() => {
    if (editingId) return; // правка уже открыта — не перескакиваем на другую
    for (let i = path.length - 1; i >= 0; i--) {
      if (path[i].role === 'user') {
        setEditingId(nodeOf(messages, path[i]).id);
        return;
      }
    }
  }, [path, messages, editingId]);

  /** Мягкое удаление ветки версий (сообщение + все его версии-потомки). */
  const handleDeleteBranch = useCallback(
    async (id: string) => {
      if (!chat) return;
      if (!window.confirm(t('msg.deleteBranchConfirm'))) return;
      await removeBranch(chat, id);
    },
    [chat, t],
  );

  async function handleNewChat() {
    if (!settings) return;
    const c = await createChat(settings.activeProviderId ?? 'demo', settings.defaultModel);
    setPickedId(c.id);
    setNavOpen(false);
    // Черновик — внутреннее состояние композера; insertText('') очищает его
    // тем же императивным путём, что и вставка сниппета.
    composerRef.current?.insertText('');
    composerRef.current?.focus();
  }

  // useCallback — не только сама функция стабильна между рендерами (toast и t
  // не меняются), но и одна и та же ссылка уходит как onCopy сразу в
  // UserBubble/AssistantBlock/CompareGroup из .map() ниже: без этого memo на
  // них был бы бесполезен — новый onCopy на каждый рендер ChatPage провалил
  // бы поверхностное сравнение пропов.
  const copyText = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        toast(t('chat.copied'));
      } catch {
        toast(t('chat.copyFailed'));
      }
    },
    [toast, t],
  );

  function handleExport() {
    if (!chat) return;
    const md = exportMarkdown(chat, messages);
    const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(chat.title || t('chat.newChat')).replace(/[^\wа-яА-ЯёЁ -]/g, '')}.md`;
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
        composerRef.current?.focus();
      } else if (meta && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        toggleSidebar();
      } else if (e.key === 'Escape') {
        // Остановка активной генерации приоритетнее закрытия просмотрщика
        // изображения — Esc во время ответа не должен молча закрывать не то.
        if (busy) abortRef.current?.abort();
        else if (viewer) setViewer(null);
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

        <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-1 border-b border-hairline px-2 pt-[calc(env(safe-area-inset-top)+8px)] pb-2">
          <button
            aria-label={t('chat.chatsAria')}
            onClick={() => setNavOpen(true)}
            className="grid size-[var(--cc-touch)] shrink-0 place-items-center rounded-[var(--cc-radius)] text-muted active:opacity-60 lg:hidden"
          >
            <PanelLeft size={20} />
          </button>
          {/* Развернуть сайдбар обратно — видна ТОЛЬКО на широком экране и
              ТОЛЬКО пока он свёрнут: другая aria-label, чем у мобильной кнопки
              выше, поэтому смоук-селектор по 'Чаты' её не задевает. */}
          <button
            aria-label={t('nav.toggleSidebar')}
            onClick={toggleSidebar}
            className={`hidden size-[var(--cc-touch)] shrink-0 place-items-center rounded-[var(--cc-radius)] text-muted transition-opacity active:opacity-60 ${
              sidebarCollapsed ? 'lg:grid' : ''
            }`}
          >
            <PanelLeft size={20} />
          </button>
          <div className="min-w-0 flex-1 px-1">
            <h1 className="truncate text-[0.95rem] font-semibold">{chat ? chat.title || t('chat.newChat') : 'AI Platform'}</h1>
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
            aria-label={t('chat.systemPromptAria')}
            onClick={() => setPromptOpen(true)}
            disabled={!chat}
            className={`grid size-[var(--cc-touch)] shrink-0 place-items-center rounded-[var(--cc-radius)] transition-colors active:opacity-60 ${
              chat?.systemPrompt || chat?.temperature != null || chat?.maxTokens != null
                ? 'text-accent'
                : 'text-muted hover:text-text'
            }`}
          >
            <ScrollText size={18} />
          </button>
          <button
            aria-label={t('chat.exportAria')}
            onClick={handleExport}
            disabled={!messages.length}
            className="grid size-[var(--cc-touch)] shrink-0 place-items-center rounded-[var(--cc-radius)] text-muted transition-colors hover:text-text active:opacity-60 disabled:opacity-25"
          >
            <Download size={18} />
          </button>
          <Link
            to="/settings"
            aria-label={t('nav.settings')}
            className="grid size-[var(--cc-touch)] shrink-0 place-items-center rounded-[var(--cc-radius)] text-muted transition-colors hover:text-text active:opacity-60 lg:hidden"
          >
            <Settings size={18} />
          </Link>
        </header>

        <div
          className="cc-scroll min-h-0 flex-1 overflow-y-auto"
          onScroll={(e) => {
            const el = e.currentTarget;
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          <div className="mx-auto w-full max-w-3xl space-y-5 px-4 py-5">
            {!path.length && !streamText && (
              <Welcome
                demo={provider?.isDemo ?? false}
                onPick={(text) => {
                  composerRef.current?.insertText(text);
                  composerRef.current?.focus();
                }}
              />
            )}
            {/* onCopy/onSwitch/onDeleteBranch/onStartEdit/onSubmitEdit/onRegenerate
                передаются как ОДНА стабильная ссылка на все элементы списка
                (не инлайн-замыкание на каждый item) — иначе React.memo ниже
                бесполезен: новая функция-проп на каждый рендер ChatPage сама
                по себе проваливает поверхностное сравнение. Компонент сам
                прикладывает к ним свой message/id при вызове. */}
            {groupRuns(path).map((item) =>
              Array.isArray(item) ? (
                <CompareGroup
                  key={item[0].id}
                  group={item}
                  messages={messages}
                  busy={busy}
                  onCopy={copyText}
                  onSwitch={switchLeaf}
                  onDeleteBranch={handleDeleteBranch}
                />
              ) : item.role === 'user' ? (
                <UserBubble
                  key={item.id}
                  message={item}
                  messages={messages}
                  busy={busy}
                  editing={editingId === item.id}
                  onStartEdit={setEditingId}
                  onCancelEdit={cancelEdit}
                  onSubmitEdit={handleSubmitEdit}
                  onSwitch={switchLeaf}
                  onView={setViewer}
                  onCopy={copyText}
                />
              ) : (
                <AssistantBlock
                  key={item.id}
                  message={item}
                  messages={messages}
                  busy={busy}
                  providers={providers}
                  currentProviderId={chat?.providerId ?? null}
                  currentModel={chat?.model ?? null}
                  canRegenerate={regenerateLeafFor(messages, path, item) !== null}
                  onCopy={copyText}
                  onRegenerate={handleRegenerate}
                  onSwitch={switchLeaf}
                  onDeleteBranch={handleDeleteBranch}
                />
              ),
            )}
            {busy &&
              (comparePicks.length > 1 ? (
                <StreamingCompare picks={comparePicks} texts={compareStream} />
              ) : (
                <Streaming text={streamText} think={streamThink} steps={agentSteps} />
              ))}
            <div ref={bottomRef} />
          </div>
        </div>

        <div className="shrink-0 border-t border-hairline bg-bg">
        <Composer
          ref={composerRef}
          busy={busy}
          canSend={!!chat}
          onSend={handleSend}
          onStop={() => abortRef.current?.abort()}
          onEditLast={handleEditLast}
          toolMode={chat?.toolMode ?? 'off'}
          onToolMode={(m) => chat && void patchChat(chat.id, { toolMode: m })}
          baseTokens={baseTokens}
          priceIn={activePriceIn}
          barSlot={
            <CompareBar
              providers={providers}
              picks={settings?.compareModels ?? []}
              onChange={(keys) => void setComparePicks(keys)}
            />
          }
        />
        </div>
        </div>
      </div>

      <PersonaSheet
        key={promptOpen ? (chat?.id ?? 'none') : 'closed'}
        open={promptOpen}
        chat={chat}
        onClose={() => setPromptOpen(false)}
      />

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
          const all = providers.flatMap((p) => modelIds(p.models).map((m) => `${p.id}:${m}`));
          void setComparePicks(settings?.compareModels?.length ? [] : all.slice(0, 2));
        }}
        onOpenSettings={() => navigate('/settings')}
        onOpenShortcuts={() => {
          setPaletteOpen(false);
          setShortcutsOpen(true);
        }}
      />

      {viewer && (
        <div
          className="animate-fade-in fixed inset-0 z-[80] grid place-items-center bg-black/80 p-3"
          onClick={() => setViewer(null)}
        >
          <img src={viewer} alt={t('chat.imageAlt')} className="max-h-[92dvh] max-w-full rounded-[var(--cc-radius)]" />
        </div>
      )}
    </div>
  );
}

function Welcome({ demo, onPick }: { demo: boolean; onPick: (text: string) => void }) {
  const t = useT();
  const chips = [t('welcome.chip1'), t('welcome.chip2'), t('welcome.chip3'), t('welcome.chip4')];
  return (
    <div className="flex flex-col items-center gap-3 py-24 text-center">
      <div className="grid size-14 place-items-center rounded-[var(--cc-radius)] bg-surface-2 text-accent">
        <Sparkles size={26} />
      </div>
      <p className="font-medium">{t('chat.welcomeTitle')}</p>
      <p className="max-w-xs text-sm leading-relaxed text-muted">
        {demo ? t('chat.welcomeDemo') : t('chat.welcomeReal')}
      </p>
      <div className="mt-1 flex max-w-md flex-wrap items-center justify-center gap-2">
        {chips.map((chip) => (
          <button
            key={chip}
            onClick={() => onPick(chip)}
            className="min-h-[var(--cc-touch)] rounded-full border border-hairline px-3 py-2 text-sm transition-colors hover:border-accent active:opacity-70"
          >
            {chip}
          </button>
        ))}
      </div>
    </div>
  );
}

interface UserBubbleProps {
  message: Message;
  messages: Message[];
  busy: boolean;
  editing: boolean;
  onStartEdit: (id: string) => void;
  onCancelEdit: () => void;
  onSubmitEdit: (message: Message, text: string) => void;
  onSwitch: (leafId: string) => void;
  onView: (src: string) => void;
  onCopy: (text: string) => void;
}

/** Вопрос — пузырь справа. Ответ пузырём НЕ оформляем: в Claude Code это
 *  поток на всю ширину с маркером, и эта асимметрия узнаётся сразу.
 *
 *  memo: пропы из ChatPage — сплошь стабильные ссылки (см. .map() выше),
 *  поэтому во время стрима ответа или набора текста в композере ни один
 *  UserBubble ленты не перерисовывается — меняется только сам streaming-блок. */
const UserBubble = memo(function UserBubble({
  message,
  messages,
  busy,
  editing,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onSwitch,
  onView,
  onCopy,
}: UserBubbleProps) {
  const t = useT();

  if (editing) {
    return (
      <EditBox
        key={message.id}
        message={message}
        onCancel={onCancelEdit}
        onSubmit={(text) => onSubmitEdit(message, text)}
      />
    );
  }

  const node = nodeOf(messages, message);

  return (
    <div className="group animate-msg-in flex flex-col items-end">
      <div className="max-w-[85%] rounded-[var(--cc-radius)] bg-surface-2 px-3.5 py-2.5 text-[length:var(--cc-text-body)] whitespace-pre-wrap">
        {message.images?.length ? (
          <div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
            {message.images.map((src, i) => (
              <button key={i} onClick={() => onView(src)} className="active:opacity-70">
                <img
                  src={src}
                  alt={t('chat.attachmentAlt')}
                  className="h-28 w-auto max-w-full cursor-zoom-in rounded-[var(--cc-radius-sm)] border border-hairline object-cover"
                />
              </button>
            ))}
          </div>
        ) : null}
        {message.files?.length ? (
          <div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
            {message.files.map((f, i) => (
              <span
                key={i}
                className="flex items-center gap-1.5 rounded-[var(--cc-radius-sm)] border border-hairline bg-surface-2 px-2 py-1 text-[length:var(--cc-text-caption)]"
              >
                <FileText size={13} className="shrink-0 text-muted" />
                <span className="max-w-[10rem] truncate">{f.name}</span>
                <span className="shrink-0 text-muted">{t('files.chars', { n: f.textChars })}</span>
              </span>
            ))}
          </div>
        ) : null}
        {message.content ? message.content : null}
      </div>
      <div className="mt-1 flex items-center gap-2 font-mono text-[length:var(--cc-text-caption)] text-muted opacity-0 transition-opacity duration-150 group-hover:opacity-100 lg:opacity-0 max-lg:opacity-100">
        <button
          aria-label={t('msg.edit')}
          disabled={busy}
          className="p-1 active:opacity-60 disabled:opacity-25"
          onClick={() => onStartEdit(message.id)}
        >
          <Pencil size={13} />
        </button>
        <button aria-label={t('chat.copy')} className="p-1 active:opacity-60" onClick={() => onCopy(message.content)}>
          <Copy size={13} />
        </button>
        <VersionNav messages={messages} node={node} disabled={busy} onSwitch={onSwitch} />
      </div>
    </div>
  );
});

/**
 * Режим правки вопроса: отдельный компонент, а не ветка внутри UserBubble —
 * состояние черновика инициализируется из пропа один раз при монтировании
 * (родитель монтирует/размонтирует его переключением editing), без
 * useEffect+setState для сброса.
 */
function EditBox({
  message,
  onCancel,
  onSubmit,
}: {
  message: Message;
  onCancel: () => void;
  onSubmit: (text: string) => void;
}) {
  const t = useT();
  const [text, setText] = useState(message.content);

  return (
    <div className="flex justify-end">
      <div className="w-full max-w-[85%] space-y-2">
        <textarea
          // Callback-ref: авторост высоты и фокус в момент появления в DOM —
          // не запись в существующий ref во время рендера, а инициализация
          // только что смонтированного узла.
          ref={(el) => {
            if (!el) return;
            el.style.height = 'auto';
            el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
            el.focus();
            el.setSelectionRange(el.value.length, el.value.length);
          }}
          value={text}
          rows={1}
          className="max-h-80 min-h-[var(--cc-touch)] w-full resize-none rounded-[var(--cc-radius)] bg-surface-2 px-3.5 py-2.5 text-base outline-none transition-shadow focus:shadow-[0_0_0_1px_var(--app-accent)]"
          onChange={(e) => {
            setText(e.target.value);
            e.target.style.height = 'auto';
            e.target.style.height = `${Math.min(e.target.scrollHeight, 320)}px`;
          }}
          onKeyDown={(e) => {
            // Enter отправляет только с физической клавиатурой — как в композере.
            if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(pointer: fine)').matches) {
              e.preventDefault();
              onSubmit(text);
            } else if (e.key === 'Escape') {
              onCancel();
            }
          }}
        />
        <div className="flex justify-end gap-2">
          <button
            className="rounded-[var(--cc-radius-sm)] px-3 py-1.5 text-sm text-muted transition-colors hover:text-text active:opacity-60"
            onClick={onCancel}
          >
            {t('common.cancel')}
          </button>
          <button
            className="rounded-[var(--cc-radius-sm)] bg-accent px-3 py-1.5 text-sm text-white active:opacity-80 disabled:opacity-40"
            disabled={!text.trim() && !message.images?.length && !message.files?.length}
            onClick={() => onSubmit(text)}
          >
            {t('common.send')}
          </button>
        </div>
      </div>
    </div>
  );
}

interface AssistantBlockProps {
  message: Message;
  messages: Message[];
  busy: boolean;
  providers: Provider[];
  currentProviderId: string | null;
  currentModel: string | null;
  canRegenerate: boolean;
  onCopy: (text: string) => void;
  onRegenerate: (message: Message, opts?: { model: string; providerId: string }) => void;
  onSwitch: (leafId: string) => void;
  onDeleteBranch: (id: string) => void;
}

/** memo — см. комментарий у UserBubble: пропы из ChatPage стабильны между
 *  рендерами, поэтому готовые ответы ленты не пересчитываются на стрим
 *  соседнего сообщения. */
const AssistantBlock = memo(function AssistantBlock({
  message,
  messages,
  busy,
  providers,
  currentProviderId,
  currentModel,
  canRegenerate,
  onCopy,
  onRegenerate,
  onSwitch,
  onDeleteBranch,
}: AssistantBlockProps) {
  const t = useT();
  const [menuRect, setMenuRect] = useState<DOMRect | null>(null);
  const failed = message.status === 'error';
  const cost = formatCost(message.costRub);
  const node = nodeOf(messages, message);
  return (
    <div className="group animate-msg-in grid grid-cols-[var(--cc-marker-col)_1fr]">
      <div aria-hidden className="pt-[0.55rem]">
        <span className={`block size-1.5 rounded-full ${failed ? 'bg-danger' : 'bg-accent'}`} />
      </div>
      <div className="min-w-0">
        {failed ? (
          <p className="text-sm text-danger">{message.error}</p>
        ) : (
          <>
            {message.toolTrace?.length ? <ToolTrace steps={message.toolTrace} /> : null}
            {message.reasoning && <ReasoningBlock text={message.reasoning} />}
            <Markdown text={message.content} />
          </>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-3 font-mono text-[length:var(--cc-text-caption)] text-muted opacity-0 transition-opacity duration-150 group-hover:opacity-100 lg:opacity-0 max-lg:opacity-100">
          {!failed && message.tokensIn !== null && (message.tokensIn > 0 || message.tokensOut) ? (
            /* Один тихий ряд через точки, без скобок: мысли — подмножество
               out (куда ушёл счёт думающей модели), кеш — вход из кеша. */
            <span className="tabular-nums">
              {formatTokens(message.tokensIn)}→{formatTokens(message.tokensOut ?? 0)}
              {message.tokensReasoning ? ` · ${t('chat.reasoningTokens')} ${formatTokens(message.tokensReasoning)}` : ''}
              {message.tokensCached ? ` · ${t('chat.cachedTokens')} ${formatTokens(message.tokensCached)}` : ''}
              {cost && ` · ${cost}`}
            </span>
          ) : null}
          {!failed && message.model && <span className="truncate">{modelLabel(message.model)}</span>}
          {!failed && (
            <button aria-label={t('chat.copy')} className="p-1 active:opacity-60" onClick={() => onCopy(message.content)}>
              <Copy size={13} />
            </button>
          )}
          <VersionNav messages={messages} node={node} disabled={busy} onSwitch={onSwitch} />
          <button
            aria-label={t('chat.retry')}
            disabled={busy || !canRegenerate}
            className="p-1 active:opacity-60 disabled:opacity-25"
            onClick={(e) => setMenuRect(e.currentTarget.getBoundingClientRect())}
          >
            <RotateCcw size={13} />
          </button>
          <button
            aria-label={t('msg.deleteBranch')}
            disabled={busy}
            className="p-1 transition-colors hover:text-danger active:opacity-60 disabled:opacity-25"
            onClick={() => onDeleteBranch(node.id)}
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
      {menuRect && (
        <RegenerateMenu
          rect={menuRect}
          providers={providers}
          currentProviderId={currentProviderId}
          currentModel={currentModel}
          onClose={() => setMenuRect(null)}
          onPick={(opts) => onRegenerate(message, opts)}
        />
      )}
    </div>
  );
});

/** Колонки сравнения во время генерации: все потоки печатаются одновременно. */
function StreamingCompare({
  picks,
  texts,
}: {
  picks: { providerId: string; model: string }[];
  texts: Record<number, string>;
}) {
  const t = useT();
  return (
    <div className="grid grid-cols-[var(--cc-marker-col)_1fr]">
      <div aria-hidden className="pt-[0.55rem]">
        <span className="block size-1.5 animate-pulse rounded-full bg-accent" />
      </div>
      <div className="min-w-0">
        <p className="mb-2 font-mono text-[length:var(--cc-text-caption)] text-muted">{t('compare.count', { n: picks.length })}</p>
        <div
          className="space-y-2 lg:grid lg:gap-3 lg:space-y-0"
          style={{ gridTemplateColumns: `repeat(${picks.length}, minmax(0, 1fr))` }}
        >
          {picks.map((pick, i) => (
            <article key={`${pick.providerId}:${pick.model}`} className="rounded-[var(--cc-radius)] border border-hairline p-3">
              <header className="mb-2 border-b border-hairline pb-2 font-mono text-[length:var(--cc-text-caption)] text-muted">
                {modelLabel(pick.model)}
              </header>
              {texts[i] ? (
                <>
                  <Markdown text={texts[i]} />
                  <span className="animate-caret -mt-1 inline-block text-accent">▍</span>
                </>
              ) : (
                <p className="font-mono text-[length:var(--cc-text-caption)] text-muted">
                  {t('compare.waiting')}
                  <span className="animate-caret">▍</span>
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
function Streaming({ text, think, steps }: { text: string; think: string; steps: ToolStep[] }) {
  const t = useT();
  return (
    <div className="grid grid-cols-[var(--cc-marker-col)_1fr]">
      <div aria-hidden className="pt-[0.55rem]">
        <span className="block size-1.5 animate-pulse rounded-full bg-accent" />
      </div>
      <div className="min-w-0">
        {steps.length > 0 && <ToolTrace steps={steps} live />}
        {think && <LiveReasoning text={think} />}
        {text ? (
          <>
            <Markdown text={text} />
            <span className="animate-caret -mt-1 inline-block text-accent">▍</span>
          </>
        ) : !think && !steps.some((s) => s.status === 'running') ? (
          <p className="font-mono text-[length:var(--cc-text-meta)] text-muted">
            {t('chat.thinking')}
            <span className="animate-caret">▍</span>
          </p>
        ) : null}
      </div>
    </div>
  );
}
