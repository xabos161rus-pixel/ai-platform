import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ArrowUp, Paperclip, Square, X } from 'lucide-react';
import { useToast } from '../../components/ui/toastContext';
import { compressImage, MAX_IMAGES } from '../../lib/images';
import { useT } from '../../lib/i18n';
import { SnippetMenu, type SnippetMenuHandle } from './SnippetMenu';

export interface ComposerHandle {
  insertText(text: string): void;
  focus(): void;
}

interface Props {
  busy: boolean;
  canSend: boolean;
  onSend: (text: string, images: string[]) => void | Promise<void>;
  onStop: () => void;
  /** ↑ в пустом поле вне сниппет-меню — открыть правку последнего своего сообщения. */
  onEditLast?: () => void;
}

function autosize(el: HTMLTextAreaElement) {
  // Сбрасываем высоту перед замером, иначе не сжимается при удалении текста.
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 176)}px`;
}

/**
 * Нижний блок чата — вынесен из ChatPage в отдельный компонент. Черновик и
 * прикреплённые картинки — состояние ВНУТРИ композера: ввод символа больше
 * не перерисовывает ленту сообщений выше (оптимизация (в) пакета). Наружу —
 * только события отправки/остановки и императивный handle для приветственных
 * чипов и правки по стрелке вверх.
 */
export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  { busy, canSend, onSend, onStop, onEditLast },
  ref,
) {
  const toast = useToast();
  const t = useT();
  const [draft, setDraft] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<SnippetMenuHandle>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // iOS-клавиатура: visualViewport ужимается высотой при появлении клавиатуры,
  // но layout viewport — нет, поэтому композер (позиционированный обычным
  // потоком у низа fixed-каркаса) остаётся под клавиатурой без этого сдвига.
  // Пишем transform напрямую в DOM, а не через setState — событие resize/scroll
  // visualViewport сыплется на каждый кадр появления клавиатуры, и вызывать
  // ререндер React на каждый из них было бы дорого и рвано (не 60fps).
  useEffect(() => {
    const vv = window.visualViewport;
    const wrapper = wrapperRef.current;
    if (!vv || !wrapper) return;
    const onViewportChange = () => {
      const offset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      wrapper.style.transform = offset ? `translateY(-${offset}px)` : '';
    };
    vv.addEventListener('resize', onViewportChange);
    vv.addEventListener('scroll', onViewportChange);
    onViewportChange();
    return () => {
      vv.removeEventListener('resize', onViewportChange);
      vv.removeEventListener('scroll', onViewportChange);
      wrapper.style.transform = '';
    };
  }, []);

  function setDraftAndResize(text: string) {
    setDraft(text);
    // Каретка и высота меняются уже после того, как DOM подхватит новое
    // value — сразу после state-обновления, вне рендера.
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      autosize(el);
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }

  useImperativeHandle(
    ref,
    () => ({
      insertText(text: string) {
        setMenuOpen(false);
        setDraftAndResize(text);
      },
      focus() {
        inputRef.current?.focus();
      },
    }),
    [],
  );

  // Сжимаем и добавляем картинки по одной: одна битая не должна ронять
  // остальные, а лимит режем ДО чтения — чтобы не тратить время на файлы,
  // которые всё равно не влезут.
  async function addFiles(list: ArrayLike<File | null> | FileList | null) {
    const files = Array.from(list ?? []).filter((f): f is File => !!f && f.type.startsWith('image/'));
    const room = MAX_IMAGES - images.length;
    if (files.length > room) toast(t('composer.tooManyImages'));
    for (const f of files.slice(0, room)) {
      try {
        const url = await compressImage(f);
        setImages((prev) => (prev.length >= MAX_IMAGES ? prev : [...prev, url]));
      } catch {
        toast(t('composer.readImageFailed'));
      }
    }
  }

  async function handleSend() {
    const text = draft.trim();
    if ((!text && !images.length) || busy || !canSend) return;
    // Очистка ДО await — как раньше в ChatPage.handleSend: черновик не должен
    // «висеть» в поле, пока идёт запрос.
    setDraft('');
    setMenuOpen(false);
    if (inputRef.current) inputRef.current.style.height = 'auto';
    const imgs = images;
    setImages([]);
    await onSend(text, imgs);
    inputRef.current?.focus();
  }

  /** Открытие/закрытие «/»-меню сниппетов по правилам из ТЗ. */
  function handleChange(value: string) {
    const prev = draft;
    if (menuOpen) {
      if (value === '' || value.includes(' ') || !value.startsWith('/')) setMenuOpen(false);
    } else if (prev === '' && value === '/') {
      setMenuOpen(true);
    }
    setDraft(value);
  }

  const query = menuOpen ? draft.slice(1) : '';

  return (
    <div ref={wrapperRef} className="shrink-0 bg-bg">
      {images.length > 0 && (
        <div className="mx-auto flex w-full max-w-3xl gap-2 px-4 pt-2">
          {images.map((src, i) => (
            <div key={i} className="relative shrink-0">
              <img src={src} alt={t('chat.attachmentAlt')} className="size-14 rounded-[var(--cc-radius-sm)] border border-hairline object-cover" />
              <button
                aria-label={t('composer.removeImageAria')}
                className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full border border-hairline bg-surface-2 text-muted active:opacity-60"
                onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="relative mx-auto flex w-full max-w-3xl items-end gap-2 px-4 pt-2 pb-[calc(env(safe-area-inset-bottom)+10px)]">
        {menuOpen && (
          <SnippetMenu
            ref={menuRef}
            query={query}
            onPick={(text) => {
              setMenuOpen(false);
              setDraftAndResize(text);
            }}
          />
        )}
        <button
          aria-label={t('chat.attachImage')}
          disabled={busy || images.length >= MAX_IMAGES}
          onClick={() => fileRef.current?.click()}
          className="grid size-[var(--cc-touch)] shrink-0 place-items-center rounded-[var(--cc-radius)] text-muted transition-colors hover:text-text active:opacity-60 disabled:opacity-25"
        >
          <Paperclip size={19} />
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            void addFiles(e.target.files);
            // Сброс value — иначе повторный выбор того же файла не даёт события change.
            e.target.value = '';
          }}
        />
        <textarea
          ref={inputRef}
          value={draft}
          rows={1}
          placeholder={t('chat.placeholder')}
          className="max-h-44 min-h-[var(--cc-touch)] flex-1 resize-none rounded-[var(--cc-radius)] bg-surface-2 px-3.5 py-2.5 outline-none transition-shadow placeholder:text-muted focus:shadow-[0_0_0_1px_var(--app-accent)]"
          onChange={(e) => {
            handleChange(e.target.value);
            autosize(e.target);
          }}
          onKeyDown={(e) => {
            if (menuOpen) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                menuRef.current?.moveDown();
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                menuRef.current?.moveUp();
                return;
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                // Enter НЕ отправляет, пока меню открыто — сначала вставляет сниппет.
                e.preventDefault();
                menuRef.current?.confirmSelected();
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setMenuOpen(false);
                return;
              }
            }
            // Enter отправляет только с физической клавиатурой: на телефоне
            // это перевод строки, иначе многострочное не написать.
            if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(pointer: fine)').matches) {
              e.preventDefault();
              void handleSend();
            } else if (e.key === 'ArrowUp' && draft === '' && !busy) {
              // Пустое поле, ничего не набрано — стрелка вверх правит
              // последний свой вопрос вместо перемещения каретки в пустоте.
              e.preventDefault();
              onEditLast?.();
            }
          }}
          onPaste={(e) => {
            // Картинки из буфера — как выбор файлов; текстовые вставки не трогаем.
            const files = Array.from(e.clipboardData.items)
              .filter((i) => i.type.startsWith('image/'))
              .map((i) => i.getAsFile());
            if (files.length) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
        />
        {busy ? (
          <button
            aria-label={t('chat.stop')}
            className="grid size-[var(--cc-touch)] shrink-0 place-items-center rounded-full bg-surface-2 transition-opacity active:opacity-70"
            onClick={onStop}
          >
            <Square size={15} />
          </button>
        ) : (
          <button
            aria-label={t('chat.send')}
            disabled={!draft.trim() && !images.length}
            className="grid size-[var(--cc-touch)] shrink-0 place-items-center rounded-full bg-accent text-white transition-all active:scale-95 active:opacity-80 disabled:opacity-25"
            onClick={() => void handleSend()}
          >
            <ArrowUp size={19} />
          </button>
        )}
      </div>
    </div>
  );
});
