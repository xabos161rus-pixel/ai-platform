import { useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import hljs from 'highlight.js/lib/common';
import { Check, Copy } from 'lucide-react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * Рендер ответа модели.
 *
 * Текст приходит из внешнего источника, поэтому только через DOMPurify. Живой
 * рендер HTML в iframe (артефакты) сознательно не делаем: рядом в IndexedDB
 * лежат API-ключи пользователя, и это самая опасная поверхность в приложении.
 *
 * Подсветка — highlight.js, а не самописные регулярки: свой «подсветчик»
 * ломается на нетривиальном коде, и выглядит это как баг приложения.
 * Используется сборка `common` — два десятка ходовых языков вместо всех 190.
 */
function render(text: string): string {
  const html = marked.parse(text, { async: false, breaks: true }) as string;
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ['form', 'input', 'button', 'iframe', 'object', 'embed', 'style', 'script'],
    FORBID_ATTR: ['style', 'onerror', 'onload'],
    ADD_ATTR: ['target', 'rel'],
  });
}

/** Кнопка копирования блока кода — монтируется в уже отрисованный DOM. */
function CopyCode({ code }: { code: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      aria-label="Скопировать код"
      className="absolute top-2 right-2 grid size-7 place-items-center rounded-[var(--cc-radius-sm)] bg-[var(--cc-fill-control)] text-muted opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-visible:opacity-100 active:opacity-70"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(code);
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        } catch {
          /* буфер недоступен — текст можно выделить руками */
        }
      }}
    >
      {done ? <Check size={13} className="text-success" /> : <Copy size={13} />}
    </button>
  );
}

export function Markdown({ text }: { text: string }) {
  const host = useRef<HTMLDivElement>(null);
  const roots = useRef<Root[]>([]);
  const html = useMemo(() => render(text), [text]);

  // Подсветка и кнопки копирования навешиваются после вставки разметки:
  // marked отдаёт строку, а highlight.js работает по DOM-узлам.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    // Снимаем прошлые корни до перерисовки — иначе React ругается на
    // размонтирование во время рендера родителя.
    const prev = roots.current;
    roots.current = [];
    queueMicrotask(() => prev.forEach((r) => r.unmount()));

    el.querySelectorAll('pre > code').forEach((node) => {
      const code = node as HTMLElement;
      if (!code.dataset.highlighted) {
        hljs.highlightElement(code);
        code.dataset.highlighted = '1';
      }
      const pre = code.parentElement;
      if (!pre || pre.querySelector('[data-copy-slot]')) return;
      pre.classList.add('group', 'relative');
      const slot = document.createElement('span');
      slot.dataset.copySlot = '1';
      pre.appendChild(slot);
      const root = createRoot(slot);
      root.render(<CopyCode code={code.textContent ?? ''} />);
      roots.current.push(root);
    });
    // Ссылки — только в новую вкладку и без доступа к opener.
    el.querySelectorAll('a[href]').forEach((a) => {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    });
  }, [html]);

  return <div ref={host} className="cc-md" dangerouslySetInnerHTML={{ __html: html }} />;
}
