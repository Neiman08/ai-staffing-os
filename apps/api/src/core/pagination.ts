export interface CursorPageParams {
  cursor?: string;
  limit: number;
}

export interface CursorPageResult<T> {
  items: T[];
  nextCursor: string | null;
}

export function buildCursorArgs({ cursor, limit }: CursorPageParams) {
  return {
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  };
}

export function toCursorPage<T extends { id: string }>(rows: T[], limit: number): CursorPageResult<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? last.id : null };
}
