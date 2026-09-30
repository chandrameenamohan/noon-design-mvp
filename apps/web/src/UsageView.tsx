import type { UsageReport } from "@noon/contracts";
import { readUsage } from "./api.ts";
import { hrefTo } from "./links.ts";
import { OrgNav, Page } from "./Shell.tsx";
import { tokens, usd } from "./usage.ts";
import { useOrgReport } from "./useOrgReport.ts";

const REFUSED = {
  forbidden: "Only an owner of this organisation can see what its AI runs cost.",
  gone: "This organisation cannot be found, or you are not a member of it.",
  error: "Usage could not be loaded. Try again.",
} as const;

type Sums = UsageReport["totals"];
/** The number columns every table shares, as text. */
function SumCells({ sums }: { sums: Sums }) {
  return (
    <>
      <td className="number">{tokens(sums.runs)}</td>
      <td className="number">{tokens(sums.inputTokens)}</td>
      <td className="number">{tokens(sums.outputTokens)}</td>
      <td className="number">{tokens(sums.cacheReadTokens)}</td>
      <td className="number">{tokens(sums.cacheWriteTokens)}</td>
      <td className="number">{usd(sums.costUsd)}</td>
    </>
  );
}
function SumHeads({ first }: { first: string }) {
  return (
    <thead>
      <tr>
        <th scope="col">{first}</th>
        <th scope="col">Runs</th><th scope="col">Input tokens</th><th scope="col">Output tokens</th>
        <th scope="col">Cache read tokens</th><th scope="col">Cache write tokens</th><th scope="col">Estimated cost</th>
      </tr>
    </thead>
  );
}

/**
 * F31: what the org's AI runs consumed: totals, per person, per day (UTC) and per run. Owners only (the api says 403
 * to anyone else). Every number is text in a table cell, with a header naming it, never a chart: a screen reader reads
 * it as it is. The cost is the provider's ESTIMATE (under a subscription nothing is charged per run); billing is not built.
 */
export function UsageView({ orgId }: { orgId: string }) {
  const { org, pages, refused, loading, next, more } = useOrgReport(orgId, readUsage);
  const report = pages[0]; // the totals, per person and per day: the first page carries them (every page does, alike)
  const runs = pages.flatMap((page) => page.items);

  return (
    <Page bar={<OrgNav orgId={orgId} current="usage" />}>
      <h1>AI usage{org ? ` of ${org.name}` : ""}</h1>
      {refused !== undefined && <p role="alert" className="refusal">{REFUSED[refused]}</p>}
      {report && refused === undefined && (
        <>
          <p className="usage-total">
            {tokens(report.totals.runs)} {report.totals.runs === 1 ? "run" : "runs"}, {tokens(report.totals.inputTokens)} input tokens, {tokens(report.totals.outputTokens)} output tokens, {usd(report.totals.costUsd)} estimated in all.
          </p>
          <table className="audit usage">
            <caption>Per person, most expensive first</caption>
            <SumHeads first="Person" />
            <tbody>
              {report.byUser.map((row) => (
                <tr key={row.userId ?? "deleted"}>
                  <th scope="row">{row.email ?? "A deleted user"}</th>
                  <SumCells sums={row} />
                </tr>
              ))}
            </tbody>
          </table>
          <table className="audit usage">
            <caption>Per day (UTC), newest first</caption>
            <SumHeads first="Day" />
            <tbody>
              {report.byDay.map((row) => (
                <tr key={row.day}>
                  <th scope="row"><time dateTime={row.day}>{row.day}</time></th>
                  <SumCells sums={row} />
                </tr>
              ))}
            </tbody>
          </table>
          <table className="audit usage">
            <caption>Per run, newest first</caption>
            <thead>
              <tr>
                <th scope="col">When</th><th scope="col">Who</th><th scope="col">Document</th><th scope="col">Model</th>
                <th scope="col">Input tokens</th><th scope="col">Output tokens</th><th scope="col">Cache read tokens</th><th scope="col">Cache write tokens</th><th scope="col">Estimated cost</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <th scope="row"><time dateTime={run.createdAt}>{new Date(run.createdAt).toLocaleString()}</time></th>
                  <td>{run.email ?? "A deleted user"}</td>
                  <td>{run.documentId === null ? "Deleted" : <a href={hrefTo({ doc: run.documentId })}><span className="visually-hidden">Document </span>{run.documentId.slice(0, 8)}</a>}</td>
                  <td>{run.model}</td>
                  <td className="number">{tokens(run.inputTokens)}</td>
                  <td className="number">{tokens(run.outputTokens)}</td>
                  <td className="number">{tokens(run.cacheReadTokens)}</td>
                  <td className="number">{tokens(run.cacheWriteTokens)}</td>
                  <td className="number">{usd(run.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {refused === undefined && !loading && runs.length === 0 && <p>No AI run has finished in this organisation yet.</p>}
      {refused === undefined && next !== null && <button type="button" disabled={loading} onClick={more}>Show older runs</button>}
    </Page>
  );
}
