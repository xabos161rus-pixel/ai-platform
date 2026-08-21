import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const styles: Record<Variant, string> = {
  // Один сплошной клай, без градиента: узнаваемость этого языка держится на
  // одном цвете и воздухе, а не на переливах. Текст — через токен: в тёмной
  // теме акцент светлый, и белым по нему контраст всего ~2.4:1.
  primary:
    'bg-accent text-[var(--cc-on-accent)] shadow-[inset_0_1px_0_oklch(1_0_0/0.14)] hover:bg-[var(--cc-accent-hover)]',
  secondary: 'bg-surface-2 text-text shadow-[var(--cc-elev-rest)] hover:bg-elevated',
  ghost: 'bg-transparent text-accent hover:bg-[var(--cc-fill-hover)]',
  danger: 'bg-danger/15 text-danger hover:bg-danger/25',
};

const sizes: Record<Size, string> = {
  sm: 'min-h-8 rounded-[var(--cc-radius-sm)] px-3 text-[length:var(--cc-text-meta)]',
  md: 'min-h-10 rounded-[var(--cc-radius)] px-4',
  // lg держит полный тач-таргет: это кнопки подтверждения в формах.
  lg: 'min-h-[var(--cc-touch)] rounded-[var(--cc-radius)] px-4 py-2.5',
};

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Показывает спиннер и блокирует повторное нажатие. */
  loading?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'lg',
  loading = false,
  className = '',
  children,
  disabled,
  ...props
}: Props) {
  return (
    <button
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex items-center justify-center gap-2 font-medium transition-[background-color,color,transform] duration-[var(--cc-dur-fast)] ease-[var(--cc-ease-out)] active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-[var(--cc-fill-disabled)] disabled:text-muted disabled:shadow-none disabled:active:scale-100 ${sizes[size]} ${styles[variant]} ${className}`}
      {...props}
    >
      {loading && (
        <span
          aria-hidden="true"
          className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent opacity-70"
        />
      )}
      {children}
    </button>
  );
}
