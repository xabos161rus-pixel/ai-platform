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
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
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
function demoReply(messages: ChatMessage[], systemPrompt: string): Reply {
  const last = messages[messages.length - 1];
  const content = [
    '**Демо-режим.** Провайдер не подключён — отвечает встроенная заглушка.',
    '',
    'Ваш вопрос:',
    '',
    `> ${last.content.slice(0, 500).replace(/\n/g, '\n> ')}`,
    '',
    `Сообщений в контексте: ${messages.length}${systemPrompt ? ' · системный промпт задан' : ''}`,
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
  ].join('\n');
  const inChars = messages.reduce((n, m) => n + m.content.length, 0) + systemPrompt.length;
  return { content, model: 'demo-echo', usage: { in: estimateTokens(String(inChars)), out: estimateTokens(content) } };
}

interface OpenAiChoice {
  message?: { content?: string };
}
interface OpenAiResponse {
  choices?: OpenAiChoice[];
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Кусок ответа по мере генерации. */
export type OnDelta = (chunk: string) => void;

interface StreamChunk {
  choices?: { delta?: { content?: string } }[];
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
async function readSse(res: Response, onDelta: OnDelta): Promise<{ text: string; model: string; usage: Usage }> {
  const reader = res.body?.getReader();
  if (!reader) throw new AiError('provider', 'ответ без тела');
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
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
      const piece = chunk.choices?.[0]?.delta?.content;
      if (piece) {
        text += piece;
        onDelta(piece);
      }
    }
  }
  return { text, model, usage };
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
async function streamDemo(messages: ChatMessage[], systemPrompt: string, onDelta: OnDelta, signal?: AbortSignal): Promise<Reply> {
  const full = demoReply(messages, systemPrompt);
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
  signal?: AbortSignal;
}): Promise<Reply> {
  const { provider, messages, systemPrompt, model, onDelta, signal } = params;
  if (!provider) throw new AiError('no_provider', 'провайдер не выбран');
  if (provider.isDemo) return streamDemo(messages, systemPrompt, onDelta, signal);
  if (!provider.apiKey) throw new AiError('no_key', 'не задан ключ');

  const url = `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify({
        model,
        messages: systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : messages,
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
    const { text, model: gotModel, usage } = await readSse(res, onDelta);
    if (!text.trim()) throw new AiError('provider', 'провайдер вернул пустой ответ');
    return { content: text, model: gotModel || model, usage };
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
    return demoReply(messages, systemPrompt);
  }
  if (!provider.apiKey) throw new AiError('no_key', 'не задан ключ');

  const url = `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify({
        model,
        messages: systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : messages,
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
  return {
    content,
    model: data.model ?? model,
    usage: {
      in: Number(data.usage?.prompt_tokens) || 0,
      out: Number(data.usage?.completion_tokens) || 0,
    },
  };
}
