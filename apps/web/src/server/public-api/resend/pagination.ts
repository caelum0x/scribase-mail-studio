import { ResendApiError } from "./errors";

/**
 * Resend cursor pagination: `limit` (1-100, default 20) plus either `after`
 * (older than this id, i.e. next page) or `before` (newer than this id, i.e.
 * previous page). Lists are always newest first and wrapped as
 * `{ object: "list", has_more, data }`.
 */

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

export type CursorParams = {
  limit: number;
  after?: string;
  before?: string;
};

export type ResendList<T> = {
  object: "list";
  has_more: boolean;
  data: T[];
};

export type CursorRow = { id: string; createdAt: Date };

/** Prisma-compatible keyset condition over (createdAt, id). */
export type CursorWhere = {
  OR: Array<
    | { createdAt: { lt: Date } | { gt: Date } }
    | { createdAt: Date; id: { lt: string } | { gt: string } }
  >;
};

export type CursorOrderBy = Array<
  { createdAt: "asc" | "desc" } | { id: "asc" | "desc" }
>;

export function parseCursorParams(
  query: Record<string, string | undefined>,
): CursorParams {
  const { limit: rawLimit, after, before } = query;

  if (after && before) {
    throw new ResendApiError(
      "validation_error",
      "You can only use one of `after` or `before`, not both.",
    );
  }

  let limit = DEFAULT_PAGE_LIMIT;
  if (rawLimit !== undefined && rawLimit !== "") {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_LIMIT) {
      throw new ResendApiError(
        "validation_error",
        `\`limit\` must be an integer between 1 and ${MAX_PAGE_LIMIT}.`,
      );
    }
    limit = parsed;
  }

  return {
    limit,
    ...(after ? { after } : {}),
    ...(before ? { before } : {}),
  };
}

export type PaginateOptions<T extends CursorRow> = {
  /** Look up the cursor row (scoped to the caller's team). */
  resolveCursor: (id: string) => Promise<CursorRow | null>;
  /** Run the query; must AND `cursor` (if any) with the caller's own filters. */
  fetch: (args: {
    cursor: CursorWhere | undefined;
    orderBy: CursorOrderBy;
    take: number;
  }) => Promise<T[]>;
};

export async function paginate<T extends CursorRow>(
  params: CursorParams,
  options: PaginateOptions<T>,
): Promise<ResendList<T>> {
  const cursorId = params.after ?? params.before;
  const direction: "after" | "before" | null = params.after
    ? "after"
    : params.before
      ? "before"
      : null;

  let cursor: CursorWhere | undefined;
  if (cursorId && direction) {
    const row = await options.resolveCursor(cursorId);
    if (!row) {
      throw new ResendApiError(
        "validation_error",
        `Invalid \`${direction}\` cursor: ${cursorId}`,
      );
    }
    cursor =
      direction === "after"
        ? {
            OR: [
              { createdAt: { lt: row.createdAt } },
              { createdAt: row.createdAt, id: { lt: row.id } },
            ],
          }
        : {
            OR: [
              { createdAt: { gt: row.createdAt } },
              { createdAt: row.createdAt, id: { gt: row.id } },
            ],
          };
  }

  const ascending = direction === "before";
  const order = ascending ? "asc" : "desc";
  const rows = await options.fetch({
    cursor,
    orderBy: [{ createdAt: order }, { id: order }],
    take: params.limit + 1,
  });

  const hasMore = rows.length > params.limit;
  const page = rows.slice(0, params.limit);
  const data = ascending ? [...page].reverse() : page;

  return { object: "list", has_more: hasMore, data };
}

export function mapList<T, U>(
  list: ResendList<T>,
  mapper: (item: T) => U,
): ResendList<U> {
  return { ...list, data: list.data.map(mapper) };
}
