import { useState } from 'react';
import { X } from '../../components/ui/glyphs';
import { Sheet } from '../../components/ui/Sheet';
import { Button } from '../../components/ui/Button';
import type { BaseEntity, Provider } from '../../db/types';
import { modelEntries } from '../../lib/ai/models';
import { useT } from '../../lib/i18n';

interface Props {
  open: boolean;
  provider: Provider | null; // null — добавление нового
  onClose: () => void;
  onSave: (p: Omit<Provider, keyof BaseEntity>, id?: string) => void | Promise<void>;
}

/** Готовые адреса известных агрегаторов — чтобы не искать их в документации. */
const PRESETS = [
  { name: 'Polza.ai', baseUrl: 'https://api.polza.ai/api/v1' },
  { name: 'VseGPT', baseUrl: 'https://api.vsegpt.ru/v1' },
  { name: 'BotHub', baseUrl: 'https://bothub.chat/api/v2/openai/v1' },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
];

/** Строка редактора моделей — поля ввода как строки, приводятся к числу только при сохранении. */
interface ModelRow {
  id: string;
  priceIn: string;
  priceOut: string;
}

/** ',' — обычный десятичный разделитель на русской раскладке; NaN/0/отрицательные цены не хотим. */
function parsePrice(raw: string): number | undefined {
  const n = Number(raw.trim().replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Поля инициализируются прямо из пропсов, а сброс между открытиями делает
 * `key` на стороне вызывающего: перемонтирование вместо синхронного setState
 * в эффекте, который даёт каскадные рендеры.
 */
export function ProviderSheet({ open, provider, onClose, onSave }: Props) {
  const t = useT();
  const [name, setName] = useState(provider?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState(provider?.apiKey ?? '');
  const [rows, setRows] = useState<ModelRow[]>(() => {
    const entries = modelEntries(provider?.models ?? []).map((m) => ({
      id: m.id,
      priceIn: m.priceIn !== undefined ? String(m.priceIn) : '',
      priceOut: m.priceOut !== undefined ? String(m.priceOut) : '',
    }));
    return entries.length ? entries : [{ id: '', priceIn: '', priceOut: '' }];
  });

  const valid = name.trim() && baseUrl.trim() && rows.some((r) => r.id.trim());

  function updateRow(i: number, patch: Partial<ModelRow>) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  function removeRow(i: number) {
    setRows((rs) => (rs.length > 1 ? rs.filter((_, idx) => idx !== i) : rs));
  }

  function handleSave() {
    if (!valid) return;
    // Дубли id — оставляем первый: последующие с тем же id молча отбрасываются.
    const seen = new Set<string>();
    const models = rows
      .map((r) => ({ id: r.id.trim(), priceIn: parsePrice(r.priceIn), priceOut: parsePrice(r.priceOut) }))
      .filter((m) => {
        if (!m.id || seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });
    void onSave(
      {
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        models,
        isDemo: false,
      },
      provider?.id,
    );
  }

  return (
    <Sheet open={open} onClose={onClose} title={provider ? t('provider.titleEdit') : t('provider.titleNew')}>
      <div className="space-y-3">
        {!provider && (
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.name}
                className="rounded-full bg-surface-2 px-3 py-1.5 text-sm active:opacity-70"
                onClick={() => {
                  setName(p.name);
                  setBaseUrl(p.baseUrl);
                }}
              >
                {p.name}
              </button>
            ))}
          </div>
        )}
        <Field label={t('provider.name')} value={name} onChange={setName} placeholder="Polza.ai" />
        <Field
          label={t('provider.address')}
          value={baseUrl}
          onChange={setBaseUrl}
          placeholder="https://api.polza.ai/api/v1"
          hint={t('provider.addressHint')}
        />
        <Field
          label={t('provider.key')}
          value={apiKey}
          onChange={setApiKey}
          placeholder="sk-..."
          type="password"
          hint={t('provider.keyHint')}
        />

        <div>
          <span className="mb-1 block text-sm font-medium">{t('provider.models')}</span>
          <p className="mb-2 text-[length:var(--cc-text-caption)] leading-relaxed text-muted">{t('provider.modelsHead')}</p>
          <div className="space-y-1.5">
            {rows.map((row, i) => (
              <div key={i} className="grid grid-cols-[1fr_4.5rem_4.5rem_2rem] items-center gap-1.5">
                <input
                  value={row.id}
                  placeholder="gpt-5.6"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  onChange={(e) => updateRow(i, { id: e.target.value })}
                  className="w-full min-w-0 rounded-[var(--cc-radius)] bg-surface-2 px-2.5 py-2.5 font-mono text-[length:var(--cc-text-body)] outline-none placeholder:text-muted"
                />
                <input
                  value={row.priceIn}
                  placeholder={t('provider.priceInPlaceholder')}
                  inputMode="decimal"
                  onChange={(e) => updateRow(i, { priceIn: e.target.value })}
                  className="w-full min-w-0 rounded-[var(--cc-radius)] bg-surface-2 px-2 py-2.5 text-[length:var(--cc-text-body)] outline-none placeholder:text-muted"
                />
                <input
                  value={row.priceOut}
                  placeholder={t('provider.priceOutPlaceholder')}
                  inputMode="decimal"
                  onChange={(e) => updateRow(i, { priceOut: e.target.value })}
                  className="w-full min-w-0 rounded-[var(--cc-radius)] bg-surface-2 px-2 py-2.5 text-[length:var(--cc-text-body)] outline-none placeholder:text-muted"
                />
                <button
                  aria-label={t('provider.removeModelAria')}
                  disabled={rows.length === 1}
                  onClick={() => removeRow(i)}
                  className="grid size-8 place-items-center text-muted active:opacity-60 disabled:opacity-25"
                >
                  <X size={15} />
                </button>
              </div>
            ))}
          </div>
          <button
            className="mt-2 text-sm text-accent active:opacity-60"
            onClick={() => setRows((rs) => [...rs, { id: '', priceIn: '', priceOut: '' }])}
          >
            + {t('provider.addModel')}
          </button>
        </div>

        <Button className="w-full" disabled={!valid} onClick={handleSave}>
          {t('common.save')}
        </Button>
      </div>
    </Sheet>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
  type?: string;
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
        className="w-full rounded-[var(--cc-radius)] bg-surface-2 px-3 py-2.5 outline-none placeholder:text-muted"
      />
      {hint && <span className="mt-1 block text-[length:var(--cc-text-caption)] leading-relaxed text-muted">{hint}</span>}
    </label>
  );
}
