import { X } from '../../components/ui/glyphs';
import type { Provider } from '../../db/types';
import { modelIds, modelLabel } from '../../lib/ai/models';
import { useT } from '../../lib/i18n';

interface Props {
  providers: Provider[];
  /** Выбранные модели в виде `providerId:model`. */
  picks: string[];
  /** Какой режим обслуживают чипы — только подпись панели. */
  mode: 'columns' | 'council';
  onChange: (picks: string[]) => void;
}

/**
 * Панель выбора моделей активного режима (сравнение или консилиум). Появляется
 * над капсулой, только когда режим включён иконкой в композере; сама панель
 * режим не переключает — она про состав участников.
 */
export function CompareBar({ providers, picks, mode, onChange }: Props) {
  const t = useT();
  const all = providers.flatMap((p) => modelIds(p.models).map((m) => ({ key: `${p.id}:${m}`, provider: p, model: m })));
  if (!picks.length) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[length:var(--cc-text-caption)] font-medium text-muted">
        {mode === 'council' ? t('council.barPrefix') : t('compare.prefix')}
      </span>
      {all.map((x) => {
        const on = picks.includes(x.key);
        return (
          <button
            key={x.key}
            data-testid={`compare-chip:${x.key}`}
            onClick={() => onChange(on ? picks.filter((k) => k !== x.key) : [...picks, x.key])}
            className={`rounded-full border px-2.5 py-1 font-mono text-[length:var(--cc-text-caption)] transition-colors ${
              on ? 'border-accent text-accent' : 'border-hairline text-muted hover:text-text'
            }`}
          >
            {modelLabel(x.model)}
          </button>
        );
      })}
      <button
        aria-label={t('compare.offAria')}
        onClick={() => onChange([])}
        className="grid size-6 place-items-center rounded-full text-muted transition-colors hover:text-text"
      >
        <X size={13} />
      </button>
      {picks.length === 1 && (
        <span className="font-mono text-[length:var(--cc-text-caption)] text-warning">{t('compare.needTwo')}</span>
      )}
    </div>
  );
}
