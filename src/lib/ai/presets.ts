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
