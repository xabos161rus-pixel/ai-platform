// Проверка контраста ключевых пар палитры в обеих темах по WCAG 2.1.
// Запуск: при поднятом `vite preview --port 4174 --base=/ai-platform/`
//   node scripts/contrast.mjs
// Норма AA для текста — 4.5:1, для крупного текста и не-текстовых
// элементов — 3:1. Смоук это не покрывает: он проверяет поведение, а не цвет.
// Палитра задана в oklch: canvas и getComputedStyle его не разворачивают,
// поэтому конвертируем сами (OKLab → linear sRGB → относительная яркость).
import { chromium } from 'playwright';
const BASE = 'http://localhost:4174/ai-platform';

function parseOklch(v) {
  // Браузер отдаёт переменные как «oklch(18.5% .004 75)» — с процентом и
  // без ведущего нуля.
  const m = /oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)/i.exec(v);
  if (!m) return null;
  return { L: m[2] ? +m[1] / 100 : +m[1], C: +m[3], H: +m[4] };
}
function oklchToLinearRgb({ L, C, H }) {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((x) => Math.min(1, Math.max(0, x)));
}
const lum = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
function ratio(fg, bg) {
  const a = parseOklch(fg), b = parseOklch(bg);
  if (!a || !b) return null;
  const [l1, l2] = [lum(oklchToLinearRgb(a)), lum(oklchToLinearRgb(b))].sort((x, y) => y - x);
  return +((l1 + 0.05) / (l2 + 0.05)).toFixed(2);
}

const b = await chromium.launch();
const c = await b.newContext({ locale: 'ru-RU', viewport: { width: 1280, height: 800 } });
const p = await c.newPage();
const vars = () =>
  p.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const names = ['--app-bg','--app-surface','--app-surface-2','--app-elevated','--app-text','--app-muted','--app-accent','--app-danger','--app-success','--app-warning','--cc-on-accent'];
    return Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(n).trim()]));
  });

const PAIRS = [
  ['текст / фон', '--app-text', '--app-bg'],
  ['текст / поверхность', '--app-text', '--app-surface'],
  ['текст / приподнятый', '--app-text', '--app-elevated'],
  ['приглушённый / фон', '--app-muted', '--app-bg'],
  ['приглушённый / поверхность-2', '--app-muted', '--app-surface-2'],
  ['акцент / фон', '--app-accent', '--app-bg'],
  ['текст-на-акценте / акцент', '--cc-on-accent', '--app-accent'],
  ['опасность / поверхность', '--app-danger', '--app-surface'],
  ['успех / поверхность', '--app-success', '--app-surface'],
  ['внимание / поверхность', '--app-warning', '--app-surface'],
];
async function report(title) {
  const v = await vars();
  console.log(`\n── ${title} ──`);
  for (const [name, fg, bg] of PAIRS) {
    const r = ratio(v[fg], v[bg]);
    const mark = r === null ? ' ?  ' : r >= 4.5 ? ' OK ' : r >= 3 ? 'круп' : 'МАЛО';
    console.log(` ${mark} ${String(r).padStart(6)}  ${name}`);
  }
}
await p.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
await p.waitForTimeout(800);
await p.getByRole('button', { name: 'Тёмная' }).click();
await p.waitForTimeout(400);
await report('ТЁМНАЯ');
await p.getByRole('button', { name: 'Светлая' }).click();
await p.waitForTimeout(400);
await report('СВЕТЛАЯ');
await p.getByRole('button', { name: 'Тёмная' }).click();
await p.waitForTimeout(300);
await b.close();
