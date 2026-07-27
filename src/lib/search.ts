// Поиск по чатам: заголовки и содержимое сообщений — единая точка для
// сайдбара и командной палитры, чтобы поведение (кап, сортировка, фрагмент)
// не разъезжалось между двумя UI.
import { db } from '../db/db';
import type { Chat } from '../db/types';
import { alive } from './repo';

export interface SearchHit {
  chat: Chat;
  /** Фрагмент текста вокруг совпадения — есть только у хитов по содержимому. */
  fragment?: string;
}

/** ±40 символов вокруг совпадения; переводы строк — в пробел, многоточия по краям при обрезке. */
function buildFragment(content: string, matchIndex: number, qLen: number): string {
  const from = Math.max(0, matchIndex - 40);
  const to = Math.min(content.length, matchIndex + qLen + 40);
  const slice = content.slice(from, to).replace(/\n/g, ' ');
  return `${from > 0 ? '…' : ''}${slice}${to < content.length ? '…' : ''}`;
}

/**
 * Живые чаты по заголовку и содержимому сообщений, один лучший (первый
 * найденный) хит на чат. db.messages.filter — линейный проход по таблице, но
 * .limit(200) прерывает его рано: полнотекстовый индекс был бы оверкиллом для
 * локальной базы в тысячи сообщений. Совпадения по заголовку идут первыми.
 */
export async function searchAll(query: string, cap = 50): Promise<SearchHit[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const chats = alive(await db.chats.toArray());
  const byId = new Map(chats.map((c) => [c.id, c] as const));

  const hits = new Map<string, SearchHit>();
  for (const c of chats) {
    if (c.title.toLowerCase().includes(q)) hits.set(c.id, { chat: c });
  }

  const rows = await db.messages
    .filter((m) => !m.deletedAt && m.content.toLowerCase().includes(q))
    .limit(200)
    .toArray();
  // Один — ПЕРВЫЙ найденный — фрагмент на чат: дальнейшие совпадения того же
  // чата пропускаем, иначе выдача превратилась бы в ленту сообщений.
  const gotFragment = new Set<string>();
  for (const m of rows) {
    if (gotFragment.has(m.chatId)) continue;
    const chat = byId.get(m.chatId);
    if (!chat) continue; // сообщение мёртвого чата — не в alive-списке
    gotFragment.add(m.chatId);
    const idx = m.content.toLowerCase().indexOf(q);
    const fragment = buildFragment(m.content, idx, q.length);
    const existing = hits.get(m.chatId);
    if (existing) existing.fragment = fragment;
    else hits.set(m.chatId, { chat, fragment });
  }

  return [...hits.values()]
    .sort((a, b) => {
      const aTitle = a.chat.title.toLowerCase().includes(q);
      const bTitle = b.chat.title.toLowerCase().includes(q);
      if (aTitle !== bTitle) return aTitle ? -1 : 1;
      return (b.chat.lastMessageAt ?? b.chat.createdAt).localeCompare(a.chat.lastMessageAt ?? a.chat.createdAt);
    })
    .slice(0, cap);
}
