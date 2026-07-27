import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router';
import { ChevronLeft, KeyRound, Plus, Trash2 } from 'lucide-react';
import { db, DEMO_PROVIDER_ID } from '../../db/db';
import type { Provider } from '../../db/types';
import { now, stamp } from '../../lib/repo';
import { Button } from '../../components/ui/Button';
import { useToast } from '../../components/ui/toastContext';
import { monthSpendRub } from '../../lib/ai/chatRepo';
import { formatCost } from '../../lib/ai/models';
import { ProviderSheet } from './ProviderSheet';

const BUILD_ID = document.querySelector('meta[name="build-id"]')?.getAttribute('content') ?? 'dev';

export function SettingsPage() {
  const toast = useToast();
  const [editing, setEditing] = useState<Provider | null>(null);
  const [adding, setAdding] = useState(false);

  const settings = useLiveQuery(() => db.settings.get('app'), []);
  const providers = useLiveQuery(async () => db.providers.toArray(), [], [] as Provider[]);
  const spend = useLiveQuery(() => monthSpendRub(), [], 0);

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
