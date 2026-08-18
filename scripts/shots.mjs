// Отчётные скриншоты ключевых сцен платформы (для показа, не для проверки).
// Использование: node scripts/shots.mjs <outDir> — предполагает поднятый
// vite preview на 4174, как у смоука.
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const OUT = process.argv[2] ?? 'dist/shots';
const BASE = 'http://localhost:4174/ai-platform';
const SANDBOX_CHROMIUM = '/opt/pw-browsers/chromium';
const b = await chromium.launch(existsSync(SANDBOX_CHROMIUM) ? { executablePath: SANDBOX_CHROMIUM } : {});
const ctx = await b.newContext({ locale: 'ru-RU', viewport: { width: 1400, height: 860 }, deviceScaleFactor: 2 });
const p = await ctx.newPage();

await p.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await p.waitForTimeout(900);

// Сцена 1: диалог с демо + капсула композера со счётчиком.
await p.getByPlaceholder('Спросите что угодно…').fill('Разбери плюсы и минусы BYOK-подхода для работы с ИИ');
await p.getByRole('button', { name: 'Отправить' }).click();
await p.waitForTimeout(6000);
await p.getByPlaceholder('Спросите что угодно…').fill('Продолжи: что с безопасностью ключей?');
await p.waitForTimeout(400);
await p.screenshot({ path: `${OUT}/1-chat.png` });

// Сцена 2: консилиум — выбрать демо-модели, режим, прогнать до финала.
await p.getByRole('button', { name: 'Новый чат' }).first().click();
await p.waitForTimeout(400);
await p.getByRole('button', { name: 'сравнить' }).click();
await p.waitForTimeout(300);
for (const key of ['demo:demo-echo', 'demo:demo-fast']) {
  const chip = p.getByTestId(`compare-chip:${key}`);
  if (!((await chip.getAttribute('class'))?.includes('border-accent'))) {
    await chip.click();
    await p.waitForTimeout(120);
  }
}
await p.getByRole('button', { name: 'консилиум' }).click();
await p.waitForTimeout(200);
await p.getByPlaceholder('Спросите что угодно…').fill('Что важнее для нового продукта: скорость запуска или качество?');
await p.getByRole('button', { name: 'Отправить' }).click();
// Финал стримится словами — ждём его записи (блок «Консилиум ·» в ленте).
await p.waitForFunction(() => /Консилиум · 2/.test(document.body.textContent ?? ''), { timeout: 120_000 }).catch(() => {});
await p.waitForTimeout(600);
// Раскрыть ход обсуждения.
await p.locator('button', { hasText: 'Консилиум ·' }).first().click().catch(() => {});
await p.waitForTimeout(400);
await p.screenshot({ path: `${OUT}/2-council.png` });

// Сцена 3: сплит — два чата рядом.
const menuBtns = p.locator('button:has(.glyph-more-h)');
await menuBtns.last().click();
await p.waitForTimeout(300);
await p.getByRole('button', { name: 'Открыть рядом' }).click();
await p.waitForTimeout(700);
await p.screenshot({ path: `${OUT}/3-split.png` });
await p.getByRole('button', { name: 'Закрыть панель' }).click().catch(() => {});

// Сцена 4: настройки.
await p.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
await p.waitForTimeout(700);
await p.screenshot({ path: `${OUT}/4-settings.png` });

await b.close();
console.log('SHOTS: готово →', OUT);
