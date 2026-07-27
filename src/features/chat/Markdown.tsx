import { memo, useEffect, useMemo, useRef } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { CodeBlock } from './CodeBlock';

/**
 * Рендер ответа модели.
 *
 * Текст приходит из внешнего источника, поэтому только через DOMPurify.
 * Блоки кода — отдельная React-ветка (CodeBlock): у них свой предпросмотр
 * html/svg в iframe и подсветка через динамически загружаемый highlight.js.
 * Всё остальное (текст, списки, таблицы, инлайн-код) идёт прежним путём —
 * marked.parse + DOMPurify в html-сегмент.
 */
function render(text: string): string {
  const html = marked.parse(text, { async: false, breaks: true }) as string;
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ['form', 'input', 'button', 'iframe', 'object', 'embed', 'style', 'script'],
    FORBID_ATTR: ['style', 'onerror', 'onload'],
    ADD_ATTR: ['target', 'rel'],
  });
}

type Seg = { type: 'html'; html: string } | { type: 'code'; lang: string; code: string };

/**
 * marked.lexer режет текст на токены. Код (```lang) выделяется в свой
 * сегмент — он рендерится CodeBlock, а не общим html-путём. Всё остальное
 * копится подряд по token.raw и уходит в render() одним куском: так не
 * теряются связи между соседними токенами (пустые строки между абзацами
 * и списками, которые marked.parse учитывает только при склеенном тексте).
 */
function toSegments(text: string): Seg[] {
  const tokens = marked.lexer(text);
  const segs: Seg[] = [];
  let buffer = '';
  const flush = () => {
    if (buffer) {
      segs.push({ type: 'html', html: render(buffer) });
      buffer = '';
    }
  };
  for (const tok of tokens) {
    if (tok.type === 'code') {
      flush();
      segs.push({ type: 'code', lang: tok.lang?.toLowerCase() ?? '', code: tok.text });
    } else {
      buffer += tok.raw;
    }
  }
  flush();
  return segs;
}

/** Один html-сегмент: ссылки — только в новую вкладку и без доступа к opener. */
function HtmlSegment({ html }: { html: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.querySelectorAll('a[href]').forEach((a) => {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    });
  }, [html]);
  return <div ref={ref} className="cc-md" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** memo по стабильному text: во время стрима меняется только последний сегмент. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const segs = useMemo(() => toSegments(text), [text]);
  return (
    <>
      {segs.map((s, i) =>
        s.type === 'code' ? <CodeBlock key={i} lang={s.lang} code={s.code} /> : <HtmlSegment key={i} html={s.html} />,
      )}
    </>
  );
});
