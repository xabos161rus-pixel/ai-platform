import type { BaseEntity } from '../db/types';

export function now(): string {
  return new Date().toISOString();
}

export function uid(): string {
  return crypto.randomUUID();
}

/** Проставить штампы новой записи. */
export function stamp<T extends BaseEntity>(data: Omit<T, keyof BaseEntity>): T {
  const ts = now();
  return { ...data, id: uid(), createdAt: ts, updatedAt: ts, deletedAt: null } as T;
}

/** Фильтр живых записей — применять после каждого чтения списком. */
export function alive<T extends BaseEntity>(rows: T[]): T[] {
  return rows.filter((r) => !r.deletedAt);
}
