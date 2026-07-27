import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const styles: Record<Variant, string> = {
  // Один сплошной клай, без градиента: узнаваемость этого языка держится на
  // одном цвете и воздухе, а не на переливах.
  primary: 'bg-accent text-white active:opacity-90',
  secondary: 'bg-surface-2 text-text active:opacity-80',
  ghost: 'bg-transparent text-accent active:opacity-60',
  danger: 'bg-danger/15 text-danger active:opacity-80',
};

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

export function Button({ variant = 'primary', className = '', ...props }: Props) {
  return (
    <button
      className={`min-h-[var(--cc-touch)] rounded-[var(--cc-radius)] px-4 py-2.5 font-medium transition-[transform,opacity] duration-150 active:scale-[0.98] disabled:opacity-40 disabled:active:scale-100 ${styles[variant]} ${className}`}
      {...props}
    />
  );
}
