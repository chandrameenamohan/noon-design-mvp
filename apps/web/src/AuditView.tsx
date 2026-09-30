import { readAudit } from "./api.ts";
import { auditWords } from "./audit.ts";
import { Page } from "./Shell.tsx";
import { useOrgReport } from "./useOrgReport.ts";

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
  const { org, pages, refused, loading, next, more } = useOrgReport(orgId, readAudit);
  const entries = pages.flatMap((page) => page.items);

  return (
    <Page bar={<a href="/">Home</a>}>
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
      {refused === undefined && next !== null && <button type="button" disabled={loading} onClick={more}>Show older entries</button>}
    </Page>
  );
}
