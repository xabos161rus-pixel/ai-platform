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

export interface Usage {
  in: number;
  out: number;
}

export interface Reply {
  content: string;
  model: string;
  usage: Usage;
  reasoning?: string;
}

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
  if (!(e instanceof AiError)) return 'Неизвестная ошибка.';
  switch (e.code) {
    case 'no_provider':
      return 'Не выбран провайдер. Откройте настройки.';
    case 'no_key':
      return 'У провайдера не задан API-ключ.';
    case 'unauthorized':
      return 'Ключ не принят. Проверьте его в настройках.';
    case 'forbidden':
      return 'Доступ запрещён. Возможно, ключ без прав на эту модель.';
    case 'geo_blocked':
      return 'Провайдер отклонил запрос по региону. Нужен агрегатор с российским доступом.';
    case 'rate_limit':
      return 'Слишком часто или закончились средства на счёте провайдера.';
    case 'aborted':
      return 'Остановлено.';
    case 'network':
      return 'Нет связи с провайдером. Проверьте адрес API и интернет.';
    default:
      return e.message;
  }
}

/** Ответ демо-провайдера: платформа работает сразу после установки. */
function demoReply(messages: ChatMessage[], systemPrompt: string, model = 'demo-echo'): Reply {
  const last = messages[messages.length - 1];
  const imgs = last.images?.length ?? 0;
  if (model === 'demo-fast') {
    const lines = [
      '**Демо · краткий.** Вторая модель отвечает иначе — так видно смысл сравнения.',
      '',
      `Вопрос: «${last.content.slice(0, 120)}»`,
      '',
      `Сообщений в контексте: ${messages.length}`,
    ];
    if (imgs > 0) lines.push('', `Изображений: ${imgs}`);
    const short = lines.join('\n');
    // demo-fast намеренно не шлёт reasoning — живой пример модели без мыслей.
    return { content: short, model, usage: { in: estimateTokens(last.content), out: estimateTokens(short) } };
  }
  const lines = [
    '**Демо-режим.** Провайдер не подключён — отвечает встроенная заглушка.',
    '',
    'Ваш вопрос:',
    '',
    `> ${last.content.slice(0, 500).replace(/\n/g, '\n> ')}`,
    '',
    `Сообщений в контексте: ${messages.length}${systemPrompt ? ' · системный промпт задан' : ''}`,
  ];
  if (imgs > 0) lines.push('', `Вижу изображений: ${imgs}.`);
  lines.push(
    '',
    'Чтобы получать настоящие ответы, добавьте провайдера в настройках:',
    '',
    '| Поле | Пример |',
    '|---|---|',
    '| Адрес API | `https://api.polza.ai/api/v1` |',
    '| Ключ | `sk-...` |',
    '',
    '```js',
    '// проверка блока кода',
    'const ok = true;',
    '```',
  );
  const content = lines.join('\n');
  const inChars = messages.reduce((n, m) => n + m.content.length, 0) + systemPrompt.length;
  return {
    content,
    model,
    usage: { in: estimateTokens(String(inChars)), out: estimateTokens(content) },
    reasoning: `Разбираю вопрос: «${last.content.slice(0, 80)}». Это демо — показываю, как выглядят мысли модели до ответа.`,
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
  choices?: { delta?: { content?: string; reasoning_content?: string; reasoning?: string } }[];
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
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
): Promise<{ text: string; reasoning: string; model: string; usage: Usage }> {
  const reader = res.body?.getReader();
  if (!reader) throw new AiError('provider', 'ответ без тела');
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let reasoning = '';
  let model = '';
  const usage: Usage = { in: 0, out: 0 };

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
      }
      const d = chunk.choices?.[0]?.delta;
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
    }
  }
  return { text, reasoning, model, usage };
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
): Promise<Reply> {
  const full = demoReply(messages, systemPrompt, model);
  if (full.reasoning && onReasoning) {
    const thinkParts = full.reasoning.match(/\S+\s*/g) ?? [full.reasoning];
    for (const part of thinkParts) {
      if (signal?.aborted) throw new AiError('aborted', 'остановлено');
      await new Promise((r) => setTimeout(r, 8));
      onReasoning(part);
    }
  }
  const parts = full.content.match(/\S+\s*/g) ?? [full.content];
  for (const part of parts) {
    if (signal?.aborted) throw new AiError('aborted', 'остановлено');
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
}): Promise<Reply> {
  const { provider, messages, systemPrompt, model, onDelta, onReasoning, signal } = params;
  if (!provider) throw new AiError('no_provider', 'провайдер не выбран');
  if (provider.isDemo) return streamDemo(messages, systemPrompt, model, onDelta, signal, onReasoning);
  if (!provider.apiKey) throw new AiError('no_key', 'не задан ключ');

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
        stream: true,
        // Просим прислать usage последним событием. Провайдеры, которые этого
        // не умеют, поле просто игнорируют — тогда счётчик останется нулевым,
        // и лучше показать ноль, чем выдуманную оценку.
        stream_options: { include_usage: true },
      }),
      signal,
    });
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') throw new AiError('aborted', 'остановлено');
    throw new AiError('network', 'нет связи');
  }
  if (!res.ok) throw await toAiError(res);

  try {
    const { text, reasoning, model: gotModel, usage } = await readSse(res, onDelta, onReasoning);
    if (!text.trim()) throw new AiError('provider', 'провайдер вернул пустой ответ');
    return { content: text, model: gotModel || model, usage, reasoning: reasoning.trim() ? reasoning : undefined };
  } catch (e) {
    if (e instanceof AiError) throw e;
    if ((e as { name?: string })?.name === 'AbortError') throw new AiError('aborted', 'остановлено');
    throw new AiError('network', 'поток оборван');
  }
}

/** Запрос без потока — оставлен для случаев, где стрим не нужен. */
export async function requestChat(params: {
  provider: Provider | null;
  messages: ChatMessage[];
  systemPrompt: string;
  model: string;
  signal?: AbortSignal;
}): Promise<Reply> {
  const { provider, messages, systemPrompt, model, signal } = params;
  if (!provider) throw new AiError('no_provider', 'провайдер не выбран');
  if (provider.isDemo) {
    await new Promise((r) => setTimeout(r, 400));
    if (signal?.aborted) throw new AiError('aborted', 'остановлено');
    return demoReply(messages, systemPrompt, model);
  }
  if (!provider.apiKey) throw new AiError('no_key', 'не задан ключ');

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
      }),
      signal,
    });
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') throw new AiError('aborted', 'остановлено');
    throw new AiError('network', 'нет связи');
  }
  if (!res.ok) throw await toAiError(res);

  const data = (await res.json()) as OpenAiResponse;
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new AiError('provider', 'пустой ответ провайдера');
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
