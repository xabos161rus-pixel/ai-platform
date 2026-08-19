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

export interface SourceRef {
  n: number;
  title: string;
  url: string;
}

/**
 * Сноски [n] → кликабельные надстрочные ссылки на источники прогона.
 * Применяется только к html-сегментам (блоки кода — отдельная React-ветка
 * CodeBlock и сюда не попадают), но инлайн-<code> внутри html есть — его
 * пропускаем: «[1]» в коде — легитимный синтаксис.
 */
function linkCitations(html: string, sources: SourceRef[]): string {
  if (!sources.length) return html;
  const byN = new Map(sources.map((s) => [s.n, s]));
  return html
    .split(/(<code[\s\S]*?<\/code>)/g)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part.replace(/\[(\d{1,2})\]/g, (m, num: string) => {
        const src = byN.get(Number(num));
        if (!src) return m;
        return `<sup class="cc-cite"><a href="${src.url}" target="_blank" rel="noopener noreferrer" title="${src.title.replace(/"/g, '&quot;')}">${num}</a></sup>`;
      });
    })
    .join('');
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
export const Markdown = memo(function Markdown({ text, sources }: { text: string; sources?: SourceRef[] }) {
  const segs = useMemo(() => {
    const raw = toSegments(text);
    // Сноски вставляются после санитайзера (render внутри toSegments): их
    // разметка своя и безопасная — url из результатов поиска, кавычки экранированы.
    return sources?.length ? raw.map((s) => (s.type === 'html' ? { ...s, html: linkCitations(s.html, sources) } : s)) : raw;
  }, [text, sources]);
  return (
    <>
      {segs.map((s, i) =>
        s.type === 'code' ? <CodeBlock key={i} lang={s.lang} code={s.code} /> : <HtmlSegment key={i} html={s.html} />,
      )}
    </>
  );
});
