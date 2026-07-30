import { useState } from 'react';
import { Sheet } from '../../components/ui/Sheet';
import { Button } from '../../components/ui/Button';
import { useToast } from '../../components/ui/toastContext';
import { useT } from '../../lib/i18n';
import type { SyncConfig } from '../../db/types';
import { deriveIdentity } from '../../lib/sync/crypto';
import { DEFAULT_SERVER_URL, clearSyncConfig, saveSyncConfig } from '../../lib/sync/config';
import { checkHealth, runSync } from '../../lib/sync/engine';

interface Props {
  open: boolean;
  /**
   * Приходит пропом из SettingsPage (там уже есть свой useLiveQuery для строки
   * статуса), а НЕ через собственный useLiveQuery здесь — на свежесмонтированной
   * подписке Dexie первый рендер синхронно отдаёт undefined ВСЕГДА, даже если
   * конфиг уже есть в базе (чтение IndexedDB асинхронное). useState() ниже
   * захватил бы этот undefined как начальное значение раньше, чем запрос успел
   * бы досчитаться, и поле «Адрес сервера» всегда показывало бы дефолт вместо
   * сохранённого (см. ревью). У SettingsPage запрос живёт с самого монтирования
   * страницы — к моменту открытия шита он уже успевает разрешиться.
   */
  cfg: SyncConfig | undefined;
  onClose: () => void;
}

/**
 * Поля инициализируются прямо из cfg — сброс между открытиями делает `key`
 * на стороне вызывающего (SettingsPage): перемонтирование вместо setState в
 * эффекте, тот же паттерн, что у ProviderSheet/SnippetSheet.
 */
export function SyncSheet({ open, cfg, onClose }: Props) {
  const t = useT();
  const toast = useToast();
  const enabled = !!cfg?.enabled;
  const [phrase, setPhrase] = useState('');
  const [serverUrl, setServerUrl] = useState(cfg?.serverUrl ?? DEFAULT_SERVER_URL);
  const [busy, setBusy] = useState(false);

  const canEnable = phrase.trim().length >= 8 && !busy;

  async function handleEnable() {
    if (!canEnable) return;
    setBusy(true);
    try {
      const idn = await deriveIdentity(phrase);
      await saveSyncConfig({
        id: 'sync',
        serverUrl: serverUrl.trim() || DEFAULT_SERVER_URL,
        spaceId: idn.spaceId,
        authToken: idn.authToken,
        aesKeyB64: idn.aesKeyB64,
        enabled: true,
        lastPushAt: '',
        lastPullAt: '',
        lastPullId: '',
        lastSyncAt: '',
        lastError: '',
      });
      // Первый цикл может быть долгим на большой истории — не ждём его тут:
      // шит закрывается сразу, статус на экране настроек обновится сам через
      // useLiveQuery, когда runSync завершится в фоне.
      void runSync().catch(() => {});
      setPhrase('');
      toast(t('sync.enabledToast'));
      onClose();
    } finally {
      setBusy(false);
    }
  }

  async function handleSyncNow() {
    try {
      const result = await runSync();
      // null — сработал guard критической секции (параллельный цикл уже шёл:
      // например, ещё не истёк debounce после правки), реального обмена не
      // было. Показывать «Синхронизировано» в этом случае — вводить в
      // заблуждение (см. ревью).
      toast(result ? t('sync.doneToast') : t('sync.busyToast'));
    } catch {
      // Детали уже лежат в cfg.lastError — движок сам их записал до throw.
      toast(t('sync.failToast'));
    }
  }

  async function handleCheck() {
    const ok = await checkHealth(serverUrl.trim() || DEFAULT_SERVER_URL);
    toast(ok ? t('sync.checkOk') : t('sync.checkFail'));
  }

  async function handleDisable() {
    // Локальные чаты/сообщения/провайдеры не трогаются — стирается только
    // сам конфиг синка (фраза и так нигде не хранилась).
    await clearSyncConfig();
    toast(t('sync.disabledToast'));
  }

  return (
    <Sheet open={open} onClose={onClose} title={t('sync.title')}>
      <div className="space-y-3">
        <p className="text-[length:var(--cc-text-caption)] leading-relaxed text-muted">{t('sync.hint')}</p>

        <Field
          label={t('sync.phrase')}
          value={phrase}
          onChange={setPhrase}
          placeholder={t('sync.phrasePlaceholder')}
          type="password"
        />
        <Field label={t('sync.server')} value={serverUrl} onChange={setServerUrl} mono />

        <Button className="w-full" disabled={!canEnable} onClick={() => void handleEnable()}>
          {t('sync.enable')}
        </Button>

        {enabled && (
          <Button variant="secondary" className="w-full" onClick={() => void handleSyncNow()}>
            {t('sync.syncNow')}
          </Button>
        )}

        <Button variant="secondary" className="w-full" onClick={() => void handleCheck()}>
          {t('sync.check')}
        </Button>

        {enabled && (
          <Button variant="danger" className="w-full" onClick={() => void handleDisable()}>
            {t('sync.disable')}
          </Button>
        )}

        <p className="text-[length:var(--cc-text-caption)] leading-relaxed text-muted">{t('sync.warning')}</p>
      </div>
    </Sheet>
  );
}

/** Локальная копия Field из ProviderSheet — не экспортируется оттуда намеренно (only-export-components). */
function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  mono = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  mono?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        className={`w-full rounded-[var(--cc-radius)] bg-surface-2 px-3 py-2.5 outline-none placeholder:text-muted ${mono ? 'font-mono text-[length:var(--cc-text-body)]' : ''}`}
      />
    </label>
  );
}
