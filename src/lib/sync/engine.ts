// Движок E2E-синхронизации: pull (получить чужие изменения, расшифровать,
// применить по принципу «новейший побеждает») + push (зашифровать свои свежие
// изменения и отправить). Архитектура и все обоснования взяты из
// life-hub/src/lib/sync.ts — здесь тот же движок, адаптированный под наш
// Dexie v4 (syncConfig) и составной курсор pull сервера (updated_at, id).

import { db } from '../../db/db';
import type { SyncConfig } from '../../db/types';
import { decryptJSON, encryptJSON, importAesKey } from './crypto';
import { getSyncConfig, patchSyncConfig } from './config';

// Таблицы, которые синхронизируются. settings НЕ входит — device-local
// (jinaKey, activeProviderId и т.п. осмысленны только на этом устройстве).
//
// Известный принятый компромисс: builtin-personas/snippets сеются заново на
// каждом устройстве при старте (ensureSeed) с ТЕКУЩИМ ts. В окне первого
// посева LWW может предпочесть свежепосеянную локальную копию только что
// прилетевшей отредактированной где-то ещё — но посев идемпотентен по
// фиксированным id, а контент во всех копиях совпадает, так что это не
// потеря данных. Ничего не придумываем сверху ради этого редкого случая.
const SYNCED_TABLES = ['chats', 'messages', 'providers', 'personas', 'snippets'] as const;
type SyncedTable = (typeof SYNCED_TABLES)[number];
const isSynced = (t: string): t is SyncedTable => (SYNCED_TABLES as readonly string[]).includes(t);

const PUSH_CHUNK = 200;

type Row = Record<string, unknown> & { id: string; updatedAt: string; deletedAt?: string | null };

// Формат провода: ровно то, что уходит по сети — открытые служебные поля +
// один непрозрачный blob. Сервер видит только это (см. server/src/index.ts).
interface RemoteRecord {
  tbl: string;
  id: string;
  updatedAt: string;
  deleted: 0 | 1;
  ciphertext: string;
}

interface PullResponse {
  records: RemoteRecord[];
  nextSince: string;
  nextSinceId: string;
  hasMore: boolean;
}

/** Применять ли удалённую правку: если локальной нет или удалённая новее (LWW). Строгое ">" — эхо своей же записи (та же updatedAt) не переприменяется. */
export function shouldApply(localUpdatedAt: string | undefined, remoteUpdatedAt: string): boolean {
  return !localUpdatedAt || remoteUpdatedAt > localUpdatedAt;
}

/**
 * Сбой ОТНОСИТСЯ К САМОЙ ЗАПИСИ (её можно пропустить и идти дальше), а не к
 * хранилищу? Битый шифротекст, не-JSON внутри, испорченный base64 — запись
 * «ядовитая», следующие к ней отношения не имеют. А вот QuotaExceededError,
 * DatabaseClosedError и прочие сбои IndexedDB означают, что не применится
 * НИЧЕГО: их надо пробросить, чтобы цикл упал и курсор pull не уехал вперёд
 * по записям, которые на самом деле не записаны.
 */
export function isPoisonRecord(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name ?? '';
  return (
    name === 'OperationError' || name === 'SyntaxError' || name === 'InvalidCharacterError' || name === 'DataError'
  );
}

function authHeaders(c: SyncConfig): Record<string, string> {
  return {
    'X-Space': c.spaceId,
    Authorization: `Bearer ${c.authToken}`,
    'Content-Type': 'application/json',
  };
}

// === PULL ===

async function pullPage(
  c: SyncConfig,
  key: CryptoKey,
  since: string,
  sinceId: string,
): Promise<{ applied: number; skipped: number; data: PullResponse }> {
  // limit не шлём — серверный дефолт (500) устраивает; сервер сам решает, чем
  // разумно ограничить страницу.
  const url = `${c.serverUrl}/sync/pull?since=${encodeURIComponent(since)}&sinceId=${encodeURIComponent(sinceId)}`;
  const res = await fetch(url, { headers: authHeaders(c) });
  if (!res.ok) throw new Error(`pull ${res.status}`);
  const data = (await res.json()) as PullResponse;

  // Группируем по таблице — так на каждую таблицу можно сделать один bulkGet
  // и один bulkPut вместо поштучных обращений к Dexie на каждую запись.
  const byTable = new Map<SyncedTable, RemoteRecord[]>();
  for (const rec of data.records) {
    const tbl = rec.tbl;
    if (!isSynced(tbl)) continue; // незнакомая таблица (например, более новый клиент где-то) — пропускаем
    const arr = byTable.get(tbl);
    if (arr) arr.push(rec);
    else byTable.set(tbl, [rec]);
  }

  let applied = 0;
  let skipped = 0;
  for (const [tbl, records] of byTable) {
    const table = db.table<Row>(tbl);
    const locals = await table.bulkGet(records.map((r) => r.id));
    const rows: Row[] = [];
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (!shouldApply(locals[i]?.updatedAt, r.updatedAt)) continue; // локальная запись не старше — входящую игнорируем
      try {
        rows.push(await decryptJSON<Row>(key, r.ciphertext));
      } catch (e) {
        // Сбой на ОДНОЙ «ядовитой» записи не должен ронять весь цикл — иначе
        // курсор не сдвинется и синк встанет навсегда. Сбой хранилища (ниже,
        // в bulkPut) — другое дело, его не глотаем.
        if (!isPoisonRecord(e)) throw e;
        skipped++;
        console.warn(`sync: пропущена запись ${tbl}/${r.id}`, e);
      }
    }
    if (rows.length) {
      // Пишем НАПРЯМУЮ мимо repo — сохраняем серверный updatedAt. Если бы
      // тут стоял repo.stamp/update, он проставил бы новый локальный
      // updatedAt, входящая правка выглядела бы как свежая локальная → уехала
      // бы обратно на сервер → бесконечный пинг-понг между устройствами.
      await table.bulkPut(rows); // ошибки bulkPut НЕ глотаем — это сбой хранилища, а не одной записи
      applied += rows.length;
    }
  }
  return { applied, skipped, data };
}

async function pull(c: SyncConfig, key: CryptoKey): Promise<{ applied: number; skipped: number }> {
  let applied = 0;
  let skipped = 0;
  let since = c.lastPullAt;
  let sinceId = c.lastPullId;
  for (;;) {
    const page = await pullPage(c, key, since, sinceId);
    applied += page.applied;
    skipped += page.skipped;
    since = page.data.nextSince;
    sinceId = page.data.nextSinceId;
    // Курсор двигаем ПОСЛЕ КАЖДОЙ страницы, а не в конце всего pull — цикл,
    // упавший на N-й странице (сеть/сервер прилёг), не должен заставлять
    // следующий запуск переприменять уже применённые первые N−1 страниц.
    await patchSyncConfig({ lastPullAt: since, lastPullId: sinceId });
    if (!page.data.hasMore) break;
  }
  return { applied, skipped };
}

// === PUSH ===
// Полный скан синкаемых таблиц + фильтр по updatedAt в окне. Для личного
// объёма данных (сотни записей) это миллисекунды; при росте можно перейти на
// outbox/индекс.
async function push(c: SyncConfig, key: CryptoKey): Promise<number> {
  // Курсор снимаем ДО скана и двигаем ровно на него — а НЕ на максимум
  // updatedAt среди найденных строк. Иначе правка, сделанная во время скана в
  // уже прочитанную таблицу, получила бы штамп МЕНЬШЕ нового курсора и не
  // уехала бы в облако никогда (фильтр следующего цикла её отбросил бы).
  const cutoff = new Date().toISOString();
  // Окно ПОЛУОТКРЫТОЕ: [lastPushAt, cutoff). Верхняя граница строгая — иначе
  // запись, созданная в ту же миллисекунду, что и cutoff, но уже ПОСЛЕ его
  // снятия, не попала бы ни в это окно (её ещё не было в базе на момент
  // скана), ни в следующее (там фильтр строго больше этого cutoff). Нижняя
  // граница включающая — она лишь переотправит одну пограничную запись, что
  // безвредно: на сервере ON CONFLICT ... WHERE excluded.updated_at > ...
  const inWindow = (u: unknown): u is string => typeof u === 'string' && u >= c.lastPushAt && u < cutoff;

  const fresh: { tbl: SyncedTable; row: Row }[] = [];
  for (const tbl of SYNCED_TABLES) {
    const rows = (await db.table<Row>(tbl).toArray()).filter((r) => inWindow(r.updatedAt));
    for (const row of rows) fresh.push({ tbl, row });
  }

  // Шифруем параллельно (Promise.all), а не последовательно await в цикле —
  // не блокирует главный поток при правке чата с большой историей сообщений.
  const out: RemoteRecord[] = await Promise.all(
    fresh.map(async ({ tbl, row }) => ({
      tbl,
      id: row.id,
      updatedAt: row.updatedAt,
      deleted: (row.deletedAt ? 1 : 0) as 0 | 1,
      ciphertext: await encryptJSON(key, row),
    })),
  );

  for (let i = 0; i < out.length; i += PUSH_CHUNK) {
    const res = await fetch(`${c.serverUrl}/sync/push`, {
      method: 'POST',
      headers: authHeaders(c),
      body: JSON.stringify({ records: out.slice(i, i + PUSH_CHUNK) }),
    });
    if (!res.ok) throw new Error(`push ${res.status}`);
  }
  await patchSyncConfig({ lastPushAt: cutoff });
  return out.length;
}

// === Оркестрация ===
let running = false;

/**
 * Один цикл: pull → push. Возвращает null, если синк выключен, конфига ещё
 * нет или цикл уже идёт (простая критическая секция — модульный флаг). С
 * `reset: true` курсоры зануляются ВНУТРИ секции — снаружи так делать нельзя:
 * уже идущий цикл дописал бы поверх свои значения курсоров, и сброс молча не
 * состоялся бы. Опция сейчас нигде не вызывается (UI для неё — за рамками
 * этой главы) и остаётся в API на будущее.
 */
export async function runSync(
  opts?: { reset?: boolean },
): Promise<{ pulled: number; pushed: number; skipped: number } | null> {
  // running выставляем СРАЗУ вслед за синхронной проверкой, ДО первого await.
  // Раньше флаг ставился уже ПОСЛЕ `await getSyncConfig()` — в этот
  // await-разрыв мог влезть второй параллельный вызов runSync(), тоже пройти
  // проверку `if (running)` (флаг ещё false) и запустить второй цикл pull/push
  // одновременно с первым: курсоры lastPullAt/lastPullId/lastPushAt/lastSyncAt
  // /lastError гоняются между двумя копиями, и последняя завершившаяся молча
  // перезаписывает более раннюю (подтверждено репро с двумя параллельными
  // вызовами). Между проверкой и установкой флага теперь нет ни одного await —
  // гонка невозможна.
  if (running) return null;
  running = true;
  try {
    let c = await getSyncConfig();
    if (!c || !c.enabled) return null;
    if (opts?.reset) {
      await patchSyncConfig({ lastPullAt: '', lastPullId: '', lastPushAt: '' });
      const reloaded = await getSyncConfig();
      if (!reloaded) return null;
      c = reloaded;
    }
    const key = await importAesKey(c.aesKeyB64); // один раз на цикл, а не на каждую запись
    const { applied: pulled, skipped } = await pull(c, key);
    const fresh = await getSyncConfig(); // курсор pull обновился внутри pull(); заодно ловим отключение синка во время цикла
    const pushed = fresh ? await push(fresh, key) : 0;
    await patchSyncConfig({ lastSyncAt: new Date().toISOString(), lastError: '' });
    return { pulled, pushed, skipped };
  } catch (e) {
    await patchSyncConfig({ lastError: String(e) });
    throw e; // фоновые вызовы гасят .catch(()=>{}), ручная кнопка в T3 покажет тост по исходу
  } finally {
    running = false;
  }
}

export function syncRunning(): boolean {
  return running;
}

// Debounce-синк после правок: пачка изменений за DEBOUNCE_MS уходит одним
// циклом синка. runSync сам no-op при выключенном синке или отсутствии
// конфига, поэтому накладных для не настроивших синк пользователей нет.
const DEBOUNCE_MS = 1500;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleSyncSoon(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void runSync().catch(() => {});
  }, DEBOUNCE_MS);
}

/** GET /health — не требует авторизации (см. server/src/index.ts). Используется кнопкой «Проверить связь» и валидацией сервера в SyncSheet (T3). */
export async function checkHealth(serverUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${serverUrl}/health`);
    if (!res.ok) return false;
    const data = (await res.json()) as { ok?: boolean };
    return data.ok === true;
  } catch {
    return false;
  }
}
