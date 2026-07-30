// Агентский цикл: раунды запроса к модели с tools, последовательное исполнение
// tool_calls и финальный раунд без tools (модель вынуждена ответить текстом).
//
// Стрим-состояние живёт целиком здесь и в React (ChatPage): в Dexie в итоге
// пишется одно финальное assistant-сообщение с готовым toolTrace — сам цикл
// (wireTail, промежуточные раунды) существует только в памяти этого прогона.

import type { Provider } from '../../db/types';
import type { ToolStep, ToolStepStatus } from '../../db/types';
import { AiError, streamChat, type ChatMessage, type OnDelta, type Reply, type WireAgentMsg } from './client';
import { toWireTools, type ToolDef } from './tools';
import { estimateTokens } from './models';
import { uid } from '../repo';
import { getLang, t } from '../i18n';

/** Промпт-добавка режима исследования. Wire-контент для модели — не UI-строка, поэтому не в i18n. */
export const RESEARCH_SYSTEM =
  'Режим исследования: сначала краткий план поисков; минимум 3 разных запроса web_search с разными формулировками; ' +
  'прочитай 2–3 лучших источника через read_page; в конце ответа раздел "Источники" со ссылками.';

/** Таймаут одного вызова инструмента. 30 с — тяжёлые страницы через r.jina.ai
 *  реально отдаются 15–25 с; поиск после X-Respond-With: no-content быстрый. */
export const TOOL_TIMEOUT_MS = 30000;

/** Сколько символов результата инструмента остаётся в toolTrace (для отображения). Полный результат уходит модели через wireTail. */
export const TRACE_RESULT_LIMIT = 4000;

export interface RunAgentParams {
  provider: Provider | null;
  messages: ChatMessage[];
  systemPrompt: string;
  model: string;
  tools: ToolDef[];
  /** Максимум раундов с tools; после исчерпания идёт ещё один финальный раунд без tools. По умолчанию 8. */
  maxSteps?: number;
  jinaKey?: string;
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  onDelta: OnDelta;
  onReasoning?: OnDelta;
  /** Вызывается на КАЖДОЕ изменение шага (running/done/error), всегда с новым объектом. */
  onStep?: (step: ToolStep) => void;
  /** Модель ответила 400 на запрос с tools — цикл продолжает без инструментов. */
  onToolsUnsupported?: () => void;
}

export interface AgentResult extends Reply {
  toolTrace: ToolStep[];
}

/** Завести шаг: добавить в трейс и отдать running-снимок наружу. */
function pushStep(
  trace: ToolStep[],
  onStep: ((s: ToolStep) => void) | undefined,
  id: string,
  tool: string,
  args: Record<string, unknown>,
): ToolStep {
  const step: ToolStep = { id, tool, args, status: 'running' };
  trace.push(step);
  onStep?.({ ...step });
  return step;
}

/** Завершить шаг (done/error) и отдать финальный снимок наружу. */
function finishStep(
  onStep: ((s: ToolStep) => void) | undefined,
  step: ToolStep,
  status: ToolStepStatus,
  result: string,
): void {
  step.status = status;
  step.result = result;
  onStep?.({ ...step });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Исполнение одного инструмента со своим таймаутом: собственный AbortController
 * вместо AbortSignal.any — очевиднее в отладке и не зависит от свежести API рантайма.
 */
async function execWithTimeout(
  tool: ToolDef,
  args: Record<string, unknown>,
  jinaKey: string | undefined,
  outerSignal: AbortSignal | undefined,
): Promise<string> {
  const tc = new AbortController();
  const timer = setTimeout(() => tc.abort('timeout'), TOOL_TIMEOUT_MS);
  const onAbort = () => tc.abort(outerSignal?.reason);
  outerSignal?.addEventListener('abort', onAbort);
  try {
    return await tool.run(args, { signal: tc.signal, jinaKey });
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Демо-имитация агентского цикла: без сети, детерминированный сценарий из
 * 2 шагов (web_search → read_page) и канного ответа, потоком по словам —
 * ровно тот же путь step-lifecycle (pushStep/finishStep/onStep), что и в
 * реальном цикле, чтобы smoke проверял настоящий код управления трейсом.
 */
async function runDemoAgent(
  query: string,
  model: string,
  onDelta: OnDelta,
  onStep: ((s: ToolStep) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<AgentResult> {
  const ru = getLang() === 'ru';
  const trace: ToolStep[] = [];
  const shortQuery = query.slice(0, 80);

  if (signal?.aborted) throw new AiError('aborted', t('error.abortedInternal'));
  const s1 = pushStep(trace, onStep, uid(), 'web_search', { query: shortQuery });
  await delay(400);
  if (signal?.aborted) throw new AiError('aborted', t('error.abortedInternal'));
  const searchResult = ru
    ? '1. Демо-источник A\nhttps://example.com/a\nКраткое описание найденного результата поиска.\n\n2. Демо-источник B\nhttps://example.com/b\nЕщё один демонстрационный результат поиска.'
    : '1. Demo source A\nhttps://example.com/a\nShort description of the found search result.\n\n2. Demo source B\nhttps://example.com/b\nAnother demo search result.';
  finishStep(onStep, s1, 'done', searchResult);

  const s2 = pushStep(trace, onStep, uid(), 'read_page', { url: 'https://example.com/demo' });
  await delay(400);
  if (signal?.aborted) throw new AiError('aborted', t('error.abortedInternal'));
  const pageResult = ru
    ? 'Демонстрационная страница: здесь был бы извлечённый текст статьи по теме запроса.'
    : 'Demo page: this is where the extracted article text for the query would appear.';
  finishStep(onStep, s2, 'done', pageResult);

  const finalText = ru
    ? `**По данным поиска.** По запросу «${shortQuery}» найдено 2 источника: демо-источник A и демо-источник B. Это демо-режим — реальный поиск подключится вместе с провайдером.\n\n**Источники**\n- https://example.com/a\n- https://example.com/b`
    : `**Based on search results.** For "${shortQuery}" found 2 sources: demo source A and demo source B. This is demo mode — a real search connects once a provider is set up.\n\n**Sources**\n- https://example.com/a\n- https://example.com/b`;

  let content = '';
  const parts = finalText.match(/\S+\s*/g) ?? [finalText];
  for (const part of parts) {
    if (signal?.aborted) throw new AiError('aborted', t('error.abortedInternal'));
    await delay(12);
    onDelta(part);
    content += part;
  }

  return {
    content,
    model,
    usage: { in: estimateTokens(shortQuery), out: estimateTokens(content) },
    toolTrace: trace,
  };
}

/**
 * Раунд с tools, дальше — раунды до maxSteps, затем один финальный раунд без
 * tools (модель обязана ответить текстом). Параллельные tool_calls одного
 * ответа исполняются последовательно — простая модель без гонок за wireTail.
 */
export async function runAgent(p: RunAgentParams): Promise<AgentResult> {
  const {
    provider,
    messages,
    systemPrompt,
    model,
    tools,
    maxSteps = 8,
    jinaKey,
    signal,
    temperature,
    maxTokens,
    onDelta,
    onReasoning,
    onStep,
    onToolsUnsupported,
  } = p;

  // Демо-ветка живёт ВНУТРИ runAgent (не в streamChat): триггер по последнему
  // user-сообщению — иначе обычный демо-прогон без trace.
  if (provider?.isDemo) {
    const last = [...messages].reverse().find((m) => m.role === 'user');
    if (last && /найди|поиск|search/i.test(last.content)) {
      return runDemoAgent(last.content, model, onDelta, onStep, signal);
    }
    const reply = await streamChat({ provider, messages, systemPrompt, model, onDelta, onReasoning, signal, temperature, maxTokens });
    return { ...reply, toolTrace: [] };
  }

  const trace: ToolStep[] = [];
  const wireTail: WireAgentMsg[] = [];
  let content = '';
  let reasoningAcc = '';
  let toolsOn = tools.length > 0;
  const totalUsage = { in: 0, out: 0 };

  for (let round = 0; round <= maxSteps; round++) {
    const useTools = toolsOn && round < maxSteps;
    let roundText = '';
    // На первой дельте нового раунда, если уже накоплен текст прошлых раундов,
    // вставляем разделитель — так стрим в UI совпадает символ-в-символ с
    // финальным content, который уйдёт в Dexie (без отдельного reset-колбэка).
    const wrapped: OnDelta = (chunk) => {
      if (roundText === '' && content !== '') {
        onDelta('\n\n');
        content += '\n\n';
      }
      roundText += chunk;
      onDelta(chunk);
    };

    let reply: Reply;
    try {
      reply = await streamChat({
        provider,
        messages,
        systemPrompt,
        model,
        tools: useTools ? toWireTools(tools) : undefined,
        wireTail,
        signal,
        temperature,
        maxTokens,
        onDelta: wrapped,
        onReasoning,
      });
    } catch (e) {
      // Fallback для моделей без tools — только на самом первом раунде.
      if (round === 0 && useTools && e instanceof AiError && e.code === 'bad_request') {
        toolsOn = false;
        onToolsUnsupported?.();
        reply = await streamChat({
          provider,
          messages,
          systemPrompt,
          model,
          wireTail,
          signal,
          temperature,
          maxTokens,
          onDelta: wrapped,
          onReasoning,
        });
      } else {
        throw e;
      }
    }

    content += roundText;
    reasoningAcc += reply.reasoning ?? '';
    totalUsage.in += reply.usage.in;
    totalUsage.out += reply.usage.out;

    if (!reply.toolCalls?.length) {
      return {
        content,
        model: reply.model,
        usage: totalUsage,
        reasoning: reasoningAcc || undefined,
        toolTrace: trace,
      };
    }

    // Некоторые OpenAI-совместимые агрегаторы не шлют id в каждой дельте
    // tool_call — генерируем fallback ЗДЕСЬ, один раз на вызов, и переиспользуем
    // тот же id и в tool_calls[].id assistant-сообщения, и в tool_call_id
    // ответа: иначе они расходятся (свой uid() в assistant, свой — в tool),
    // и большинство бэкендов отклоняют такой payload с 400.
    const callIds = reply.toolCalls.map((c) => c.id || uid());

    wireTail.push({
      role: 'assistant',
      content: roundText || null,
      tool_calls: reply.toolCalls.map((c, i) => ({ id: callIds[i], type: 'function', function: { name: c.name, arguments: c.arguments } })),
    });

    for (let i = 0; i < reply.toolCalls.length; i++) {
      const call = reply.toolCalls[i];
      const cid = callIds[i];
      let args: Record<string, unknown> | null;
      try {
        args = JSON.parse(call.arguments || '{}') as Record<string, unknown>;
      } catch {
        args = null;
      }
      const step = pushStep(trace, onStep, cid, call.name, args ?? {});

      let wireContent: string;
      if (args === null) {
        finishStep(onStep, step, 'error', 'bad arguments JSON');
        wireContent = `Error: ${step.result}`;
      } else {
        const tool = tools.find((t2) => t2.name === call.name);
        if (!tool) {
          finishStep(onStep, step, 'error', 'unknown tool');
          wireContent = `Error: ${step.result}`;
        } else {
          try {
            const full = await execWithTimeout(tool, args, jinaKey, signal);
            finishStep(onStep, step, 'done', full.length > TRACE_RESULT_LIMIT ? full.slice(0, TRACE_RESULT_LIMIT) : full);
            wireContent = full;
          } catch (e) {
            // Внешний abort — единственное, что прерывает цикл целиком;
            // таймаут инструмента и прочие ошибки — просто error-шаг.
            if (signal?.aborted) throw new AiError('aborted', t('error.abortedInternal'));
            let msg = String((e as Error)?.message ?? e).slice(0, 500);
            // tc.abort('timeout') долетает сюда голой строкой-reason: разворачиваем
            // в подсказку, по которой модель поймёт, что делать дальше.
            if (msg === 'timeout') {
              msg = `инструмент не ответил за ${TOOL_TIMEOUT_MS / 1000} с — повтори вызов или сузь запрос`;
            }
            finishStep(onStep, step, 'error', msg);
            wireContent = `Error: ${msg}`;
          }
        }
      }
      wireTail.push({ role: 'tool', tool_call_id: step.id, content: wireContent });
    }
  }

  // Недостижимо: финальный раунд (round === maxSteps) идёт без tools, поэтому
  // toolCalls в нём всегда пусты и цикл возвращается раньше. Оставлено ради TS.
  return { content, model, usage: totalUsage, reasoning: reasoningAcc || undefined, toolTrace: trace };
}
