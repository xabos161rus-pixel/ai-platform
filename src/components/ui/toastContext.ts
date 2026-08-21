import { createContext, use } from 'react';

export type ToastKind = 'info' | 'success' | 'error';
/** Второй аргумент необязателен: старые вызовы toast('текст') работают как есть. */
export type Toast = (text: string, kind?: ToastKind) => void;

// Контекст и хук живут отдельно от компонента: файл, экспортирующий и
// компонент, и не-компонент, ломает Fast Refresh.
export const ToastContext = createContext<Toast>(() => {});

export function useToast(): Toast {
  return use(ToastContext);
}
