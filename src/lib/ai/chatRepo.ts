import { db } from '../../db/db';
import { alive, now, stamp, uid } from '../repo';
import type { BaseEntity, Chat, Message } from '../../db/types';
import { costRub } from './models';
import type { ChatMessage, Reply } from './client';

/** Заголовок чата из первого вопроса — короткая первая строка без хвостов. */
export function autoTitle(text: string): string {
  const line = text.trim().split('\n')[0].trim();
  if (!line) return 'Без названия';
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
    title: 'Новый чат',
    providerId,
    model,
    systemPrompt: '',
    lastMessageAt: null,
    pinned: false,
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

async function addMessage(data: Omit<Message, keyof BaseEntity>): Promise<Message> {
  const row: Message = { ...data, id: uid(), createdAt: now(), updatedAt: now(), deletedAt: null };
  await db.messages.add(row);
  await db.chats.update(data.chatId, { lastMessageAt: row.createdAt, updatedAt: row.createdAt });
  return row;
}

export async function addUserMessage(chat: Chat, content: string, images?: string[]): Promise<Message> {
  // Первый вопрос даёт чату имя — руками переименовывать не нужно. Вопрос из
  // одних картинок (без текста) тоже достоин заголовка, а не пустой строки.
  if (chat.title === 'Новый чат') {
    const title = !content.trim() && images?.length ? 'Изображение' : autoTitle(content);
    await patchChat(chat.id, { title });
  }
  return addMessage({
    chatId: chat.id,
    role: 'user',
    content,
    model: null,
    tokensIn: null,
    tokensOut: null,
    costRub: null,
    status: 'done',
    error: null,
    images: images?.length ? images : undefined,
  });
}

export async function addAssistantMessage(
  chatId: string,
  reply: Reply,
  run?: { runId: string; runIndex: number; chosen?: boolean },
): Promise<Message> {
  return addMessage({
    chatId,
    role: 'assistant',
    content: reply.content,
    model: reply.model,
    tokensIn: reply.usage.in,
    tokensOut: reply.usage.out,
    costRub: costRub(reply.model, reply.usage.in, reply.usage.out),
    status: 'done',
    error: null,
    runId: run?.runId ?? null,
    runIndex: run?.runIndex ?? 0,
    chosen: run?.chosen ?? false,
    reasoning: reply.reasoning || undefined,
  });
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
  run?: { runId: string; runIndex: number },
): Promise<Message> {
  return addMessage({
    chatId,
    role: 'assistant',
    content: '',
    model: null,
    tokensIn: null,
    tokensOut: null,
    costRub: null,
    status: 'error',
    error,
    runId: run?.runId ?? null,
    runIndex: run?.runIndex ?? 0,
    chosen: false,
  });
}

export async function removeMessage(id: string): Promise<void> {
  const ts = now();
  await db.messages.update(id, { deletedAt: ts, updatedAt: ts });
}

/**
 * Контекст для отправки. Берём только успешные непустые сообщения: пустой
 * content (ошибка/отмена) провайдер отвергает с 400. Ограничение по
 * historyLimit — прямой контроль расхода: без него длинный диалог
 * оплачивается целиком на каждом вопросе.
 */
export function toContext(messages: Message[], historyLimit: number): ChatMessage[] {
  // Из прогона сравнения в контекст уходит ТОЛЬКО один ответ — выбранный, а
  // если выбор не сделан, первый. Иначе модель получила бы несколько разных
  // ответов на один и тот же вопрос, а платить пришлось бы за все сразу.
  const taken = new Set<string>();
  const usable = messages.filter((m) => {
    // Вопрос из одних картинок (без текста) валиден — content пуст, но
    // images непусты.
    if (m.status !== 'done' || (!m.content.trim() && !m.images?.length)) return false;
    if (!m.runId) return true;
    if (taken.has(m.runId)) return false;
    const group = messages.filter((x) => x.runId === m.runId);
    const winner = group.find((x) => x.chosen) ?? group[0];
    if (winner.id !== m.id) return false;
    taken.add(m.runId);
    return true;
  });
  const tail = historyLimit > 0 ? usable.slice(-historyLimit) : usable;
  return tail.map((m) => ({ role: m.role, content: m.content, images: m.images }));
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
      if (m.status === 'error') return `**Ошибка:** ${m.error ?? ''}`;
      return m.role === 'user' ? `## Вопрос\n\n${m.content}` : `## Ответ\n\n${m.content}`;
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
