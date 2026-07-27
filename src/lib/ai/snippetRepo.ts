import { db } from '../../db/db';
import { alive, now, stamp } from '../repo';
import type { Snippet } from '../../db/types';

/** Встроенные сниппеты первыми (по образцу personaRepo), внутри групп — по времени создания. */
export async function listSnippets(): Promise<Snippet[]> {
  const rows = alive(await db.snippets.toArray());
  return rows.sort((a, b) => {
    if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

export async function addSnippet(title: string, text: string): Promise<Snippet> {
  const row = stamp<Snippet>({ title: title.trim(), text, builtin: false });
  await db.snippets.add(row);
  return row;
}

export async function patchSnippet(id: string, changes: Partial<Pick<Snippet, 'title' | 'text'>>): Promise<void> {
  await db.snippets.update(id, { ...changes, updatedAt: now() });
}

export async function removeSnippet(id: string): Promise<void> {
  const row = await db.snippets.get(id);
  // Встроенные не удаляем — UI кнопку удаления для них не показывает, это
  // вторая, серверная защита от гонки/прямого вызова (по образцу personaRepo).
  if (!row || row.builtin) return;
  const ts = now();
  await db.snippets.update(id, { deletedAt: ts, updatedAt: ts });
}
