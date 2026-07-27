import Dexie, { type Table } from 'dexie';
import type { Chat, Message, Persona, Provider, Settings } from './types';

export const SCHEMA_VERSION = 2;

export class AiPlatformDB extends Dexie {
  chats!: Table<Chat, string>;
  messages!: Table<Message, string>;
  providers!: Table<Provider, string>;
  settings!: Table<Settings, string>;
  personas!: Table<Persona, string>;

  constructor() {
    super('ai-platform');
    // Индексы минимальные: чаты сортируем по lastMessageAt, сообщения читаем
    // выборкой по chatId. Составной [chatId+createdAt] не заводим — его не
    // использовал бы ни один запрос, а каждый индекс это лишняя запись на
    // каждое сообщение (самая горячая таблица).
    this.version(1).stores({
      chats: 'id, lastMessageAt, pinned',
      messages: 'id, chatId',
      providers: 'id',
      settings: 'id',
    });
    // v2: библиотека ролей. Объявляем только новую таблицу — определения прежних
    // Dexie наследует из v1, данные пользователя не мигрируются и не теряются.
    this.version(2).stores({ personas: 'id' });
  }
}

export const db = new AiPlatformDB();

export const DEFAULT_SETTINGS: Settings = {
  id: 'app',
  theme: 'dark',
  activeProviderId: null,
  defaultModel: 'demo-echo',
  historyLimit: 20,
  monthlyBudgetRub: 0,
  updatedAt: new Date().toISOString(),
};

/** Встроенная заглушка: платформа отвечает и без единого ключа. */
export const DEMO_PROVIDER_ID = 'demo';

/**
 * Встроенные роли: фиксированные id, чтобы посев был идемпотентным — переживает
 * переустановку и импорт снапшота без дублей. builtin: true защищает от удаления в UI.
 */
const BUILTIN_PERSONAS: Pick<Persona, 'id' | 'name' | 'prompt'>[] = [
  {
    id: 'persona-analyst',
    name: 'Бизнес-аналитик',
    prompt:
      'Ты — бизнес-аналитик с опытом в юнит-экономике и оценке ниш. Отвечай структурно: сначала вывод, потом аргументы и цифры. Всегда называй риски и слабые места идеи, не приукрашивай. Если данных не хватает — скажи, каких именно, вместо предположений.',
  },
  {
    id: 'persona-editor',
    name: 'Редактор текста',
    prompt:
      'Ты — редактор русскоязычных текстов. Правь стиль, структуру и логику, сохраняя голос автора. Сначала показывай правленый текст целиком, после — короткий список, что и почему изменено. Канцелярит и штампы убирай.',
  },
  {
    id: 'persona-docs',
    name: 'Разбор документов',
    prompt:
      'Ты помогаешь разбирать документы: договоры, инструкции, статьи. Сначала выжимка в 3–5 пунктов, затем важные детали: сроки, суммы, обязательства. Отдельно отмечай спорные и рискованные формулировки. Если в тексте нет ответа на вопрос — прямо скажи об этом.',
  },
  {
    id: 'persona-code',
    name: 'Наставник по коду',
    prompt:
      'Ты — наставник по программированию. Объясняй на практических примерах, коротко и без воды. Показывай минимальный рабочий код и поясняй, почему он устроен именно так. Называй типичные ошибки и подводные камни. Если решение спорное — предложи альтернативы и trade-offs.',
  },
];

/**
 * Первый запуск: строка настроек + демо-провайдер, чтобы приложение было
 * работоспособным сразу после установки, до всякой регистрации у провайдера.
 */
export async function ensureSeed(): Promise<void> {
  const ts = new Date().toISOString();
  if (!(await db.settings.get('app'))) {
    await db.settings.put({ ...DEFAULT_SETTINGS, activeProviderId: DEMO_PROVIDER_ID, updatedAt: ts });
  }
  if (!(await db.providers.get(DEMO_PROVIDER_ID))) {
    await db.providers.put({
      id: DEMO_PROVIDER_ID,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      name: 'Демо (без ключа)',
      baseUrl: '',
      apiKey: '',
      models: ['demo-echo', 'demo-fast'],
      isDemo: true,
    });
  }
  for (const p of BUILTIN_PERSONAS) {
    if (!(await db.personas.get(p.id))) {
      await db.personas.put({ ...p, builtin: true, createdAt: ts, updatedAt: ts, deletedAt: null });
    }
  }
}
