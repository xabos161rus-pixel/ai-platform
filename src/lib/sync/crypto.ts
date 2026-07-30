// E2E-крипто для синхронизации: идентичность пространства и ключ шифрования
// выводятся из фразы, которую пользователь вводит на обоих устройствах.
// Сама фраза нигде не хранится — только то, что из неё необратимо выведено
// (см. src/lib/sync/config.ts). Чистый WebCrypto, без зависимостей.

// === base64url (без паддинга) ↔ байты — так же, как в life-hub/crypto.ts ===
export function bytesToB64url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Тип возврата явно Uint8Array<ArrayBuffer> — TS иначе выводит Uint8Array<ArrayBufferLike>
// из new Uint8Array(bin.length) и ругается там, где вызывающий код передаёт
// результат в BufferSource-параметры WebCrypto (importKey/decrypt и т.п.).
export function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const PBKDF2_ITERATIONS = 310_000;
// Соль PBKDF2 — константа, а не случайная: у нас нет отдельного места её
// хранить (фраза не хранится вообще, а spaceId должен получаться из одной
// только фразы одинаково на любом устройстве). Секретность обеспечивает сама
// фраза и число итераций, не соль.
const KDF_SALT = 'ai-platform-sync-v1';
const IV_BYTES = 12; // рекомендованный размер nonce для AES-GCM

export interface DerivedIdentity {
  spaceId: string; // hex, 64 символа — публичный идентификатор пространства на сервере
  authToken: string; // base64url 32 байта — bearer для воркера
  aesKeyB64: string; // raw AES-GCM-256 ключ, base64url
}

/**
 * Вывести идентичность пространства и ключ шифрования из фразы.
 * PBKDF2 (растягивание пароля) → общий мастер-секрет → HKDF с разными
 * метками домена на каждое из трёх назначений, чтобы компрометация одного
 * производного значения (например, authToken, который живёт на сервере в
 * виде хэша) не давала вообще ничего для восстановления двух других.
 */
export async function deriveIdentity(phrase: string): Promise<DerivedIdentity> {
  // NFKC + trim: визуально одинаковая фраза, набранная на маковской и
  // айфонной клавиатуре, может отличаться на уровне кодовых точек (NBSP
  // вместо пробела, автотипографические кавычки/тире) — без нормализации
  // это тихо развело бы устройства по разным пространствам.
  const p = phrase.normalize('NFKC').trim();
  const enc = new TextEncoder();

  const baseKey = await crypto.subtle.importKey('raw', enc.encode(p), 'PBKDF2', false, ['deriveBits']);
  const master = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(KDF_SALT), iterations: PBKDF2_ITERATIONS },
    baseKey,
    256, // length — в БИТАХ, не байтах
  );

  const hkdfKey = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveBits']);
  const hkdf = (info: string): Promise<ArrayBuffer> =>
    crypto.subtle.deriveBits(
      // salt в HkdfParams ОБЯЗАТЕЛЕН даже пустой — без него WebCrypto кидает
      // TypeError ещё до вычисления (соль не нужна: домен-метка в info уже
      // разводит разные назначения одного мастер-секрета).
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(info) },
      hkdfKey,
      256,
    );

  const [spaceBits, authBits, encBits] = await Promise.all([hkdf('space'), hkdf('auth'), hkdf('enc')]);
  return {
    spaceId: bytesToHex(new Uint8Array(spaceBits)),
    authToken: bytesToB64url(new Uint8Array(authBits)),
    aesKeyB64: bytesToB64url(new Uint8Array(encBits)),
  };
}

/** Импортировать сохранённый в Dexie raw-ключ обратно в CryptoKey для шифрования/расшифровки. */
export function importAesKey(aesKeyB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', b64urlToBytes(aesKeyB64), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

// === Шифрование полезной нагрузки записи ===
// Формат шифротекста: base64url( iv(12 байт) ‖ ciphertext ) — как в
// life-hub/crypto.ts. Именно base64url без паддинга, а не классический
// base64: сервер это поле не декодирует и не трогает, но между собой клиенты
// (T2 здесь и T4 в тестах/смоуке) обязаны договориться об одном формате.
export async function encryptJSON(key: CryptoKey, obj: unknown): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(obj));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  const ctBytes = new Uint8Array(ct);
  const combined = new Uint8Array(iv.length + ctBytes.length);
  combined.set(iv, 0);
  combined.set(ctBytes, iv.length);
  return bytesToB64url(combined);
}

export async function decryptJSON<T>(key: CryptoKey, payload: string): Promise<T> {
  const combined = b64urlToBytes(payload);
  const iv = combined.slice(0, IV_BYTES);
  const ct = combined.slice(IV_BYTES);
  const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return JSON.parse(new TextDecoder().decode(data)) as T;
}
