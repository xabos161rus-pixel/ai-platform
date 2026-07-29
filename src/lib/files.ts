// Текстовые и PDF-вложения композера. Картинки — отдельно, см. images.ts
// (сжатие в JPEG dataURL); здесь — извлечение читаемого текста, который
// уходит в контекст модели через Message.fileTexts (см. chatRepo.toContext).

/** Расширения, которые читаем как обычный текст без парсинга. */
export const TEXT_EXTS = [
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'js', 'mjs', 'ts', 'tsx', 'jsx',
  'py', 'html', 'css', 'xml', 'yaml', 'yml', 'toml', 'ini', 'log', 'sh', 'sql',
];

export const MAX_TEXT_FILE_BYTES = 200 * 1024;
// Офисные файлы — ZIP-контейнеры, реальный текст внутри многократно меньше
// размера файла; 15 МБ покрывает тяжёлые документы с картинками.
export const MAX_OFFICE_FILE_BYTES = 15 * 1024 * 1024;
export const MAX_XLSX_SHEETS = 10;
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

export function isDocxFile(f: File): boolean {
  return ext(f.name) === 'docx';
}

export function isXlsxFile(f: File): boolean {
  return ['xlsx', 'xlsm'].includes(ext(f.name));
}

/** Старые бинарные форматы Office: парсить в браузере нечем — честно отказываем
 *  с подсказкой пересохранить в современный формат. */
export function isLegacyOffice(f: File): boolean {
  return ['doc', 'xls', 'ppt'].includes(ext(f.name));
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

export async function extractDocx(f: File): Promise<AttachedFile> {
  // Не 'too_big': у офисных файлов свой лимит, и тост должен называть 15 МБ, а не 200 КБ.
  if (f.size > MAX_OFFICE_FILE_BYTES) throw new Error('office_too_big');
  try {
    // Ленивый импорт: mammoth уходит отдельным чанком и грузится только при
    // первом .docx-вложении — как pdfjs для PDF.
    const mammoth = await import('mammoth');
    const { value } = await mammoth.extractRawText({ arrayBuffer: await f.arrayBuffer() });
    return { name: f.name, size: f.size, text: value.trim() };
  } catch {
    throw new Error('bad_office');
  }
}

export async function extractXlsx(f: File): Promise<AttachedFile> {
  if (f.size > MAX_OFFICE_FILE_BYTES) throw new Error('office_too_big');
  try {
    const XLSX = await import('xlsx');
    const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
    const names = wb.SheetNames.slice(0, MAX_XLSX_SHEETS);
    // CSV на лист: модель читает таблицы в CSV лучше, чем в сыром XML; имя
    // листа — заголовком, чтобы в многолистовой книге не потерялась структура.
    const parts = names.map((n) => `## ${n}\n${XLSX.utils.sheet_to_csv(wb.Sheets[n])}`.trim());
    let text = parts.join('\n\n');
    if (wb.SheetNames.length > names.length) {
      // Wire-контент, не i18n: пометка уходит модели вместе с текстом листов —
      // по-русски, как обрезка страниц в extractPdf.
      text += `\n\n[обрезано: первые ${names.length} листов из ${wb.SheetNames.length}]`;
    }
    return { name: f.name, size: f.size, text };
  } catch {
    throw new Error('bad_office');
  }
}

/** accept для <input type="file"> композера: картинки + документы + текстовые расширения. */
export function acceptAttr(): string {
  return `image/*,.pdf,.docx,.xlsx,.xlsm,${TEXT_EXTS.map((e) => `.${e}`).join(',')}`;
}
