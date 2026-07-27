// Реестр моделей и расчёт стоимости.
//
// Цены — в РУБЛЯХ за миллион токенов, уже с наценкой агрегатора: так сумма
// сразу в той валюте, в которой она приходит на счёт, без курса внутри
// клиента. Держим константой в коде, а не таблицей в БД: меняется только
// при обновлении приложения.
//
// ВАЖНО про оценку токенов: русский текст токенизируется заметно дороже
// английского, поэтому предварительная оценка по символам систематически
// занижена. Показывать её только со знаком «≈» и не строить на ней лимитов —
// точное число приходит от провайдера вместе с ответом.

export interface ModelInfo {
  id: string;
  label: string;
  priceIn: number; // ₽ за 1M входных токенов
  priceOut: number; // ₽ за 1M выходных токенов
  /** Подпись под названием в выпадающем списке. */
  note?: string;
}

export const MODELS: ModelInfo[] = [
  { id: 'demo-echo', label: 'Демо (бесплатно)', priceIn: 0, priceOut: 0, note: 'Отвечает заглушка, без сети' },
];

export function modelById(id: string): ModelInfo | undefined {
  return MODELS.find((m) => m.id === id);
}

export function modelLabel(id: string | null): string {
  if (!id) return '';
  return modelById(id)?.label ?? id;
}

/** Стоимость запроса в рублях. null — модель незнакомая, цену не выдумываем. */
export function costRub(modelId: string | null, tokensIn: number, tokensOut: number): number | null {
  const m = modelId ? modelById(modelId) : undefined;
  if (!m) return null;
  return (tokensIn * m.priceIn + tokensOut * m.priceOut) / 1_000_000;
}

export function formatCost(rub: number | null): string {
  if (rub === null) return '';
  if (rub === 0) return 'бесплатно';
  if (rub < 0.01) return '<0,01 ₽';
  return `${rub.toFixed(2).replace('.', ',')} ₽`;
}

/** Грубая пред-оценка входа. Только для подписи «≈», см. комментарий выше. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}
