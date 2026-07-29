import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Code2, Copy, Eye, Maximize2, X } from 'lucide-react';
import { useT } from '../../lib/i18n';

/**
 * Модульный кэш промиса: highlight.js грузится динамически один раз на всё
 * приложение — не на каждый блок кода и не в основной бандл. Сборка `common`
 * — два десятка ходовых языков вместо всех 190.
 */
let hljsPromise: Promise<typeof import('highlight.js/lib/common')> | null = null;
function loadHljs() {
  hljsPromise ??= import('highlight.js/lib/common');
  return hljsPromise;
}

/** Языки, для которых есть смысл в живом предпросмотре. */
const PREVIEWABLE = new Set(['html', 'svg']);

/** svg сам по себе не документ — оборачиваем в минимальный html с центрированием. */
function previewDoc(lang: string, code: string): string {
  if (lang === 'svg') {
    return `<!doctype html><html><body style="margin:0;display:grid;place-items:center;min-height:100vh">${code}</body></html>`;
  }
  return code;
}

/** Кнопки шапки — тач-таргет крупнее визуального размера на грубом указателе (палец). */
const HEADER_BTN =
  'grid size-8 shrink-0 place-items-center rounded-[var(--cc-radius-sm)] text-muted transition-colors hover:text-text active:opacity-60 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11';

export function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const t = useT();
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [preview, setPreview] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  // Подсветка — динамическая загрузка. До готовности показываем текст как есть,
  // а не «мигающий» промежуточный html — так проще и не даёт лишних перерисовок.
  useEffect(() => {
    let cancelled = false;
    void loadHljs().then((mod) => {
      if (cancelled) return;
      const hl = mod.default;
      try {
        if (lang && hl.getLanguage(lang)) {
          setHtml(hl.highlight(code, { language: lang }).value);
        } else if (code.length < 4000) {
          setHtml(hl.highlightAuto(code).value);
        } else {
          setHtml(null);
        }
      } catch {
        setHtml(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [lang, code]);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* буфер недоступен — текст можно выделить руками */
    }
  }

  const canPreview = PREVIEWABLE.has(lang);
  const doc = canPreview ? previewDoc(lang, code) : '';

  return (
    <div className="overflow-hidden rounded-[var(--cc-radius)] border border-hairline bg-[var(--cc-code-bg)]">
      <div className="flex items-center justify-between gap-2 border-b border-hairline px-3 py-1">
        <span className="font-mono text-[length:var(--cc-text-caption)] tracking-wide text-muted uppercase">
          {lang || 'text'}
        </span>
        <div className="flex items-center gap-0.5">
          {canPreview && (
            <button
              type="button"
              aria-label={preview ? t('code.code') : t('code.preview')}
              className={HEADER_BTN}
              onClick={() => setPreview((v) => !v)}
            >
              {preview ? <Code2 size={14} /> : <Eye size={14} />}
            </button>
          )}
          {canPreview && preview && (
            <button
              type="button"
              aria-label={t('code.fullscreen')}
              className={HEADER_BTN}
              onClick={() => setFullscreen(true)}
            >
              <Maximize2 size={14} />
            </button>
          )}
          <button type="button" aria-label={t('chat.copy')} className={HEADER_BTN} onClick={() => void copy()}>
            {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
          </button>
        </div>
      </div>
      {canPreview && preview ? (
        // allow-same-origin НЕ добавлять никогда: рядом в IndexedDB лежат
        // ключи пользователя провайдеров. Без него iframe получает opaque
        // origin и не видит ни БД, ни origin приложения — это и есть граница
        // безопасности BYOK-клиента.
        <iframe
          sandbox="allow-scripts"
          srcDoc={doc}
          title={t('code.previewTitle')}
          className="h-72 w-full border-0 bg-white"
        />
      ) : (
        <pre className="overflow-x-auto p-3">
          {html !== null ? (
            <code
              className="block font-mono text-[0.8rem] leading-[1.55]"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          ) : (
            <code className="block font-mono text-[0.8rem] leading-[1.55]">{code}</code>
          )}
        </pre>
      )}
      {fullscreen &&
        createPortal(
          <div
            className="animate-fade-in fixed inset-0 z-[90] flex items-stretch justify-center bg-black/80 p-3 pt-[calc(env(safe-area-inset-top)+12px)] pb-[calc(env(safe-area-inset-bottom)+12px)]"
            onClick={() => setFullscreen(false)}
          >
            <div
              className="flex h-[90dvh] w-[min(96vw,1100px)] flex-col overflow-hidden rounded-[var(--cc-radius)] border border-hairline bg-elevated"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex shrink-0 items-center justify-between gap-2 border-b border-hairline px-3 py-2">
                <span className="font-mono text-[length:var(--cc-text-caption)] tracking-wide text-muted uppercase">
                  {lang || 'text'}
                </span>
                <button aria-label={t('common.close')} className={HEADER_BTN} onClick={() => setFullscreen(false)}>
                  <X size={16} />
                </button>
              </div>
              <iframe
                sandbox="allow-scripts"
                srcDoc={doc}
                title={t('code.previewTitle')}
                className="min-h-0 flex-1 border-0 bg-white"
              />
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
