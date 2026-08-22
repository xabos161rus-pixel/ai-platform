import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Trash2 } from '../../components/ui/glyphs';
import { Sheet } from '../../components/ui/Sheet';
import { Button } from '../../components/ui/Button';
import { useToast } from '../../components/ui/toastContext';
import type { Chat, Persona } from '../../db/types';
import { createPersona, listPersonas, removePersona } from '../../lib/ai/personaRepo';
import { patchChat } from '../../lib/ai/chatRepo';
import { useT } from '../../lib/i18n';
import { isClaudeModel, isReasoningModel } from '../../lib/ai/models';

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
  const t = useT();
  const toast = useToast();
  const [text, setText] = useState(chat?.systemPrompt ?? '');
  const [roleName, setRoleName] = useState<string | null>(chat?.personaName ?? null);
  const [temperature, setTemperature] = useState<number | null>(chat?.temperature ?? null);
  const [maxTokens, setMaxTokens] = useState<number | null>(chat?.maxTokens ?? null);
  const [effort, setEffort] = useState<'low' | 'medium' | 'high' | null>(chat?.reasoningEffort ?? null);
  const personas = useLiveQuery(() => listPersonas(), [], [] as Persona[]);

  if (!open || !chat) return null;

  async function handleDelete(p: Persona) {
    if (!window.confirm(t('persona.deleteRoleConfirm', { name: p.name }))) return;
    await removePersona(p.id);
    // Если удаляемая роль была выбрана — text/roleName не трогаем: промпт уже
    // скопирован по значению в состояние формы, ссылка на роль ему не нужна.
  }

  async function handleSaveAsPersona() {
    const name = window.prompt(t('persona.namePrompt'));
    if (!name?.trim()) return;
    await createPersona(name, text);
    toast(t('persona.roleSaved'));
    setRoleName(name.trim());
  }

  const handleSave = async () => {
    await patchChat(chat.id, {
      systemPrompt: text.trim(),
      personaName: text.trim() ? roleName : null,
      // null пишем явно (не пропускаем поле) — «не задано» отличимо от «не менялось»,
      // и запрос корректно перестаёт слать параметр после сброса.
      temperature,
      maxTokens,
      reasoningEffort: effort,
    });
    toast(t('persona.promptUpdated'));
    onClose();
  };

  return (
    <Sheet open={open} onClose={onClose} title={t('persona.title')}>
      <div className="space-y-4">
        <p className="text-muted text-[length:var(--cc-text-meta)] leading-relaxed">{t('persona.description')}</p>

        {/* border-accent/50, не /40: на светлой теме элевейтед-фон белый, и более
            бледная граница у чипа сливалась с ним по краям скругления. */}
        {roleName && (
          <span className="border-accent/50 text-accent inline-flex items-center rounded-full border px-2.5 py-1 font-mono text-[length:var(--cc-text-caption)]">
            {t('persona.roleChip', { name: roleName })}
          </span>
        )}

        <textarea
          rows={5}
          value={text}
          placeholder={t('persona.placeholder')}
          className="w-full resize-none rounded-[var(--cc-radius)] bg-surface-2 px-3.5 py-2.5 text-base outline-none transition-shadow placeholder:text-muted focus:shadow-[0_0_0_1px_var(--app-accent)]"
          onChange={(e) => {
            setText(e.target.value);
            // Ручная правка отвязывает имя роли: имя не должно врать про содержимое.
            setRoleName(null);
          }}
        />

        <div>
          <h3 className="mb-2 text-sm font-semibold">{t('persona.rolesHeading')}</h3>
          <div className="space-y-1.5">
            {personas.map((p) => (
              <div
                key={p.id}
                className={`flex items-center gap-2 rounded-[var(--cc-radius)] border px-3 py-2 ${
                  p.name === roleName ? 'border-accent' : 'border-hairline'
                }`}
              >
                <button
                  className="cc-hit min-w-0 flex-1 rounded-[var(--cc-radius)] text-left"
                  onClick={() => {
                    setText(p.prompt);
                    setRoleName(p.name);
                  }}
                >
                  <span className="block truncate text-sm font-medium">{p.name}</span>
                  <span className="block truncate text-[length:var(--cc-text-caption)] text-muted">{p.prompt}</span>
                </button>
                {p.builtin ? (
                  <span className="shrink-0 font-mono text-[length:var(--cc-text-caption)] text-muted">{t('persona.builtin')}</span>
                ) : (
                  <button aria-label={t('persona.deleteRoleAria')} className="cc-hit shrink-0 rounded-[var(--cc-radius-sm)] p-1" onClick={() => void handleDelete(p)}>
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-3 border-t border-hairline pt-4">
          <h3 className="text-sm font-semibold">{t('params.title')}</h3>

          <div>
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{t('params.temperature')}</span>
              <div className="flex items-center gap-2">
                <span className={`font-mono text-[length:var(--cc-text-caption)] ${temperature === null ? 'text-muted' : ''}`}>
                  {temperature === null ? t('params.default') : temperature.toFixed(1)}
                </span>
                <button
                  className="cc-hit rounded-[var(--cc-radius-sm)] p-1 text-muted transition-colors hover:text-text disabled:opacity-25"
                  disabled={temperature === null}
                  onClick={() => setTemperature(null)}
                >
                  {t('params.reset')}
                </button>
              </div>
            </div>
            <input
              type="range"
              min={0}
              max={2}
              step={0.1}
              value={temperature ?? 1}
              onChange={(e) => setTemperature(Number(e.target.value))}
              className={`w-full accent-[var(--app-accent)] ${temperature === null ? 'opacity-40' : ''}`}
            />
          </div>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">{t('params.maxTokens')}</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={maxTokens ?? ''}
              placeholder="—"
              onChange={(e) => {
                const raw = e.target.value.trim();
                if (raw === '') {
                  setMaxTokens(null);
                  return;
                }
                const n = Number(raw);
                if (Number.isFinite(n)) setMaxTokens(Math.max(1, Math.floor(n)));
              }}
              className="w-full rounded-[var(--cc-radius)] bg-surface-2 px-3.5 py-2.5 text-base outline-none placeholder:text-muted focus:shadow-[0_0_0_1px_var(--app-accent)]"
            />
            <span className="mt-1 block text-[length:var(--cc-text-caption)] leading-relaxed text-muted">
              {t('params.maxTokensHint')}
            </span>
          </label>

          {/* Глубина рассуждения. «Не задано» — отдельное значение, а не ноль:
              модели без поддержки на неизвестное поле в теле отвечают 400,
              поэтому по умолчанию параметр не уходит вовсе. */}
          <div>
            <span className="mb-1 block text-sm font-medium">{t('params.effort')}</span>
            <div className="flex gap-1 rounded-[var(--cc-radius)] bg-surface-2 p-1">
              {([null, 'low', 'medium', 'high'] as const).map((v) => (
                <button
                  key={v ?? 'off'}
                  onClick={() => setEffort(v)}
                  className={`flex-1 rounded-[var(--cc-radius-sm)] px-2 py-2 text-[length:var(--cc-text-meta)] transition-colors duration-[var(--cc-dur-fast)] ${
                    effort === v
                      ? 'bg-accent font-medium text-[var(--cc-on-accent)]'
                      : 'cc-hit text-muted'
                  }`}
                >
                  {t(
                    v === null
                      ? 'params.effortOff'
                      : v === 'low'
                        ? 'params.effortLow'
                        : v === 'medium'
                          ? 'params.effortMedium'
                          : 'params.effortHigh',
                  )}
                </button>
              ))}
            </div>
            <span className="mt-1 block text-[length:var(--cc-text-caption)] leading-relaxed text-muted">
              {isClaudeModel(chat.model)
                ? t('params.effortHintClaude')
                : isReasoningModel(chat.model)
                  ? t('params.effortHint')
                  : t('params.effortHintPlain')}
            </span>
          </div>
        </div>

        {text.trim() && (
          <Button variant="ghost" className="w-full" onClick={() => void handleSaveAsPersona()}>
            {t('persona.saveAsRole')}
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
            {t('persona.clear')}
          </Button>
          <Button className="flex-1" onClick={() => void handleSave()}>
            {t('common.save')}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
