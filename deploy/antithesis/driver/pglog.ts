// The fence (F22) seen from outside. A fenced append leaves NOTHING in the journal, and the sync node that was
// fenced logs "lease N lost" (its renewal timer always runs before Postgres's refusal comes back), so neither the
// journal nor the app's log can show that a zombie tried to write. Postgres's own statement log can: the harness
// starts it with log_statement=mod (configuration, not code), and every claim and every append is there with its
// parameters, in order. This file reads that log. Pure: text in, findings out.

/** A room claiming a document under a lease token, or appending under the claim it holds. */
export type Statement =
  | { kind: "claim"; at: number; document: string; token: number; claim: string }
  | { kind: "append"; at: number; document: string; seq: number; opId: string; claim: string | null };

const LINE = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}) (\w+) \[(\d+)\] (LOG|DETAIL): {2}(.*)$/u;
const PARAMETER = /\$(\d+) = (?:'((?:[^']|'')*)'|(NULL))/gu;

/** The claims and appends of a Postgres log written with `log_statement=mod` and `log_line_prefix='%m [%p] '`. */
export function statements(log: string): Statement[] {
  const found: Statement[] = [];
  // Per backend: the statement whose parameters the next DETAIL line of that backend carries.
  const open = new Map<string, { at: number; kind: "claim" | "append" }>();
  for (const line of log.split("\n")) {
    const match = LINE.exec(line);
    if (!match) continue;
    const [, when = "", zone = "", pid = "", level, rest = ""] = match;
    if (level === "LOG") {
      const kind = rest.includes("insert into op_journal") ? "append" : rest.includes("update documents set fence_token") ? "claim" : undefined;
      if (kind) open.set(pid, { at: Date.parse(`${when.replace(" ", "T")}${zone === "UTC" ? "Z" : ""}`), kind });
      else open.delete(pid);
      continue;
    }
    const statement = open.get(pid);
    open.delete(pid);
    if (!statement || !/^parameters:/iu.test(rest)) continue;
    const values = new Map<number, string | null>();
    for (const [, index = "", text, isNull] of rest.matchAll(PARAMETER)) values.set(Number(index), isNull === undefined ? (text ?? "").replaceAll("''", "'") : null);
    const text = (index: number): string => values.get(index) ?? "";
    // documentStore.claim: $2 document, $3 token, $4 claim. documentStore.append: $2 document, $3 seq, $4 opId, $9 claim.
    if (statement.kind === "claim") found.push({ kind: "claim", at: statement.at, document: text(2), token: Number(text(3)), claim: text(4) });
    else found.push({ kind: "append", at: statement.at, document: text(2), seq: Number(text(3)), opId: text(4), claim: values.get(9) ?? null });
  }
  return found;
}

export type Append = Extract<Statement, { kind: "append" }>;

/**
 * Appends made under a claim that was no longer the document's: a zombie owner's. The claims are replayed in log
 * order by the database's own rule (a claim takes only under a larger token). An append logged within `marginMs` of
 * the claim that replaced its own is left out: the log orders statements by when they STARTED, and those two may
 * have been serialized the other way round.
 */
export function staleAppends(all: readonly Statement[], marginMs = 250): Append[] {
  const holder = new Map<string, { token: number; claim: string; since: number }>();
  const stale: Append[] = [];
  for (const statement of all) {
    const current = holder.get(statement.document);
    if (statement.kind === "claim") {
      if (statement.token > (current?.token ?? 0)) holder.set(statement.document, { token: statement.token, claim: statement.claim, since: statement.at });
    } else if (current && statement.claim !== current.claim && statement.at - current.since > marginMs) stale.push(statement);
  }
  return stale;
}

/**
 * Of the stale appends, those whose row IS in the journal with nobody else to thank for it: no append of that op at
 * that seq under a claim that was current. Each is a write the fence should have refused. `journaled`: is this op
 * at this seq of this document in op_journal?
 */
export function landed(all: readonly Statement[], journaled: (append: Append) => boolean, marginMs = 250): Append[] {
  const stale = staleAppends(all, marginMs);
  const key = (append: Append): string => `${append.document}:${String(append.seq)}:${append.opId}`;
  const staleOnes = new Set(stale);
  const rightful = new Set(all.filter((each): each is Append => each.kind === "append" && !staleOnes.has(each)).map(key));
  return stale.filter((append) => journaled(append) && !rightful.has(key(append)));
}
