import { MessageSquarePlus, Pin, PinOff, Trash2 } from 'lucide-react';
import { Sheet } from '../../components/ui/Sheet';
import { Button } from '../../components/ui/Button';
import type { Chat } from '../../db/types';
import { patchChat, removeChat } from '../../lib/ai/chatRepo';

interface Props {
  open: boolean;
  chats: Chat[];
  activeId: string | null;
  onClose: () => void;
  onPick: (id: string) => void;
  onNew: () => void;
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function ChatListSheet({ open, chats, activeId, onClose, onPick, onNew }: Props) {
  async function handleRemove(chat: Chat) {
    if (!window.confirm(`Удалить чат «${chat.title}» со всей перепиской?`)) return;
    await removeChat(chat.id);
  }

  return (
    <Sheet open={open} onClose={onClose} title="Чаты">
      <div className="space-y-1.5">
        <Button className="mb-2 inline-flex w-full items-center justify-center gap-2" onClick={onNew}>
          <MessageSquarePlus size={18} />
          Новый чат
        </Button>
        {chats.map((c) => (
          <div
            key={c.id}
            className={`flex items-center gap-1 rounded-[var(--cc-radius)] px-2 py-1.5 ${
              c.id === activeId ? 'bg-surface-2' : ''
            }`}
          >
            <button className="min-w-0 flex-1 py-1 text-left active:opacity-60" onClick={() => onPick(c.id)}>
              <span className="block truncate font-medium">{c.title}</span>
              <span className="block font-mono text-[var(--cc-text-caption)] text-muted">
                {formatWhen(c.lastMessageAt ?? c.createdAt)}
              </span>
            </button>
            <button
              aria-label={c.pinned ? 'Открепить' : 'Закрепить'}
              className="grid size-9 place-items-center text-muted active:opacity-60"
              onClick={() => void patchChat(c.id, { pinned: !c.pinned })}
            >
              {c.pinned ? <PinOff size={16} /> : <Pin size={16} />}
            </button>
            <button
              aria-label="Удалить чат"
              className="grid size-9 place-items-center text-muted active:opacity-60"
              onClick={() => void handleRemove(c)}
            >
              <Trash2 size={16} />
            </button>
          </div>
        ))}
      </div>
    </Sheet>
  );
}
