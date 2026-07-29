// Реестр инструментов агентского цикла.
//
// Инструменты работают через Jina AI (s.jina.ai — поиск, r.jina.ai — чтение
// страницы): у Jina есть бесплатный тир без ключа, поэтому агентский режим
// работает «из коробки», а свой ключ (Settings.jinaKey) просто снимает более
// жёсткий рейт-лимит анонимных запросов.
//
// description/parameters у инструментов — английские: это wire-контент для
// модели (JSON Schema function calling), а не UI-строка, i18n не участвует.

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
      headers: { Accept: 'application/json', ...authHeaders(ctx.jinaKey) },
      signal: ctx.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
