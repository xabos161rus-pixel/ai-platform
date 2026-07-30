-- spaces: TOFU-регистрация пространств синхронизации. spaceId выводится из
-- фразы пользователя через PBKDF2+HKDF на клиенте (неугадываем), поэтому
-- первый запрос с новым spaceId просто регистрирует пару (space_id, token_hash),
-- дальнейшие сверяются с ней — без отдельного шага регистрации/логина.
CREATE TABLE IF NOT EXISTS spaces (
  space_id   TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- records: на сервере только шифротекст (AES-GCM на клиенте) + открытые
-- служебные поля, нужные для дельта-синка и LWW. Тело записи (JSON) сервер
-- не видит и не разбирает.
CREATE TABLE IF NOT EXISTS records (
  space_id   TEXT NOT NULL,
  tbl        TEXT NOT NULL,
  id         TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0,
  ciphertext TEXT NOT NULL,
  PRIMARY KEY (space_id, tbl, id)
);

-- Индекс сразу тройной (space_id, updated_at, id) — а не просто (space_id,
-- updated_at), как было в life-hub изначально. Там курсор из одного
-- updated_at терял записи с одинаковым миллисекундным штампом, не
-- поместившиеся на страницу (см. life-hub/worker/migrations/0006), и индекс
-- пришлось расширять отдельной миграцией задним числом. У нас пагинация
-- /sync/pull с первого дня идёт по паре (updated_at, id) через row values
-- сравнение — индекс покрывает и фильтр по space_id, и ORDER BY, и сам seek
-- по курсору одним проходом, без отдельного сканирования.
--
-- Курсор пары (updated_at, id) НЕ включает tbl, хотя PRIMARY KEY ниже —
-- тройка (space_id, tbl, id): допущение и когда его пересматривать — см.
-- комментарий у SQL-запроса /sync/pull в server/src/index.ts.
CREATE INDEX IF NOT EXISTS idx_records_pull ON records (space_id, updated_at, id);
