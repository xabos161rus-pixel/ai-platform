import { createContext, use } from 'react';

export type Toast = (text: string) => void;

// Контекст и хук живут отдельно от компонента: файл, экспортирующий и
// компонент, и не-компонент, ломает Fast Refresh.
export const ToastContext = createContext<Toast>(() => {});

export function useToast(): Toast {
  return use(ToastContext);
}
