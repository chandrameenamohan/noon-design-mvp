import { useEffect, useState } from "react";
import type { Ship } from "@noon/contracts";
import { readShip, startShip } from "./api.ts";

// Why a ship failed, in the user's words. The vocabulary is OPEN (the worker may name a reason this build has
// never heard of), so an unknown name gets an honest general sentence, never a blank.
const FAILURES: Partial<Record<string, string>> = {
  gitea_unavailable: "The git server did not answer or refused the request. Try again in a little while.",
  branch_busy: "The branch kept changing while shipping. Try again.",
  no_main_branch: "The repository has no main branch to open a pull request into.",
  codegen_failed: "This page could not be turned into code.",
  sync_unreachable: "The server could not read the document. Try again in a little while.",
  worker_stopped: "The server was restarted while shipping. Try again.",
  owner_missing: "You are no longer a member of this document's organisation.",
  forbidden: "You can no longer edit this document: an owner made you a viewer, so it was not shipped.",
};
const sentence = (ship: Ship): string =>
  ship.status === "queued" ? "Waiting to ship."
  : ship.status === "running" ? "Shipping: pushing the page and opening the pull request."
  : ship.status === "succeeded" ? (ship.commit === null ? "Shipped. The pull request already had this page." : "Shipped. The pull request has the page as it is now.")
  : ship.status === "cancelled" ? "The ship was cancelled."
  : `Shipping failed. ${FAILURES[ship.error ?? ""] ?? "Something went wrong on the server."}`;
const active = (ship: Ship | null): ship is Ship => ship?.status === "queued" || ship?.status === "running";

/**
 * F17: Ship turns the document into a pull request. The ship is a job on the server; this panel presses it,
 * asks how it is doing once a second while it runs, and links the pull request. Pressing again after an edit
 * updates the same pull request. A conflict banner does not stop it: the fresh page is what fixes the branch.
 * ponytail: polling, as for runs and the preview.
 */
export function ShipPanel({ documentId }: { documentId: string }) {
  const [ship, setShip] = useState<Ship | null>(null);
  const [problem, setProblem] = useState("");
  const shipping = active(ship);

  useEffect(() => { readShip(documentId).then(setShip, () => undefined); }, [documentId]); // the last ship, after a reload too
  useEffect(() => {
    if (!shipping) return;
    const timer = setInterval(() => { readShip(documentId).then(setShip, () => undefined); }, 1000); // a failed look is tried again in a second
    return () => { clearInterval(timer); };
  }, [shipping, documentId]);

  const press = (): void => {
    setProblem("");
    startShip(documentId).then(setShip, () => { setProblem("Ship could not be started. Try again."); });
  };

  return (
    <section className="ship-panel" aria-label="Ship">
      <button type="button" onClick={press} disabled={ship?.status === "queued"}>Ship</button>
      {/* Not role="status": the page already has one (the connection), and this one is said politely too. */}
      <span aria-live="polite" data-ship-status={ship?.status ?? ""}>{ship ? sentence(ship) : ""}</span>
      {ship?.pr && <a href={ship.pr.url} target="_blank" rel="noopener noreferrer">Pull request #{ship.pr.number}</a>}
      {problem !== "" && <p role="alert" className="refusal">{problem}</p>}
    </section>
  );
}
