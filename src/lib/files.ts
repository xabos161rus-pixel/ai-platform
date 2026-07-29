// Текстовые и PDF-вложения композера. Картинки — отдельно, см. images.ts
// (сжатие в JPEG dataURL); здесь — извлечение читаемого текста, который
// уходит в контекст модели через Message.fileTexts (см. chatRepo.toContext).

/** Расширения, которые читаем как обычный текст без парсинга. */
export const TEXT_EXTS = [
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'js', 'mjs', 'ts', 'tsx', 'jsx',
  'py', 'html', 'css', 'xml', 'yaml', 'yml', 'toml', 'ini', 'log', 'sh', 'sql',
];

export const MAX_TEXT_FILE_BYTES = 200 * 1024;
// Суммарный бюджет текста файлов на ОДНО сообщение — прямой контроль размера
// wire-запроса, как historyLimit для истории (см. chatRepo.toContext).
export const MAX_MSG_FILE_CHARS = 60000;
export const MAX_PDF_PAGES = 50;

export interface AttachedFile {
  name: string;
  size: number;
  text: string;
}

function ext(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

export function isTextFile(f: File): boolean {
  return TEXT_EXTS.includes(ext(f.name)) || f.type.startsWith('text/');
}

export function isPdfFile(f: File): boolean {
  return ext(f.name) === 'pdf' || f.type === 'application/pdf';
}

export async function extractText(f: File): Promise<AttachedFile> {
  if (f.size > MAX_TEXT_FILE_BYTES) throw new Error('too_big');
  const text = await f.text();
  return { name: f.name, size: f.size, text };
}

export async function extractPdf(f: File): Promise<AttachedFile> {
  try {
    // Ленивый импорт: pdfjs-dist уходит отдельным чанком (vendor-pdf, см.
    // vite.config.ts) и грузится только при первом PDF-вложении.
    const pdfjs = await import('pdfjs-dist');
    // Воркер через ?url — иначе pdfjs по умолчанию полез бы за ним на CDN,
    // а CSP/оффлайн-режим PWA этого не переживут.
    const { default: workerUrl } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    const doc = await pdfjs.getDocument({ data: await f.arrayBuffer() }).promise;
    const pageCount = Math.min(doc.numPages, MAX_PDF_PAGES);
    const pages: string[] = [];
    for (let n = 1; n <= pageCount; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      pages.push(content.items.map((i) => ('str' in i ? i.str : '')).join(' '));
    }
    let text = pages.join('\n\n');
    if (doc.numPages > MAX_PDF_PAGES) {
      text += `\n\n[обрезано: первые ${MAX_PDF_PAGES} страниц из ${doc.numPages}]`;
    }
    return { name: f.name, size: f.size, text };
  } catch {
    throw new Error('bad_pdf');
  }
}

/** accept для <input type="file"> композера: картинки + PDF + текстовые расширения. */
export function acceptAttr(): string {
  return `image/*,.pdf,${TEXT_EXTS.map((e) => `.${e}`).join(',')}`;
}
