import { memo } from 'react';
import { ChevronLeft, ChevronRight } from '../../components/ui/glyphs';
import type { Message } from '../../db/types';
import { siblingsOf, switchSibling } from '../../lib/ai/tree';
import { useT } from '../../lib/i18n';

interface Props {
  messages: Message[];
  /** Узел (представитель), для которого показываем переключатель версий. */
  node: Message;
  disabled: boolean;
  onSwitch: (leafId: string) => void;
}

/**
 * Переключатель версий узла дерева: «‹ 1/2 ›». Меньше двух версий — переключать
 * нечего, компонент не рендерится (а не рендерится пустым — не место занимать).
 *
 * memo: рендерится в каждом сообщении ленты — не должен пересчитываться на
 * стрим соседнего ответа или набор текста в композере, только на изменение
 * своих собственных пропов.
 */
export const VersionNav = memo(function VersionNav({ messages, node, disabled, onSwitch }: Props) {
  const t = useT();
  const { list, index } = siblingsOf(messages, node.id);
  if (list.length < 2 || index < 0) return null;

  function go(dir: -1 | 1) {
    const next = switchSibling(messages, node.id, dir);
    if (next) onSwitch(next);
  }

  return (
    <div className="flex items-center gap-0.5">
      <button
        aria-label={t('branch.prevVersion')}
        disabled={disabled || index <= 0}
        onClick={() => go(-1)}
        className="flex h-[var(--cc-touch)] items-center px-0.5 disabled:opacity-25 active:opacity-60"
      >
        <ChevronLeft size={13} />
      </button>
      <span>
        {index + 1}/{list.length}
      </span>
      <button
        aria-label={t('branch.nextVersion')}
        disabled={disabled || index >= list.length - 1}
        onClick={() => go(1)}
        className="flex h-[var(--cc-touch)] items-center px-0.5 disabled:opacity-25 active:opacity-60"
      >
        <ChevronRight size={13} />
      </button>
    </div>
  );
});
