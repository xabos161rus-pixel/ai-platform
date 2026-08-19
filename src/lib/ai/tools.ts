// Реестр инструментов агентского цикла.
//
// Инструменты работают через Jina AI (s.jina.ai — поиск, r.jina.ai — чтение
// страницы). Поиску ключ (Settings.jinaKey) ОБЯЗАТЕЛЕН — анонимный s.jina.ai
// отвечает 401; чтение страниц работает и без ключа, но с жёстким рейт-лимитом.
//
// description/parameters у инструментов — английские: это wire-контент для
// модели (JSON Schema function calling), а не UI-строка, i18n не участвует.
// Тексты ошибок — русские и самодиагностирующие: их читает модель, и она
// должна суметь пересказать пользователю, что именно сделать.

import type { WireTool } from './client';

export interface ToolCtx {
  signal: AbortSignal;
  jinaKey?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: object; // JSON Schema объекта аргументов
  run(args: Record<string, unknown>, ctx: ToolCtx): Promise<string>;
}

export const SEARCH_TOP = 5;
export const PAGE_CHAR_LIMIT = 12000;

function authHeaders(jinaKey?: string): Record<string, string> {
  return jinaKey ? { Authorization: `Bearer ${jinaKey}` } : {};
}

/** Ошибка Jina → текст, по которому модель поймёт, что сказать пользователю. */
function jinaError(status: number): Error {
  if (status === 401 || status === 403) {
    return new Error(
      `Jina отклонила запрос (HTTP ${status}): нет или неверен API-ключ. ` +
        'Передай пользователю: веб-поиску нужен бесплатный ключ с jina.ai — ' +
        'вставить в Настройки → Инструменты → Ключ Jina AI.',
    );
  }
  if (status === 402) {
    return new Error('Квота ключа Jina исчерпана (HTTP 402). Передай пользователю: обновить ключ или пополнить баланс на jina.ai.');
  }
  if (status === 429) {
    return new Error(
      'Слишком много запросов к Jina (HTTP 429). Повтори чуть позже; если повторяется — ' +
        'передай пользователю, что нужен свой ключ jina.ai (Настройки → Инструменты).',
    );
  }
  return new Error(`HTTP ${status}`);
}

interface JinaSearchHit {
  title?: string;
  url?: string;
  description?: string;
  content?: string;
}
interface JinaSearchResponse {
  data?: JinaSearchHit[];
}

/**
 * Ветка веб-поиска через Jina (s.jina.ai) — то же тело, что раньше жило прямо
 * в webSearchTool.run, вынесено отдельной функцией: нужна и как единственный
 * путь при выключенном синке, и как молчаливый фолбэк, когда серверный поиск
 * недоступен/выключен (см. makeWebSearchTool ниже).
 */
export interface SourceRef {
  n: number;
  title: string;
  url: string;
}

/** Сквозная нумерация результатов и сбор источников прогона: buildTools
 *  создаётся на каждый прогон, счётчик и реестр живут в его замыкании. */
interface SourceBook {
  next: number;
  refs: SourceRef[];
  add(title: string, url: string): number;
}

function newSourceBook(): SourceBook {
  const book: SourceBook = {
    next: 1,
    refs: [],
    add(title, url) {
      // Один URL — один номер: повторный поиск не плодит дубли источников.
      const seen = book.refs.find((r) => r.url === url);
      if (seen) return seen.n;
      const ref = { n: book.next++, title: title || url, url };
      book.refs.push(ref);
      return ref.n;
    },
  };
  return book;
}

async function jinaSearch(query: string, ctx: ToolCtx, book: SourceBook): Promise<string> {
  const res = await fetch(`https://s.jina.ai/?q=${encodeURIComponent(query)}`, {
    headers: {
      Accept: 'application/json',
      // Только SERP (title/url/description), БЕЗ чтения топ-страниц ридером:
      // иначе Jina ходит по каждому результату и ответ легко выходит за
      // таймаут инструмента (ровно так поиск и «зависал» у DeepSeek).
      'X-Respond-With': 'no-content',
      ...authHeaders(ctx.jinaKey),
    },
    signal: ctx.signal,
  });
  if (!res.ok) throw jinaError(res.status);
  const json = (await res.json()) as JinaSearchResponse;
  const hits = (json.data ?? []).slice(0, SEARCH_TOP);
  // Wire-контент для модели (как и остальные строки результата инструмента) — по-английски, не через i18n.
  if (!hits.length) return 'No results found';
  return hits
    .map((h) => {
      const n = book.add(h.title ?? '', h.url ?? '');
      const snippet = (h.description ?? h.content ?? '').slice(0, 400);
      return `[${n}] ${h.title ?? ''}\n${h.url ?? ''}\n${snippet}`;
    })
    .join('\n\n');
}

/** Конфиг серверного поиска: web_search ходит в свой воркер (Serper), пока синк включён. */
export interface SyncSearchCtx {
  serverUrl: string;
  spaceId: string;
  authToken: string;
}

/**
 * Фабрика вместо константы: серверный конфиг синка (T4) замыкается на этапе
 * сборки списка инструментов (buildTools), а НЕ прокидывается через ToolCtx —
 * его собирает agentLoop.execWithTimeout сам как {signal, jinaKey}, и
 * расширение ToolCtx потребовало бы правок agentLoop (решение 10). Так
 * agentLoop остаётся нетронутым, а web_search просто получает готовый
 * sync-конфиг из замыкания либо undefined.
 */
function makeWebSearchTool(book: SourceBook, sync?: SyncSearchCtx): ToolDef {
  return {
    name: 'web_search',
    description:
      'Search the web and return numbered results [n] with title, url and a short snippet. Cite facts in your answer with the matching [n] markers.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query text.' },
      },
      required: ['query'],
    },
    async run(args, ctx) {
      const query = String(args.query ?? '');
      if (sync) {
        try {
          const res = await fetch(`${sync.serverUrl}/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Space': sync.spaceId, Authorization: `Bearer ${sync.authToken}` },
            body: JSON.stringify({ q: query }),
            signal: ctx.signal,
          });
          if (!res.ok) throw new Error(`search ${res.status}`); // 501 без Serper-ключа, 429/402 квоты — всё в фолбэк
          const data = (await res.json()) as { results?: { title?: string; url?: string; snippet?: string }[]; answer?: string | null };
          const hits = (data.results ?? []).slice(0, SEARCH_TOP);
          if (hits.length || data.answer) {
            const head = data.answer ? `Ответ: ${data.answer}\n\n` : '';
            return (
              head +
              hits
                .map((h) => {
                  const n = book.add(h.title ?? '', h.url ?? '');
                  return `[${n}] ${h.title ?? ''}\n${h.url ?? ''}\n${(h.snippet ?? '').slice(0, 400)}`;
                })
                .join('\n\n')
            );
          }
          return 'No results found';
        } catch (e) {
          // Остановку пользователя уважаем — не подменяем фолбэком.
          if (ctx.signal.aborted) throw e;
          // Сервер лёг/квота/выключен поиск — молча падаем на Jina: пользователь просто получает результат.
        }
      }
      return jinaSearch(query, ctx, book);
    },
  };
}

const readPageTool: ToolDef = {
  name: 'read_page',
  description: 'Fetch a web page by URL and return its readable text content.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Full http(s) URL of the page to read.' },
    },
    required: ['url'],
  },
  async run(args, ctx) {
    const url = String(args.url ?? '');
    if (!/^https?:\/\//i.test(url)) throw new Error('bad url');
    // url НЕ энкодируем целиком — Jina принимает исходный URL как хвост пути.
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers: { ...authHeaders(ctx.jinaKey) },
      signal: ctx.signal,
    });
    if (!res.ok) throw jinaError(res.status);
    const text = await res.text();
    if (text.length > PAGE_CHAR_LIMIT) {
      return `${text.slice(0, PAGE_CHAR_LIMIT)}\n\n[обрезано: показаны первые ${PAGE_CHAR_LIMIT} символов]`;
    }
    return text;
  },
};

const getTimeTool: ToolDef = {
  name: 'get_time',
  description: 'Get the current date and time on the user device, with timezone.',
  parameters: { type: 'object', properties: {} },
  async run() {
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return `${now.toString()}\n${now.toISOString()}\n${tz}`;
  },
};

export function buildTools(opts: { jinaKey?: string; sync?: SyncSearchCtx }): { tools: ToolDef[]; sources: SourceRef[] } {
  // opts.jinaKey и здесь не участвует — инструменты читают его из ToolCtx на
  // каждый вызов (его собирает agentLoop.execWithTimeout). А opts.sync нужен
  // именно на этом этапе: серверный конфиг замыкается в web_search при сборке
  // списка инструментов, а не через ToolCtx (см. makeWebSearchTool выше).
  // Реестр источников живёт в замыкании прогона: buildTools вызывается на
  // каждый запрос, нумерация [n] сквозная и стабильная в его пределах.
  const book = newSourceBook();
  return { tools: [makeWebSearchTool(book, opts.sync), readPageTool, getTimeTool], sources: book.refs };
}

export function toWireTools(tools: ToolDef[]): WireTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}
