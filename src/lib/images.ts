// Сжатие вложений перед сохранением в Dexie и отправкой провайдеру.
// Фото с телефона весят 3–10 МБ: без сжатия IndexedDB и запрос к провайдеру
// раздуваются на порядок, а 1024px по длинной стороне хватает модели,
// чтобы понять, что на картинке.
export const MAX_IMAGES = 4;
const MAX_SIDE = 1024;

export async function compressImage(file: Blob): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('bad_image'));
      el.src = url;
    });
    const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('bad_image');
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    // И на успехе, и на ошибке — иначе объектный URL течёт на каждое фото.
    URL.revokeObjectURL(url);
  }
}
