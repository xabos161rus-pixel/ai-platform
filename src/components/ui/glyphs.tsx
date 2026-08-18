// Фирменные глифы платформы. Один штрих 1.75, скруглённые стыки, поле 24,
// рисунок держится в 20 с полями по 2 — как рука Claude Code, а не стоковый
// набор. Каждая форма упрощена под РАБОЧИЙ размер 13–19px: у lucide многие
// иконки несут детали, которые на этих кеглях сливаются в кашу (шестерёнка,
// клавиатура с 12 клавишами, свиток с завитками) — здесь у каждого глифа
// остаётся ровно столько линий, сколько читается с одного взгляда.
//
// Имена экспортов совпадают с lucide-react намеренно: API тот же
// (size/className/strokeWidth), замена набора — это замена пути импорта,
// а не переименование ста использований.

import { forwardRef, type ReactNode, type SVGProps } from 'react';

interface GlyphProps extends SVGProps<SVGSVGElement> {
  size?: number | string;
  strokeWidth?: number | string;
}

function glyph(name: string, draw: ReactNode) {
  const C = forwardRef<SVGSVGElement, GlyphProps>(function Glyph(
    { size = 24, strokeWidth: sw = 1.75, className = '', ...rest },
    ref,
  ) {
    return (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={sw}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className={`glyph glyph-${name} ${className}`.trim()}
        {...rest}
      >
        {draw}
      </svg>
    );
  });
  C.displayName = name;
  return C;
}

// === Действия ===

export const ArrowUp = glyph('arrow-up', <path d="M12 19V5.4M6.6 10.8 12 5.4l5.4 5.4" />);

export const Check = glyph('check', <path d="m5 12.6 4.8 4.9L19 7" />);

export const Plus = glyph('plus', <path d="M12 5v14M5 12h14" />);

export const X = glyph('x', <path d="m6 6 12 12M18 6 6 18" />);

/** Копировать: два листа, задний без деталей — на 13px деталям не выжить. */
export const Copy = glyph(
  'copy',
  <>
    <rect x="9" y="9" width="11.5" height="11.5" rx="2" />
    <path d="M5.6 15H5.3A1.8 1.8 0 0 1 3.5 13.2V5.3A1.8 1.8 0 0 1 5.3 3.5h7.9A1.8 1.8 0 0 1 15 5.3v.3" />
  </>,
);

/** Повторить: незамкнутая дуга против часовой + стрелка на входе. */
export const RotateCcw = glyph(
  'rotate-ccw',
  <>
    <path d="M4.3 5.2v4.6h4.6" />
    <path d="M4.6 9.8a7.7 7.7 0 1 1-.3 4.4" />
  </>,
);

/** Карандаш: корпус одним контуром, без ластика и насечек. */
export const Pencil = glyph(
  'pencil',
  <path d="m4.5 19.5.9-3.7L16 5.2a2 2 0 0 1 2.8 2.8L8.2 18.6l-3.7.9ZM13.9 7.3l2.8 2.8" />,
);

/** Стоп: литой квадрат. Контурный на 14px выглядел рамкой без смысла. */
export const Square = glyph(
  'square-stop',
  <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />,
);

export const Trash2 = glyph(
  'trash',
  <>
    <path d="M4.5 6.5h15M9.7 6.3V5.2A1.7 1.7 0 0 1 11.4 3.5h1.2a1.7 1.7 0 0 1 1.7 1.7v1.1" />
    <path d="m6.2 6.9.7 11.4a2 2 0 0 0 2 1.9h6.2a2 2 0 0 0 2-1.9l.7-11.4" />
    <path d="M10 10.6v6M14 10.6v6" />
  </>,
);

export const Download = glyph(
  'download',
  <>
    <path d="M12 4.5v9.8M7.6 10 12 14.4 16.4 10" />
    <path d="M4.5 15.6V18a1.9 1.9 0 0 0 1.9 1.9h11.2A1.9 1.9 0 0 0 19.5 18v-2.4" />
  </>,
);

export const Upload = glyph(
  'upload',
  <>
    <path d="M12 14.3V4.5M7.6 8.9 12 4.5l4.4 4.4" />
    <path d="M4.5 15.6V18a1.9 1.9 0 0 0 1.9 1.9h11.2A1.9 1.9 0 0 0 19.5 18v-2.4" />
  </>,
);

export const Search = glyph(
  'search',
  <>
    <circle cx="11" cy="11" r="6.2" />
    <path d="m15.6 15.6 4.4 4.4" />
  </>,
);

/** Enter: угол вниз-влево со стрелкой — подпись хоткея в палитре. */
export const CornerDownLeft = glyph(
  'corner-down-left',
  <>
    <path d="M19 5.5v5.2a3 3 0 0 1-3 3H6.5" />
    <path d="M9.8 10.4 6.4 13.7l3.4 3.4" />
  </>,
);

/** Развернуть: две диагональные стрелки из центра в углы. */
export const Maximize2 = glyph(
  'maximize',
  <>
    <path d="M14.2 4.5h5.3v5.3M9.8 19.5H4.5v-5.3" />
    <path d="M19.2 4.8 13.6 10.4M4.8 19.2l5.6-5.6" />
  </>,
);

// === Навигация ===

export const ChevronDown = glyph('chevron-down', <path d="m6.6 9.6 5.4 5.3 5.4-5.3" />);
export const ChevronLeft = glyph('chevron-left', <path d="M14.6 6.6 9.2 12l5.4 5.4" />);
export const ChevronRight = glyph('chevron-right', <path d="M9.4 6.6 14.8 12l-5.4 5.4" />);

export const MoreHorizontal = glyph(
  'more-h',
  <>
    <circle cx="5.4" cy="12" r="1.15" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.15" fill="currentColor" stroke="none" />
    <circle cx="18.6" cy="12" r="1.15" fill="currentColor" stroke="none" />
  </>,
);

export const PanelLeft = glyph(
  'panel-left',
  <>
    <rect x="3.5" y="5" width="17" height="14" rx="2" />
    <path d="M9.6 5v14" />
  </>,
);

export const Columns2 = glyph(
  'columns',
  <>
    <rect x="3.5" y="5" width="17" height="14" rx="2" />
    <path d="M12 5v14" />
  </>,
);

// === Чат и содержимое ===

export const MessageSquare = glyph(
  'message',
  <path d="M20.5 14.6a1.9 1.9 0 0 1-1.9 1.9H8.2l-3.7 3.6V6.4a1.9 1.9 0 0 1 1.9-1.9h12.2a1.9 1.9 0 0 1 1.9 1.9z" />,
);

export const MessageSquarePlus = glyph(
  'message-plus',
  <>
    <path d="M20.5 14.6a1.9 1.9 0 0 1-1.9 1.9H8.2l-3.7 3.6V6.4a1.9 1.9 0 0 1 1.9-1.9h12.2a1.9 1.9 0 0 1 1.9 1.9z" />
    <path d="M12 7.6v5M9.5 10.1h5" />
  </>,
);

/** Файл: контур с загнутым углом и две строки — ровно то, что читается. */
export const FileText = glyph(
  'file-text',
  <>
    <path d="M13.6 3.5H7.3A1.8 1.8 0 0 0 5.5 5.3v13.4a1.8 1.8 0 0 0 1.8 1.8h9.4a1.8 1.8 0 0 0 1.8-1.8V8.4z" />
    <path d="M13.4 3.6v4.9h5" />
    <path d="M9 13h6M9 16.2h4.2" />
  </>,
);

/** Скрепка: одна плавная петля вместо двойного витка lucide. */
export const Paperclip = glyph(
  'paperclip',
  <path d="m16.9 11.2-5.9 5.9a3.4 3.4 0 0 1-4.8-4.8l7.3-7.3a2.4 2.4 0 0 1 3.4 3.4l-7.2 7.2a1.4 1.4 0 0 1-2-2l5.9-5.9" />,
);

/** Глобус: круг, экватор и один меридиан — сетка на 18px не читается. */
export const Globe = glyph(
  'globe',
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17M12 3.5c2.9 2.6 2.9 14.4 0 17-2.9-2.6-2.9-14.4 0-17Z" />
  </>,
);

/** Код: две угловые скобки без слэша — символ, а не синтаксис. */
export const Code2 = glyph(
  'code',
  <path d="M8.8 7.4 4.2 12l4.6 4.6M15.2 7.4 19.8 12l-4.6 4.6" />,
);

/** Свиток: лист с подвёрнутым нижним краем и строками. */
export const ScrollText = glyph(
  'scroll',
  <>
    <path d="M6.5 3.5h11A1.5 1.5 0 0 1 19 5v12.2a2.3 2.3 0 0 1-2.3 2.3H7.3A2.3 2.3 0 0 1 5 17.2V5a1.5 1.5 0 0 1 1.5-1.5Z" />
    <path d="M9 8.2h6M9 11.4h6M9 14.6h3.6" />
  </>,
);

export const Sparkles = glyph(
  'sparkles',
  <>
    <path d="M10.4 3.6 12.2 8.2 16.8 10 12.2 11.8 10.4 16.4 8.6 11.8 4 10l4.6-1.8z" />
    <path d="m17.8 14.6.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" />
  </>,
);

/** Корона (победитель сравнения): три зубца одним контуром, без камней. */
export const Crown = glyph(
  'crown',
  <path d="m4.5 8.6 3.6 3 3.9-5.3 3.9 5.3 3.6-3-1.5 9.2a1.5 1.5 0 0 1-1.5 1.2H7.5A1.5 1.5 0 0 1 6 18.8Z" />,
);

export const Eye = glyph(
  'eye',
  <>
    <path d="M2.8 12S6.3 5.7 12 5.7 21.2 12 21.2 12 17.7 18.3 12 18.3 2.8 12 2.8 12Z" />
    <circle cx="12" cy="12" r="2.7" />
  </>,
);

// === Папки и закрепление ===

export const Folder = glyph(
  'folder',
  <path d="M3.5 6.9A1.8 1.8 0 0 1 5.3 5.1h3.5l2 2.3h7.9a1.8 1.8 0 0 1 1.8 1.8v7.9a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8Z" />,
);

export const FolderInput = glyph(
  'folder-input',
  <>
    <path d="M3.5 9.5V6.9A1.8 1.8 0 0 1 5.3 5.1h3.5l2 2.3h7.9a1.8 1.8 0 0 1 1.8 1.8v7.9a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8v-.6" />
    <path d="M2.5 13.6h7.2M7.3 11.2l2.4 2.4-2.4 2.4" />
  </>,
);

/** Булавка: шляпка-капля и ножка — без перекладин lucide. */
export const Pin = glyph(
  'pin',
  <>
    <path d="M9.4 3.9h5.2l-.7 5.4 2.9 2.6a1 1 0 0 1-.7 1.7H7.9a1 1 0 0 1-.7-1.7l2.9-2.6z" />
    <path d="M12 13.8v6.3" />
  </>,
);

export const PinOff = glyph(
  'pin-off',
  <>
    <path d="M9.4 3.9h5.2l-.7 5.4 2.9 2.6a1 1 0 0 1-.7 1.7H7.9a1 1 0 0 1-.7-1.7l2.9-2.6z" />
    <path d="M12 13.8v6.3M4.5 4.5l15 15" />
  </>,
);

// === Система ===

/** Настройки: два ползунка — шестерёнка остаётся самым шумным глифом мира. */
export const Settings = glyph(
  'settings',
  <>
    <path d="M3.4 8.4h17.2M3.4 15.6h17.2" />
    <circle cx="9.2" cy="8.4" r="2.6" />
    <circle cx="15" cy="15.6" r="2.6" />
  </>,
);

/** Клавиатура: рамка, пробел и три клавиши — 12 точек lucide на 16px это шум. */
export const Keyboard = glyph(
  'keyboard',
  <>
    <rect x="3" y="6.5" width="18" height="11" rx="2" />
    <path d="M8 14.4h8M6.6 10h.01M12 10h.01M17.4 10h.01" />
  </>,
);

export const KeyRound = glyph(
  'key',
  <>
    <circle cx="8" cy="14.8" r="3.7" />
    <path d="m10.8 12 7.7-7.6M15 7.4l2.7 2.7" />
  </>,
);

export const Cloud = glyph(
  'cloud',
  <path d="M7.4 19.4a4.4 4.4 0 0 1-.5-8.8 5.6 5.6 0 0 1 10.7 1.5 3.9 3.9 0 0 1-.6 7.3z" />,
);

export const Sun = glyph(
  'sun',
  <>
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2.8v2M12 19.2v2M2.8 12h2M19.2 12h2" />
    <path d="M5.5 5.5 7 7M17 17l1.5 1.5M18.5 5.5 17 7M7 17l-1.5 1.5" />
  </>,
);

export const Moon = glyph(
  'moon',
  <path d="M19.4 14.3A7.9 7.9 0 1 1 9.7 4.6a6.3 6.3 0 0 0 9.7 9.7z" />,
);
