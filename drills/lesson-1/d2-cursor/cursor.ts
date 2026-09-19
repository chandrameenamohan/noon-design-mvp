// DRILL 2 · a planted bug.  This is a simplified copy of the paging code in packages/db/src/index.ts,
// working on an in-memory list instead of Postgres. It has ONE bug. The test next to it is RED.
// Fix the bug in this file. Hint: read the comment above `decodeCursor` in the real file AFTER you
// have a theory, not before.

export type Row = { id: string; createdAt: string }; // createdAt is Postgres text: "2026-01-01 10:00:00.123456+00"
export type Page = { items: Row[]; nextCursor: string | null };

const compare = (a: Row, b: Row): number => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt));

function encodeCursor(row: Row): string {
  const at = new Date(row.createdAt.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
  return Buffer.from(`${at.toISOString()}|${row.id}`).toString("base64url");
}

function decodeCursor(cursor: string): Row {
  const [createdAt = "", id = ""] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  return { createdAt: createdAt.replace("T", " ").replace("Z", "+00"), id };
}

/** Returns the rows after `cursor`, oldest first, `limit` at a time. */
export function page(rows: readonly Row[], limit: number, cursor?: string): Page {
  const sorted = [...rows].sort(compare);
  const after = cursor === undefined ? undefined : decodeCursor(cursor);
  const rest = after === undefined ? sorted : sorted.filter((row) => compare(row, after) > 0);
  const items = rest.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: rest.length > limit && last ? encodeCursor(last) : null };
}
