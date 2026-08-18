// Слой обращения к модели.
//
// Все поддерживаемые API — OpenAI-совместимые (/chat/completions), поэтому
// один адаптер закрывает и российские агрегаторы, и собственный прокси, и
// локальный сервер: различаются только baseUrl и ключ. Anthropic со своим
// форматом Messages добавится отдельным адаптером, когда понадобится.
//
// Ключ живёт в IndexedDB устройства и уходит только самому провайдеру —
// платформа BYOK, посредников между пользователем и его ключом нет.

import type { Provider } from '../../db/types';
import { estimateTokens } from './models';
import { getLang, t } from '../i18n';

export interface Usage {
  in: number;
  out: number;
  /** Токены размышлений — ПОДмножество out (completion_tokens их уже включает,
   *  стоимость от out верна). Отдельно храним, чтобы показать, куда ушёл счёт:
   *  у думающих моделей мысли — заметная часть выхода. null — провайдер не отдал. */
  reasoning?: number | null;
  /** Токены входа, прочитанные из кеша провайдера, — подмножество in. Обычно
   *  тарифицируются дешевле; свой прайс кеша не выдумываем — только показываем. */
  cached?: number | null;
}

export interface Reply {
  content: string;
  model: string;
  usage: Usage;
  reasoning?: string;
  toolCalls?: ToolCallReq[];
  finishReason?: string;
}

/** Вызов инструмента, запрошенный моделью. arguments — сырой JSON-текст (может быть битым — парсит вызывающий). */
export interface ToolCallReq {
  id: string;
  name: string;
  arguments: string;
}

/** Описание инструмента в wire-формате OpenAI-совместимого API (поле tools в теле запроса). */
export type WireTool = { type: 'function'; function: { name: string; description: string; parameters: object } };

/**
 * Готовые wire-сообщения агентского цикла (ответ модели с tool_calls и результаты
 * инструментов). agentLoop добавляет их ПОСЛЕ toWire(messages) как есть — toWire
 * новым ролям не обучаем, история цикла с обычными сообщениями не пересекается.
 */
export type WireAgentMsg =
  | {
      role: 'assistant';
      content: string | null;
      tool_calls: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  images?: string[];
}

/** Часть мультимодального сообщения в wire-формате OpenAI-совместимого API. */
type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

/**
 * Упаковка сообщений в wire-формат. Без картинок content остаётся строкой —
 * максимальная совместимость с провайдерами без vision. С картинками —
 * массив частей: текст (если есть) плюс по одной части на каждый dataURL.
 */
function toWire(messages: ChatMessage[]): { role: 'user' | 'assistant'; content: string | ContentPart[] }[] {
  return messages.map((m) => {
    if (!m.images?.length) return { role: m.role, content: m.content };
    const parts: ContentPart[] = [];
    if (m.content.trim()) parts.push({ type: 'text', text: m.content });
    for (const url of m.images) parts.push({ type: 'image_url', image_url: { url } });
    return { role: m.role, content: parts };
  });
}

export type ErrorCode =
  | 'no_provider'
  | 'no_key'
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limit'
  | 'bad_request'
  | 'geo_blocked'
  | 'network'
  | 'aborted'
  | 'provider';

export class AiError extends Error {
  // Поле объявлено явно: в проекте включён erasableSyntaxOnly, и сокращённая
  // форма конструктора с модификатором доступа там запрещена.
  code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'AiError';
    this.code = code;
  }
}

/** Текст ошибки для человека — без кодов и стектрейсов. */
export function errorText(e: unknown): string {
  if (!(e instanceof AiError)) return t('error.unknown');
  switch (e.code) {
    case 'no_provider':
      return t('error.noProvider');
    case 'no_key':
      return t('error.noKey');
    case 'unauthorized':
      return t('error.unauthorized');
    case 'forbidden':
      return t('error.forbidden');
    case 'geo_blocked':
      return t('error.geoBlocked');
    case 'rate_limit':
      return t('error.rateLimit');
    case 'aborted':
      return t('error.aborted');
    case 'network':
      return t('error.network');
    default:
      return e.message;
  }
}

/**
 * Ответ демо-провайдера: платформа работает сразу после установки.
 * Контент строится по текущему языку интерфейса (getLang()) в момент
 * генерации — это код, а не запись БД, поэтому перегенерируется свободно.
 */
function demoReply(messages: ChatMessage[], systemPrompt: string, model = 'demo-echo'): Reply {
  const last = messages[messages.length - 1];
  const imgs = last.images?.length ?? 0;
  const ru = getLang() === 'ru';
  // toContext вклеивает текст файлов в content блоками <file name="…">…</file>
  // (см. lib/ai/chatRepo.ts) — реальная модель должна их видеть, но демо-эхо
  // не должно дословно печатать содержимое чужого файла обратно в ленту:
  // обрезаем цитату вопроса ДО первого такого блока, если он есть.
  const hasFileBlock = /<file name="/.test(last.content);
  const questionText = hasFileBlock ? last.content.split(/<file name="/)[0].trimEnd() : last.content;
  if (model === 'demo-fast') {
    const lines = ru
      ? [
          '**Демо · краткий.** Вторая модель отвечает иначе — так видно смысл сравнения.',
          '',
          `Вопрос: «${questionText.slice(0, 120)}»`,
          '',
          `Сообщений в контексте: ${messages.length}`,
        ]
      : [
          "**Demo · brief.** The second model answers differently — that's the point of comparison.",
          '',
          `Question: "${questionText.slice(0, 120)}"`,
          '',
          `Messages in context: ${messages.length}`,
        ];
    if (imgs > 0) lines.push('', ru ? `Изображений: ${imgs}` : `Images: ${imgs}`);
    if (hasFileBlock) lines.push('', ru ? 'К вопросу приложен файл.' : 'A file is attached to the question.');
    const short = lines.join('\n');
    // demo-fast намеренно не шлёт reasoning — живой пример модели без мыслей.
    return { content: short, model, usage: { in: estimateTokens(last.content), out: estimateTokens(short) } };
  }
  const lines = ru
    ? [
        '**Демо-режим.** Провайдер не подключён — отвечает встроенная заглушка.',
        '',
        'Ваш вопрос:',
        '',
        `> ${questionText.slice(0, 500).replace(/\n/g, '\n> ')}`,
        '',
        `Сообщений в контексте: ${messages.length}${systemPrompt ? ' · системный промпт задан' : ''}`,
      ]
    : [
        '**Demo mode.** No provider connected — a built-in stub is answering.',
        '',
        'Your question:',
        '',
        `> ${questionText.slice(0, 500).replace(/\n/g, '\n> ')}`,
        '',
        `Messages in context: ${messages.length}${systemPrompt ? ' · system prompt set' : ''}`,
      ];
  if (imgs > 0) lines.push('', ru ? `Вижу изображений: ${imgs}.` : `I see images: ${imgs}.`);
  if (hasFileBlock) {
    lines.push(
      '',
      ru
        ? 'К вопросу приложен файл — в демо-режиме его содержимое не пересказывается.'
        : 'A file is attached to the question — demo mode does not retell its contents.',
    );
  }
  lines.push(
    '',
    ru
      ? 'Чтобы получать настоящие ответы, добавьте провайдера в настройках:'
      : 'To get real answers, add a provider in settings:',
    '',
    ru ? '| Поле | Пример |' : '| Field | Example |',
    '|---|---|',
    ru ? '| Адрес API | `https://api.polza.ai/api/v1` |' : '| API address | `https://api.polza.ai/api/v1` |',
    ru ? '| Ключ | `sk-...` |' : '| Key | `sk-...` |',
    '',
    '```js',
    ru ? '// проверка блока кода' : '// code block check',
    'const ok = true;',
    '```',
  );
  // Триггер существует для проверяемости предпросмотра артефактов в smoke:
  // без живого провайдера это единственный детерминированный способ получить
  // html-блок кода с рабочей кнопкой «Предпросмотр». Слово-триггер 'html'
  // не переводим — это литерал во входном тексте пользователя, а не UI-строка.
  if (/html/i.test(last.content)) {
    lines.push(
      '',
      '```html',
      ru
        ? '<!doctype html><html><body style="font-family:sans-serif"><h3>Демо-артефакт</h3><button onclick="this.textContent=\'Работает!\'">Нажми меня</button></body></html>'
        : '<!doctype html><html><body style="font-family:sans-serif"><h3>Demo artifact</h3><button onclick="this.textContent=\'Works!\'">Click me</button></body></html>',
      '```',
    );
  }
  const content = lines.join('\n');
  const inChars = messages.reduce((n, m) => n + m.content.length, 0) + systemPrompt.length;
  return {
    content,
    model,
    usage: { in: estimateTokens(String(inChars)), out: estimateTokens(content) },
    reasoning: ru
      ? `Разбираю вопрос: «${last.content.slice(0, 80)}». Это демо — показываю, как выглядят мысли модели до ответа.`
      : `Parsing the question: "${last.content.slice(0, 80)}". This is a demo — showing what a model's thoughts look like before the answer.`,
  };
}

interface OpenAiChoice {
  message?: { content?: string; reasoning_content?: string; reasoning?: string };
}
interface OpenAiResponse {
  choices?: OpenAiChoice[];
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Кусок ответа по мере генерации. */
export type OnDelta = (chunk: string) => void;

interface StreamChunk {
  choices?: {
    delta?: {
      content?: string;
      reasoning_content?: string;
      reasoning?: string;
      tool_calls?: { index: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
  }[];
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    // Детали в OpenAI-формате; агрегаторы отдают их не все и не всегда.
    completion_tokens_details?: { reasoning_tokens?: number };
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/**
 * Разбор SSE-потока OpenAI-совместимого API.
 *
 * Буфер обязателен: сетевой чанк рвётся на произвольном байте, и половина
 * строки `data: {...}` регулярно приезжает в следующем чтении. Без склейки
 * JSON.parse падал бы на каждом длинном ответе.
 */
async function readSse(
  res: Response,
  onDelta: OnDelta,
  onReasoning?: OnDelta,
): Promise<{ text: string; reasoning: string; model: string; usage: Usage; toolCalls: ToolCallReq[]; finishReason?: string }> {
  const reader = res.body?.getReader();
  if (!reader) throw new AiError('provider', t('error.noBody'));
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let reasoning = '';
  let model = '';
  const usage: Usage = { in: 0, out: 0 };
  // Аккумулятор tool_calls по индексу дельты: id присваивается (провайдеры шлют
  // его целиком в одной из дельт), name/arguments конкатенируются построчно —
  // так приходит длинный JSON аргументов, растянутый на десятки чанков.
  const calls: { id: string; name: string; arguments: string }[] = [];
  let finishReason: string | undefined;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Разделитель событий — пустая строка; обрабатываем всё, кроме хвоста.
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;
      let chunk: StreamChunk;
      try {
        chunk = JSON.parse(payload) as StreamChunk;
      } catch {
        continue; // недособранное или служебное событие — пропускаем
      }
      if (chunk.model) model = chunk.model;
      // usage приходит последним событием, когда включён stream_options.
      if (chunk.usage) {
        usage.in = Number(chunk.usage.prompt_tokens) || usage.in;
        usage.out = Number(chunk.usage.completion_tokens) || usage.out;
        const rt = chunk.usage.completion_tokens_details?.reasoning_tokens;
        if (typeof rt === 'number' && rt > 0) usage.reasoning = rt;
        const ct = chunk.usage.prompt_tokens_details?.cached_tokens;
        if (typeof ct === 'number' && ct > 0) usage.cached = ct;
      }
      const choice = chunk.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const d = choice?.delta;
      // Разные провайдеры шлют мысли в разных полях (DeepSeek/OpenRouter-стиль
      // vs остальные) — читаем оба, до обработки основного текста.
      const think = d?.reasoning_content ?? d?.reasoning;
      if (think) {
        reasoning += think;
        onReasoning?.(think);
      }
      const piece = d?.content;
      if (piece) {
        text += piece;
        onDelta(piece);
      }
      for (const tc of d?.tool_calls ?? []) {
        const slot = (calls[tc.index] ??= { id: '', name: '', arguments: '' });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.arguments += tc.function.arguments;
      }
    }
  }
  return { text, reasoning, model, usage, toolCalls: calls.filter((c) => c.name), finishReason };
}

/** Разбор тела ошибки провайдера в понятный код. */
async function toAiError(res: Response): Promise<AiError> {
  const raw = await res.text().catch(() => '');
  let msg = raw.slice(0, 300);
  try {
    const j = JSON.parse(raw) as { error?: { message?: string }; message?: string };
    msg = j.error?.message ?? j.message ?? msg;
  } catch {
    /* тело не JSON — оставляем как есть */
  }
  if (res.status === 401) return new AiError('unauthorized', msg);
  // 403 у зарубежных провайдеров чаще означает регион, а не права ключа.
  if (res.status === 403) {
    return new AiError(/region|country|location|unsupported_country/i.test(msg) ? 'geo_blocked' : 'forbidden', msg);
  }
  if (res.status === 429) return new AiError('rate_limit', msg);
  if (res.status === 400) return new AiError('bad_request', msg);
  return new AiError('provider', msg || `HTTP ${res.status}`);
}

/** Демо печатается по словам — чтобы поведение совпадало с живым потоком. */
async function streamDemo(
  messages: ChatMessage[],
  systemPrompt: string,
  model: string,
  onDelta: OnDelta,
  signal?: AbortSignal,
  onReasoning?: OnDelta,
  instant?: boolean,
): Promise<Reply> {
  const full = demoReply(messages, systemPrompt, model);
  // Мгновенный режим — для стадий, которые никто не смотрит в реальном
  // времени (промежуточные ответы консилиума): честная задержка стрима там
  // превращала демо-прогон в минуты ожидания на ровном месте.
  if (instant) {
    if (signal?.aborted) throw new AiError('aborted', t('error.abortedInternal'));
    await new Promise((r) => setTimeout(r, 60));
    onDelta(full.content);
    return full;
  }
  if (full.reasoning && onReasoning) {
    const thinkParts = full.reasoning.match(/\S+\s*/g) ?? [full.reasoning];
    for (const part of thinkParts) {
      if (signal?.aborted) throw new AiError('aborted', t('error.abortedInternal'));
      await new Promise((r) => setTimeout(r, 8));
      onReasoning(part);
    }
  }
  const parts = full.content.match(/\S+\s*/g) ?? [full.content];
  for (const part of parts) {
    if (signal?.aborted) throw new AiError('aborted', t('error.abortedInternal'));
    await new Promise((r) => setTimeout(r, 12));
    onDelta(part);
  }
  return full;
}

/**
 * Отправка с потоковым ответом. onDelta вызывается на каждый кусок текста —
 * вызывающий копит его в состоянии React и пишет в базу один раз, в конце:
 * запись каждого чанка в наблюдаемую таблицу перерисовывала бы всю ленту
 * десятки раз в секунду.
 */
export async function streamChat(params: {
  provider: Provider | null;
  messages: ChatMessage[];
  systemPrompt: string;
  model: string;
  onDelta: OnDelta;
  onReasoning?: OnDelta;
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  /** Описания инструментов в wire-формате. Демо-путь их игнорирует — демо-цикл живёт в agentLoop. */
  tools?: WireTool[];
  /** Готовые wire-сообщения агентского цикла (ответы assistant с tool_calls + role:'tool'), добавляются после toWire(messages) как есть. */
  wireTail?: WireAgentMsg[];
  /** Демо без задержки стрима — для стадий, которые не смотрят в реальном времени (консилиум). Живых провайдеров не касается. */
  demoInstant?: boolean;
}): Promise<Reply> {
  const { provider, messages, systemPrompt, model, onDelta, onReasoning, signal, temperature, maxTokens, tools, wireTail, demoInstant } = params;
  if (!provider) throw new AiError('no_provider', t('error.noProviderInternal'));
  // Демо-путь параметры игнорирует — заглушка не читает temperature/maxTokens/tools.
  if (provider.isDemo) return streamDemo(messages, systemPrompt, model, onDelta, signal, onReasoning, demoInstant);
  if (!provider.apiKey) throw new AiError('no_key', t('error.noKeyInternal'));

  const url = `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const wireMessages = [...toWire(messages), ...(wireTail ?? [])];
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify({
        model,
        messages: systemPrompt ? [{ role: 'system', content: systemPrompt }, ...wireMessages] : wireMessages,
        stream: true,
        // Просим прислать usage последним событием. Провайдеры, которые этого
        // не умеют, поле просто игнорируют — тогда счётчик останется нулевым,
        // и лучше показать ноль, чем выдуманную оценку.
        stream_options: { include_usage: true },
        ...(typeof temperature === 'number' && { temperature }),
        ...(typeof maxTokens === 'number' && { max_tokens: maxTokens }),
        ...(tools?.length && { tools }),
      }),
      signal,
    });
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') throw new AiError('aborted', t('error.abortedInternal'));
    throw new AiError('network', t('error.noConnectionInternal'));
  }
  if (!res.ok) throw await toAiError(res);

  try {
    const { text, reasoning, model: gotModel, usage, toolCalls, finishReason } = await readSse(res, onDelta, onReasoning);
    // Пустой content допустим, если модель вместо текста вернула tool_calls —
    // бросаем «пустой ответ» только когда нет ни текста, ни вызовов инструментов.
    if (!text.trim() && !toolCalls.length) throw new AiError('provider', t('error.emptyReply'));
    return {
      content: text,
      model: gotModel || model,
      usage,
      reasoning: reasoning.trim() ? reasoning : undefined,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      finishReason,
    };
  } catch (e) {
    if (e instanceof AiError) throw e;
    if ((e as { name?: string })?.name === 'AbortError') throw new AiError('aborted', t('error.abortedInternal'));
    throw new AiError('network', t('error.streamBroken'));
  }
}

/** Запрос без потока — оставлен для случаев, где стрим не нужен. */
export async function requestChat(params: {
  provider: Provider | null;
  messages: ChatMessage[];
  systemPrompt: string;
  model: string;
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
}): Promise<Reply> {
  const { provider, messages, systemPrompt, model, signal, temperature, maxTokens } = params;
  if (!provider) throw new AiError('no_provider', t('error.noProviderInternal'));
  if (provider.isDemo) {
    await new Promise((r) => setTimeout(r, 400));
    if (signal?.aborted) throw new AiError('aborted', t('error.abortedInternal'));
    return demoReply(messages, systemPrompt, model);
  }
  if (!provider.apiKey) throw new AiError('no_key', t('error.noKeyInternal'));

  const url = `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const wireMessages = toWire(messages);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify({
        model,
        messages: systemPrompt ? [{ role: 'system', content: systemPrompt }, ...wireMessages] : wireMessages,
        ...(typeof temperature === 'number' && { temperature }),
        ...(typeof maxTokens === 'number' && { max_tokens: maxTokens }),
      }),
      signal,
    });
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') throw new AiError('aborted', t('error.abortedInternal'));
    throw new AiError('network', t('error.noConnectionInternal'));
  }
  if (!res.ok) throw await toAiError(res);

  const data = (await res.json()) as OpenAiResponse;
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new AiError('provider', t('error.emptyReply'));
  const think = data.choices?.[0]?.message?.reasoning_content ?? data.choices?.[0]?.message?.reasoning;
  return {
    content,
    model: data.model ?? model,
    usage: {
      in: Number(data.usage?.prompt_tokens) || 0,
      out: Number(data.usage?.completion_tokens) || 0,
    },
    reasoning: think?.trim() ? think : undefined,
  };
}
