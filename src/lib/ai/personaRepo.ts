import { db } from '../../db/db';
import { alive, now, stamp } from '../repo';
import { scheduleSyncSoon } from '../sync/engine';
import type { Persona } from '../../db/types';

/** Встроенные роли первыми (порядок посева не гарантирован), внутри групп — по имени. */
export async function listPersonas(): Promise<Persona[]> {
  const rows = alive(await db.personas.toArray());
  return rows.sort((a, b) => {
    if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
    return a.name.localeCompare(b.name, 'ru');
  });
}

export async function createPersona(name: string, prompt: string): Promise<Persona> {
  const persona = stamp<Persona>({ name: name.trim(), prompt: prompt.trim(), builtin: false });
  await db.personas.add(persona);
  scheduleSyncSoon();
  return persona;
}

export async function removePersona(id: string): Promise<void> {
  const row = await db.personas.get(id);
  // Встроенные не удаляем: UI кнопку удаления для них и не показывает, это
  // вторая, серверная защита от гонки/прямого вызова.
  if (!row || row.builtin) return;
  const ts = now();
  await db.personas.update(id, { deletedAt: ts, updatedAt: ts });
  scheduleSyncSoon();
}
