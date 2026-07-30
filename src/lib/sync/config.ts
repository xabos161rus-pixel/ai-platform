// Хранилище конфига E2E-синхронизации: одна строка id 'sync' в Dexie.
// Никакой логики синка здесь нет (см. engine.ts) — только CRUD над записью.

import { db } from '../../db/db';
import type { SyncConfig } from '../../db/types';

/** Сервер по умолчанию — воркер Влада, тот же CF-аккаунт, что у life-hub-push. */
export const DEFAULT_SERVER_URL = 'https://ai-platform-sync.xabos161rus.workers.dev';

export function getSyncConfig(): Promise<SyncConfig | undefined> {
  return db.syncConfig.get('sync');
}

export async function saveSyncConfig(c: SyncConfig): Promise<void> {
  await db.syncConfig.put(c);
}

/** Частичное обновление; no-op, если конфига ещё нет (нечего патчить). */
export async function patchSyncConfig(changes: Partial<SyncConfig>): Promise<void> {
  await db.syncConfig.update('sync', changes);
}

export async function clearSyncConfig(): Promise<void> {
  await db.syncConfig.delete('sync');
}
