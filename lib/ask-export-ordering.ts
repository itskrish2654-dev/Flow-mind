export type AskExportOrder = Readonly<{
  column: "thread_id" | "turn_sequence" | "sequence_no" | "created_at" | "id";
  ascending: true;
  nullsFirst?: true;
}>;

export const ASK_TURN_EXPORT_ORDER = [
  { column: "thread_id", ascending: true },
  { column: "turn_sequence", ascending: true },
  { column: "created_at", ascending: true },
  { column: "id", ascending: true },
] as const satisfies readonly AskExportOrder[];

export const ASK_MESSAGE_EXPORT_ORDER = [
  { column: "thread_id", ascending: true },
  { column: "sequence_no", ascending: true, nullsFirst: true },
  { column: "created_at", ascending: true },
  { column: "id", ascending: true },
] as const satisfies readonly AskExportOrder[];

type OrderableQuery<Query> = {
  order(
    column: string,
    options: { ascending: boolean; nullsFirst?: boolean },
  ): Query;
};

function applyAskExportOrder<Query extends OrderableQuery<Query>>(
  query: Query,
  ordering: readonly AskExportOrder[],
): Query {
  return ordering.reduce<Query>(
    (orderedQuery, { column, ascending, nullsFirst }) => orderedQuery.order(
      column,
      nullsFirst === undefined ? { ascending } : { ascending, nullsFirst },
    ),
    query,
  );
}

export function orderAskTurnsForExport<Query extends OrderableQuery<Query>>(query: Query): Query {
  return applyAskExportOrder(query, ASK_TURN_EXPORT_ORDER);
}

export function orderAskMessagesForExport<Query extends OrderableQuery<Query>>(query: Query): Query {
  return applyAskExportOrder(query, ASK_MESSAGE_EXPORT_ORDER);
}
