import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ArrowUp, CompareColumns, Council, FileText, Globe, Paperclip, Square, X } from '../../components/ui/glyphs';
import { useToast } from '../../components/ui/toastContext';
import { compressImage, MAX_IMAGES } from '../../lib/images';
import {
  acceptAttr,
  extractDocx,
  extractPdf,
  extractText,
  extractXlsx,
  isDocxFile,
  isLegacyOffice,
  isPdfFile,
  isTextFile,
  isXlsxFile,
  MAX_MSG_FILE_CHARS,
  type AttachedFile,
} from '../../lib/files';
import { useT } from '../../lib/i18n';
import { estimateTokens, formatTokens } from '../../lib/ai/models';
import { SnippetMenu, type SnippetMenuHandle } from './SnippetMenu';

export interface ComposerHandle {
  insertText(text: string): void;
  focus(): void;
}

interface Props {
  busy: boolean;
  canSend: boolean;
  onSend: (text: string, images: string[], files: AttachedFile[]) => void | Promise<void>;
  onStop: () => void;
  /** ↑ в пустом поле вне сниппет-меню — открыть правку последнего своего сообщения. */
  onEditLast?: () => void;
  /** Режим агентских инструментов текущего чата — переключается кнопкой-глобусом. */
  toolMode: 'off' | 'tools' | 'research';
  onToolMode: (m: 'off' | 'tools' | 'research') => void;
  /** Режим отправки: обычный, сравнение колонками или консилиум. */
  sendMode: 'off' | 'columns' | 'council';
  onSendMode: (m: 'off' | 'columns' | 'council') => void;
  /** ≈токенов уже в контексте (история по лимиту + системный промпт) — из ChatPage. */
  baseTokens?: number;
  /** ₽ за 1M входных токенов активной модели; null — цена неизвестна. */
  priceIn?: number | null;
  /** Левый конец служебной строки (панель сравнения) — рендерится напротив
   *  счётчика ≈входа, чтобы строка была одна, а не две сироты друг над другом. */
  barSlot?: React.ReactNode;
}

const NEXT_TOOL_MODE = { off: 'tools', tools: 'research', research: 'off' } as const;

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
  { busy, canSend, onSend, onStop, onEditLast, toolMode, onToolMode, sendMode, onSendMode, baseTokens = 0, priceIn = null, barSlot },
  ref,
) {
  const toast = useToast();
  const t = useT();
  const [draft, setDraft] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<SnippetMenuHandle>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Клавиатуру теперь отрабатывает каркас страницы (ChatPage ужимает свою
  // высоту по visualViewport) — композер поднимается вместе с ним. Здесь
  // осталось одно: сообщить наружу фактическую высоту блока, чтобы тост
  // вставал НАД композером, а не под ним и не по зашитой константе.
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const publish = () => {
      document.documentElement.style.setProperty(
        '--cc-composer-h',
        `${Math.round(wrapper.getBoundingClientRect().height)}px`,
      );
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(wrapper);
    return () => {
      ro.disconnect();
      document.documentElement.style.removeProperty('--cc-composer-h');
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
  // которые всё равно не влезут. Не-картинки (текст/PDF) обрабатываются
  // отдельно ниже — у них свой лимит (символьный бюджет, а не счётчик штук).
  async function addImages(list: File[]) {
    const room = MAX_IMAGES - images.length;
    if (list.length > room) toast(t('composer.tooManyImages'));
    for (const f of list.slice(0, room)) {
      try {
        const url = await compressImage(f);
        setImages((prev) => (prev.length >= MAX_IMAGES ? prev : [...prev, url]));
      } catch {
        toast(t('composer.readImageFailed'));
      }
    }
  }

  // Текст/PDF — по одному, с общим бюджетом MAX_MSG_FILE_CHARS на сообщение:
  // файл, не влезающий целиком, обрезается до остатка; при нулевом остатке —
  // отклоняется. Порядок важен: room считается по уже накопленным files на
  // момент обработки каждого файла (не снимок на старте цикла).
  async function addDocs(list: File[]) {
    for (const f of list) {
      let attached: AttachedFile;
      try {
        if (isPdfFile(f)) attached = await extractPdf(f);
        else if (isDocxFile(f)) attached = await extractDocx(f);
        else if (isXlsxFile(f)) attached = await extractXlsx(f);
        else attached = await extractText(f);
      } catch (e) {
        if (e instanceof Error && e.message === 'too_big') toast(t('files.tooBig'));
        else if (e instanceof Error && e.message === 'office_too_big') toast(t('files.officeTooBig'));
        else toast(t('files.readFailed'));
        continue;
      }
      setFiles((prev) => {
        const used = prev.reduce((n, x) => n + x.text.length, 0);
        const room = MAX_MSG_FILE_CHARS - used;
        if (room <= 0) {
          toast(t('files.limitReached'));
          return prev;
        }
        if (attached.text.length > room) {
          toast(t('files.trimmed', { name: attached.name }));
          return [...prev, { ...attached, text: attached.text.slice(0, room) }];
        }
        return [...prev, attached];
      });
    }
  }

  async function addFiles(list: ArrayLike<File | null> | FileList | null) {
    const all = Array.from(list ?? []).filter((f): f is File => !!f);
    const imgs = all.filter((f) => f.type.startsWith('image/'));
    const docs: File[] = [];
    for (const f of all) {
      if (f.type.startsWith('image/')) continue;
      if (isLegacyOffice(f)) {
        // .doc/.xls/.ppt — бинарные форматы прошлого века, в браузере их
        // парсить нечем; молча игнорировать нельзя — человек решит, что сломано.
        toast(t('files.legacyOffice', { name: f.name }));
        continue;
      }
      if (isPdfFile(f) || isDocxFile(f) || isXlsxFile(f) || isTextFile(f)) docs.push(f);
      else toast(t('files.unsupported'));
    }
    await addImages(imgs);
    await addDocs(docs);
  }

  async function handleSend() {
    const text = draft.trim();
    if ((!text && !images.length && !files.length) || busy || !canSend) return;
    // Очистка ДО await — как раньше в ChatPage.handleSend: черновик не должен
    // «висеть» в поле, пока идёт запрос.
    setDraft('');
    setMenuOpen(false);
    if (inputRef.current) inputRef.current.style.height = 'auto';
    const imgs = images;
    setImages([]);
    const fs = files;
    setFiles([]);
    await onSend(text, imgs, fs);
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

  // ≈ вход следующего запроса: контекст (из ChatPage) + черновик + тексты
  // вложений. Оценка честно приблизительная (символы/3, русский дороже) —
  // поэтому знак «≈» и ничего на ней не блокируем; точные числа придут в
  // usage после ответа. Пересчёт на каждый символ дешёвый: длины строк.
  const estIn = baseTokens + estimateTokens(draft) + files.reduce((n, f) => n + estimateTokens(f.text), 0);
  const estRub = priceIn != null ? (estIn * priceIn) / 1_000_000 : null;

  return (
    <div ref={wrapperRef} className="shrink-0 bg-bg">
      {barSlot && <div className="mx-auto w-full max-w-3xl px-4 pt-1.5">{barSlot}</div>}
      {(images.length > 0 || files.length > 0) && (
        <div className="mx-auto flex w-full max-w-3xl flex-wrap gap-2 px-4 pt-2">
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
          {files.map((f, i) => (
            <div
              key={i}
              className="flex shrink-0 items-center gap-1.5 rounded-[var(--cc-radius-sm)] border border-hairline bg-surface-2 px-2 py-1 text-[length:var(--cc-text-caption)]"
            >
              <FileText size={13} className="shrink-0 text-muted" />
              <span className="max-w-[10rem] truncate">{f.name}</span>
              <span className="shrink-0 text-muted">{t('files.kb', { n: Math.max(1, Math.round(f.size / 1024)) })}</span>
              <button
                aria-label={t('files.removeAria')}
                className="shrink-0 text-muted active:opacity-60"
                onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
      {/* Капсула ввода — одна поверхность: текст сверху, контролы нижним
          рядом ВНУТРИ (как у лучших чат-интерфейсов). Метрика ≈входа живёт
          в этом же ряду перед кнопкой отправки — у неё нет отдельного этажа,
          и на телефоне она больше не болтается в пустоте. */}
      <div className="relative mx-auto w-full max-w-3xl px-4 pt-2 pb-[calc(env(safe-area-inset-bottom)+10px)]">
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
        <div className="cc-capsule flex flex-col rounded-[calc(var(--cc-radius)*1.6)] bg-surface-2 transition-shadow focus-within:shadow-[0_0_0_1px_var(--app-accent)]">
        <input
          ref={fileRef}
          type="file"
          accept={acceptAttr()}
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
          className="max-h-44 min-h-[var(--cc-touch)] w-full resize-none bg-transparent px-4 pt-3 pb-1 outline-none placeholder:text-muted"
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
            const pasted = Array.from(e.clipboardData.items)
              .filter((i) => i.type.startsWith('image/'))
              .map((i) => i.getAsFile());
            if (pasted.length) {
              e.preventDefault();
              void addFiles(pasted);
            }
          }}
        />
        <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
          <button
            aria-label={t('chat.attachFile')}
            disabled={busy}
            onClick={() => fileRef.current?.click()}
            className="grid size-9 shrink-0 place-items-center rounded-[var(--cc-radius-sm)] text-muted transition-colors hover:text-text active:opacity-60 disabled:opacity-25"
          >
            <Paperclip size={18} />
          </button>
          <button
            aria-label={t(`agent.mode.${toolMode}`)}
            title={t(`agent.mode.${toolMode}`)}
            onClick={() => onToolMode(NEXT_TOOL_MODE[toolMode])}
            className={
              'grid size-9 shrink-0 place-items-center rounded-[var(--cc-radius-sm)] transition-colors active:opacity-60 ' +
              (toolMode === 'research'
                ? 'bg-accent/15 text-accent'
                : toolMode === 'tools'
                  ? 'text-accent'
                  : 'text-muted hover:text-text')
            }
          >
            <Globe size={18} />
          </button>
          {/* Режимы отправки — самостоятельные входы, а не варианты одной
              кнопки: сравнение и консилиум — разные инструменты. Актив —
              клай, как у режимов глобуса. */}
          <button
            aria-label={t('compare.modeAria')}
            title={t('compare.modeAria')}
            aria-pressed={sendMode === 'columns'}
            disabled={busy}
            onClick={() => onSendMode(sendMode === 'columns' ? 'off' : 'columns')}
            className={
              'grid size-9 shrink-0 place-items-center rounded-[var(--cc-radius-sm)] transition-colors active:opacity-60 disabled:opacity-25 ' +
              (sendMode === 'columns' ? 'bg-accent/15 text-accent' : 'text-muted hover:text-text')
            }
          >
            <CompareColumns size={18} />
          </button>
          <button
            aria-label={t('council.modeAria')}
            title={t('council.modeAria')}
            aria-pressed={sendMode === 'council'}
            disabled={busy}
            onClick={() => onSendMode(sendMode === 'council' ? 'off' : 'council')}
            className={
              'grid size-9 shrink-0 place-items-center rounded-[var(--cc-radius-sm)] transition-colors active:opacity-60 disabled:opacity-25 ' +
              (sendMode === 'council' ? 'bg-accent/15 text-accent' : 'text-muted hover:text-text')
            }
          >
            <Council size={18} />
          </button>
          <span className="flex-1" />
          {estIn > 0 && (
            <span
              title={t('composer.estTitle')}
              className="mr-2 shrink-0 cursor-default font-mono text-[length:var(--cc-text-caption)] text-muted/60 tabular-nums select-none"
            >
              {t('composer.estIn', { n: formatTokens(estIn) })}
              {estRub != null && estRub >= 0.01 ? ` · ${estRub.toFixed(2).replace('.', ',')} ₽` : ''}
            </span>
          )}
          {busy ? (
            <button
              aria-label={t('chat.stop')}
              className="grid size-9 shrink-0 place-items-center rounded-full bg-bg transition-opacity active:opacity-70"
              onClick={onStop}
            >
              <Square size={14} />
            </button>
          ) : (
            <button
              aria-label={t('chat.send')}
              disabled={!draft.trim() && !images.length && !files.length}
              className="grid size-9 shrink-0 place-items-center rounded-full bg-accent text-white transition-all active:scale-95 active:opacity-80 disabled:bg-transparent disabled:text-muted/40"
              onClick={() => void handleSend()}
            >
              <ArrowUp size={17} />
            </button>
          )}
        </div>
        </div>
      </div>
    </div>
  );
});
