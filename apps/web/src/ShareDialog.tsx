import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react";
import type { Member } from "@noon/contracts";
import { readShares, revokeShare, shareWith } from "./api.ts";
import { shareRefusalWords, withMember, withoutMember } from "./members.ts";

type ShareRole = "viewer" | "editor";
const REFUSED = {
  forbidden: shareRefusalWords("forbidden"),
  gone: shareRefusalWords("gone"),
  error: "Who this document is shared with could not be loaded. Try again.",
} as const;

/**
 * E10.8 (F25): the top bar's Share. A native <dialog> shown modally, as the `?` sheet is (E10.7): the browser traps
 * focus, makes the rest of the editor inert, closes on Escape and gives focus back to the Share button. It lists who the
 * document is shared with, shares with someone by email (they must have signed up) at viewer or editor, changes a share's
 * role, and revokes one after a confirmation in place (their open session closes, E8.3). The list is read afresh every
 * time it opens, and every row shown is the api's answer: the api decides, and its refusals come back as sentences.
 * Everything a row says (names, emails) is rendered as TEXT.
 */
export function ShareDialog({ documentId, open, onClose }: { documentId: string; open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const email = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const [shares, setShares] = useState<Member[]>();
  const [refused, setRefused] = useState<keyof typeof REFUSED>();
  const [problem, setProblem] = useState<string>();
  // The share whose Revoke was pressed and awaits its confirmation; one at a time.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [said, setSaid] = useState("");

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      setShares(undefined);
      setRefused(undefined);
      setProblem(undefined);
      setConfirming(null);
      // ponytail: the first page (50) of shares; ceiling: a 51st is not listed; upgrade: a "show more" as the org pages have.
      readShares(documentId).then((page) => { if (typeof page === "string") setRefused(page); else setShares(page.items); }, () => { setRefused("error"); });
    } else if (!open && el.open) el.close();
  }, [open, documentId]);

  const share = async (address: string, role: ShareRole): Promise<boolean> => {
    let result;
    try {
      result = await shareWith(documentId, address, role);
    } catch {
      setProblem("The share could not be saved. Try again.");
      return false;
    }
    if (typeof result === "string") { setProblem(shareRefusalWords(result)); return false; }
    setProblem(undefined);
    setShares((before) => withMember(before ?? [], result));
    setSaid(`Shared with ${result.email} as ${result.role}.`);
    return true;
  };
  const add = async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const address = data.get("email");
    const role = data.get("role");
    if (typeof address !== "string" || (role !== "viewer" && role !== "editor")) return;
    if (await share(address, role)) form.reset();
  };
  const revoke = async (member: Member): Promise<void> => {
    let result;
    try {
      result = await revokeShare(documentId, member.userId);
    } catch {
      setProblem("The share could not be revoked. Try again.");
      return;
    }
    setConfirming(null);
    if (result === "forbidden") { setProblem(shareRefusalWords("forbidden")); return; }
    setProblem(undefined);
    setShares((before) => withoutMember(before ?? [], member.userId));
    setSaid(`The share of ${member.email} was revoked. Their open session is closing.`);
    email.current?.focus(); // the row is gone: focus must not fall out of the dialog
  };
  const keep = (member: Member): void => {
    setConfirming(null);
    // Back to the button that asked, once it is drawn again.
    setTimeout(() => { dialog.current?.querySelector<HTMLButtonElement>(`[data-revoke="${member.userId}"]`)?.focus(); }, 0);
  };

  return (
    // A click on the dialog element itself is a click on the backdrop (the body fills it): it closes, as Escape does.
    <dialog ref={dialog} className="sheet share-dialog" aria-labelledby={titleId} onClose={onClose} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="sheet-body">
        <div className="sheet-head">
          <h2 id={titleId}>Share this document</h2>
          <button type="button" onClick={onClose}>Close</button>
        </div>
        <p className="hint">Someone you share with opens this document only, as a viewer or an editor, and nothing else of the organisation. They must have signed up. Revoking closes their open session.</p>
        {refused !== undefined && <p role="alert" className="refusal">{REFUSED[refused]}</p>}
        {refused === undefined && (
          <>
            <form className="share-form" aria-label="Share with someone" onSubmit={(event) => void add(event)}>
              <label>Email <input ref={email} name="email" type="email" autoComplete="off" required /></label>
              <label>
                Role{" "}
                <select name="role" defaultValue="viewer">
                  <option value="viewer">viewer</option>
                  <option value="editor">editor</option>
                </select>
              </label>
              <button type="submit" className="primary">Share</button>
            </form>
            {problem !== undefined && <p role="alert" className="refusal">{problem}</p>}
            {shares !== undefined && shares.length === 0 && <p>Not shared with anyone outside the organisation yet.</p>}
            {shares !== undefined && shares.length > 0 && (
              <table className="audit shares">
                <caption>Shared with</caption>
                <thead>
                  <tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Access</th></tr>
                </thead>
                <tbody>
                  {shares.map((member) => (
                    <tr key={member.userId} data-role={member.role}>
                      <th scope="row">{member.name}</th>
                      <td>{member.email}</td>
                      <td>
                        <select aria-label={`Role of ${member.email}`} value={member.role} onChange={(event) => { void share(member.email, event.currentTarget.value as ShareRole); }}>
                          <option value="viewer">viewer</option>
                          <option value="editor">editor</option>
                        </select>
                      </td>
                      <td>
                        {confirming === member.userId ? (
                          <span className="confirm" role="group" aria-label={`Confirm revoking the access of ${member.email}`}>
                            <span>Revoke the access of {member.email}? Their open session will close.</span>
                            {/* autoFocus: the confirmation appeared where the person was; focus lands on the answer they came for. */}
                            <button type="button" className="danger" autoFocus onClick={() => void revoke(member)}>Revoke</button>
                            <button type="button" onClick={() => { keep(member); }}>Keep</button>
                          </span>
                        ) : (
                          <button type="button" data-revoke={member.userId} aria-label={`Revoke the access of ${member.email}`} onClick={() => { setConfirming(member.userId); }}>Revoke</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
        <p aria-live="polite" className="visually-hidden">{said}</p>
      </div>
    </dialog>
  );
}
