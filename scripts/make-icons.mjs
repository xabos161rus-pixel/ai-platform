// Генерация иконок PWA из SVG: браузер рендерит разметку и снимает PNG нужного
// размера. Так иконка правится как код, без графического редактора.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const CLAY = '#D97757';
const INK = '#1a1917';

// Значок: клай-скобка ⟩ и каретка — символы командной строки, из языка
// которой взят весь дизайн платформы.
const svg = (bg, fg, pad) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="${pad ? 0 : 112}" fill="${bg}"/>
  <g stroke="${fg}" stroke-width="34" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M176 186 L246 256 L176 326"/>
    <path d="M286 330 L336 330"/>
  </g>
</svg>`;

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await b.newPage();

async function shot(file, size, markup) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<body style="margin:0"><div style="width:${size}px;height:${size}px">${markup}</div></body>`,
  );
  writeFileSync(file, await page.screenshot({ omitBackground: false }));
  console.log('✓', file);
}

await shot('public/icons/icon-192.png', 192, svg(INK, CLAY, false));
await shot('public/icons/icon-512.png', 512, svg(INK, CLAY, false));
// maskable: без скругления и с запасом полей — система обрежет сама.
await shot('public/icons/maskable-512.png', 512, svg(INK, CLAY, true));
await shot('public/apple-touch-icon.png', 180, svg(INK, CLAY, false));
writeFileSync('public/favicon.svg', svg(INK, CLAY, false).trim());
console.log('✓ public/favicon.svg');

await b.close();
