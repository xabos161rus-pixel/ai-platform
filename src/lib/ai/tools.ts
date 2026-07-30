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

const webSearchTool: ToolDef = {
  name: 'web_search',
  description: 'Search the web and return top results with title, url and a short snippet.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query text.' },
    },
    required: ['query'],
  },
  async run(args, ctx) {
    const query = String(args.query ?? '');
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
      .map((h, i) => {
        const snippet = (h.description ?? h.content ?? '').slice(0, 300);
        return `${i + 1}. ${h.title ?? ''}\n${h.url ?? ''}\n${snippet}`;
      })
      .join('\n\n');
  },
};

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

export function buildTools(opts: { jinaKey?: string }): ToolDef[] {
  // jinaKey сейчас не влияет на состав списка — инструменты просто читают его
  // из ToolCtx при вызове; параметр оставлен для симметрии с ToolCtx и на
  // случай будущих инструментов, которым ключ понадобится на этапе сборки.
  void opts;
  return [webSearchTool, readPageTool, getTimeTool];
}

export function toWireTools(tools: ToolDef[]): WireTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}
