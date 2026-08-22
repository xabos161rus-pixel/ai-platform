/**
 * Готовые адреса провайдеров — чтобы не искать их в документации.
 *
 * Моделей в пресетах НЕТ намеренно. Первая версия пресета DeepSeek приехала
 * с зашитыми `deepseek-chat` / `deepseek-reasoner` и устарела в тот же день:
 * у провайдера сменилась линейка. Список моделей всегда живее любого хардкода,
 * поэтому пресет заполняет только адрес, а модели приезжают кнопкой
 * «Подтянуть список» (и подтягиваются сами, если ключ уже введён).
 *
 * Группы отражают то, что реально важно из России: откуда ответ придёт без
 * VPN, а откуда — нет.
 */

export type PresetGroup = 'ru' | 'direct' | 'vpn';

export interface ProviderPreset {
  name: string;
  baseUrl: string;
  group: PresetGroup;
}

export const PRESETS: ProviderPreset[] = [
  // Российские агрегаторы: оплата в рублях, доступ без VPN, внутри — модели
  // всех вендоров сразу.
  { name: 'Polza.ai', baseUrl: 'https://api.polza.ai/api/v1', group: 'ru' },
  { name: 'VseGPT', baseUrl: 'https://api.vsegpt.ru/v1', group: 'ru' },
  { name: 'BotHub', baseUrl: 'https://bothub.chat/api/v2/openai/v1', group: 'ru' },

  // Прямые API, которые из России отвечают без посредника.
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', group: 'direct' },
  { name: 'GLM · Z.ai', baseUrl: 'https://api.z.ai/api/paas/v4', group: 'direct' },
  { name: 'Kimi · Moonshot', baseUrl: 'https://api.moonshot.ai/v1', group: 'direct' },
  { name: 'Qwen · DashScope', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', group: 'direct' },

  // Западные вендоры: из России отвечают 403, нужен VPN или прокси.
  // Все перечисленные умеют OpenAI-совместимый /chat/completions — у Anthropic
  // и Google это отдельный слой совместимости, адреса указаны именно на него.
  { name: 'Anthropic · Claude', baseUrl: 'https://api.anthropic.com/v1', group: 'vpn' },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', group: 'vpn' },
  { name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', group: 'vpn' },
  { name: 'xAI · Grok', baseUrl: 'https://api.x.ai/v1', group: 'vpn' },
  { name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', group: 'vpn' },
  { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', group: 'vpn' },
];

/**
 * Заголовки запроса к провайдеру.
 *
 * У Anthropic браузерный доступ закрыт по умолчанию: без явного
 * `anthropic-dangerous-direct-browser-access` предполётный CORS-запрос не
 * проходит, а `anthropic-version` обязателен на всех путях. Для остальных
 * провайдеров хватает Bearer — лишних заголовков им не шлём, часть
 * агрегаторов отвергает неизвестные поля на предполёте.
 */
export function providerHeaders(baseUrl: string, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (apiKey.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`;
  if (/(^|\/\/)api\.anthropic\.com/.test(baseUrl)) {
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  }
  return headers;
}

/** Провайдер — Anthropic (в т.ч. собственный прокси на их домене). */
export function isAnthropic(baseUrl: string): boolean {
  return /(^|\/\/)api\.anthropic\.com/.test(baseUrl);
}

/**
 * Версия модели Claude из её идентификатора.
 *
 * Схемы именования у Anthropic две: старая `claude-3-7-sonnet-20250219` и
 * новая `claude-sonnet-4-6`. Берём первые два числа, отбрасывая хвост-дату
 * (её видно по величине). Эвристика намеренно грубая: единственное, на что
 * она влияет, — какой из двух режимов мышления попробовать первым, а ошибку
 * прикрывает фолбэк в client.ts.
 */
function claudeVersion(model: string): number {
  const nums = (model.match(/\d+/g) ?? []).map(Number).filter((n) => n < 100);
  if (!nums.length) return 99; // неизвестное имя — считаем новым
  return nums[0] + (nums[1] ?? 0) / 10;
}

interface TuningInput {
  model: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
  temperature?: number;
  maxTokens?: number;
}

/**
 * Поля тела запроса, зависящие от вендора.
 *
 * У Anthropic `reasoning_effort` из OpenAI-формата **молча игнорируется** —
 * регулятор глубины выглядел бы рабочим и не делал ничего. Настоящий рычаг
 * у них другой, и он зависит от поколения модели:
 *   · 4.6 и новее — адаптивное мышление плюс `output_config.effort`;
 *   · 4.5 и старее — ручной бюджет `thinking.budget_tokens`, где минимум
 *     1024 токена и бюджет обязан быть меньше `max_tokens`.
 * Отправка не того варианта даёт 400, поэтому в client.ts есть фолбэк:
 * запрос повторяется без этих полей.
 */
export function providerTuning(baseUrl: string, input: TuningInput): Record<string, unknown> {
  const { model, reasoningEffort, temperature, maxTokens } = input;
  if (!isAnthropic(baseUrl)) {
    return reasoningEffort ? { reasoning_effort: reasoningEffort } : {};
  }
  if (!reasoningEffort) return {};

  if (claudeVersion(model) >= 4.6) {
    return { thinking: { type: 'adaptive' }, output_config: { effort: reasoningEffort } };
  }

  // Ручной бюджет: минимум 1024 и строго меньше max_tokens — иначе 400.
  const wanted = { low: 4000, medium: 10000, high: 24000 }[reasoningEffort];
  const budget = typeof maxTokens === 'number' ? Math.min(wanted, maxTokens - 1024) : wanted;
  if (budget < 1024) return {};
  // При ручном мышлении Anthropic принимает только temperature = 1, поэтому
  // чужое значение здесь не отправляется вовсе (см. dropsTemperature).
  void temperature;
  return { thinking: { type: 'enabled', budget_tokens: budget } };
}

/** Отправляется ли для этого запроса ручной бюджет мышления (он несовместим с temperature). */
export function dropsTemperature(baseUrl: string, tuning: Record<string, unknown>): boolean {
  return (
    isAnthropic(baseUrl) &&
    typeof tuning.thinking === 'object' &&
    (tuning.thinking as { type?: string }).type === 'enabled'
  );
}

/** Поля, которые снимаются при повторе после 400: именно они могли не подойти модели. */
export const TUNING_KEYS = ['thinking', 'output_config', 'reasoning_effort'] as const;
