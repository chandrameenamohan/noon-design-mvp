import { useEffect, useState } from "react";
import type { Run } from "@noon/contracts";
import { cancelRun, readRun, startRun } from "./api.ts";

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
 * starts it, asks how it is doing once a second, and asks for it to stop. The EDITS do not come
 * through here at all: the agent is a peer in the document, so its nodes arrive on the canvas the
 * same way another person's do.
 * ponytail: polling, and the run is forgotten on reload. Streamed progress that survives a reload is E9.4.
 */
export function AiPanel({ documentId }: { documentId: string }) {
  const [instruction, setInstruction] = useState("");
  const [run, setRun] = useState<Run>();
  const [problem, setProblem] = useState("");
  const running = active(run);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => { readRun(run).then(setRun, () => undefined); }, 1000); // a failed look is tried again in a second
    return () => { clearInterval(timer); };
  }, [running, run]);

  const start = (): void => {
    setProblem("");
    startRun(documentId, instruction).then(
      (started) => { if (started === "busy") setProblem("The AI is already working on this document. Wait for it to finish, or cancel it."); else setRun(started); },
      () => { setProblem("The run could not be started. Check the instruction (at most 4,000 characters) and try again."); },
    );
  };

  return (
    <form className="ai-panel" aria-label="Ask the AI" onSubmit={(event) => { event.preventDefault(); start(); }}>
      <label htmlFor="ai-instruction">Ask the AI to change this page</label>
      <textarea id="ai-instruction" rows={2} maxLength={4000} value={instruction} onChange={(event) => { setInstruction(event.target.value); }} placeholder="Add a payment card with a card-number input and a primary Pay button" />
      <div className="ai-actions">
        <button type="submit" disabled={running || instruction.trim() === ""}>Ask the AI</button>
        {running && <button type="button" onClick={() => { cancelRun(run).then(setRun, () => undefined); }}>Cancel the AI run</button>}
      </div>
      {/* Not role="status": the page already has one (the connection), and this one is said politely too. */}
      <p id="ai-status" aria-live="polite" data-run-status={run?.status ?? ""}>{run ? sentence(run) : ""}</p>
      {problem !== "" && <p role="alert" className="refusal">{problem}</p>}
    </form>
  );
}
