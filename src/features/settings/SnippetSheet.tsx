import { useState } from 'react';
import { Sheet } from '../../components/ui/Sheet';
import { Button } from '../../components/ui/Button';
import type { Snippet } from '../../db/types';
import { useT } from '../../lib/i18n';

interface Props {
  open: boolean;
  snippet: Snippet | null; // null — добавление нового
  onClose: () => void;
  onSave: (s: Pick<Snippet, 'title' | 'text'>, id?: string) => void | Promise<void>;
}

/**
 * Поля инициализируются прямо из пропсов — сброс между открытиями делает
 * `key` на стороне вызывающего (SettingsPage), тот же паттерн, что у
 * ProviderSheet/PersonaSheet: перемонтирование вместо setState в эффекте.
 */
export function SnippetSheet({ open, snippet, onClose, onSave }: Props) {
  const t = useT();
  const [title, setTitle] = useState(snippet?.title ?? '');
  const [text, setText] = useState(snippet?.text ?? '');

  const valid = title.trim() && text.trim();

  function handleSave() {
    if (!valid) return;
    void onSave({ title: title.trim(), text: text.trim() }, snippet?.id);
  }

  return (
    <Sheet open={open} onClose={onClose} title={snippet ? t('snippets.edit') : t('snippets.new')}>
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-sm font-medium">{t('snippet.titleLabel')}</span>
          <input
            type="text"
            value={title}
            placeholder={t('snippet.titlePlaceholder')}
            onChange={(e) => setTitle(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-[var(--cc-radius)] bg-surface-2 px-3 py-2.5 text-base outline-none placeholder:text-muted"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">{t('snippet.textLabel')}</span>
          <textarea
            // Callback-ref: авторост высоты при появлении в DOM — инициализация
            // только что смонтированного узла, а не запись в существующий ref
            // во время рендера.
            ref={(el) => {
              if (!el) return;
              el.style.height = 'auto';
              el.style.height = `${Math.min(el.scrollHeight, 8 * 24)}px`;
            }}
            value={text}
            rows={4}
            placeholder={t('snippet.textPlaceholder')}
            className="max-h-48 min-h-[var(--cc-touch)] w-full resize-none rounded-[var(--cc-radius)] bg-surface-2 px-3.5 py-2.5 text-base outline-none transition-shadow placeholder:text-muted focus:shadow-[0_0_0_1px_var(--app-accent)]"
            onChange={(e) => {
              setText(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, 8 * 24)}px`;
            }}
          />
        </label>
        <Button className="w-full" disabled={!valid} onClick={handleSave}>
          {t('common.save')}
        </Button>
      </div>
    </Sheet>
  );
}
