// След агентского цикла (шаги вызова инструментов) — переиспользуется и в
// живом стриме (live=true, строки видны сразу), и в готовом сообщении из
// истории (свёрнуто под заголовком-счётчиком, как ReasoningBlock).
//
// Отдельный файл по той же причине, что и ReasoningBlock: используется и в
// ChatPage напрямую (Streaming/AssistantBlock), и потенциально в других
// местах ленты — импорт из ChatPage дал бы цикл.

import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { ToolStep } from '../../db/types';
import { useT, type TKey } from '../../lib/i18n';

const TOOL_LABEL_KEY: Record<string, TKey> = {
  web_search: 'tool.web_search',
  read_page: 'tool.read_page',
  get_time: 'tool.get_time',
};

/** Аргумент строкой для строки шага: у известных инструментов — конкретное поле, иначе — сырой JSON. */
function stepArg(tool: string, args: Record<string, unknown>): string | undefined {
  if (tool === 'web_search') return String(args.query ?? '');
  if (tool === 'read_page') return String(args.url ?? '');
  if (Object.keys(args).length === 0) return undefined;
  return JSON.stringify(args).slice(0, 80);
}

function StepRow({ step, expanded, onToggle }: { step: ToolStep; expanded: boolean; onToggle: () => void }) {
  const t = useT();
  const labelKey = TOOL_LABEL_KEY[step.tool];
  const label = labelKey ? t(labelKey) : step.tool;
  const arg = stepArg(step.tool, step.args);
  return (
    <div>
      <button
        onClick={onToggle}
        className="flex min-h-[var(--cc-touch)] w-full items-center gap-1.5 text-left font-mono text-[length:var(--cc-text-caption)] text-muted transition-colors hover:text-text active:opacity-60"
      >
        <span aria-hidden>▸</span>
        <span className="truncate">
          {label}
          {arg ? `: ${arg}` : ''}
        </span>
        <span className="ml-auto shrink-0 pl-2">
          {step.status === 'running' ? (
            <span className="animate-caret text-accent">▍</span>
          ) : step.status === 'error' ? (
            <span className="text-danger">✗</span>
          ) : (
            <span>✓</span>
          )}
        </span>
      </button>
      {expanded && step.result ? (
        <div className="mb-1 max-h-64 overflow-y-auto border-l-2 border-hairline pl-3 font-mono text-[length:var(--cc-text-meta)] whitespace-pre-wrap text-muted">
          {step.result}
        </div>
      ) : null}
    </div>
  );
}

export function ToolTrace({ steps, live }: { steps: ToolStep[]; live?: boolean }) {
  const t = useT();
  // Раскрытые строки — по step.id, независимо от live/история.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Свёрнутость всего блока — только в режиме истории (live не сворачивается).
  const [historyOpen, setHistoryOpen] = useState(false);

  if (!steps.length) return null;

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const rows = (
    <div className="space-y-0.5">
      {steps.map((step) => (
        <StepRow key={step.id} step={step} expanded={expanded.has(step.id)} onToggle={() => toggle(step.id)} />
      ))}
    </div>
  );

  if (live) return <div className="mb-2">{rows}</div>;

  return (
    <div className="mb-2">
      <button
        onClick={() => setHistoryOpen((v) => !v)}
        className="flex items-center gap-1 font-mono text-[length:var(--cc-text-caption)] text-muted transition-colors hover:text-text active:opacity-60"
      >
        <ChevronRight size={12} className={`transition-transform ${historyOpen ? 'rotate-90' : ''}`} />
        {t('trace.label', { n: steps.length })}
      </button>
      {historyOpen && <div className="mt-1">{rows}</div>}
    </div>
  );
}
