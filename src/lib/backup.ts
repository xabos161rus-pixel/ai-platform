// Экспорт/импорт снапшота всей базы — страховка от потери устройства и
// перенос между устройствами вручную (Dexie-хранилище не синхронизируется).

import { db, SCHEMA_VERSION } from '../db/db';
import type { Chat, Message, Persona, Provider, Settings, Snippet } from '../db/types';

export interface BackupFile {
  app: 'ai-platform';
  schema: number;
  exportedAt: string;
  chats: Chat[];
  messages: Message[];
  providers: Provider[];
  personas: Persona[];
  settings: Settings[];
  snippets: Snippet[];
}

export interface ImportReport {
  chats: number;
  messages: number;
  providers: number;
  personas: number;
  snippets: number;
}

/** Полный снапшот, включая мягко удалённые записи — иначе снапшот неполный. */
export async function exportAll(): Promise<BackupFile> {
  const [chats, messages, providers, personas, settings, snippets] = await Promise.all([
    db.chats.toArray(),
    db.messages.toArray(),
    db.providers.toArray(),
    db.personas.toArray(),
    db.settings.toArray(),
    db.snippets.toArray(),
  ]);
  return {
    app: 'ai-platform',
    schema: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    chats,
    messages,
    providers,
    personas,
    settings,
    snippets,
  };
}

/** Оставить только элементы с валидным строковым id — остальное отбрасываем как мусор. */
function pickWithId<T extends { id: unknown }>(raw: unknown): T[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is T => typeof x === 'object' && x !== null && typeof (x as { id?: unknown }).id === 'string');
}

/**
 * Синхронная валидация без записи в базу — позволяет показать пользователю
 * точные числа в подтверждении ДО того, как что-либо изменится.
 */
export function parseBackup(raw: unknown): BackupFile {
  if (typeof raw !== 'object' || raw === null) throw new Error('bad_format');
  const r = raw as Record<string, unknown>;
  if (r.app !== 'ai-platform' || typeof r.schema !== 'number') throw new Error('bad_format');
  return {
    app: 'ai-platform',
    schema: r.schema,
    exportedAt: typeof r.exportedAt === 'string' ? r.exportedAt : new Date().toISOString(),
    chats: pickWithId<Chat>(r.chats),
    messages: pickWithId<Message>(r.messages),
    providers: pickWithId<Provider>(r.providers),
    personas: pickWithId<Persona>(r.personas),
    settings: pickWithId<Settings>(r.settings).filter((s) => s.id === 'app'),
    // Старые снапшоты без поля snippets — pickWithId на non-array вернёт [].
    snippets: pickWithId<Snippet>(r.snippets),
  };
}

/**
 * Запись снапшота. bulkPut идемпотентен по id: свои записи перезаписываются,
 * чужие остаются — экспорт→импорт на том же устройстве ничего не дублирует.
 */
export async function importAll(b: BackupFile): Promise<ImportReport> {
  await db.transaction('rw', [db.chats, db.messages, db.providers, db.personas, db.settings, db.snippets], async () => {
    if (b.chats.length) await db.chats.bulkPut(b.chats);
    if (b.messages.length) await db.messages.bulkPut(b.messages);
    if (b.providers.length) await db.providers.bulkPut(b.providers);
    if (b.personas.length) await db.personas.bulkPut(b.personas);
    if (b.settings.length) await db.settings.bulkPut(b.settings);
    if (b.snippets.length) await db.snippets.bulkPut(b.snippets);
  });
  return {
    chats: b.chats.length,
    messages: b.messages.length,
    providers: b.providers.length,
    personas: b.personas.length,
    snippets: b.snippets.length,
  };
}
