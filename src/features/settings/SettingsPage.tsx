import { useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router';
import { ChevronLeft, Download, KeyRound, Plus, Trash2, Upload } from 'lucide-react';
import { db, DEMO_PROVIDER_ID } from '../../db/db';
import type { Provider } from '../../db/types';
import { now, stamp } from '../../lib/repo';
import { Button } from '../../components/ui/Button';
import { useToast } from '../../components/ui/toastContext';
import { monthSpendByModel, monthSpendRub, type ModelSpend } from '../../lib/ai/chatRepo';
import { formatCost, formatTokens, modelLabel } from '../../lib/ai/models';
import { exportAll, parseBackup, importAll, type BackupFile } from '../../lib/backup';
import { ProviderSheet } from './ProviderSheet';

const BUILD_ID = document.querySelector('meta[name="build-id"]')?.getAttribute('content') ?? 'dev';

export function SettingsPage() {
  const toast = useToast();
  const [editing, setEditing] = useState<Provider | null>(null);
  const [adding, setAdding] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);

  const settings = useLiveQuery(() => db.settings.get('app'), []);
  const providers = useLiveQuery(async () => db.providers.toArray(), [], [] as Provider[]);
  const spend = useLiveQuery(() => monthSpendRub(), [], 0);
  const byModel = useLiveQuery(() => monthSpendByModel(), [], [] as ModelSpend[]);

  async function patchSettings(changes: Partial<typeof settings>) {
    await db.settings.update('app', { ...changes, updatedAt: now() });
  }

  async function handleSaveProvider(p: Omit<Provider, keyof import('../../db/types').BaseEntity>, id?: string) {
    if (id) {
      await db.providers.update(id, { ...p, updatedAt: now() });
    } else {
      const row = stamp<Provider>(p);
      await db.providers.add(row);
      await patchSettings({ activeProviderId: row.id, defaultModel: row.models[0] ?? 'demo-echo' });
    }
    setEditing(null);
    setAdding(false);
    toast('Провайдер сохранён');
  }

  async function handleRemoveProvider(p: Provider) {
    if (p.id === DEMO_PROVIDER_ID) return;
    if (!window.confirm(`Удалить провайдера «${p.name}»? Ключ будет стёрт с устройства.`)) return;
    await db.providers.delete(p.id);
    if (settings?.activeProviderId === p.id) await patchSettings({ activeProviderId: DEMO_PROVIDER_ID });
    toast('Провайдер удалён');
  }

  async function handleExport() {
    // Ключи провайдеров лежат в снапшоте открытым текстом — предупреждаем
    // до скачивания, чтобы файл не разошёлся куда попало.
    if (!window.confirm('В файле будут API-ключи провайдеров — храните его в надёжном месте. Продолжить?')) return;
    const data = await exportAll();
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `ai-platform-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Снапшот скачан');
  }

  async function handleImport(file: File) {
    let backup: BackupFile;
    try {
      backup = parseBackup(JSON.parse(await file.text()));
    } catch {
      // Битый JSON и чужой формат — один и тот же честный тост, без деталей парсера.
      toast('Файл не похож на снапшот AI Platform');
      return;
    }
    if (
      !window.confirm(
        `Восстановить данные из снапшота? Чатов: ${backup.chats.length}, сообщений: ${backup.messages.length}. Записи с совпадающими id будут перезаписаны.`,
      )
    )
      return;
    const rep = await importAll(backup);
    // Интерфейс обновится сам через useLiveQuery — руками ничего перечитывать не нужно.
    toast(`Восстановлено: ${rep.chats} чатов, ${rep.messages} сообщений`);
  }

  if (!settings) return null;

  return (
    <div className="fixed inset-0 flex flex-col bg-bg">
      <header className="flex shrink-0 items-center gap-2 border-b border-hairline px-2 pt-[calc(env(safe-area-inset-top)+8px)] pb-2">
        <Link
          to="/"
          aria-label="Назад"
          className="grid size-[var(--cc-touch)] place-items-center rounded-[var(--cc-radius)] text-accent active:opacity-60"
        >
          <ChevronLeft size={22} />
        </Link>
        <h1 className="flex-1 text-[0.95rem] font-semibold">Настройки</h1>
      </header>

      <div className="mx-auto w-full max-w-3xl flex-1 space-y-6 overflow-y-auto px-4 py-5 pb-[calc(env(safe-area-inset-bottom)+24px)]">
        <Section title="Провайдеры" hint="Ключи хранятся только на этом устройстве и уходят напрямую провайдеру.">
          <div className="space-y-1.5">
            {providers.map((p) => (
              <div
                key={p.id}
                className={`flex items-center gap-2 rounded-[var(--cc-radius)] border px-3 py-2.5 ${
                  settings.activeProviderId === p.id ? 'border-accent' : 'border-hairline'
                }`}
              >
                <button
                  className="min-w-0 flex-1 text-left active:opacity-60"
                  onClick={() => void patchSettings({ activeProviderId: p.id, defaultModel: p.models[0] ?? 'demo-echo' })}
                >
                  <span className="block truncate font-medium">{p.name}</span>
                  <span className="block truncate font-mono text-[var(--cc-text-caption)] text-muted">
                    {p.isDemo ? 'встроенная заглушка' : p.baseUrl || 'адрес не задан'}
                  </span>
                </button>
                {!p.isDemo && (
                  <>
                    <button
                      aria-label="Изменить"
                      className="grid size-9 place-items-center text-muted active:opacity-60"
                      onClick={() => setEditing(p)}
                    >
                      <KeyRound size={16} />
                    </button>
                    <button
                      aria-label="Удалить"
                      className="grid size-9 place-items-center text-muted active:opacity-60"
                      onClick={() => void handleRemoveProvider(p)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
          <Button
            variant="secondary"
            className="mt-2 inline-flex w-full items-center justify-center gap-2"
            onClick={() => setAdding(true)}
          >
            <Plus size={18} />
            Добавить провайдера
          </Button>
        </Section>

        <Section title="Оформление">
          <div className="flex rounded-[var(--cc-radius)] bg-surface-2 p-1">
            {(['dark', 'light', 'system'] as const).map((t) => (
              <button
                key={t}
                aria-pressed={settings.theme === t}
                onClick={() => void patchSettings({ theme: t })}
                className={`flex-1 rounded-[var(--cc-radius-sm)] py-2 text-sm font-medium transition-all ${
                  settings.theme === t ? 'bg-accent text-white' : 'text-muted'
                }`}
              >
                {t === 'dark' ? 'Тёмная' : t === 'light' ? 'Светлая' : 'Системная'}
              </button>
            ))}
          </div>
        </Section>

        <Section
          title="Контекст и расходы"
          hint="Сколько последних сообщений уходит в модель. Меньше контекста — дешевле запрос: без ограничения длинный диалог оплачивается целиком каждый раз."
        >
          <label className="flex items-center gap-3 py-1">
            <span className="flex-1">Сообщений в контексте</span>
            <input
              type="number"
              min={2}
              max={200}
              value={settings.historyLimit}
              onChange={(e) => void patchSettings({ historyLimit: Math.max(2, Number(e.target.value) || 20) })}
              className="w-20 rounded-[var(--cc-radius-sm)] bg-surface-2 px-2.5 py-2 text-right outline-none"
            />
          </label>
          <p className="mt-2 flex items-center justify-between border-t border-hairline pt-3 text-sm">
            <span className="text-muted">Потрачено за месяц</span>
            <span className="font-mono">{spend > 0 ? formatCost(spend) : '0 ₽'}</span>
          </p>
          {byModel.length > 0 &&
            (() => {
              const top = byModel.slice(0, 5);
              const rest = byModel.slice(5);
              return (
                <div className="mt-2 space-y-1.5">
                  {top.map((row) => (
                    <p key={row.model} className="flex items-baseline justify-between gap-3 text-[var(--cc-text-meta)]">
                      <span className="min-w-0 truncate text-muted">{modelLabel(row.model)}</span>
                      <span className="shrink-0 font-mono">
                        {formatTokens(row.tokens)} · {row.rub > 0 ? formatCost(row.rub) : '0 ₽'}
                      </span>
                    </p>
                  ))}
                  {rest.length > 0 &&
                    (() => {
                      const tokens = rest.reduce((s, r) => s + r.tokens, 0);
                      const rub = rest.reduce((s, r) => s + r.rub, 0);
                      return (
                        <p className="flex items-baseline justify-between gap-3 text-[var(--cc-text-meta)]">
                          <span className="min-w-0 truncate text-muted">прочее</span>
                          <span className="shrink-0 font-mono">
                            {formatTokens(tokens)} · {rub > 0 ? formatCost(rub) : '0 ₽'}
                          </span>
                        </p>
                      );
                    })()}
                </div>
              );
            })()}
        </Section>

        <Section
          title="Данные"
          hint="Снапшот включает чаты, сообщения, роли, настройки и провайдеров — вместе с API-ключами."
        >
          <Button
            variant="secondary"
            className="inline-flex w-full items-center justify-center gap-2"
            onClick={() => void handleExport()}
          >
            <Download size={18} />
            Скачать снапшот (JSON)
          </Button>
          <Button
            variant="secondary"
            className="mt-2 inline-flex w-full items-center justify-center gap-2"
            onClick={() => importRef.current?.click()}
          >
            <Upload size={18} />
            Импортировать снапшот
          </Button>
          <input
            ref={importRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleImport(f);
              e.target.value = '';
            }}
          />
        </Section>

        <p className="text-center font-mono text-[var(--cc-text-caption)] text-muted">
          сборка {BUILD_ID} · данные только на этом устройстве
        </p>
      </div>

      <ProviderSheet
        // key перемонтирует форму при каждом открытии — так поля берут
        // значения из пропсов без setState в эффекте.
        key={editing?.id ?? (adding ? 'new' : 'closed')}
        open={adding || editing !== null}
        provider={editing}
        onClose={() => {
          setAdding(false);
          setEditing(null);
        }}
        onSave={handleSaveProvider}
      />
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-1 text-sm font-semibold">{title}</h2>
      {hint && <p className="mb-2.5 text-[var(--cc-text-meta)] leading-relaxed text-muted">{hint}</p>}
      {children}
    </section>
  );
}
