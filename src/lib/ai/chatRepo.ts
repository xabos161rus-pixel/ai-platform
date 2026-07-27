import { db } from '../../db/db';
import { alive, now, stamp, uid } from '../repo';
import type { BaseEntity, Chat, Message } from '../../db/types';
import { costRub } from './models';
import type { Reply } from './client';

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

export async function addUserMessage(chat: Chat, content: string): Promise<Message> {
  // Первый вопрос даёт чату имя — руками переименовывать не нужно.
  if (chat.title === 'Новый чат') await patchChat(chat.id, { title: autoTitle(content) });
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
export function toContext(messages: Message[], historyLimit: number): { role: 'user' | 'assistant'; content: string }[] {
  // Из прогона сравнения в контекст уходит ТОЛЬКО один ответ — выбранный, а
  // если выбор не сделан, первый. Иначе модель получила бы несколько разных
  // ответов на один и тот же вопрос, а платить пришлось бы за все сразу.
  const taken = new Set<string>();
  const usable = messages.filter((m) => {
    if (m.status !== 'done' || !m.content.trim()) return false;
    if (!m.runId) return true;
    if (taken.has(m.runId)) return false;
    const group = messages.filter((x) => x.runId === m.runId);
    const winner = group.find((x) => x.chosen) ?? group[0];
    if (winner.id !== m.id) return false;
    taken.add(m.runId);
    return true;
  });
  const tail = historyLimit > 0 ? usable.slice(-historyLimit) : usable;
  return tail.map((m) => ({ role: m.role, content: m.content }));
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
