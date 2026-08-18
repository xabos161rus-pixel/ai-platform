// Консилиум моделей: несколько подключённых моделей совместно разбирают один
// вопрос. Синтез трёх проверенных подходов (docs/COUNCIL-DESIGN.md):
// llm-council Карпатого (мнения → анонимное ранжирование → председатель),
// Mixture-of-Agents (чужие ответы как референсы для улучшения своего) и
// multi-agent debate (итеративное обновление ответов).
//
// Четыре стадии, все результаты пишет вызывающий (ChatPage) в Dexie по мере
// готовности — перезагрузка посреди прогона теряет только незавершённую
// стадию. Стримится ТОЛЬКО финал председателя: промежуточные ответы
// показываются по готовности, это в разы меньше перерисовок ленты.
//
// Анонимизация обязательна: модели видят чужие ответы как «Ответ A/B/C» в
// перемешанном порядке — иначе модель подыгрывает своим (капкан llm-council).

import type { Provider } from '../../db/types';
import { streamChat, type ChatMessage, type Reply } from './client';

export interface CouncilPick {
  provider: Provider | null;
  model: string;
}

export interface CouncilStageResult {
  pickIndex: number;
  reply: Reply;
}

export type CouncilStage = 'opinion' | 'debate' | 'review' | 'final';

export interface CouncilCallbacks {
  /** Стадия началась (для строки прогресса). */
  onStage?: (stage: CouncilStage) => void;
  /** Готов один ответ стадии — вызывающий сразу пишет его в Dexie. */
  onStageResult?: (stage: Exclude<CouncilStage, 'final'>, r: CouncilStageResult) => Promise<void> | void;
  /** Дельты финального свода председателя. */
  onDelta?: (piece: string) => void;
}

export interface CouncilResult {
  final: Reply;
  /** Итоги ранжирования: буква участника → сумма мест (меньше — лучше). */
  rankSummary: { letter: string; label: string; score: number }[] | null;
}

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

/** Промпт стадии дебатов: чужие ответы анонимно, просьба улучшить свой. */
function debatePrompt(ownAnswer: string, others: { letter: string; text: string }[]): string {
  const blocks = others.map((o) => `### Ответ ${o.letter}\n${o.text}`).join('\n\n');
  return [
    'Ниже — ответы других участников на тот же вопрос (анонимно, в случайном порядке).',
    'Сравни их со своим ответом: найди ошибки, пробелы и сильные ходы.',
    'Затем дай УЛУЧШЕННУЮ версию своего ответа — целиком, самодостаточную.',
    'Не упоминай ни участников, ни сам процесс сравнения — только улучшенный ответ.',
    '',
    blocks,
    '',
    '### Твой прежний ответ',
    ownAnswer,
  ].join('\n');
}

/** Промпт ранжирования: JSON строгой формы, объяснение в поле why. */
function reviewPrompt(answers: { letter: string; text: string }[]): string {
  const blocks = answers.map((a) => `### Ответ ${a.letter}\n${a.text}`).join('\n\n');
  return [
    'Ниже — ответы разных участников на один вопрос (анонимно).',
    'Проранжируй их по точности, глубине и полезности: 1 — лучший.',
    'Ответь ТОЛЬКО JSON-массивом без пояснений и без markdown-ограждений:',
    '[{"letter":"A","rank":1,"why":"одна короткая фраза"}, …]',
    '',
    blocks,
  ].join('\n');
}

/** Промпт председателя: всё на столе, нужен единый лучший ответ. */
function chairmanPrompt(
  question: string,
  answers: { letter: string; text: string }[],
  rankSummary: { letter: string; score: number }[] | null,
): string {
  const blocks = answers.map((a) => `### Ответ ${a.letter}\n${a.text}`).join('\n\n');
  const ranks = rankSummary
    ? `\nВзаимное ранжирование участников (сумма мест, меньше — лучше): ${rankSummary
        .map((r) => `${r.letter}=${r.score}`)
        .join(', ')}.`
    : '';
  return [
    'Ты — председатель консилиума. Участники дали ответы на вопрос ниже и',
    'проранжировали друг друга. Сведи всё в ОДИН лучший ответ: возьми сильное,',
    'отбрось ошибочное, противоречия разреши явно. Отвечай пользователю прямо,',
    'без упоминания консилиума, участников и процесса.' + ranks,
    '',
    `### Вопрос\n${question}`,
    '',
    blocks,
  ].join('\n');
}

/** Разбор JSON-ранжирования; модель могла завернуть в ```json — счищаем. */
export function parseRanking(text: string): { letter: string; rank: number; why?: string }[] | null {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const arr = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
    if (!Array.isArray(arr)) return null;
    const rows = arr
      .map((x) => x as { letter?: unknown; rank?: unknown; why?: unknown })
      .filter((x) => typeof x.letter === 'string' && typeof x.rank === 'number')
      .map((x) => ({ letter: (x.letter as string).toUpperCase(), rank: x.rank as number, why: typeof x.why === 'string' ? x.why : undefined }));
    return rows.length ? rows : null;
  } catch {
    return null;
  }
}

/** Перемешивание Фишера-Йетса — порядок чужих ответов в промптах случайный. */
function shuffled<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export async function runCouncil(params: {
  picks: CouncilPick[];
  chairman: CouncilPick;
  /** История диалога, включая свежий вопрос последним сообщением. */
  history: ChatMessage[];
  systemPrompt: string;
  question: string;
  signal: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  cb?: CouncilCallbacks;
}): Promise<CouncilResult> {
  const { picks, chairman, history, systemPrompt, question, signal, temperature, maxTokens, cb } = params;
  const ask = (pick: CouncilPick, messages: ChatMessage[], onDelta?: (s: string) => void) =>
    streamChat({
      provider: pick.provider,
      messages,
      systemPrompt,
      model: pick.model,
      signal,
      temperature,
      maxTokens,
      onDelta: onDelta ?? (() => {}),
      // Промежуточные стадии никто не читает по мере печати — демо отвечает
      // мгновенно; стримится только финал председателя (у него есть onDelta).
      demoInstant: !onDelta,
    });

  // 1. Мнения — параллельно. Падение одной модели не валит прогон: её место
  // занимает пометка об ошибке, дальше работают выжившие.
  cb?.onStage?.('opinion');
  const opinions = await Promise.all(
    picks.map(async (pick, i) => {
      try {
        const reply = await ask(pick, history);
        await cb?.onStageResult?.('opinion', { pickIndex: i, reply });
        return reply;
      } catch (e) {
        if (signal.aborted) throw e;
        return null;
      }
    }),
  );
  const alive = picks.map((p, i) => ({ pick: p, i, text: opinions[i]?.content ?? '' })).filter((x) => x.text.trim());
  if (!alive.length) throw new Error('council: ни одна модель не ответила');

  // 2. Дебаты (1 раунд): каждый видит чужие ответы анонимно и улучшает свой.
  cb?.onStage?.('debate');
  const letters = new Map(alive.map((x, k) => [x.i, LETTERS[k] ?? String(k)]));
  const debated = await Promise.all(
    alive.map(async (x) => {
      const others = shuffled(alive.filter((o) => o.i !== x.i)).map((o) => ({ letter: letters.get(o.i)!, text: o.text }));
      // Одному участнику дебатировать не с кем — его мнение и есть итог.
      if (!others.length) return { ...x, finalText: x.text };
      try {
        const reply = await ask(x.pick, [...history, { role: 'assistant', content: x.text }, { role: 'user', content: debatePrompt(x.text, others) }]);
        await cb?.onStageResult?.('debate', { pickIndex: x.i, reply });
        return { ...x, finalText: reply.content.trim() || x.text };
      } catch (e) {
        if (signal.aborted) throw e;
        return { ...x, finalText: x.text };
      }
    }),
  );

  // 3. Ранжирование: каждый ставит места ВСЕМ финальным ответам (JSON).
  cb?.onStage?.('review');
  const finalAnswers = debated.map((x) => ({ letter: letters.get(x.i)!, text: x.finalText, i: x.i, pick: x.pick }));
  const scores = new Map<string, number>();
  await Promise.all(
    debated.map(async (x) => {
      try {
        const reply = await ask(x.pick, [{ role: 'user', content: reviewPrompt(shuffled(finalAnswers).map(({ letter, text }) => ({ letter, text }))) }]);
        await cb?.onStageResult?.('review', { pickIndex: x.i, reply });
        for (const row of parseRanking(reply.content) ?? []) {
          scores.set(row.letter, (scores.get(row.letter) ?? 0) + row.rank);
        }
      } catch (e) {
        if (signal.aborted) throw e;
      }
    }),
  );
  const rankSummary = scores.size
    ? finalAnswers
        .map((a) => ({ letter: a.letter, label: a.pick.model, score: scores.get(a.letter) ?? 0 }))
        .filter((r) => r.score > 0)
        .sort((a, b) => a.score - b.score)
    : null;

  // 4. Председатель сводит — единственная стримящаяся стадия.
  cb?.onStage?.('final');
  const final = await ask(
    chairman,
    [...history.slice(0, -1), { role: 'user', content: chairmanPrompt(question, finalAnswers.map(({ letter, text }) => ({ letter, text })), rankSummary) }],
    cb?.onDelta,
  );
  return { final, rankSummary };
}
