import { useMemo } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

/**
 * Рендер ответа модели. Текст приходит из внешнего источника, поэтому только
 * через DOMPurify. Живой рендер HTML в iframe (артефакты) сознательно не
 * делаем: рядом в IndexedDB лежат API-ключи пользователя, и это самая опасная
 * поверхность в приложении.
 */
export function Markdown({ text }: { text: string }) {
  const html = useMemo(
    () =>
      DOMPurify.sanitize(marked.parse(text, { async: false, breaks: true }) as string, {
        FORBID_TAGS: ['form', 'input', 'button', 'iframe', 'object', 'embed', 'style', 'script'],
        FORBID_ATTR: ['style', 'onerror', 'onload'],
      }),
    [text],
  );
  return <div className="cc-md" dangerouslySetInnerHTML={{ __html: html }} />;
}
