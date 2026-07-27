// Smoke-тест: сквозной сценарий платформы в браузере.
// Запуск: npm run smoke — единственная автоматическая проверка в проекте.
import { chromium } from 'playwright';

const BASE = 'http://localhost:4174/ai-platform';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
p.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`); });

let pass = true;
const check = (ok, label) => { console.log(`${ok ? '✓' : '✗'} ${label}`); pass = pass && ok; };

await p.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await p.waitForTimeout(700);

check((await p.textContent('body')).includes('Спросите что угодно'), 'экран чата открылся');
check(await p.getByPlaceholder('Спросите что угодно…').isVisible(), 'поле ввода на месте');
check((await p.textContent('body')).includes('демо'), 'демо-провайдер активен по умолчанию');

// Сквозной сценарий: вопрос → ответ заглушки → метрики
await p.getByPlaceholder('Спросите что угодно…').fill('Привет, проверка');
await p.getByRole('button', { name: 'Отправить' }).click();
await p.waitForTimeout(2000);
let body = await p.textContent('body');
check(body.includes('Привет, проверка'), 'вопрос отрисован');
check(body.includes('Демо-режим'), 'ответ получен');
check(body.includes('бесплатно'), 'стоимость показана');
check(body.includes('проверка блока кода'), 'markdown и блок кода отрендерены');

// Заголовок чата взялся из первого вопроса
check((await p.textContent('h1')) === 'Привет, проверка', 'авто-заголовок чата');

// История переживает перезагрузку
await p.reload({ waitUntil: 'networkidle' });
await p.waitForTimeout(1200);
check((await p.textContent('body')).includes('Привет, проверка'), 'история на месте после перезагрузки');

// Настройки: провайдеры и тема
await p.getByRole('link', { name: 'Настройки' }).click();
await p.waitForTimeout(600);
body = await p.textContent('body');
check(body.includes('Провайдеры'), 'настройки открылись');
check(body.includes('Добавить провайдера'), 'добавление провайдера доступно');
await p.getByRole('button', { name: 'Светлая' }).click();
await p.waitForTimeout(400);
check(await p.evaluate(() => document.documentElement.classList.contains('light')), 'светлая тема применилась');
await p.getByRole('button', { name: 'Тёмная' }).click();
await p.waitForTimeout(300);

// Форма провайдера с пресетами
await p.getByRole('button', { name: 'Добавить провайдера' }).click();
await p.waitForTimeout(500);
check((await p.textContent('body')).includes('Polza.ai'), 'пресеты агрегаторов в форме');
await p.getByRole('button', { name: 'Polza.ai' }).click();
await p.waitForTimeout(300);
// Ищем поле по placeholder, а не по индексу: в DOM одновременно есть и
// поля настроек, и поля панели провайдера.
check(
  (await p.getByPlaceholder('https://api.polza.ai/api/v1').inputValue()).includes('polza.ai'),
  'пресет подставил адрес API',
);

// Второй чат и переключение между ними
await p.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await p.waitForTimeout(600);
await p.getByRole('button', { name: 'Новый чат' }).first().click();
await p.waitForTimeout(700);
check((await p.textContent('h1')) === 'Новый чат', 'создан второй чат');
// Широкий экран: боковая панель постоянная, кнопки «Чаты» нет
check((await p.textContent('body')).includes('Привет, проверка'), 'первый чат виден в боковой панели');
check(await p.getByPlaceholder('Поиск').isVisible(), 'поиск по чатам на месте');
// Поиск фильтрует список
await p.getByPlaceholder('Поиск').fill('Привет');
await p.waitForTimeout(400);
check(!(await p.textContent('aside')).includes('Новый чат\n27'), 'поиск отфильтровал список');
await p.getByPlaceholder('Поиск').fill('');
// Переключатель модели в шапке
check(await p.getByRole('button', { expanded: false }).first().isVisible(), 'переключатель модели в шапке');

// Командная палитра
await p.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await p.waitForTimeout(600);
await p.keyboard.press('Control+k');
await p.waitForTimeout(500);
check(await p.getByPlaceholder('Команда, чат или модель…').isVisible(), 'палитра открылась по ⌘K');
await p.getByPlaceholder('Команда, чат или модель…').fill('сравн');
await p.waitForTimeout(300);
check((await p.textContent('[role=dialog]')).includes('сравнения'), 'палитра ищет команды');
await p.keyboard.press('Escape');
await p.waitForTimeout(300);
check(!(await p.locator('[role=dialog]').count()), 'палитра закрылась по Escape');

// Режим сравнения: нужно минимум две модели, поэтому заводим провайдера
await p.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
await p.waitForTimeout(500);
await p.getByRole('button', { name: 'Добавить провайдера' }).click();
await p.waitForTimeout(400);
await p.getByPlaceholder('Polza.ai', { exact: true }).fill('Тест');
await p.getByPlaceholder('https://api.polza.ai/api/v1').fill('https://example.invalid/v1');
await p.getByPlaceholder('claude-sonnet-5, gpt-5.6').fill('model-a, model-b');
await p.getByRole('button', { name: 'Сохранить' }).click();
await p.waitForTimeout(600);
await p.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await p.waitForTimeout(600);
check(await p.getByRole('button', { name: 'сравнить' }).isVisible(), 'кнопка сравнения в композере');
await p.getByRole('button', { name: 'сравнить' }).click();
await p.waitForTimeout(500);
check((await p.textContent('body')).includes('сравнить:'), 'панель выбора моделей раскрылась');

await p.screenshot({ path: 'dist/smoke-chat.png' });
await b.close();

const real = errors.filter((e) => !/Failed to load resource|net::ERR|Manifest|icon|sw\.js/i.test(e));
if (real.length) { console.log('\nОШИБКИ КОНСОЛИ:'); real.slice(0, 6).forEach((e) => console.log(' ', e)); }
console.log(pass && !real.length ? '\nSMOKE: ВСЁ ЗЕЛЁНОЕ' : '\nSMOKE: ЕСТЬ ПРОБЛЕМЫ');
