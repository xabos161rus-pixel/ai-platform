// Базовые поля каждой записи: uuid, метки времени и мягкое удаление
// (deletedAt вместо физического delete) — задел под синхронизацию между
// устройствами, которая появится, когда платформа приживётся.
export interface BaseEntity {
  id: string;
  createdAt: string; // ISO 8601
  updatedAt: string;
  deletedAt: string | null;
}

export interface Chat extends BaseEntity {
  title: string; // авто-заголовок из первого вопроса, редактируемый
  providerId: string;
  model: string;
  systemPrompt: string;
  lastMessageAt: string | null;
  pinned: boolean;
}

export type Role = 'user' | 'assistant';

/** 'streaming' появится вместе с потоковым ответом (этап 2). */
export type MessageStatus = 'done' | 'error';

export interface Message extends BaseEntity {
  chatId: string;
  role: Role;
  content: string;
  model: string | null; // чем отвечено; у сообщений пользователя null
  tokensIn: number | null;
  tokensOut: number | null;
  // Стоимость считаем на клиенте от usage и прайса. Храним снимок: прайс
  // со временем меняется, а «сколько это стоило» — факт.
  costRub: number | null;
  status: MessageStatus;
  error: string | null;
}

/**
 * Подключение к провайдеру. Все поддерживаемые API — OpenAI-совместимые,
 * поэтому одного baseUrl достаточно и для российского агрегатора, и для
 * собственного прокси, и для локального сервера. Ключ лежит здесь же, в
 * IndexedDB устройства: платформа BYOK, ключ пользователя никуда не уходит,
 * кроме самого провайдера.
 */
export interface Provider extends BaseEntity {
  name: string;
  baseUrl: string; // напр. https://api.polza.ai/api/v1
  apiKey: string;
  models: string[]; // список доступных id моделей
  isDemo: boolean; // встроенная заглушка-эхо: без сети, без ключа
}

export interface Settings {
  id: 'app';
  theme: 'dark' | 'light' | 'system';
  activeProviderId: string | null;
  defaultModel: string;
  // Сколько последних сообщений уходит в модель. Прямой контроль расхода:
  // длинный диалог иначе оплачивается целиком на каждом вопросе.
  historyLimit: number;
  // Мягкий предел трат за месяц, ₽. 0 — без предупреждения.
  monthlyBudgetRub: number;
  updatedAt: string;
}
