import { useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router';
import { ChevronLeft, Cloud, Download, Keyboard, Pencil, Plus, Trash2, Upload } from '../../components/ui/glyphs';
import { db, DEMO_PROVIDER_ID } from '../../db/db';
import type { Provider, Snippet, SyncConfig } from '../../db/types';
import { alive, now, stamp } from '../../lib/repo';
import { Button } from '../../components/ui/Button';
import { useToast } from '../../components/ui/toastContext';
import {
  monthSpendByChat,
  monthSpendByModel,
  monthSpendRub,
  spendByDay,
  spendMonths,
  type ChatSpend,
  type DaySpend,
  type ModelSpend,
  type MonthSpend,
} from '../../lib/ai/chatRepo';
import { formatCost, formatTokens, modelIds, modelLabel } from '../../lib/ai/models';
import { addSnippet, listSnippets, patchSnippet, removeSnippet } from '../../lib/ai/snippetRepo';
import { exportAll, parseBackup, importAll, type BackupFile } from '../../lib/backup';
import { scheduleSyncSoon } from '../../lib/sync/engine';
import { ProviderSheet } from './ProviderSheet';
import { SnippetSheet } from './SnippetSheet';
import { SyncSheet } from './SyncSheet';
import { ShortcutsSheet } from '../chat/ShortcutsSheet';
import { useT } from '../../lib/i18n';

const BUILD_ID = document.querySelector('meta[name="build-id"]')?.getAttribute('content') ?? 'dev';

/** Строка статуса синка — по приоритету: выключено → ошибка → ни разу не синкалось → время последнего синка. */
function syncStatusText(t: ReturnType<typeof useT>, cfg: SyncConfig | undefined): string {
  if (!cfg?.enabled) return t('sync.statusOff');
  if (cfg.lastError) return t('sync.statusError', { error: cfg.lastError.slice(0, 80) });
  if (!cfg.lastSyncAt) return t('sync.statusNever');
  return t('sync.statusOn', {
    time: new Date(cfg.lastSyncAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  });
}

export function SettingsPage() {
  const toast = useToast();
  const t = useT();
  const [editing, setEditing] = useState<Provider | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingSnippet, setEditingSnippet] = useState<Snippet | null>(null);
  const [addingSnippet, setAddingSnippet] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);

  const settings = useLiveQuery(() => db.settings.get('app'), []);
  // alive(): мягко удалённый провайдер (решение 12) не должен всплывать обратно в списке.
  const providers = useLiveQuery(async () => alive(await db.providers.toArray()), [], [] as Provider[]);
  const snippets = useLiveQuery(() => listSnippets(), [], [] as Snippet[]);
  const syncCfg = useLiveQuery(() => db.syncConfig.get('sync'), []);
  const spend = useLiveQuery(() => monthSpendRub(), [], 0);
  const byModel = useLiveQuery(() => monthSpendByModel(), [], [] as ModelSpend[]);
  const byDay = useLiveQuery(() => spendByDay(30), [], [] as DaySpend[]);
  const byChat = useLiveQuery(() => monthSpendByChat(5), [], [] as ChatSpend[]);
  const months = useLiveQuery(() => spendMonths(6), [], [] as MonthSpend[]);

  async function patchSettings(changes: Partial<typeof settings>) {
    await db.settings.update('app', { ...changes, updatedAt: now() });
  }

  async function handleSaveProvider(p: Omit<Provider, keyof import('../../db/types').BaseEntity>, id?: string) {
    if (id) {
      await db.providers.update(id, { ...p, updatedAt: now() });
    } else {
      const row = stamp<Provider>(p);
      await db.providers.add(row);
      await patchSettings({ activeProviderId: row.id, defaultModel: modelIds(row.models)[0] ?? 'demo-echo' });
    }
    setEditing(null);
    setAdding(false);
    toast(t('settings.providerSaved'));
    scheduleSyncSoon();
  }

  async function handleSaveSnippet(s: Pick<Snippet, 'title' | 'text'>, id?: string) {
    if (id) await patchSnippet(id, s);
    else await addSnippet(s.title, s.text);
    setEditingSnippet(null);
    setAddingSnippet(false);
    toast(t('settings.snippetSaved'));
  }

  async function handleRemoveSnippet(s: Snippet) {
    if (!window.confirm(t('settings.deleteSnippetConfirm', { title: s.title }))) return;
    await removeSnippet(s.id);
    toast(t('settings.snippetDeleted'));
  }

  async function handleRemoveProvider(p: Provider) {
    if (p.id === DEMO_PROVIDER_ID) return;
    if (!window.confirm(t('settings.deleteProviderConfirm', { name: p.name }))) return;
    const ts = now();
    // Мягко, по образцу personaRepo: запись должна уехать синком на второе
    // устройство как удаление, а не молча пропасть только тут.
    await db.providers.update(p.id, { deletedAt: ts, updatedAt: ts });
    if (settings?.activeProviderId === p.id) await patchSettings({ activeProviderId: DEMO_PROVIDER_ID });
    toast(t('settings.providerDeleted'));
    scheduleSyncSoon();
  }

  async function handleExport() {
    // Ключи провайдеров лежат в снапшоте открытым текстом — предупреждаем
    // до скачивания, чтобы файл не разошёлся куда попало.
    if (!window.confirm(t('settings.exportConfirm'))) return;
    const data = await exportAll();
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `ai-platform-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast(t('settings.snapshotDownloaded'));
  }

  async function handleImport(file: File) {
    let backup: BackupFile;
    try {
      backup = parseBackup(JSON.parse(await file.text()));
    } catch {
      // Битый JSON и чужой формат — один и тот же честный тост, без деталей парсера.
      toast(t('settings.badBackup'));
      return;
    }
    if (
      !window.confirm(
        t('settings.importConfirm', { chats: backup.chats.length, messages: backup.messages.length }),
      )
    )
      return;
    const rep = await importAll(backup);
    // Интерфейс обновится сам через useLiveQuery — руками ничего перечитывать не нужно.
    toast(t('settings.restored', { chats: rep.chats, messages: rep.messages }));
  }

  if (!settings) return null;

  return (
    <div className="fixed inset-0 flex flex-col bg-bg">
      <header className="flex shrink-0 items-center gap-2 border-b border-hairline px-2 pt-[calc(env(safe-area-inset-top)+8px)] pb-2">
        <Link
          to="/"
          aria-label={t('settings.backAria')}
          className="grid size-[var(--cc-touch)] place-items-center rounded-[var(--cc-radius)] text-accent active:opacity-60"
        >
          <ChevronLeft size={22} />
        </Link>
        <h1 className="flex-1 text-[0.95rem] font-semibold">{t('nav.settings')}</h1>
      </header>

      <div className="cc-scroll mx-auto w-full max-w-3xl flex-1 space-y-8 overflow-y-auto px-4 py-5 pb-[calc(env(safe-area-inset-bottom)+24px)]">
        <Section title={t('settings.providers')} hint={t('settings.providersHint')}>
          <div className="space-y-1.5">
            {/* Демо-строка существует, только пока нет ни одного настоящего
                провайдера: с живым ключом платформа выглядит взрослой, без
                демо-моментов. Дорога назад — удалить последний живой: актив
                сам вернётся на демо (handleRemoveProvider), и строка всплывёт. */}
            {(providers.some((x) => !x.isDemo) ? providers.filter((x) => !x.isDemo) : providers).map((p) => (
              <div
                key={p.id}
                className={`group flex items-center gap-2.5 rounded-[var(--cc-radius)] border border-hairline px-3 py-2.5 transition-colors ${
                  settings.activeProviderId === p.id ? 'bg-surface-2' : 'hover:bg-[var(--cc-fill-ghost-hover)]'
                }`}
              >
                {/* Активность — клай-точкой, тем же маркером, что у ответов в
                    чате: рамка на всю карточку кричала громче содержимого. */}
                <span
                  aria-hidden
                  className={`size-1.5 shrink-0 rounded-full transition-colors ${
                    settings.activeProviderId === p.id ? 'bg-accent' : 'bg-hairline'
                  }`}
                />
                <button
                  className="min-w-0 flex-1 text-left active:opacity-60"
                  onClick={() => void patchSettings({ activeProviderId: p.id, defaultModel: modelIds(p.models)[0] ?? 'demo-echo' })}
                >
                  <span className="block truncate font-medium">{p.name}</span>
                  <span className="block truncate font-mono text-[length:var(--cc-text-caption)] text-muted">
                    {p.isDemo ? t('settings.demoProviderNote') : p.baseUrl || t('settings.noAddress')}
                  </span>
                </button>
                {!p.isDemo && (
                  <>
                    <button
                      aria-label={t('settings.editAria')}
                      title={t('settings.editAria')}
                      className="grid size-9 place-items-center rounded-[var(--cc-radius-sm)] text-muted transition-colors hover:text-text active:opacity-60"
                      onClick={() => setEditing(p)}
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      aria-label={t('settings.deleteAria')}
                      title={t('settings.deleteAria')}
                      className="grid size-9 place-items-center rounded-[var(--cc-radius-sm)] text-muted transition-colors hover:text-danger active:opacity-60"
                      onClick={() => void handleRemoveProvider(p)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
          <button
            onClick={() => setAdding(true)}
            className="mt-1 flex min-h-[var(--cc-touch)] items-center gap-2 rounded-[var(--cc-radius)] px-2.5 text-sm font-medium text-muted transition-colors hover:bg-[var(--cc-fill-ghost-hover)] hover:text-text active:opacity-70"
          >
            <Plus size={16} />
            {t('settings.addProvider')}
          </button>
        </Section>

        <Section title={t('settings.appearance')}>
          <div className="inline-flex rounded-[var(--cc-radius)] bg-surface-2 p-1">
            {(['dark', 'light', 'system'] as const).map((theme) => (
              <button
                key={theme}
                aria-pressed={settings.theme === theme}
                onClick={() => void patchSettings({ theme })}
                className={`rounded-[var(--cc-radius-sm)] px-4 py-1.5 text-sm font-medium transition-all ${
                  settings.theme === theme ? 'bg-accent text-white' : 'text-muted hover:text-text'
                }`}
              >
                {theme === 'dark' ? t('settings.theme.dark') : theme === 'light' ? t('settings.theme.light') : t('settings.system')}
              </button>
            ))}
          </div>
        </Section>

        <Section title={t('settings.language')}>
          <div className="inline-flex rounded-[var(--cc-radius)] bg-surface-2 p-1">
            {(['ru', 'en', 'system'] as const).map((lang) => (
              <button
                key={lang}
                aria-pressed={(settings.language ?? 'system') === lang}
                onClick={() => void patchSettings({ language: lang })}
                className={`rounded-[var(--cc-radius-sm)] px-4 py-1.5 text-sm font-medium transition-all ${
                  (settings.language ?? 'system') === lang ? 'bg-accent text-white' : 'text-muted hover:text-text'
                }`}
              >
                {lang === 'ru' ? 'Русский' : lang === 'en' ? 'English' : t('settings.system')}
              </button>
            ))}
          </div>
        </Section>

        <Section title={t('settings.context')} hint={t('settings.contextHint')}>
          <label className="flex items-center gap-3 py-1">
            <span className="flex-1">{t('settings.messagesInContext')}</span>
            <input
              type="number"
              min={2}
              max={200}
              value={settings.historyLimit}
              onChange={(e) => void patchSettings({ historyLimit: Math.max(2, Number(e.target.value) || 20) })}
              className="w-20 rounded-[var(--cc-radius-sm)] bg-surface-2 px-2.5 py-2 text-right outline-none"
            />
          </label>
          <label className="flex items-center gap-3 border-t border-hairline py-1 pt-3">
            <span className="flex-1">
              {t('settings.monthlyBudget')}
              <span className="block text-[length:var(--cc-text-meta)] text-muted">{t('settings.monthlyBudgetHint')}</span>
            </span>
            <input
              type="number"
              min={0}
              step={100}
              value={settings.monthlyBudgetRub || ''}
              placeholder="0"
              onChange={(e) => void patchSettings({ monthlyBudgetRub: Math.max(0, Number(e.target.value) || 0) })}
              className="w-24 rounded-[var(--cc-radius-sm)] bg-surface-2 px-2.5 py-2 text-right outline-none"
            />
          </label>
          <p className="mt-2 flex items-center justify-between border-t border-hairline pt-3 text-sm">
            <span className="text-muted">{t('settings.spentThisMonth')}</span>
            <span className="font-mono">{spend > 0 ? formatCost(spend) : '0 ₽'}</span>
          </p>
          {settings.monthlyBudgetRub > 0 && (
            <div className="mt-2">
              {/* Полоса расхода: до 80% — акцент, дальше — предупреждение, за
                  бюджетом — danger. Те же пороги, что у гейта отправки в чате. */}
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                <div
                  className={`h-full rounded-full transition-all ${
                    spend >= settings.monthlyBudgetRub ? 'bg-danger' : spend >= settings.monthlyBudgetRub * 0.8 ? 'bg-warning' : 'bg-accent'
                  }`}
                  style={{ width: `${Math.min(100, (spend / settings.monthlyBudgetRub) * 100)}%` }}
                />
              </div>
              <p className="mt-1 text-right font-mono text-[length:var(--cc-text-meta)] text-muted">
                {Math.round((spend / settings.monthlyBudgetRub) * 100)}% · {formatCost(settings.monthlyBudgetRub)}
              </p>
            </div>
          )}
          {byModel.length > 0 &&
            (() => {
              const top = byModel.slice(0, 5);
              const rest = byModel.slice(5);
              return (
                <div className="mt-2 space-y-1.5">
                  {top.map((row) => (
                    <p key={row.model} className="flex items-baseline justify-between gap-3 text-[length:var(--cc-text-meta)]">
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
                        <p className="flex items-baseline justify-between gap-3 text-[length:var(--cc-text-meta)]">
                          <span className="min-w-0 truncate text-muted">{t('settings.other')}</span>
                          <span className="shrink-0 font-mono">
                            {formatTokens(tokens)} · {rub > 0 ? formatCost(rub) : '0 ₽'}
                          </span>
                        </p>
                      );
                    })()}
                </div>
              );
            })()}
          {/* Расход по дням: 30 столбиков без библиотек — див с высотой от max.
              Ось не подписываем: это градусник «где жгло», а не аналитика. */}
          {byDay.some((d) => d.rub > 0) &&
            (() => {
              const max = Math.max(...byDay.map((d) => d.rub));
              return (
                <div className="mt-3 border-t border-hairline pt-3">
                  <p className="mb-1.5 text-[length:var(--cc-text-meta)] text-muted">{t('settings.spendByDay')}</p>
                  <div className="flex h-12 items-end gap-[2px]">
                    {byDay.map((d) => (
                      <div
                        key={d.day}
                        title={`${d.day} · ${d.rub > 0 ? formatCost(d.rub) : '0 ₽'}`}
                        className={`min-w-0 flex-1 rounded-t-[2px] ${d.rub > 0 ? 'bg-accent' : 'bg-surface-2'}`}
                        style={{ height: d.rub > 0 ? `${Math.max(8, (d.rub / max) * 100)}%` : '3px' }}
                      />
                    ))}
                  </div>
                </div>
              );
            })()}
          {byChat.length > 0 && (
            <div className="mt-3 space-y-1.5 border-t border-hairline pt-3">
              <p className="text-[length:var(--cc-text-meta)] text-muted">{t('settings.spendByChat')}</p>
              {byChat.map((c) => (
                <p key={c.chatId} className="flex items-baseline justify-between gap-3 text-[length:var(--cc-text-meta)]">
                  <span className="min-w-0 truncate text-muted">{c.title || t('chat.newChat')}</span>
                  <span className="shrink-0 font-mono">
                    {formatTokens(c.tokens)} · {c.rub > 0 ? formatCost(c.rub) : '0 ₽'}
                  </span>
                </p>
              ))}
            </div>
          )}
          {months.length > 1 && (
            <div className="mt-3 space-y-1.5 border-t border-hairline pt-3">
              <p className="text-[length:var(--cc-text-meta)] text-muted">{t('settings.spendMonths')}</p>
              {months.map((m) => (
                <p key={m.month} className="flex items-baseline justify-between gap-3 text-[length:var(--cc-text-meta)]">
                  <span className="min-w-0 truncate text-muted">{m.month}</span>
                  <span className="shrink-0 font-mono">
                    {formatTokens(m.tokens)} · {m.rub > 0 ? formatCost(m.rub) : '0 ₽'}
                  </span>
                </p>
              ))}
            </div>
          )}
        </Section>

        <Section title={t('settings.tools')} hint={t('settings.toolsHint')}>
          <label className="flex flex-col gap-1.5 py-1">
            <span>{t('settings.jinaKey')}</span>
            <input
              type="password"
              placeholder="jina_…"
              value={settings.jinaKey ?? ''}
              onChange={(e) => void patchSettings({ jinaKey: e.target.value })}
              className="w-full rounded-[var(--cc-radius-sm)] bg-surface-2 px-2.5 py-2 font-mono outline-none"
            />
          </label>
          <p className="mt-1 text-[length:var(--cc-text-caption)]">
            <a href="https://jina.ai" target="_blank" rel="noreferrer" className="text-accent">
              {t('settings.jinaGetKey')}
            </a>
          </p>
          <p className="text-[length:var(--cc-text-caption)] text-muted">{t('settings.jinaFree')}</p>
        </Section>

        <Section title={t('sync.title')} hint={t('sync.hint')}>
          <p className="mb-2 text-sm text-muted">{syncStatusText(t, syncCfg)}</p>
          <button
            onClick={() => setSyncOpen(true)}
            className="flex min-h-[var(--cc-touch)] items-center gap-2 rounded-[var(--cc-radius)] px-2.5 text-sm font-medium text-muted transition-colors hover:bg-[var(--cc-fill-ghost-hover)] hover:text-text active:opacity-70"
          >
            <Cloud size={16} />
            {t('sync.configure')}
          </button>
        </Section>

        <Section title={t('snippets.title')} hint={t('snippets.hint')}>
          <div className="space-y-1.5">
            {snippets.map((s) => (
              <div key={s.id} className="flex items-center gap-2 rounded-[var(--cc-radius)] border border-hairline px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{s.title}</span>
                  <span className="block truncate text-[length:var(--cc-text-caption)] text-muted">{s.text}</span>
                </div>
                <button
                  aria-label={t('settings.editAria')}
                  className="grid size-9 place-items-center text-muted active:opacity-60"
                  onClick={() => setEditingSnippet(s)}
                >
                  <Pencil size={16} />
                </button>
                {!s.builtin && (
                  <button
                    aria-label={t('settings.deleteAria')}
                    className="grid size-9 place-items-center text-muted active:opacity-60"
                    onClick={() => void handleRemoveSnippet(s)}
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
            ))}
          </div>
          <button
            onClick={() => setAddingSnippet(true)}
            className="mt-1 flex min-h-[var(--cc-touch)] items-center gap-2 rounded-[var(--cc-radius)] px-2.5 text-sm font-medium text-muted transition-colors hover:bg-[var(--cc-fill-ghost-hover)] hover:text-text active:opacity-70"
          >
            <Plus size={16} />
            {t('snippets.add')}
          </button>
        </Section>

        <Section title={t('settings.data')} hint={t('settings.dataHint')}>
          <Button
            variant="secondary"
            className="inline-flex w-full items-center justify-center gap-2"
            onClick={() => void handleExport()}
          >
            <Download size={18} />
            {t('settings.downloadSnapshot')}
          </Button>
          <Button
            variant="secondary"
            className="mt-2 inline-flex w-full items-center justify-center gap-2"
            onClick={() => importRef.current?.click()}
          >
            <Upload size={18} />
            {t('settings.importSnapshot')}
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

        <Section title={t('shortcuts.title')}>
          <Button
            variant="secondary"
            className="inline-flex w-full items-center justify-center gap-2"
            onClick={() => setShortcutsOpen(true)}
          >
            <Keyboard size={18} />
            {t('shortcuts.title')}
          </Button>
        </Section>

        <p className="text-center font-mono text-[length:var(--cc-text-caption)] text-muted">
          {t('settings.buildLine', { build: BUILD_ID })}
        </p>
      </div>

      <ProviderSheet
        // key перемонтирует форму при каждом открытии — так поля берут
        // значения из пропсов без setState в эффекте.
        key={editing?.id ?? (adding ? 'provider-new' : 'provider-closed')}
        open={adding || editing !== null}
        provider={editing}
        onClose={() => {
          setAdding(false);
          setEditing(null);
        }}
        onSave={handleSaveProvider}
      />

      <SnippetSheet
        // key перемонтирует форму при каждом открытии — тот же паттерн, что у ProviderSheet.
        key={editingSnippet?.id ?? (addingSnippet ? 'snippet-new' : 'snippet-closed')}
        open={addingSnippet || editingSnippet !== null}
        snippet={editingSnippet}
        onClose={() => {
          setAddingSnippet(false);
          setEditingSnippet(null);
        }}
        onSave={handleSaveSnippet}
      />

      <SyncSheet
        // key перемонтирует форму при каждом открытии — тот же паттерн, что у ProviderSheet/SnippetSheet.
        key={syncOpen ? 'sync-open' : 'sync-closed'}
        open={syncOpen}
        cfg={syncCfg}
        onClose={() => setSyncOpen(false)}
      />

      <ShortcutsSheet open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-1 text-sm font-semibold">{title}</h2>
      {hint && <p className="mb-2.5 text-[length:var(--cc-text-meta)] leading-relaxed text-muted">{hint}</p>}
      {children}
    </section>
  );
}

// Default-экспорт — только ради React.lazy() в App.tsx (именованный импорт
// туда не годится); именованный export выше остаётся для прямых импортов.
export default SettingsPage;
