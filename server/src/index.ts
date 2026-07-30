// Воркер синхронизации + поиска для ai-platform. Чистый fetch-handler без
// фреймворков (аналог life-hub/worker, но своя БД и свой набор таблиц —
// см. /workspace/ai-platform/src/db/db.ts на клиенте).
// HTTP:
//   GET  /health       — проверка живости
//   POST /sync/push    — приём записей (только шифротекст), D1
//   GET  /sync/pull    — дельта записей курсором (updatedAt, id)
//   POST /search       — прокси к serper.dev для инструмента web_search

export interface Env {
  DB: D1Database;
  ALLOW_ORIGIN?: string;
  SERPER_KEY?: string;
}

// Локальные адреса разработки (vite dev и vite preview из package.json —
// npm run smoke поднимает превью на 4174). Прод-домен приходит из vars.
const DEV_ORIGINS = ['http://localhost:4174', 'http://localhost:5173'];

const PULL_LIMIT = 500;

// Отражаем свой же Origin, если он совпадает с разрешённым — иначе браузер
// не примет ответ ни при каком заголовке, кроме '*' (а '*' несовместим с
// Authorization/credentialed-запросами). Прод-домен и дев-адреса — единственные,
// кому вообще можно ходить в этот воркер.
function allowOrigin(request: Request, env: Env): string {
  const origin = request.headers.get('Origin') ?? '';
  if (origin === env.ALLOW_ORIGIN || DEV_ORIGINS.includes(origin)) return origin;
  return env.ALLOW_ORIGIN ?? '*';
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Space',
    'Access-Control-Max-Age': '86400',
  };
}

function json(data: unknown, status: number, origin: string): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Авторизация синка: X-Space = spaceId, Authorization: Bearer <authToken>.
 * spaceId и authToken выводятся на клиенте из фразы пользователя через
 * PBKDF2+HKDF (см. решение 2 архитектуры) — токен неугадываем, поэтому
 * первое обращение с новым spaceId само его регистрирует (trust on first
 * use), отдельного шага логина/регистрации нет. Дальнейшие обращения
 * сверяются с сохранённым хэшем токена.
 */
async function authSpace(request: Request, env: Env): Promise<string | null> {
  const spaceId = request.headers.get('X-Space');
  const auth = request.headers.get('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!spaceId || !token) return null;
  const hash = await sha256hex(token);
  const row = await env.DB.prepare('SELECT token_hash FROM spaces WHERE space_id = ?')
    .bind(spaceId)
    .first<{ token_hash: string }>();
  if (!row) {
    await env.DB.prepare('INSERT INTO spaces (space_id, token_hash, created_at) VALUES (?, ?, ?)')
      .bind(spaceId, hash, new Date().toISOString())
      .run();
    return spaceId;
  }
  return row.token_hash === hash ? spaceId : null;
}

interface SerperOrganic {
  title?: string;
  link?: string;
  snippet?: string;
}

interface SerperAnswerBox {
  answer?: string;
  snippet?: string;
}

interface SerperResponse {
  organic?: SerperOrganic[];
  answerBox?: SerperAnswerBox;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = allowOrigin(request, env);
    // До любого роутинга — иначе preflight (его шлёт браузер перед запросом
    // с Authorization/X-Space) получит 404 и реальный запрос до сервера не дойдёт.
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });

    const url = new URL(request.url);
    try {
      if (url.pathname === '/health') return json({ ok: true }, 200, origin);

      if (url.pathname === '/sync/push' && request.method === 'POST') {
        const spaceId = await authSpace(request, env);
        if (!spaceId) return json({ error: 'unauthorized' }, 401, origin);
        const body = (await request.json()) as { records?: unknown };
        if (!Array.isArray(body.records)) return json({ error: 'bad request' }, 400, origin);

        // LWW на сервере: WHERE excluded.updated_at > records.updated_at значит,
        // что переотправка пограничной записи из полуоткрытого push-окна клиента
        // (см. lib/sync.ts) безвредна — более старая версия просто не перетрёт
        // уже сохранённую более новую (например, с другого устройства).
        const stmt = env.DB.prepare(
          `INSERT INTO records (space_id, tbl, id, updated_at, deleted, ciphertext)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(space_id, tbl, id) DO UPDATE SET
             updated_at = excluded.updated_at,
             deleted = excluded.deleted,
             ciphertext = excluded.ciphertext
           WHERE excluded.updated_at > records.updated_at`,
        );
        // Клиент чанкует не больше 200 записей на запрос — здесь просто
        // складываем всё, что пришло, в один батч D1.
        const batch: D1PreparedStatement[] = [];
        for (const r of body.records) {
          if (!r || typeof r !== 'object') continue;
          const rec = r as Record<string, unknown>;
          // Пропускаем записи с неверными типами полей, а не роняем весь запрос —
          // одна битая запись не должна блокировать синк остальных.
          if (typeof rec.tbl !== 'string') continue;
          if (typeof rec.id !== 'string') continue;
          if (typeof rec.updatedAt !== 'string') continue;
          if (typeof rec.ciphertext !== 'string') continue;
          batch.push(stmt.bind(spaceId, rec.tbl, rec.id, rec.updatedAt, rec.deleted ? 1 : 0, rec.ciphertext));
        }
        if (batch.length) await env.DB.batch(batch);
        return json({ ok: true, count: batch.length }, 200, origin);
      }

      if (url.pathname === '/sync/pull' && request.method === 'GET') {
        const spaceId = await authSpace(request, env);
        if (!spaceId) return json({ error: 'unauthorized' }, 401, origin);
        const since = url.searchParams.get('since') ?? '';
        const sinceId = url.searchParams.get('sinceId') ?? '';
        const limitParam = parseInt(url.searchParams.get('limit') ?? '', 10);
        const limit = Math.min(Math.max(limitParam || PULL_LIMIT, 1), PULL_LIMIT);

        // Сравнение ROW VALUES (updated_at, id) > (?, ?), а НЕ эквивалентная
        // форма с OR — только row values SQLite превращает в seek по составному
        // индексу idx_records_pull. С OR планировщик берёт индекс лишь по
        // space_id и сканирует все записи пространства на каждый /sync/pull —
        // при опросе раз в 90с с двух устройств это миллионы прочитанных строк
        // в сутки и выход за лимиты D1 (тот же урок, что в life-hub, миграция 0006).
        //
        // Допущение: курсор — ПАРА (updated_at, id), а не тройка с tbl, хотя
        // PRIMARY KEY таблицы — (space_id, tbl, id). Если бы у двух записей в
        // РАЗНЫХ tbl когда-нибудь совпали id И updated_at (до миллисекунды) в
        // одном space_id, а один из них лёг бы последней строкой страницы,
        // второй тихо выпал бы из фильтра — потерянная запись для этого
        // клиента. Не страшно, пока id везде генерируется crypto.randomUUID()
        // одним генератором для всех синкаемых таблиц (см. src/lib/repo.ts,
        // uid()) — совпадение потребовало бы столкновения UUID. Если id
        // когда-нибудь станут предсказуемыми/составными — курсор надо расширить
        // до тройки (ORDER BY updated_at, id, tbl; сравнение с (?, ?, ?)).
        const res = await env.DB.prepare(
          `SELECT tbl, id, updated_at AS u, deleted AS d, ciphertext AS c
           FROM records
           WHERE space_id = ? AND (updated_at, id) > (?, ?)
           ORDER BY updated_at, id LIMIT ?`,
        )
          .bind(spaceId, since, sinceId, limit + 1)
          .all<{ tbl: string; id: string; u: string; d: number; c: string }>();
        const rows = res.results ?? [];
        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const records = page.map((r) => ({
          tbl: r.tbl,
          id: r.id,
          updatedAt: r.u,
          deleted: r.d,
          ciphertext: r.c,
        }));
        const last = records.length ? records[records.length - 1] : null;
        // Пустая страница — курсор не двигаем, отдаём то, что прислал клиент.
        const nextSince = last ? last.updatedAt : since;
        const nextSinceId = last ? last.id : sinceId;
        return json({ records, nextSince, nextSinceId, hasMore }, 200, origin);
      }

      if (url.pathname === '/search' && request.method === 'POST') {
        // Авторизация ДО проверки SERPER_KEY: без неё это открытый прокси на
        // платный ключ serper.dev для кого угодно (урок AI_ALLOWED_ACCOUNTS
        // из life-hub/worker/src/index.js).
        const spaceId = await authSpace(request, env);
        if (!spaceId) return json({ error: 'unauthorized' }, 401, origin);
        if (!env.SERPER_KEY) return json({ error: 'search_disabled' }, 501, origin);
        const body = (await request.json()) as { q?: unknown };
        if (typeof body.q !== 'string' || !body.q.trim()) return json({ error: 'bad request' }, 400, origin);

        const res = await fetch('https://google.serper.dev/search', {
          method: 'POST',
          headers: { 'X-API-KEY': env.SERPER_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: body.q, gl: 'ru', hl: 'ru' }),
        });
        // Пробрасываем статус Serper как есть — покрывает 429 (рейт-лимит) и
        // 402 (кончились кредиты), не оставляя дыр на прочих кодах.
        if (!res.ok) return json({ error: `serper_${res.status}` }, res.status, origin);
        const data = (await res.json()) as SerperResponse;
        // Внимание: у Serper поле ссылки в organic называется `link`, не `url` —
        // маппим здесь в единообразный {title,url,snippet} для клиента.
        const results = (data.organic ?? []).slice(0, 5).map((o) => ({
          title: o.title ?? '',
          url: o.link ?? '',
          snippet: o.snippet ?? '',
        }));
        const answer = data.answerBox?.answer ?? data.answerBox?.snippet ?? null;
        return json({ results, answer }, 200, origin);
      }

      return json({ error: 'not found' }, 404, origin);
    } catch (e) {
      return json({ error: String(e) }, 500, origin);
    }
  },
};
