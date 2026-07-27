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
  /** Папка в боковой панели. null/undefined — вне папок. Поле не индексируем: чатов сотни, фильтруем в памяти. */
  folder?: string | null;
  /** Имя роли-источника systemPrompt — только подпись в UI. Промпт скопирован по значению: удаление роли чат не ломает. */
  personaName?: string | null;
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
  /**
   * Общий идентификатор «прогона» для режима сравнения: один вопрос уходит в
   * несколько моделей, и их ответы — сиблинги с одним runId. Рисуются рядом
   * колонками, а в контекст следующего вопроса уходит только выбранный.
   * null/undefined — обычный одиночный ответ.
   */
  runId?: string | null;
  /** Порядок колонки внутри прогона. */
  runIndex?: number;
  /** Победитель прогона — его ответ уходит в контекст. */
  chosen?: boolean;
  /** Вложенные картинки: сжатые JPEG dataURL (≤1024px по длинной стороне, ≤4 шт). Только у сообщений пользователя. */
  images?: string[];
  /** Рассуждения модели (reasoning_content/reasoning из потока). Нет поля — модель мысли не шлёт. */
  reasoning?: string;
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

export interface Persona extends BaseEntity {
  name: string;
  prompt: string;
  /** Встроенная роль: нельзя удалить, восстанавливается при старте. */
  builtin: boolean;
}

export interface Settings {
  id: 'app';
  theme: 'dark' | 'light' | 'system';
  activeProviderId: string | null;
  defaultModel: string;
  /** Модели для режима сравнения: `providerId:model`. Пусто — режим выключен. */
  compareModels?: string[];
  // Сколько последних сообщений уходит в модель. Прямой контроль расхода:
  // длинный диалог иначе оплачивается целиком на каждом вопросе.
  historyLimit: number;
  // Мягкий предел трат за месяц, ₽. 0 — без предупреждения.
  monthlyBudgetRub: number;
  updatedAt: string;
}
