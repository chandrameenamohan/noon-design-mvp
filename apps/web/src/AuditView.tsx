import { useEffect, useState } from "react";
import type { AuditEntry, Org } from "@noon/contracts";
import { readAudit, readOrg } from "./api.ts";
import { auditWords } from "./audit.ts";

const REFUSED = {
  forbidden: "Only an owner of this organisation can read its audit trail.",
  gone: "This organisation cannot be found, or you are not a member of it.",
  error: "The audit trail could not be loaded. Try again.",
} as const;

/**
 * F26: the org's audit trail, newest first: who did what, and when. Read-only: there is nothing here (or in the api)
 * that changes an entry. Everything an entry says is rendered as TEXT: React makes text nodes of it, never markup.
 */
export function AuditView({ orgId }: { orgId: string }) {
  const [org, setOrg] = useState<Org>();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [refused, setRefused] = useState<keyof typeof REFUSED>();
  const [loading, setLoading] = useState(true);

  const load = async (cursor?: string): Promise<void> => {
    setLoading(true);
    try {
      const page = await readAudit(orgId, cursor);
      if (typeof page === "string") setRefused(page);
      else {
        setEntries((before) => (cursor === undefined ? page.items : [...before, ...page.items]));
        setNext(page.nextCursor);
      }
    } catch {
      setRefused("error");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    readOrg(orgId).then((found) => { if (found !== "gone") setOrg(found); }, () => undefined);
    void load();
    // Once per org (`load` is recreated every render, and only reads orgId).
  }, [orgId]);

  return (
    <main>
      <p><a href="/">Home</a></p>
      <h1>Audit trail{org ? ` of ${org.name}` : ""}</h1>
      {refused !== undefined && <p role="alert" className="refusal">{REFUSED[refused]}</p>}
      {refused === undefined && (
        <table className="audit">
          <caption>Sign-ins, role and share changes, AI runs, ships and rejected pushes, newest first.</caption>
          <thead>
            <tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">What</th><th scope="col">Document</th></tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const words = auditWords(entry);
              return (
                <tr key={entry.id} data-action={entry.action}>
                  <td><time dateTime={entry.at}>{new Date(entry.at).toLocaleString()}</time></td>
                  <td>{words.who}</td>
                  <td>{words.what}</td>
                  <td>{entry.documentId === null ? "" : <a href={`/?doc=${entry.documentId}`}><span className="visually-hidden">Document </span>{entry.documentId.slice(0, 8)}</a>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {refused === undefined && !loading && entries.length === 0 && <p>Nothing has happened in this organisation yet.</p>}
      {refused === undefined && next !== null && <button type="button" disabled={loading} onClick={() => void load(next)}>Show older entries</button>}
    </main>
  );
}
