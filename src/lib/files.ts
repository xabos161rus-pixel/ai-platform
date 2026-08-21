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
// У PDF единственного из форматов проверки размера не было вообще: скан на
// 200 МБ уходил в парсер и вешал вкладку.
export const MAX_PDF_FILE_BYTES = 25 * 1024 * 1024;
/** Меньше этого на страницу — считаем, что текстового слоя нет (скан). */
const SCAN_CHARS_PER_PAGE = 40;
/** Сколько страниц скана отправляем картинками: столько же, сколько картинок
 *  вообще влезает в одно сообщение (MAX_IMAGES в images.ts). */
const SCAN_MAX_PAGES = 4;
/** Скан читает модель, а не человек: мельче 1600px по длинной стороне мелкий
 *  шрифт в JPEG разваливается. */
const SCAN_PAGE_PX = 1600;

export interface AttachedFile {
  name: string;
  size: number;
  text: string;
  /** Страницы скана в виде JPEG dataURL — уходят как картинки сообщения. */
  images?: string[];
}

/**
 * Ужимает текст файла под остаток бюджета сообщения.
 *
 * Раньше здесь был slice(0, room) — он рвал слово на середине и молча
 * выбрасывал весь хвост документа, где у деловых бумаг как раз лежат итоги,
 * реквизиты и подписи. Берём начало и конец, режем по границе абзаца (или
 * хотя бы строки), а про выброшенную середину честно пишем в самом тексте:
 * его читает модель, и она должна знать, что видит не весь документ.
 */
export function fitFileText(text: string, room: number): string {
  if (text.length <= room) return text;
  const note = (n: number) => `\n\n[…пропущено ${n.toLocaleString('ru-RU')} символов…]\n\n`;
  // Две трети под начало, треть под хвост: начало почти всегда информативнее.
  const headRoom = Math.floor((room - note(0).length - 12) * 0.66);
  const tailRoom = room - note(0).length - 12 - headRoom;
  if (headRoom < 200 || tailRoom < 100) {
    // Бюджета не хватает даже на два куска — отдаём одно начало по границе слова.
    const cut = text.slice(0, room);
    const stop = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
    return stop > room * 0.5 ? cut.slice(0, stop) : cut;
  }
  const head = text.slice(0, headRoom);
  const headEnd = Math.max(head.lastIndexOf('\n\n'), head.lastIndexOf('\n'), head.lastIndexOf(' '));
  const headCut = headEnd > headRoom * 0.5 ? head.slice(0, headEnd) : head;

  const tail = text.slice(text.length - tailRoom);
  const tailStart = tail.indexOf('\n\n') >= 0 ? tail.indexOf('\n\n') + 2 : tail.indexOf('\n') + 1;
  const tailCut = tailStart > 0 && tailStart < tailRoom * 0.5 ? tail.slice(tailStart) : tail;

  return headCut + note(text.length - headCut.length - tailCut.length) + tailCut;
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
  if (f.size > MAX_PDF_FILE_BYTES) throw new Error('pdf_too_big');
  // import type стирается при сборке — статической зависимости от чанка
  // vendor-pdf не появляется. Уничтожать нужно задачу загрузки: у самого
  // документа метода destroy нет, он живёт на PDFDocumentLoadingTask.
  let task: import('pdfjs-dist').PDFDocumentLoadingTask | null = null;
  try {
    // Ленивый импорт: pdfjs-dist уходит отдельным чанком (vendor-pdf, см.
    // vite.config.ts) и грузится только при первом PDF-вложении.
    const pdfjs = await import('pdfjs-dist');
    // Воркер через ?url — иначе pdfjs по умолчанию полез бы за ним на CDN,
    // а CSP/оффлайн-режим PWA этого не переживут.
    const { default: workerUrl } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    task = pdfjs.getDocument({ data: await f.arrayBuffer() });
    const doc = await task.promise;
    const pageCount = Math.min(doc.numPages, MAX_PDF_PAGES);
    const pages: string[] = [];
    for (let n = 1; n <= pageCount; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      // hasEOL раньше игнорировался, и весь PDF склеивался в одну строку без
      // единого переноса: ни абзацев, ни таблиц — модель читала кашу, а любая
      // обрезка «по границе абзаца» работала вслепую.
      let out = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        out += item.str + (item.hasEOL ? '\n' : ' ');
      }
      pages.push(out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim());
      page.cleanup();
    }
    let text = pages.join('\n\n').trim();

    // Скан без текстового слоя раньше возвращался как пустая строка — файл
    // «прикреплялся», а модель не получала ничего. Отдаём страницы картинками:
    // современные vision-модели читают их лучше, чем локальный OCR, и это не
    // тянет в бандл десятки мегабайт wasm с языковыми моделями.
    if (text.length < pageCount * SCAN_CHARS_PER_PAGE) {
      const images = await renderPdfPages(doc, Math.min(pageCount, SCAN_MAX_PAGES));
      if (images.length) {
        const shown = images.length;
        const total = doc.numPages;
        return {
          name: f.name,
          size: f.size,
          images,
          // Wire-контент: это читает модель, поэтому по-русски и без жаргона.
          text:
            `[В PDF нет текстового слоя — это скан. ` +
            `Страниц отправлено картинками: ${shown} из ${total}. ` +
            `Прочитай их и работай с содержимым как с текстом документа.]`,
        };
      }
    }

    if (doc.numPages > MAX_PDF_PAGES) {
      text += `\n\n[обрезано: первые ${MAX_PDF_PAGES} страниц из ${doc.numPages}]`;
    }
    return { name: f.name, size: f.size, text };
  } catch (e) {
    throw new Error('bad_pdf', { cause: e });
  } finally {
    // Без destroy воркер и буферы страниц висят до перезагрузки вкладки —
    // на iOS это заметно после нескольких тяжёлых документов.
    void task?.destroy();
  }
}

/** Рендер первых страниц в JPEG dataURL — для сканов без текстового слоя. */
async function renderPdfPages(
  doc: import('pdfjs-dist').PDFDocumentProxy,
  count: number,
): Promise<string[]> {
  const out: string[] = [];
  for (let n = 1; n <= count; n++) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(SCAN_PAGE_PX / Math.max(base.width, base.height), 3);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) break;
    // Белая подложка: у PDF прозрачный фон, в JPEG он стал бы чёрным.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, viewport }).promise;
    out.push(canvas.toDataURL('image/jpeg', 0.72));
    page.cleanup();
  }
  return out;
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
