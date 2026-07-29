import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// Метка сборки живёт в <meta> внутри index.html, а НЕ в JS через define:
// вшитая в бандл метка меняла бы контент-хэш чанка на каждой сборке.
const BUILD_ID = new Date().toISOString().replace('T', ' ').slice(0, 16)

// Путь GitHub Pages в проде, корень в dev. ВАЖНО: vite preview — это команда
// serve, поэтому base для неё надо передавать флагом: `--base=/ai-platform/`,
// иначе preview отдаёт ассеты не по тому пути и страница остаётся пустой.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/ai-platform/' : '/',
  build: {
    rollupOptions: {
      output: {
        // vendor-react: библиотеки фреймворка меняются реже кода приложения —
        // отдельный чанк кэшируется браузером между деплоями, где правится
        // только наш код. vendor-hljs: highlight.js и так грузится динамически
        // (см. CodeBlock.tsx), но без явного чанка попадал бы в общий
        // «остаток» вместе со случайными соседями по графу импортов.
        //
        // Функция, а не объект {chunkName: [pkg,...]}: это rolldown-vite
        // (см. node_modules/vite — обёртка над rolldown, не над rollup),
        // а его manualChunks принимает только ManualChunksFunction —
        // объектная форма классического Rollup здесь не типизирована.
        manualChunks(id) {
          if (!id.includes('node_modules')) {
            // src/lib и src/db — общий код между главным экраном и ленивым
            // экраном настроек (Dexie, chatRepo, i18n, модели): без явного
            // имени бандлер всё равно вынес бы их в отдельный общий чанк
            // (два входа делят модуль — дублировать код нельзя), но назвал бы
            // его в честь случайного компонента-импортёра. Явное имя читаемо
            // в таблице размеров README.
            if (/[/\\]src[/\\](lib|db)[/\\]/.test(id)) return 'app-shared';
            return;
          }
          if (/node_modules\/(react|react-dom|react-router|scheduler)\//.test(id)) return 'vendor-react';
          if (id.includes('node_modules/highlight.js')) return 'vendor-hljs';
          // pdfjs-dist грузится лениво только при первом PDF-вложении
          // (см. lib/files.ts) — отдельным чанком, не в общем остатке.
          if (id.includes('node_modules/pdfjs-dist')) return 'vendor-pdf';
        },
      },
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'build-id-meta',
      transformIndexHtml: () => [
        { tag: 'meta', attrs: { name: 'build-id', content: BUILD_ID }, injectTo: 'head' as const },
      ],
    },
    VitePWA({
      // autoUpdate, а не 'prompt': на iOS-PWA ручное «Обновить» ненадёжно —
      // пользователь застревает на старом кэше и не видит задеплоенных фиксов.
      registerType: 'autoUpdate',
      manifest: {
        name: 'AI Platform',
        short_name: 'AI',
        description: 'Работа с ИИ через API — свои ключи, свои модели',
        lang: 'ru',
        start_url: '/ai-platform/',
        scope: '/ai-platform/',
        display: 'standalone',
        orientation: 'portrait',
        // Совпадает с цветом каркаса в index.css — иначе в standalone на iOS
        // видна полоса другого оттенка у краёв.
        theme_color: '#1a1917',
        background_color: '#1a1917',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        navigateFallback: '/ai-platform/index.html',
        skipWaiting: true,
        clientsClaim: true,
      },
    }),
  ],
}))
