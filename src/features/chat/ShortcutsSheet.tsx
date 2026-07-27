import { Sheet } from '../../components/ui/Sheet';
import { useT, type TKey } from '../../lib/i18n';

interface Props {
  open: boolean;
  onClose: () => void;
}

/** Строка справки: клавиши (kbd-элементы) + подпись из словаря. */
const ROWS: { keys: string[]; labelKey: TKey }[] = [
  { keys: ['⌘', 'K'], labelKey: 'shortcuts.palette' },
  { keys: ['⌘', 'N'], labelKey: 'shortcuts.newChat' },
  { keys: ['⌘', '/'], labelKey: 'shortcuts.focusInput' },
  { keys: ['⌘', 'B'], labelKey: 'shortcuts.toggleSidebar' },
  { keys: ['Esc'], labelKey: 'shortcuts.stopOrClose' },
  { keys: ['↑'], labelKey: 'shortcuts.editLast' },
  { keys: ['Enter', '⇧Enter'], labelKey: 'shortcuts.sendOrNewline' },
  { keys: ['/'], labelKey: 'shortcuts.snippets' },
  { keys: ['‹', '›'], labelKey: 'shortcuts.versions' },
];

/** Лист-справка по клавиатурным шорткатам: открывается из настроек и из палитры (T8). */
export function ShortcutsSheet({ open, onClose }: Props) {
  const t = useT();
  return (
    <Sheet open={open} onClose={onClose} title={t('shortcuts.title')}>
      <div className="cc-scroll max-h-[60vh] space-y-0.5 overflow-y-auto">
        {ROWS.map((row) => (
          <div key={row.labelKey} className="flex items-center justify-between gap-3 py-2">
            <span className="text-sm text-muted">{t(row.labelKey)}</span>
            <span className="flex shrink-0 items-center gap-1">
              {row.keys.map((k, i) => (
                <span key={i} className="flex items-center gap-1">
                  {i > 0 && <span className="text-muted">/</span>}
                  <kbd className="rounded-[var(--cc-radius-sm)] bg-surface-2 px-1.5 py-0.5 font-mono text-[var(--cc-text-caption)]">
                    {k}
                  </kbd>
                </span>
              ))}
            </span>
          </div>
        ))}
      </div>
    </Sheet>
  );
}
