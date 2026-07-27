import Dexie, { type Table } from 'dexie';
import type { Chat, Message, Provider, Settings } from './types';

export const SCHEMA_VERSION = 1;

export class AiPlatformDB extends Dexie {
  chats!: Table<Chat, string>;
  messages!: Table<Message, string>;
  providers!: Table<Provider, string>;
  settings!: Table<Settings, string>;

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
      models: ['demo-echo'],
      isDemo: true,
    });
  }
}
