import { useState } from 'react';
import { Sheet } from '../../components/ui/Sheet';
import { Button } from '../../components/ui/Button';
import type { BaseEntity, Provider } from '../../db/types';

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

/**
 * Поля инициализируются прямо из пропсов, а сброс между открытиями делает
 * `key` на стороне вызывающего: перемонтирование вместо синхронного setState
 * в эффекте, который даёт каскадные рендеры.
 */
export function ProviderSheet({ open, provider, onClose, onSave }: Props) {
  const [name, setName] = useState(provider?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState(provider?.apiKey ?? '');
  const [models, setModels] = useState((provider?.models ?? []).join(', '));

  const valid = name.trim() && baseUrl.trim() && models.trim();

  function handleSave() {
    if (!valid) return;
    void onSave(
      {
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        models: models
          .split(',')
          .map((m) => m.trim())
          .filter(Boolean),
        isDemo: false,
      },
      provider?.id,
    );
  }

  return (
    <Sheet open={open} onClose={onClose} title={provider ? 'Провайдер' : 'Новый провайдер'}>
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
        <Field label="Название" value={name} onChange={setName} placeholder="Polza.ai" />
        <Field
          label="Адрес API"
          value={baseUrl}
          onChange={setBaseUrl}
          placeholder="https://api.polza.ai/api/v1"
          hint="OpenAI-совместимый эндпоинт. Путь /chat/completions добавляется сам."
        />
        <Field
          label="Ключ"
          value={apiKey}
          onChange={setApiKey}
          placeholder="sk-..."
          type="password"
          hint="Хранится только на этом устройстве, уходит напрямую провайдеру."
        />
        <Field
          label="Модели"
          value={models}
          onChange={setModels}
          placeholder="claude-sonnet-5, gpt-5.6"
          hint="Через запятую. Первая станет моделью по умолчанию."
        />
        <Button className="w-full" disabled={!valid} onClick={handleSave}>
          Сохранить
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
      {hint && <span className="mt-1 block text-[var(--cc-text-caption)] leading-relaxed text-muted">{hint}</span>}
    </label>
  );
}
