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

export async function requestChat(params: {
  provider: Provider | null;
  messages: ChatMessage[];
  systemPrompt: string;
  model: string;
  signal?: AbortSignal;
}): Promise<Reply> {
  const { provider, messages, systemPrompt, model, signal } = params;
  if (!provider) throw new AiError('no_provider', 'провайдер не выбран');

  // Демо отвечает мгновенно; небольшая задержка нужна, чтобы был виден
  // индикатор ожидания и поведение совпадало с настоящим запросом.
  if (provider.isDemo) {
    await new Promise((r) => setTimeout(r, 400));
    if (signal?.aborted) throw new AiError('aborted', 'остановлено');
    return demoReply(messages, systemPrompt);
  }

  if (!provider.apiKey) throw new AiError('no_key', 'не задан ключ');
  const url = `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body = {
    model,
    messages: systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : messages,
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') throw new AiError('aborted', 'остановлено');
    throw new AiError('network', 'нет связи');
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    let msg = raw.slice(0, 300);
    try {
      const j = JSON.parse(raw) as { error?: { message?: string }; message?: string };
      msg = j.error?.message ?? j.message ?? msg;
    } catch {
      /* тело не JSON — оставляем как есть */
    }
    if (res.status === 401) throw new AiError('unauthorized', msg);
    // 403 у зарубежных провайдеров чаще всего означает именно регион, а не
    // права ключа — подсказываем это в тексте ошибки.
    if (res.status === 403) throw new AiError(/region|country|location/i.test(msg) ? 'geo_blocked' : 'forbidden', msg);
    if (res.status === 429) throw new AiError('rate_limit', msg);
    if (res.status === 400) throw new AiError('bad_request', msg);
    throw new AiError('provider', msg || `HTTP ${res.status}`);
  }

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
