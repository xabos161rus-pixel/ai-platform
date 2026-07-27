// Smoke-тест: сквозной сценарий платформы в браузере.
// Запуск: npm run smoke — единственная автоматическая проверка в проекте.
import { chromium } from 'playwright';

const BASE = 'http://localhost:4174/ai-platform';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
// acceptDownloads — иначе событие 'download' для экспорта снапшота не долетает.
// locale: 'ru-RU' — иначе navigator.language в headless-браузере 'en-US', и
// resolveLang(undefined) (язык ещё не выбран пользователем) резолвится в
// English вместо ожидаемого рантаймом 'ru' по умолчанию: часть проверок ниже
// теперь читает текст, прошедший через t() (композер, T4).
const ctx = await b.newContext({ acceptDownloads: true, locale: 'ru-RU' });
const p = await ctx.newPage();
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
await p.getByPlaceholder('gpt-5.6').first().fill('model-a');
await p.getByRole('button', { name: 'добавить модель' }).click();
check((await p.getByPlaceholder('gpt-5.6').count()) === 2, 'вторая строка модели добавлена');
await p.getByPlaceholder('gpt-5.6').nth(1).fill('model-b');
await p.getByPlaceholder('₽ вход').first().fill('100');
await p.getByPlaceholder('₽ выход').first().fill('300');
await p.getByRole('button', { name: 'Сохранить' }).click();
await p.waitForTimeout(600);
// Цена модели и вторая строка пережили сохранение и переоткрытие формы
await p.getByRole('button', { name: 'Изменить' }).first().click();
await p.waitForTimeout(400);
check((await p.getByPlaceholder('₽ вход').first().inputValue()) === '100', 'цена модели провайдера сохранилась');
check((await p.getByPlaceholder('gpt-5.6').nth(1).inputValue()) === 'model-b', 'вторая модель провайдера сохранилась');
await p.keyboard.press('Escape');
await p.waitForTimeout(300);
await p.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await p.waitForTimeout(600);
check(await p.getByRole('button', { name: 'сравнить' }).isVisible(), 'кнопка сравнения в композере');
await p.getByRole('button', { name: 'сравнить' }).click();
await p.waitForTimeout(500);
check((await p.textContent('body')).includes('сравнить:'), 'панель выбора моделей раскрылась');

// Общий обработчик диалогов — ставим здесь, ПОСЛЕ всех сценариев со своими
// window.confirm выше (там подтверждений не было). Новые сценарии ниже сами
// провоцируют confirm (переименование не спрашивает, а вот экспорт и импорт —
// да), и без авто-accept они бы зависли на модалке браузера.
p.on('dialog', (d) => d.accept());

// Предыдущий блок оставил включённым режим сравнения (2 модели без ключа) —
// выключаем, иначе дальнейшая «Отправить» уходит в сравнение, а не в обычный ask().
await p.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await p.waitForTimeout(500);
const compareOff = p.getByRole('button', { name: 'Выключить сравнение' });
if (await compareOff.isVisible().catch(() => false)) {
  await compareOff.click();
  await p.waitForTimeout(300);
}

// Переименование чата
await p.goto(`${BASE}/`);
await p.waitForTimeout(600);
await p.locator('aside .group').first().hover();
await p.getByRole('button', { name: 'Действия с чатом' }).first().click();
await p.waitForTimeout(300);
await p.getByRole('button', { name: 'Переименовать' }).click();
await p.waitForTimeout(300);
await p.getByLabel('Новое название').fill('Переименованный');
await p.keyboard.press('Enter');
await p.waitForTimeout(500);
check((await p.textContent('aside')).includes('Переименованный'), 'чат переименован из меню');

// Папка: тот же чат — снова меню → «В папку…» → новое имя папки
await p.locator('aside .group').first().hover();
await p.getByRole('button', { name: 'Действия с чатом' }).first().click();
await p.waitForTimeout(300);
await p.getByRole('button', { name: 'В папку…' }).click();
await p.waitForTimeout(300);
await p.getByPlaceholder('Новая папка').fill('Работа');
await p.keyboard.press('Enter');
await p.waitForTimeout(500);
check((await p.textContent('aside')).includes('Работа'), 'чат перенесён в новую папку');
// Клик по заголовку папки сворачивает список — чат внутри должен пропасть из aside
await p.getByText('Работа', { exact: false }).first().click();
await p.waitForTimeout(400);
check(!(await p.textContent('aside')).includes('Переименованный'), 'папка сворачивается');

// Роль и системный промпт: разворачиваем папку обратно и открываем чат из неё
await p.getByText('Работа', { exact: false }).first().click();
await p.waitForTimeout(400);
await p.getByText('Переименованный', { exact: false }).first().click();
await p.waitForTimeout(500);
await p.getByRole('button', { name: 'Системный промпт' }).click();
await p.waitForTimeout(400);
check((await p.textContent('body')).includes('Параметры'), 'блок параметров чата под промптом');
// Слайдер температуры не поддерживает fill() (Playwright это запрещает для
// input[type=range]) — двигаем значением через нативный сеттер прототипа:
// простое el.value = v проходит через сеттер, который React уже подменил
// своим трекером, и синтетический onChange после такого не срабатывает.
await p.locator('input[type=range]').evaluate((el, v) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, '1.5');
await p.getByPlaceholder('—').fill('500');
await p.getByText('Бизнес-аналитик').first().click();
await p.waitForTimeout(300);
await p.getByRole('button', { name: 'Сохранить', exact: true }).click();
await p.waitForTimeout(400);
await p.getByPlaceholder('Спросите что угодно…').fill('проверка роли');
await p.getByRole('button', { name: 'Отправить' }).click();
await p.waitForTimeout(2000);
check((await p.textContent('body')).includes('системный промпт задан'), 'роль дошла до запроса');

// Параметры чата пережили сохранение и переоткрытие
await p.getByRole('button', { name: 'Системный промпт' }).click();
await p.waitForTimeout(400);
check((await p.getByPlaceholder('—').inputValue()) === '500', 'максимум токенов сохранён');
check((await p.textContent('body')).includes('1.5'), 'температура сохранена');
await p.getByRole('button', { name: 'Сбросить' }).click();
await p.waitForTimeout(200);
check((await p.textContent('body')).includes('по умолчанию'), 'сброс температуры возвращает значение по умолчанию');
await p.keyboard.press('Escape');
await p.waitForTimeout(300);

// Мысли модели: демо-ответ по умолчанию (demo-echo) шлёт синтетическое reasoning
check((await p.textContent('body')).includes('мысли модели'), 'reasoning-блок у демо-ответа');

// Экспорт снапшота
await p.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
await p.waitForTimeout(500);
const dlPromise = p.waitForEvent('download');
await p.getByRole('button', { name: 'Скачать снапшот (JSON)' }).click();
const dl = await dlPromise;
check(dl.suggestedFilename().startsWith('ai-platform-backup'), 'снапшот скачивается');
const dlPath = await dl.path();

// Импорт того же снапшота — bulkPut идемпотентен, дублей быть не должно
await p.locator('input[type=file][accept*="json"]').setInputFiles(dlPath);
await p.waitForTimeout(800);
check((await p.textContent('body')).includes('Восстановлено'), 'импорт отчитался о восстановлении');

// Разбивка расходов по моделям — демо-модель показывается «бесплатно», но попадает в список
check((await p.textContent('body')).includes('Демо · подробный'), 'разбивка расходов по моделям');

// ── T8: дизайн-люкс ────────────────────────────────────────────────
// Более ранний сценарий (сравнение моделей) сделал активным провайдером
// добавленный «Тест» без ключа — новые чаты ниже наследуют его и падают
// синхронной ошибкой вместо демо-стрима. Возвращаем активным демо-провайдера.
await p.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
await p.waitForTimeout(500);
await p.getByText('Демо (без ключа)').first().click();
await p.waitForTimeout(300);

// Приветственные чипы: показываются на пустом чате, клик вставляет текст без отправки.
await p.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await p.waitForTimeout(600);
await p.getByRole('button', { name: 'Новый чат' }).first().click();
await p.waitForTimeout(600);
check((await p.textContent('body')).includes('Разбери этот документ по пунктам'), 'приветственные чипы показаны на пустом чате');
await p.getByRole('button', { name: 'Разбери этот документ по пунктам' }).click();
await p.waitForTimeout(300);
check(
  (await p.getByPlaceholder('Спросите что угодно…').inputValue()) === 'Разбери этот документ по пунктам',
  'чип вставил текст в композер без отправки',
);

// Esc останавливает активную генерацию (приоритет над просмотрщиком изображения)
await p.getByRole('button', { name: 'Отправить' }).click();
await p.waitForTimeout(120);
await p.keyboard.press('Escape');
await p.waitForTimeout(1000);
// Прервано до первого куска ответа → error.aborted ('Остановлено.'); прервано
// после — stoppedNote ('_(остановлено)_'). Оба варианта — честный «стоп»,
// сравниваем регистронезависимо, чтобы не зависеть от того, какая ветка сработала.
check((await p.textContent('body')).toLowerCase().includes('остановлено'), 'Esc останавливает активную генерацию');

// ↑ в пустом композере правит последний свой вопрос
await p.getByPlaceholder('Спросите что угодно…').click();
await p.keyboard.press('ArrowUp');
await p.waitForTimeout(300);
check((await p.textContent('body')).includes('Отмена'), '↑ в пустом поле открыло правку последнего сообщения');
await p.keyboard.press('Escape');
await p.waitForTimeout(300);

// ⌘B сворачивает и разворачивает постоянный сайдбар на широком экране; состояние переживает перезагрузку
check(await p.locator('aside').first().isVisible(), 'сайдбар виден по умолчанию');
await p.keyboard.press('Control+b');
await p.waitForTimeout(300);
check(!(await p.locator('aside').first().isVisible()), 'сайдбар свернулся по ⌘B');
await p.reload({ waitUntil: 'networkidle' });
await p.waitForTimeout(700);
check(!(await p.locator('aside').first().isVisible()), 'свёрнутое состояние сайдбара пережило перезагрузку');
await p.getByRole('button', { name: 'Показать чаты' }).click();
await p.waitForTimeout(300);
check(await p.locator('aside').first().isVisible(), 'сайдбар развернулся обратно по кнопке в шапке');

// Справка по клавишам: из настроек и из палитры по запросу «?»
await p.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
await p.waitForTimeout(500);
await p.getByRole('button', { name: 'Быстрые клавиши' }).click();
await p.waitForTimeout(400);
check((await p.textContent('body')).includes('Командная палитра'), 'справка по клавишам открылась из настроек');
await p.keyboard.press('Escape');
await p.waitForTimeout(300);
await p.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await p.waitForTimeout(500);
await p.keyboard.press('Control+k');
await p.waitForTimeout(400);
await p.getByPlaceholder('Команда, чат или модель…').fill('?');
await p.waitForTimeout(300);
const firstCmdLabel = await p.locator('[role=dialog] button').first().textContent();
check((firstCmdLabel ?? '').includes('Быстрые клавиши'), 'запрос «?» поднимает справку по клавишам первой в палитре');
await p.keyboard.press('Escape');
await p.waitForTimeout(300);

// Аврора: fixed-слой с градиентом позади контента, без горизонтального скролла
const auroraBg = await p.evaluate(() => {
  const el = document.querySelector('.cc-aurora');
  return el ? getComputedStyle(el).backgroundImage : '';
});
check(auroraBg.includes('gradient'), 'аврора отрисована фоновым градиентом');
check(
  await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
  'аврора не создаёт горизонтального скролла',
);

// prefers-reduced-motion отключает анимацию появления сообщений
await p.emulateMedia({ reducedMotion: 'reduce' });
await p.getByPlaceholder('Спросите что угодно…').fill('проверка reduced motion');
await p.getByRole('button', { name: 'Отправить' }).click();
await p.waitForTimeout(1500);
const msgAnimName = await p.evaluate(() => {
  const el = document.querySelector('.animate-msg-in');
  return el ? getComputedStyle(el).animationName : null;
});
check(msgAnimName === 'none', 'prefers-reduced-motion отключает анимацию появления сообщений');
await p.emulateMedia({ reducedMotion: null });

// Мобильная эмуляция (390×844, touch): композер и меню сниппетов без ошибок консоли
const mobileErrors = [];
const mobileCtx = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'ru-RU' });
const mp = await mobileCtx.newPage();
mp.on('pageerror', (e) => mobileErrors.push(`pageerror: ${e.message}`));
mp.on('console', (m) => { if (m.type() === 'error') mobileErrors.push(`console: ${m.text().slice(0, 160)}`); });
await mp.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await mp.waitForTimeout(700);
await mp.getByPlaceholder('Спросите что угодно…').fill('/');
await mp.waitForTimeout(300);
check((await mp.locator('[role=listbox]').count()) > 0, 'меню сниппетов открылось в мобильной эмуляции');
await mp.getByPlaceholder('Спросите что угодно…').fill('');
const mobileReal = mobileErrors.filter((e) => !/Failed to load resource|net::ERR|Manifest|icon|sw\.js/i.test(e));
check(mobileReal.length === 0, 'мобильная эмуляция композера без ошибок консоли (visualViewport)');
await mobileCtx.close();

// ── T9: оптимизация — ветвление, регенерация, artifacts, сниппеты, цены,
// поиск по содержимому, i18n, ⌘B. Свежий чат — детерминированное состояние,
// не зависящее от того, что накопилось в предыдущих сценариях.
await p.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await p.waitForTimeout(500);
await p.getByRole('button', { name: 'Новый чат' }).first().click();
await p.waitForTimeout(500);

// ВЕТВЛЕНИЕ: правка вопроса создаёт сиблинга, а не стирает историю.
await p.getByPlaceholder('Спросите что угодно…').fill('Ветвление: исходный вопрос');
await p.getByRole('button', { name: 'Отправить' }).click();
await p.waitForTimeout(2000);
// Пузырь вопроса открывает правку только по наведению (кнопки скрыты
// opacity-0 до hover) — наводим на пузырь перед кликом по «Изменить».
// Ищем строго в ленте сообщений (.max-w-3xl.space-y-5), а не по всей странице:
// строка чата в сайдбаре тоже несёт класс group и тот же текст заголовка.
const messageList = p.locator('.max-w-3xl.space-y-5');
const qBubbleV1 = messageList.locator('.group').filter({ hasText: 'Ветвление: исходный вопрос' }).first();
await qBubbleV1.hover();
await qBubbleV1.getByRole('button', { name: 'Изменить' }).click();
await p.waitForTimeout(300);
// Textarea EditBox — единственная без placeholder (у композера и у листов
// персоны/сниппета placeholder всегда задан), поэтому CSS-селектор её
// однозначно отличает без обращения к текущему value.
await p.locator('textarea:not([placeholder])').fill('Правка вопроса');
await p.keyboard.press('Enter');
await p.waitForTimeout(2000);
body = await p.textContent('body');
check(body.includes('2/2'), 'ветвление: правка стала версией 2/2, а не заменой');
check(body.includes('Правка вопроса'), 'ветвление: демо-ответ отвечает на актуальный (правленый) вопрос');
const prevVersionBtn = p.getByRole('button', { name: 'Предыдущая версия' });
await prevVersionBtn.hover();
await prevVersionBtn.click();
await p.waitForTimeout(400);
body = await p.textContent('body');
check(body.includes('1/2'), 'ветвление: ‹ переключил на версию 1/2');
check(body.includes('Ветвление: исходный вопрос'), 'ветвление: ‹ вернул текст исходного (до правки) вопроса');
const nextVersionBtn = p.getByRole('button', { name: 'Следующая версия' });
await nextVersionBtn.hover();
await nextVersionBtn.click();
await p.waitForTimeout(400);
body = await p.textContent('body');
check(body.includes('Правка вопроса'), 'ветвление: › вернул правку — контекст следует за активной веткой');

// РЕГЕНЕРАЦИЯ: «Повторить» → другая модель → сиблинг-ответ, старый не стирается.
const retryBtn = p.getByRole('button', { name: 'Повторить' });
await retryBtn.hover();
await retryBtn.click();
await p.waitForTimeout(300);
await p.getByRole('button', { name: 'Демо · краткий', exact: true }).click();
await p.waitForTimeout(2000);
body = await p.textContent('body');
check(body.includes('Демо · краткий'), 'регенерация: ответ другой модели пришёл и виден в ленте');
const versionBadges = body.match(/\d\/2/g) ?? [];
check(versionBadges.length >= 2, 'регенерация: у ответа (не только у вопроса) появился переключатель версий');

// ARTIFACTS: html-блок в демо-ответе → предпросмотр в песочнице без allow-same-origin.
await p.getByPlaceholder('Спросите что угодно…').fill('покажи html демо');
await p.getByRole('button', { name: 'Отправить' }).click();
await p.waitForTimeout(3000);
const previewBtn = p.getByRole('button', { name: 'Предпросмотр' }).first();
check(await previewBtn.isVisible(), 'artifacts: кнопка «Предпросмотр» видна у html-блока');
await previewBtn.click();
await p.waitForTimeout(300);
const sandboxFrame = p.locator('iframe[sandbox="allow-scripts"]');
check((await sandboxFrame.count()) > 0, 'artifacts: iframe с sandbox="allow-scripts" существует');
check(
  (await sandboxFrame.first().getAttribute('sandbox')) === 'allow-scripts',
  'artifacts: iframe БЕЗ allow-same-origin (opaque origin, нет доступа к IndexedDB с ключами)',
);

// СНИППЕТЫ: «/» в пустом композере открывает меню, клик по строке вставляет текст.
const composerInput = p.getByPlaceholder('Спросите что угодно…');
await composerInput.fill('');
await composerInput.pressSequentially('/');
await p.waitForTimeout(300);
check((await p.textContent('body'))?.includes('Краткая выжимка') ?? false, 'сниппеты: список открылся и виден встроенный сниппет');
await p.getByRole('option').first().click();
await p.waitForTimeout(200);
const draftAfterSnippet = await composerInput.inputValue();
check(draftAfterSnippet.length > 0 && draftAfterSnippet !== '/', 'сниппеты: клик по строке вставил текст в композер');
await composerInput.fill('');

// ЦЕНЫ: провайдер «Тест» (заведён в сценарии сравнения выше) — цены модели переживают Сохранить+переоткрытие.
await p.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
await p.waitForTimeout(500);
await p.getByRole('button', { name: 'Изменить' }).first().click();
await p.waitForTimeout(400);
await p.getByPlaceholder('₽ вход').first().fill('100');
await p.getByPlaceholder('₽ выход').first().fill('200');
await p.getByRole('button', { name: 'Сохранить' }).click();
await p.waitForTimeout(500);
await p.getByRole('button', { name: 'Изменить' }).first().click();
await p.waitForTimeout(400);
check((await p.getByPlaceholder('₽ вход').first().inputValue()) === '100', 'цены: цена входа 100 сохранилась и видна при переоткрытии');
check((await p.getByPlaceholder('₽ выход').first().inputValue()) === '200', 'цены: цена выхода 200 сохранилась и видна при переоткрытии');
await p.keyboard.press('Escape');
await p.waitForTimeout(300);

// ПОИСК ПО СОДЕРЖИМОМУ: фраза встречается только в теле демо-ответа (js-комментарий), не в заголовках чатов.
await p.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await p.waitForTimeout(500);
await p.getByPlaceholder('Поиск').fill('проверка блока');
await p.waitForTimeout(600);
const asideSearchText = (await p.locator('aside').first().textContent()) ?? '';
check(asideSearchText.includes('проверка блока'), 'поиск: выдача содержит фрагмент содержимого');
const firstHitButton = p.locator('aside nav button').first();
const firstHitTitle = ((await firstHitButton.locator('span').first().textContent()) ?? '').trim();
check(firstHitTitle.length > 0, 'поиск: у результата есть заголовок чата');
await firstHitButton.click();
await p.waitForTimeout(400);
check((await p.textContent('h1'))?.trim() === firstHitTitle, 'поиск: клик по результату открывает этот чат');
await p.getByPlaceholder('Поиск').fill('');
await p.waitForTimeout(300);

// I18N: настройки → English → обратно Русский, оба экрана переведены.
await p.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
await p.waitForTimeout(500);
await p.getByRole('button', { name: 'English' }).click();
await p.waitForTimeout(400);
body = await p.textContent('body');
check(body.includes('Providers') || body.includes('New chat'), 'i18n: переключение на English применилось к интерфейсу');
await p.getByRole('button', { name: 'Русский' }).click();
await p.waitForTimeout(400);
body = await p.textContent('body');
check(body.includes('Провайдеры'), 'i18n: возврат на Русский применился к интерфейсу');

// ⌘B: на главном экране Control+b скрывает и возвращает постоянный сайдбар.
await p.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await p.waitForTimeout(500);
check(await p.locator('aside').first().isVisible(), '⌘B: сайдбар виден до переключения');
await p.keyboard.press('Control+b');
await p.waitForTimeout(300);
check(await p.locator('aside').first().isHidden(), '⌘B: сайдбар скрылся');
await p.keyboard.press('Control+b');
await p.waitForTimeout(300);
check(await p.locator('aside').first().isVisible(), '⌘B: сайдбар снова виден');

// ── T10: регресс дефекта toContext — упавшая колонка-0 сравнения не должна
// вытеснять из контекста успешный ответ соседней колонки, если пользователь
// не нажал «выбрать» вручную (см. фикс в src/lib/ai/chatRepo.ts toContext()).
await p.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await p.waitForTimeout(500);
await p.getByRole('button', { name: 'Новый чат' }).first().click();
await p.waitForTimeout(500);

// Порядок picks (кто получит runIndex 0, а кто 1) через клики по CompareBar
// детерминированно не собрать — итог зависит от того, какие два пункта
// панель включит по умолчанию. Пишем settings.compareModels напрямую в
// IndexedDB: провайдер «Тест» (заведён без API-ключа в сценарии сравнения
// выше) — runIndex 0, он гарантированно падает синхронной AiError('no_key')
// ещё до сети; демо-провайдер — runIndex 1, отвечает всегда.
await p.evaluate(async () => {
  const idb = await new Promise((resolve, reject) => {
    const req = indexedDB.open('ai-platform');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const tx = idb.transaction(['providers', 'settings'], 'readwrite');
  const providers = await new Promise((resolve, reject) => {
    const r = tx.objectStore('providers').getAll();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const demo = providers.find((pr) => pr.isDemo);
  const noKeyProv = providers.find((pr) => !pr.isDemo && !pr.apiKey);
  const settings = await new Promise((resolve, reject) => {
    const r = tx.objectStore('settings').get('app');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  settings.compareModels = [`${noKeyProv.id}:model-a`, `${demo.id}:demo-echo`];
  tx.objectStore('settings').put(settings);
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  idb.close();
});
await p.reload({ waitUntil: 'networkidle' });
await p.waitForTimeout(600);

// Раунд сравнения: колонка-0 падает (нет ключа), колонка-1 (демо) успешна.
// «Выбрать» НЕ нажимаем — именно этот случай раньше терял успешный ответ.
await p.getByPlaceholder('Спросите что угодно…').fill('Раунд сравнения без выбора победителя');
await p.getByRole('button', { name: 'Отправить' }).click();
await p.waitForTimeout(2000);
body = await p.textContent('body');
check(body.includes('У провайдера не задан API-ключ.'), 'toContext-регресс: колонка без ключа показала ошибку');
check(body.includes('Демо-режим'), 'toContext-регресс: колонка демо ответила успешно');

// Выключаем сравнение и задаём обычный вопрос той же демо-моделью.
const compareOffBtn2 = p.getByRole('button', { name: 'Выключить сравнение' });
if (await compareOffBtn2.isVisible().catch(() => false)) {
  await compareOffBtn2.click();
  await p.waitForTimeout(300);
}
await p.getByPlaceholder('Спросите что угодно…').fill('Обычный вопрос после сравнения');
await p.getByRole('button', { name: 'Отправить' }).click();
await p.waitForTimeout(2000);
body = await p.textContent('body');
// Ожидаемый контекст: вопрос-1 (сравнение) + успешный ответ демо-колонки +
// вопрос-2 = 3. До фикса победителем по умолчанию считался участник с
// минимальным runIndex СРЕДИ ВСЕХ (включая упавших) — упавшая колонка-0
// побеждала, а единственный успешный ответ раунда молча пропадал из
// контекста, и счётчик показывал бы 2.
check(body.includes('Сообщений в контексте: 3'), 'toContext-регресс: успешный ответ сравнения остался в контексте без явного выбора');

await p.screenshot({ path: 'dist/smoke-chat.png' });
await b.close();

const real = errors.filter((e) => !/Failed to load resource|net::ERR|Manifest|icon|sw\.js/i.test(e));
if (real.length) { console.log('\nОШИБКИ КОНСОЛИ:'); real.slice(0, 6).forEach((e) => console.log(' ', e)); }
console.log(pass && !real.length ? '\nSMOKE: ВСЁ ЗЕЛЁНОЕ' : '\nSMOKE: ЕСТЬ ПРОБЛЕМЫ');
