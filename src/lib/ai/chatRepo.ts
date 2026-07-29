import { db } from '../../db/db';
import { alive, now, stamp, uid } from '../repo';
import type { BaseEntity, Chat, Message, Provider, ToolStep } from '../../db/types';
import { costRub } from './models';
import type { ChatMessage, Reply } from './client';
import { buildPath, leafAfterRemoval, nodeOf, parentMap, subtreeIds } from './tree';
import { t } from '../i18n';
import type { AttachedFile } from '../files';

/** Заголовок чата из первого вопроса — короткая первая строка без хвостов. */
export function autoTitle(text: string): string {
  const line = text.trim().split('\n')[0].trim();
  if (!line) return t('chat.untitled');
  return line.length > 48 ? `${line.slice(0, 48).trimEnd()}…` : line;
}

export async function listChats(): Promise<Chat[]> {
  const rows = alive(await db.chats.toArray());
  return rows.sort((a, b) => {
    // Закреплённые всегда сверху, внутри группы — по свежести.
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt);
  });
}

export async function createChat(providerId: string, model: string): Promise<Chat> {
  const chat = stamp<Chat>({
    // Пусто, а не сентинел-строка: UI показывает title || t('chat.newChat'),
    // и на EN-локали пользователь не увидит русское «Новый чат» в данных.
    title: '',
    providerId,
    model,
    systemPrompt: '',
    lastMessageAt: null,
    pinned: false,
    activeLeafId: null,
  });
  await db.chats.add(chat);
  return chat;
}

export async function patchChat(id: string, changes: Partial<Omit<Chat, 'id' | 'createdAt'>>): Promise<void> {
  await db.chats.update(id, { ...changes, updatedAt: now() });
}

/** Мягкое удаление чата вместе с сообщениями. */
export async function removeChat(id: string): Promise<void> {
  const ts = now();
  await db.chats.update(id, { deletedAt: ts, updatedAt: ts });
  const ids = (await db.messages.where('chatId').equals(id).toArray()).map((m) => m.id);
  if (ids.length) {
    await db.messages.bulkUpdate(ids.map((k) => ({ key: k, changes: { deletedAt: ts, updatedAt: ts } })));
  }
}

export async function chatMessages(chatId: string): Promise<Message[]> {
  const rows = alive(await db.messages.where('chatId').equals(chatId).toArray());
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * @param asActiveLeaf Сдвинуть activeLeafId чата на это же сообщение — в ОДНОЙ
 * транзакции с lastMessageAt, а не отдельным вызовом patchChat следом. Два
 * последовательных db.chats.update по одной и той же записи давали окно между
 * ними, где useLiveQuery(chats) успевал отрисовать чат с уже новым
 * lastMessageAt, но ещё старым activeLeafId (и наоборот) — на медленной
 * машине (или при плотном потоке событий, как обрыв генерации по Esc сразу
 * после отправки) React иногда фиксировал именно этот промежуточный кадр,
 * и лента переставала показывать только что добавленный ответ. Один вызов
 * update() — одна запись в IndexedDB — одно избежание гонки.
 */
async function addMessage(
  data: Omit<Message, keyof BaseEntity>,
  opts?: { asActiveLeaf?: boolean },
): Promise<Message> {
  const row: Message = { ...data, id: uid(), createdAt: now(), updatedAt: now(), deletedAt: null };
  await db.messages.add(row);
  await db.chats.update(data.chatId, {
    lastMessageAt: row.createdAt,
    updatedAt: row.createdAt,
    ...(opts?.asActiveLeaf ? { activeLeafId: row.id } : {}),
  });
  return row;
}

/**
 * @param opts.parentId Явный родитель нового сообщения. Не передан —
 * вычисляется от текущего активного листа чата: новое сообщение продолжает
 * ту ветку, на которую сейчас смотрит чат (обычный случай отправки вопроса).
 * Три позиционных опциональных параметра (images/parentId/files) стали
 * нечитаемыми на месте вызова — отсюда объект.
 */
export async function addUserMessage(
  chat: Chat,
  content: string,
  opts?: { images?: string[]; parentId?: string | null; files?: AttachedFile[] },
): Promise<Message> {
  // Первый вопрос даёт чату имя — руками переименовывать не нужно. Вопрос из
  // одних картинок или файлов (без текста) тоже достоин заголовка, а не
  // пустой строки. Проверяем и '', и legacy-сентинел 'Новый чат' — старые
  // чаты писали его прямо в данные до этой задачи.
  if (chat.title === '' || chat.title === 'Новый чат') {
    const title = !content.trim() && opts?.images?.length
      ? t('chat.imageTitle')
      : !content.trim() && opts?.files?.length
        ? autoTitle(opts.files[0].name)
        : autoTitle(content);
    await patchChat(chat.id, { title });
  }
  let effectiveParentId = opts?.parentId;
  if (effectiveParentId === undefined) {
    const liveMsgs = await chatMessages(chat.id);
    const path = buildPath(liveMsgs, chat.activeLeafId);
    const last = path[path.length - 1];
    effectiveParentId = last ? nodeOf(liveMsgs, last).id : null;
  }
  const row = await addMessage(
    {
      chatId: chat.id,
      role: 'user',
      content,
      model: null,
      tokensIn: null,
      tokensOut: null,
      costRub: null,
      status: 'done',
      error: null,
      images: opts?.images?.length ? opts.images : undefined,
      files: opts?.files?.length ? opts.files.map((f) => ({ name: f.name, size: f.size, textChars: f.text.length })) : undefined,
      fileTexts: opts?.files?.length ? opts.files.map((f) => f.text) : undefined,
      parentId: effectiveParentId,
    },
    { asActiveLeaf: true },
  );
  return row;
}

/**
 * Правка вопроса без потери истории: создаёт НОВОЕ user-сообщение-сиблинга
 * (тот же эффективный родитель, что и у original), а не переписывает старое —
 * старый вопрос и его ответ остаются доступной версией.
 */
export async function editUserMessage(chat: Chat, original: Message, content: string): Promise<Message> {
  const liveMsgs = await chatMessages(chat.id);
  const parentId = parentMap(liveMsgs).get(original.id) ?? null;
  const row = await addMessage(
    {
      chatId: chat.id,
      role: 'user',
      content,
      model: null,
      tokensIn: null,
      tokensOut: null,
      costRub: null,
      status: 'done',
      error: null,
      images: original.images,
      files: original.files,
      fileTexts: original.fileTexts,
      parentId,
    },
    { asActiveLeaf: true },
  );
  return row;
}

export async function addAssistantMessage(
  chatId: string,
  reply: Reply,
  opts?: {
    /** Группа сравнения: один вопрос → несколько моделей, сиблинги с общим runId. */
    run?: { runId: string; runIndex: number; chosen?: boolean };
    parentId?: string | null;
    /** Цена провайдера смотрится раньше встроенного реестра — см. costRub. */
    provider?: Provider | null;
    /** Трейс агентского цикла (шаги инструментов) — только для отображения, в wire не уходит. */
    toolTrace?: ToolStep[];
  },
): Promise<Message> {
  // Лист сдвигаем только для представителя прогона (runIndex 0) либо для
  // одиночного ответа — остальные колонки сравнения не должны спорить за
  // единственный указатель активной ветки.
  const row = await addMessage(
    {
      chatId,
      role: 'assistant',
      content: reply.content,
      model: reply.model,
      tokensIn: reply.usage.in,
      tokensOut: reply.usage.out,
      costRub: costRub(reply.model, reply.usage.in, reply.usage.out, opts?.provider),
      status: 'done',
      error: null,
      runId: opts?.run?.runId ?? null,
      runIndex: opts?.run?.runIndex ?? 0,
      chosen: opts?.run?.chosen ?? false,
      reasoning: reply.reasoning || undefined,
      parentId: opts?.parentId,
      toolTrace: opts?.toolTrace?.length ? opts.toolTrace : undefined,
    },
    { asActiveLeaf: !opts?.run || opts.run.runIndex === 0 },
  );
  return row;
}

/**
 * Выбрать победителя прогона сравнения: его ответ уходит в контекст, остальные
 * колонки остаются в переписке как история, но модель их больше не видит.
 */
export async function chooseWinner(runId: string, messageId: string): Promise<void> {
  const rows = await db.messages.where('chatId').equals((await db.messages.get(messageId))?.chatId ?? '').toArray();
  const ts = now();
  const updates = rows
    .filter((m) => m.runId === runId)
    .map((m) => ({ key: m.id, changes: { chosen: m.id === messageId, updatedAt: ts } }));
  if (updates.length) await db.messages.bulkUpdate(updates);
}

/**
 * Группировка ленты: подряд идущие ответы одного прогона сравнения
 * сворачиваются в одну строку-группу, остальное остаётся как есть.
 */
export function groupRuns(messages: Message[]): (Message | Message[])[] {
  const out: (Message | Message[])[] = [];
  const seen = new Set<string>();
  for (const m of messages) {
    if (!m.runId) {
      out.push(m);
      continue;
    }
    if (seen.has(m.runId)) continue;
    seen.add(m.runId);
    const group = messages.filter((x) => x.runId === m.runId).sort((a, b) => (a.runIndex ?? 0) - (b.runIndex ?? 0));
    out.push(group.length > 1 ? group : group[0]);
  }
  return out;
}

export async function addErrorMessage(
  chatId: string,
  error: string,
  opts?: {
    run?: { runId: string; runIndex: number };
    parentId?: string | null;
    /** Трейс шагов агентского цикла, уже выполненных до падения раунда — не теряем их вместе с ошибкой. */
    toolTrace?: ToolStep[];
  },
): Promise<Message> {
  // Ошибка — законный лист дерева: повтор («Retry») строится от её родителя.
  const row = await addMessage(
    {
      chatId,
      role: 'assistant',
      content: '',
      model: null,
      tokensIn: null,
      tokensOut: null,
      costRub: null,
      status: 'error',
      error,
      runId: opts?.run?.runId ?? null,
      runIndex: opts?.run?.runIndex ?? 0,
      chosen: false,
      parentId: opts?.parentId,
      toolTrace: opts?.toolTrace?.length ? opts.toolTrace : undefined,
    },
    { asActiveLeaf: !opts?.run || opts.run.runIndex === 0 },
  );
  return row;
}

export async function removeMessage(id: string): Promise<void> {
  const ts = now();
  await db.messages.update(id, { deletedAt: ts, updatedAt: ts });
}

/** Мягкое удаление целого поддерева версий с переводом активного листа чата на живое место. */
export async function removeBranch(chat: Chat, messageId: string): Promise<void> {
  const prevAlive = await chatMessages(chat.id);
  const ids = subtreeIds(prevAlive, messageId);
  const ts = now();
  if (ids.length) {
    await db.messages.bulkUpdate(ids.map((id) => ({ key: id, changes: { deletedAt: ts, updatedAt: ts } })));
  }
  const nextLeaf = leafAfterRemoval(prevAlive, messageId, chat.activeLeafId);
  await patchChat(chat.id, { activeLeafId: nextLeaf });
}

/**
 * Контекст для отправки. Алгоритм:
 * (1) path = buildPath(messages, activeLeafId) — путь от корня до активного
 *     листа; runId-группы разворачиваются на месте представителя всеми членами;
 * (2) фильтр: status==='done' и есть непустой content либо images либо files
 *     (пустой content без вложений — ошибка/отмена, провайдер отвергает
 *     такое с 400);
 * (3) из runId-группы в контекст уходит ТОЛЬКО победитель — chosen, либо
 *     участник с минимальным runIndex, если выбор не сделан;
 * (4) хвост historyLimit последних сообщений (0 и меньше — без среза) —
 *     прямой контроль расхода: без него длинный диалог оплачивается целиком
 *     на каждом вопросе;
 * (5) превращаем в { role, content, images } для wire-формата: текст файлов
 *     (fileTexts) вклеивается в content блоками <file name="…">…</file>,
 *     сам wire-формат новому полю не обучается.
 */
export function toContext(messages: Message[], historyLimit: number, activeLeafId?: string | null): ChatMessage[] {
  const path = buildPath(messages, activeLeafId);
  // Вопрос из одних картинок или файлов (без текста) валиден — content пуст,
  // но images/files непусты. Ошибка/отмена — status!=='done', не пригодно.
  const isUsable = (m: Message) => m.status === 'done' && (!!m.content.trim() || !!m.images?.length || !!m.files?.length);
  const taken = new Set<string>();
  const usable = path.filter((m) => {
    if (!isUsable(m)) return false;
    if (!m.runId) return true;
    if (taken.has(m.runId)) return false;
    // Победитель по умолчанию ищется ТОЛЬКО среди пригодных (done, непустых)
    // колонок группы — упавшая (error) колонка не может стать «победителем»
    // просто из-за меньшего runIndex. Иначе, если колонка-0 падает и явный
    // выбор (chosen) не сделан, весь раунд сравнения — включая успешные
    // колонки — молча выпадал из контекста следующего вопроса.
    const group = path.filter((x) => x.runId === m.runId);
    const usableGroup = group.filter(isUsable);
    const winner = usableGroup.find((x) => x.chosen) ?? usableGroup.reduce((min, x) => ((x.runIndex ?? 0) < (min.runIndex ?? 0) ? x : min));
    if (winner.id !== m.id) return false;
    taken.add(m.runId);
    return true;
  });
  const tail = historyLimit > 0 ? usable.slice(-historyLimit) : usable;
  return tail.map((m) => {
    const blocks = m.files?.length && m.fileTexts
      ? m.files.map((f, i) => `<file name="${f.name}">\n${m.fileTexts?.[i] ?? ''}\n</file>`).join('\n\n')
      : '';
    const content = blocks ? (m.content.trim() ? `${m.content}\n\n${blocks}` : blocks) : m.content;
    return { role: m.role, content, images: m.images };
  });
}

/** Список уникальных папок среди живых чатов — папка без единого чата исчезает сама. */
export function listFolders(chats: Chat[]): string[] {
  const set = new Set<string>();
  for (const c of chats) {
    if (c.folder) set.add(c.folder);
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'ru'));
}

/** Экспорт диалога в markdown — страховка от потери устройства. */
export function exportMarkdown(chat: Chat, messages: Message[]): string {
  const head = `# ${chat.title}\n\n_${new Date(chat.createdAt).toLocaleString('ru-RU')}_\n`;
  const body = messages
    .map((m) => {
      if (m.status === 'error') return t('chat.errorPrefix', { error: m.error ?? '' });
      return m.role === 'user' ? `${t('chat.questionHeading')}\n\n${m.content}` : `${t('chat.answerHeading')}\n\n${m.content}`;
    })
    .join('\n\n');
  return `${head}\n${body}\n`;
}

/** Суммарные траты за текущий календарный месяц, ₽. */
export async function monthSpendRub(): Promise<number> {
  const from = new Date();
  from.setDate(1);
  from.setHours(0, 0, 0, 0);
  const iso = from.toISOString();
  const rows = await db.messages.toArray();
  return rows.reduce((sum, m) => (m.createdAt >= iso ? sum + (m.costRub ?? 0) : sum), 0);
}

export interface ModelSpend {
  model: string;
  tokens: number;
  rub: number;
}

/**
 * Разбивка трат за текущий месяц по моделям — включая нулевую стоимость, если
 * по модели были токены (демо показывает «бесплатно»): иначе на чистой
 * установке секция всегда пуста и непроверяема в smoke.
 */
export async function monthSpendByModel(): Promise<ModelSpend[]> {
  const from = new Date();
  from.setDate(1);
  from.setHours(0, 0, 0, 0);
  const iso = from.toISOString();
  const rows = alive(await db.messages.toArray()).filter(
    (m) => m.role === 'assistant' && m.model && m.createdAt >= iso,
  );
  const byModel = new Map<string, ModelSpend>();
  for (const m of rows) {
    const key = m.model as string;
    const entry = byModel.get(key) ?? { model: key, tokens: 0, rub: 0 };
    entry.tokens += (m.tokensIn ?? 0) + (m.tokensOut ?? 0);
    entry.rub += m.costRub ?? 0;
    byModel.set(key, entry);
  }
  return [...byModel.values()]
    .filter((e) => e.tokens !== 0 || e.rub !== 0)
    .sort((a, b) => b.rub - a.rub || b.tokens - a.tokens);
}
