// Дерево версий чата — чистые функции без обращений к БД.
//
// КОНТРАКТ: каждая функция принимает `messages` — живые (не удалённые)
// сообщения ОДНОГО чата, отсортированные по createdAt по возрастанию.
// Модуль не читает и не пишет Dexie: вызывающий сам делает выборку и сортировку.
//
// Модель: у сообщения есть явный parentId (string — конкретный родитель,
// null — корень), либо parentId===undefined — legacy-сообщение из линейной
// цепочки старых чатов, для которого эффективный родитель вычисляется по
// позиции в массиве (предыдущее сообщение). runId-группа сравнения (несколько
// ответов на один вопрос) — АТОМАРНЫЙ узел дерева: представитель группы —
// участник с минимальным runIndex, и только представитель фигурирует как
// родитель/ребёнок в дереве.
//
// ИНВАРИАНТЫ:
// (а) для чата, где ВСЕ parentId===undefined, buildPath(msgs, что_угодно)
//     === msgs в исходном порядке — линейный чат остаётся веткой глубины N
//     без единой записи в БД;
// (б) члены одной runId-группы никогда не расходятся по разным веткам —
//     эффективный родитель члена группы всегда равен эффективному родителю
//     представителя;
// (в) activeLeafId после любой операции указывает на живое сообщение либо null;
// (г) переключатель версий (siblingsOf/switchSibling) считает узлы
//     (представителей), а не отдельных членов runId-групп.

import type { Message } from '../../db/types';

/** Представитель runId-группы: участник с минимальным runIndex. Для одиночного сообщения — оно само. */
export function nodeOf(messages: Message[], m: Message): Message {
  if (!m.runId) return m;
  let rep = m;
  for (const x of messages) {
    if (x.runId === m.runId && (x.runIndex ?? 0) < (rep.runIndex ?? 0)) rep = x;
  }
  return rep;
}

/** Эффективный родитель узла-представителя: явный parentId, если задан, иначе legacy-правило по позиции в массиве. */
function repParent(messages: Message[], rep: Message): string | null {
  if (rep.parentId !== undefined) return rep.parentId;
  const idx = messages.findIndex((x) => x.id === rep.id);
  if (idx <= 0) return null;
  return nodeOf(messages, messages[idx - 1]).id;
}

/**
 * Эффективный родитель КАЖДОГО сообщения (не только представителей): член
 * runId-группы наследует родителя представителя своей группы — инвариант (б).
 */
export function parentMap(messages: Message[]): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const m of messages) {
    map.set(m.id, repParent(messages, nodeOf(messages, m)));
  }
  return map;
}

/** Узлы-представители с данным эффективным родителем, по возрастанию createdAt. */
export function childrenOf(messages: Message[], parentId: string | null): Message[] {
  const pm = parentMap(messages);
  const reps = new Map<string, Message>();
  for (const m of messages) {
    if (pm.get(m.id) !== parentId) continue;
    const rep = nodeOf(messages, m);
    if (!reps.has(rep.id)) reps.set(rep.id, rep);
  }
  return [...reps.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Версии узла `id`: представители с тем же эффективным родителем + позиция переданного узла в этом списке. */
export function siblingsOf(messages: Message[], id: string): { list: Message[]; index: number } {
  const target = messages.find((m) => m.id === id);
  if (!target) return { list: [], index: -1 };
  const rep = nodeOf(messages, target);
  const pm = parentMap(messages);
  const parentId = pm.get(target.id) ?? null;
  const list = childrenOf(messages, parentId);
  return { list, index: list.findIndex((m) => m.id === rep.id) };
}

/** Спуск от узла: на каждом шаге ребёнок с максимальным createdAt. Возвращает id листа-представителя. */
export function deepestLeaf(messages: Message[], fromId: string): string {
  const startMsg = messages.find((m) => m.id === fromId);
  let current = startMsg ? nodeOf(messages, startMsg).id : fromId;
  for (;;) {
    const kids = childrenOf(messages, current);
    if (!kids.length) return current;
    current = kids[kids.length - 1].id; // sorted asc — последний = самый свежий
  }
}

/**
 * Путь корень→лист. runId-группы разворачиваются на месте представителя всеми
 * членами по runIndex. Если activeLeafId пуст/не найден/удалён — fallback:
 * deepestLeaf от самого свежего корня среди childrenOf(null).
 */
export function buildPath(messages: Message[], activeLeafId?: string | null): Message[] {
  if (!messages.length) return [];
  const pm = parentMap(messages);
  const byId = new Map(messages.map((m) => [m.id, m]));

  let leafRepId: string | null = null;
  if (activeLeafId) {
    const found = byId.get(activeLeafId);
    if (found) leafRepId = nodeOf(messages, found).id;
  }
  if (leafRepId === null) {
    const roots = childrenOf(messages, null);
    if (!roots.length) return [];
    leafRepId = deepestLeaf(messages, roots[roots.length - 1].id);
  }

  // Цепочка id представителей от листа к корню.
  const chain: string[] = [];
  const guard = new Set<string>(); // защита от цикла в повреждённых данных
  let cur: string | null = leafRepId;
  while (cur !== null && !guard.has(cur)) {
    guard.add(cur);
    chain.push(cur);
    cur = pm.get(cur) ?? null;
  }
  chain.reverse();

  const result: Message[] = [];
  const emittedRuns = new Set<string>();
  for (const repId of chain) {
    const rep = byId.get(repId);
    if (!rep) continue;
    if (rep.runId) {
      if (emittedRuns.has(rep.runId)) continue;
      emittedRuns.add(rep.runId);
      const group = messages.filter((x) => x.runId === rep.runId).sort((a, b) => (a.runIndex ?? 0) - (b.runIndex ?? 0));
      result.push(...group);
    } else {
      result.push(rep);
    }
  }
  return result;
}

/** Соседняя версия узла currentId. За краем списка версий — null (не по кругу). */
export function switchSibling(messages: Message[], currentId: string, dir: -1 | 1): string | null {
  const { list, index } = siblingsOf(messages, currentId);
  if (index < 0) return null;
  const j = index + dir;
  if (j < 0 || j >= list.length) return null;
  return deepestLeaf(messages, list[j].id);
}

/** Все id сообщений поддерева rootId, включая ВСЕХ членов runId-групп (не только представителей). */
export function subtreeIds(messages: Message[], rootId: string): string[] {
  const ids: string[] = [];
  const stack: string[] = [rootId];
  const visited = new Set<string>();
  while (stack.length) {
    const id = stack.pop() as string;
    if (visited.has(id)) continue;
    visited.add(id);
    const msg = messages.find((m) => m.id === id);
    if (!msg) continue;
    if (msg.runId) {
      for (const g of messages.filter((x) => x.runId === msg.runId)) ids.push(g.id);
    } else {
      ids.push(id);
    }
    for (const child of childrenOf(messages, id)) stack.push(child.id);
  }
  return ids;
}

/**
 * Куда перевести активный лист после удаления поддерева removedId: если
 * activeLeafId не задет удалением — оставить как есть; иначе — deepestLeaf
 * предыдущей версии удаляемого узла, нет предыдущей — следующей, нет вовсе
 * версий — эффективный родитель (может быть null).
 */
export function leafAfterRemoval(messages: Message[], removedId: string, activeLeafId?: string | null): string | null {
  if (!activeLeafId) return activeLeafId ?? null;
  if (!subtreeIds(messages, removedId).includes(activeLeafId)) return activeLeafId;

  const { list, index } = siblingsOf(messages, removedId);
  if (index < 0) return null;
  if (index > 0) return deepestLeaf(messages, list[index - 1].id);
  if (index < list.length - 1) return deepestLeaf(messages, list[index + 1].id);

  const target = messages.find((m) => m.id === removedId);
  if (!target) return null;
  return parentMap(messages).get(nodeOf(messages, target).id) ?? null;
}
