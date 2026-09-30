import { useEffect, useState } from "react";
import type { Run } from "@noon/contracts";
import { cancelRun, readLatestRun, readRun, startRun } from "./api.ts";
import { stepText } from "./progress.ts";
import { waitWords } from "./usage.ts";

// Why a run failed, in the user's words. The vocabulary is OPEN (the worker may name a reason this
// build has never heard of), so an unknown name gets an honest general sentence, never a blank.
const FAILURES: Partial<Record<string, string>> = {
  token_missing: "The AI is not set up on this server: no Claude token is configured.",
  token_invalid: "The AI could not sign in: the Claude token on this server is no longer valid.",
  rate_limited: "The AI provider is limiting requests right now. Try again in a little while.",
  provider_unavailable: "The AI provider is not answering right now. Try again in a little while.",
  account_problem: "The AI provider refused the request because of a problem with the account.",
  timed_out: "The AI ran out of time. What it had already changed stays in the document.",
  too_many_steps: "The AI needed too many steps and was stopped. What it had already changed stays in the document.",
  sync_unreachable: "The AI lost its connection to the document. What it had already changed stays.",
  worker_stopped: "The server was restarted during the run. What the AI had already changed stays.",
  owner_missing: "You are no longer a member of this document's organisation.",
};
const sentence = (run: Run): string =>
  run.status === "queued" ? "The AI is waiting to start."
  : run.status === "running" ? "The AI is working. Its changes appear on the canvas as it makes them."
  : run.status === "succeeded" ? "The AI has finished."
  : run.status === "cancelled" ? "Cancelled. What the AI had already changed stays in the document."
  : `The AI run failed. ${FAILURES[run.error ?? ""] ?? "Something went wrong on the server."}`;
const active = (run: Run | undefined): run is Run => run?.status === "queued" || run?.status === "running";

/**
 * Ask the AI for a change (F9) and stop it (F10). The run is a row on the server; this panel only
 * starts it, asks how it is doing once a second (status and steps, F30), and asks for it to stop. The
 * EDITS do not come through here at all: the agent is a peer in the document, so its nodes arrive on
 * the canvas the same way another person's do. A reload picks the document's newest run up again.
 * ponytail: the steps ride that 1 s poll (a step shows up to a second late); a push channel if that is ever too slow.
 */
export function AiPanel({ documentId, hidden = false }: { documentId: string; hidden?: boolean }) {
  const [instruction, setInstruction] = useState("");
  const [run, setRun] = useState<Run>();
  const [problem, setProblem] = useState("");
  const running = active(run);

  // The newest run, after a reload too (F30). A run started before this answers is not replaced by an older one.
  useEffect(() => { readLatestRun(documentId).then((latest) => { if (latest) setRun((current) => current ?? latest); }, () => undefined); }, [documentId]);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => { readRun(run).then(setRun, () => undefined); }, 1000); // a failed look is tried again in a second
    return () => { clearInterval(timer); };
  }, [running, run]);

  const start = (): void => {
    setProblem("");
    startRun(documentId, instruction).then(
      (started) => {
        if (started === "busy") setProblem("The AI is already working on this document. Wait for it to finish, or cancel it.");
        else if ("retryAfterSeconds" in started) setProblem(`This organisation has started as many AI runs as it may for now. Try again in ${waitWords(started.retryAfterSeconds)}.`);
        else setRun(started);
      },
      () => { setProblem("The run could not be started. Check the instruction (at most 4,000 characters) and try again."); },
    );
  };

  // `hidden` (the top bar's AI button closed it): the run keeps being followed, only the panel is out of view.
  return (
    <form id="ai-panel" className="ai-panel" aria-label="Ask the AI" hidden={hidden} onSubmit={(event) => { event.preventDefault(); start(); }}>
      <label htmlFor="ai-instruction">Ask the AI to change this page</label>
      <textarea id="ai-instruction" rows={2} maxLength={4000} value={instruction} onChange={(event) => { setInstruction(event.target.value); }} placeholder="Add a payment card with a card-number input and a primary Pay button" />
      <div className="ai-actions">
        <button type="submit" disabled={running || instruction.trim() === ""}>Ask the AI</button>
        {running && <button type="button" onClick={() => { cancelRun(run).then(setRun, () => undefined); }}>Cancel the AI run</button>}
      </div>
      {/* Not role="status": the page already has one (the connection), and this one is said politely too. */}
      <p id="ai-status" aria-live="polite" data-run-status={run?.status ?? ""}>{run ? sentence(run) : ""}</p>
      {run && run.steps.length > 0 && (
        <ol className="ai-steps" aria-label="What the AI has done">
          {/* Text only: `detail` is the model's own words. The key is the position: steps are only ever appended (the oldest drop off past 50). */}
          {run.steps.map((step, at) => <li key={at} data-ok={step.ok}>{stepText(step)}</li>)}
        </ol>
      )}
      {problem !== "" && <p role="alert" className="refusal">{problem}</p>}
    </form>
  );
}
