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
  /**
   * Активный лист дерева версий — id узла-представителя, на который сейчас
   * смотрит чат. null — чат пуст либо явно на корне. Поле не индексируем:
   * читается только вместе с самим чатом.
   */
  activeLeafId?: string | null;
  /** Температура запроса. null/отсутствие — не передавать провайдеру (его дефолт). */
  temperature?: number | null;
  /** Лимит токенов ответа. null/отсутствие — не передавать провайдеру. */
  maxTokens?: number | null;
  /** Режим инструментов агентского цикла. Отсутствие/null — как 'off' (без tools). */
  toolMode?: 'off' | 'tools' | 'research' | null;
}

export type Role = 'user' | 'assistant';

/** 'streaming' появится вместе с потоковым ответом (этап 2). */
export type MessageStatus = 'done' | 'error';

export type ToolStepStatus = 'running' | 'done' | 'error';

/** Один шаг агентского цикла (вызов инструмента моделью). Живёт только в Message.toolTrace — для отображения, в контекст следующих вопросов не уходит. */
export interface ToolStep {
  id: string; // id tool_call от модели либо uid()
  tool: string; // имя инструмента (web_search|read_page|get_time|…)
  args: Record<string, unknown>; // распарсенные аргументы; {} если JSON битый
  status: ToolStepStatus;
  result?: string; // результат или текст ошибки; в toolTrace обрезан до 4000 симв.
}

export interface Message extends BaseEntity {
  chatId: string;
  role: Role;
  content: string;
  model: string | null; // чем отвечено; у сообщений пользователя null
  tokensIn: number | null;
  tokensOut: number | null;
  /** Токены размышлений — подмножество tokensOut (в стоимость уже входят).
   *  Показываем, куда ушёл счёт; null/undefined — провайдер не отдал. */
  tokensReasoning?: number | null;
  /** Токены входа из кеша провайдера — подмножество tokensIn. */
  tokensCached?: number | null;
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
  /**
   * Явный родитель в дереве версий. undefined — legacy-сообщение из линейной
   * цепочки (эффективный родитель вычисляется по createdAt в tree.ts). null —
   * корень чата. Поле не индексируем: дерево строится в памяти из выборки по chatId.
   */
  parentId?: string | null;
  /** След агентского прогона (шаги инструментов) — только для отображения; в toContext/wire не попадает. */
  toolTrace?: ToolStep[];
  /** Метаданные прикреплённых файлов (не картинок). Текст — параллельно, в fileTexts[i]. Рендерится в пузыре чипом. */
  files?: { name: string; size: number; textChars: number }[];
  /** Извлечённый текст файлов, по индексу как в files. Не рендерится — уходит в wire через toContext. */
  fileTexts?: string[];
}

/**
 * Подключение к провайдеру. Все поддерживаемые API — OpenAI-совместимые,
 * поэтому одного baseUrl достаточно и для российского агрегатора, и для
 * собственного прокси, и для локального сервера. Ключ лежит здесь же, в
 * IndexedDB устройства: платформа BYOK, ключ пользователя никуда не уходит,
 * кроме самого провайдера.
 */
/** Модель провайдера с опциональной ценой, ₽ за 1M токенов. */
export interface ProviderModel {
  id: string;
  priceIn?: number;
  priceOut?: number;
}

export interface Provider extends BaseEntity {
  name: string;
  baseUrl: string; // напр. https://api.polza.ai/api/v1
  apiKey: string;
  // Строка — legacy-запись (модель без цены); новые записи пишутся объектами.
  // Единственная точка нормализации — modelEntries() в lib/ai/models.ts.
  models: (string | ProviderModel)[];
  isDemo: boolean; // встроенная заглушка-эхо: без сети, без ключа
}

export interface Persona extends BaseEntity {
  name: string;
  prompt: string;
  /** Встроенная роль: нельзя удалить, восстанавливается при старте. */
  builtin: boolean;
}

export interface Snippet extends BaseEntity {
  title: string;
  text: string;
  /** Встроенный сниппет: нельзя удалить, восстанавливается при старте. */
  builtin: boolean;
}

export interface Settings {
  id: 'app';
  theme: 'dark' | 'light' | 'system';
  /** Язык интерфейса. 'system' — по navigator.language. Отсутствие поля = 'system'. */
  language?: 'ru' | 'en' | 'system';
  activeProviderId: string | null;
  defaultModel: string;
  /** Модели для режима сравнения: `providerId:model`. Пусто — режим выключен. */
  compareModels?: string[];
  // Сколько последних сообщений уходит в модель. Прямой контроль расхода:
  // длинный диалог иначе оплачивается целиком на каждом вопросе.
  historyLimit: number;
  // Мягкий предел трат за месяц, ₽. 0 — без предупреждения.
  monthlyBudgetRub: number;
  /** Ключ Jina AI (s.jina.ai/r.jina.ai) для инструментов web_search/read_page. Пусто — запросы идут без Authorization (более жёсткий рейт-лимит). */
  jinaKey?: string;
  updatedAt: string;
}

/**
 * Конфиг E2E-синхронизации. НЕ extends BaseEntity — это локальные настройки
 * устройства (как Settings), сама запись на сервер не уходит и не синкается.
 * Секрет — введённая пользователем фраза — здесь не хранится вообще: только
 * то, что из неё необратимо выведено (spaceId/authToken/aesKeyB64).
 */
export interface SyncConfig {
  id: 'sync';
  serverUrl: string;
  spaceId: string; // hex, 64 символа — идентификатор пространства на сервере
  authToken: string; // base64url 32 байта — bearer для воркера
  aesKeyB64: string; // raw AES-GCM-256 ключ, base64url; сама фраза НЕ хранится
  enabled: boolean;
  lastPushAt: string; // курсор push (ISO); '' — ещё не пушили
  lastPullAt: string; // курсор pull: первая половина составного курсора (updated_at, id)
  // Вторая половина курсора pull. Сервер пагинирует по паре (updated_at, id) —
  // курсор из одного lastPullAt терял бы записи с тем же миллисекундным
  // штампом (тот самый баг, который в life-hub чинила миграция 0006).
  lastPullId: string;
  lastSyncAt: string; // время последнего успешного полного цикла; '' — не было
  lastError: string; // '' — ошибок нет; показывается на экране синка
}
