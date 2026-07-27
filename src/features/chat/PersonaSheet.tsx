import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Trash2 } from 'lucide-react';
import { Sheet } from '../../components/ui/Sheet';
import { Button } from '../../components/ui/Button';
import { useToast } from '../../components/ui/toastContext';
import type { Chat, Persona } from '../../db/types';
import { createPersona, listPersonas, removePersona } from '../../lib/ai/personaRepo';
import { patchChat } from '../../lib/ai/chatRepo';

interface Props {
  open: boolean;
  chat: Chat | null;
  onClose: () => void;
}

/**
 * Поля инициализируются прямо из пропсов — сброс между открытиями делает
 * `key` на стороне ChatPage (тот же паттерн, что и у ProviderSheet):
 * перемонтирование вместо синхронного setState в эффекте.
 */
export function PersonaSheet({ open, chat, onClose }: Props) {
  const toast = useToast();
  const [text, setText] = useState(chat?.systemPrompt ?? '');
  const [roleName, setRoleName] = useState<string | null>(chat?.personaName ?? null);
  const personas = useLiveQuery(() => listPersonas(), [], [] as Persona[]);

  if (!open || !chat) return null;

  async function handleDelete(p: Persona) {
    if (!window.confirm(`Удалить роль «${p.name}»?`)) return;
    await removePersona(p.id);
    // Если удаляемая роль была выбрана — text/roleName не трогаем: промпт уже
    // скопирован по значению в состояние формы, ссылка на роль ему не нужна.
  }

  async function handleSaveAsPersona() {
    const name = window.prompt('Название роли');
    if (!name?.trim()) return;
    await createPersona(name, text);
    toast('Роль сохранена');
    setRoleName(name.trim());
  }

  const handleSave = async () => {
    await patchChat(chat.id, {
      systemPrompt: text.trim(),
      personaName: text.trim() ? roleName : null,
    });
    toast('Промпт обновлён');
    onClose();
  };

  return (
    <Sheet open={open} onClose={onClose} title="Системный промпт">
      <div className="space-y-4">
        <p className="text-muted text-[var(--cc-text-meta)] leading-relaxed">
          Промпт задаёт модели роль и правила на весь чат. Выберите готовую роль или напишите свой — он уходит первым
          сообщением в каждый запрос.
        </p>

        {/* border-accent/50, не /40: на светлой теме элевейтед-фон белый, и более
            бледная граница у чипа сливалась с ним по краям скругления. */}
        {roleName && (
          <span className="border-accent/50 text-accent inline-flex items-center rounded-full border px-2.5 py-1 font-mono text-[var(--cc-text-caption)]">
            Роль: {roleName}
          </span>
        )}

        <textarea
          rows={5}
          value={text}
          placeholder="Например: отвечай кратко, по-русски, с примерами…"
          className="w-full resize-none rounded-[var(--cc-radius)] bg-surface-2 px-3.5 py-2.5 text-base outline-none transition-shadow placeholder:text-muted focus:shadow-[0_0_0_1px_var(--app-accent)]"
          onChange={(e) => {
            setText(e.target.value);
            // Ручная правка отвязывает имя роли: имя не должно врать про содержимое.
            setRoleName(null);
          }}
        />

        <div>
          <h3 className="mb-2 text-sm font-semibold">Роли</h3>
          <div className="space-y-1.5">
            {personas.map((p) => (
              <div
                key={p.id}
                className={`flex items-center gap-2 rounded-[var(--cc-radius)] border px-3 py-2 ${
                  p.name === roleName ? 'border-accent' : 'border-hairline'
                }`}
              >
                <button
                  className="min-w-0 flex-1 text-left active:opacity-60"
                  onClick={() => {
                    setText(p.prompt);
                    setRoleName(p.name);
                  }}
                >
                  <span className="block truncate text-sm font-medium">{p.name}</span>
                  <span className="block truncate text-[var(--cc-text-caption)] text-muted">{p.prompt}</span>
                </button>
                {p.builtin ? (
                  <span className="shrink-0 font-mono text-[var(--cc-text-caption)] text-muted">встроенная</span>
                ) : (
                  <button aria-label="Удалить роль" className="shrink-0 p-1 active:opacity-60" onClick={() => void handleDelete(p)}>
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        {text.trim() && (
          <Button variant="ghost" className="w-full" onClick={() => void handleSaveAsPersona()}>
            Сохранить как роль
          </Button>
        )}

        <div className="flex gap-2">
          <Button
            variant="secondary"
            disabled={!text.trim()}
            onClick={() => {
              setText('');
              setRoleName(null);
            }}
          >
            Очистить
          </Button>
          <Button className="flex-1" onClick={() => void handleSave()}>
            Сохранить
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
