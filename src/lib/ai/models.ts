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

import type { Provider, ProviderModel } from '../../db/types';
import { getLang, t } from '../i18n';

export interface ModelInfo {
  id: string;
  label: string;
  priceIn: number; // ₽ за 1M входных токенов
  priceOut: number; // ₽ за 1M выходных токенов
  /** Подпись под названием в выпадающем списке. */
  note?: string;
}

/**
 * Единственная точка нормализации Provider.models: строка (legacy-запись) →
 * {id}. Все читатели (ModelPicker, CompareBar, CommandPalette, SettingsPage,
 * ChatPage) обязаны ходить через neё, а не читать models напрямую.
 */
export function modelEntries(models: (string | ProviderModel)[]): ProviderModel[] {
  return models.map((m) => (typeof m === 'string' ? { id: m } : m));
}

/** Шорткат: только id моделей, в исходном порядке. */
export function modelIds(models: (string | ProviderModel)[]): string[] {
  return modelEntries(models).map((m) => m.id);
}

// Только числовые поля фиксированы — label/note встроенных демо-моделей
// вычисляются через t() при каждом обращении (см. modelById), а не хранятся
// строкой: иначе смена языка интерфейса не задела бы уже загруженный модуль.
const MODEL_BASE: { id: string; priceIn: number; priceOut: number }[] = [
  { id: 'demo-echo', priceIn: 0, priceOut: 0 },
  { id: 'demo-fast', priceIn: 0, priceOut: 0 },
];

function demoMeta(id: string): { label: string; note: string } | undefined {
  if (id === 'demo-echo') return { label: t('models.demoEchoLabel'), note: t('models.demoEchoNote') };
  if (id === 'demo-fast') return { label: t('models.demoFastLabel'), note: t('models.demoFastNote') };
  return undefined;
}

export function modelById(id: string): ModelInfo | undefined {
  const base = MODEL_BASE.find((m) => m.id === id);
  if (!base) return undefined;
  const meta = demoMeta(id);
  return { ...base, label: meta?.label ?? id, note: meta?.note };
}

export function modelLabel(id: string | null): string {
  if (!id) return '';
  return modelById(id)?.label ?? id;
}

/**
 * Стоимость запроса в рублях. Цена провайдера (если задана хоть одна из двух
 * priceIn/priceOut у его записи модели) смотрится РАНЬШЕ встроенного реестра —
 * пользовательская цена точнее общей таблицы. null — модель незнакомая нигде,
 * цену не выдумываем.
 */
export function costRub(
  modelId: string | null,
  tokensIn: number,
  tokensOut: number,
  provider?: Provider | null,
): number | null {
  if (modelId && provider) {
    const entry = modelEntries(provider.models).find(
      (m) => m.id === modelId && (m.priceIn !== undefined || m.priceOut !== undefined),
    );
    if (entry) return (tokensIn * (entry.priceIn ?? 0) + tokensOut * (entry.priceOut ?? 0)) / 1_000_000;
  }
  const m = modelId ? modelById(modelId) : undefined;
  if (!m) return null;
  return (tokensIn * m.priceIn + tokensOut * m.priceOut) / 1_000_000;
}

/** ₽ за 1M входных токенов модели — для оценки «≈сколько уйдёт» до отправки.
 *  Логика источников та же, что в costRub: цена провайдера раньше встроенной. */
export function priceInFor(modelId: string | null, provider?: Provider | null): number | null {
  if (modelId && provider) {
    const entry = modelEntries(provider.models).find(
      (m) => m.id === modelId && (m.priceIn !== undefined || m.priceOut !== undefined),
    );
    if (entry) return entry.priceIn ?? 0;
  }
  const m = modelId ? modelById(modelId) : undefined;
  return m ? m.priceIn : null;
}

export function formatCost(rub: number | null): string {
  if (rub === null) return '';
  if (rub === 0) return t('cost.free');
  if (rub < 0.01) return t('cost.lessThanCent');
  // Валюта всегда рубли — переводится только разделитель разрядов (','/'.').
  const lang = getLang();
  return `${rub.toFixed(2).replace('.', lang === 'ru' ? ',' : '.')} ₽`;
}

/** Грубая пред-оценка входа. Только для подписи «≈», см. комментарий выше. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** Компактная запись количества токенов для разбивки расходов по моделям. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  const lang = getLang();
  const sep = lang === 'ru' ? ',' : '.';
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace('.', sep)}${lang === 'ru' ? 'к' : 'k'}`;
  return `${(n / 1_000_000).toFixed(1).replace('.', sep)}${lang === 'ru' ? 'М' : 'M'}`;
}
