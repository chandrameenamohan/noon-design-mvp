import { useEffect, useState, type SyntheticEvent } from "react";
import type { Member, Role, User } from "@noon/contracts";
import { readMembers, setMemberRole, whoAmI } from "./api.ts";
import { memberRefusalWords, ROLE_WORDS, ROLES_TO_OFFER, roleOf, withMember } from "./members.ts";
import { OrgNav, Page } from "./Shell.tsx";
import { useOrgReport } from "./useOrgReport.ts";

const REFUSED = {
  forbidden: "Only a member of this organisation can see who is in it.",
  gone: "This organisation cannot be found, or you are not a member of it.",
  error: "The members could not be loaded. Try again.",
} as const;

/** The role as a control (an owner's) or as a word (everyone else's). The label names the person, so a screen reader hears whose role it is. */
function RoleCell({ member, editable, onChange }: { member: Member; editable: boolean; onChange: (role: Role) => void }) {
  if (!editable) return <>{member.role}</>;
  return (
    <select aria-label={`Role of ${member.email}`} value={member.role} onChange={(event) => { onChange(event.currentTarget.value as Role); }}>
      {ROLES_TO_OFFER.map((role) => <option key={role} value={role}>{role}</option>)}
    </select>
  );
}

/**
 * E10.8 (F24): the org's members with their roles. Every member reads it; an owner also adds a person (who has signed
 * up: the api has no email to invite with) and changes roles, their own included, and the api's refusals come back as
 * sentences (the last owner cannot step down). The controls are shown to an owner only, but the api decides: a role
 * that changed under this page is met as a sentence, and the list is read again.
 * Everything a row says (names, emails) is rendered as TEXT: React makes text nodes of it, never markup.
 */
export function OrgView({ orgId }: { orgId: string }) {
  const { org, pages, refused, loading, next, more, reload } = useOrgReport(orgId, readMembers);
  // undefined: still asking the api who this is. The caller's own role is read from the list (members.ts: roleOf).
  const [me, setMe] = useState<User | null>();
  useEffect(() => { whoAmI().then(setMe, () => { setMe(null); }); }, []);
  // Changes THIS page made, applied over the pages read: each is the api's own answer, so the list stays the api's.
  const [changed, setChanged] = useState<Member[]>([]);
  const members = changed.reduce((list, member) => withMember(list, member), pages.flatMap((page) => page.items));
  const owner = roleOf(members, me?.id) === "owner";
  // One refusal at a time, beside the row (by user id) or the form it was about; and one sentence for a screen reader per change.
  const [problem, setProblem] = useState<{ at: string; text: string }>();
  const [said, setSaid] = useState("");

  const apply = async (at: string, email: string, role: Role): Promise<boolean> => {
    let result;
    try {
      result = await setMemberRole(orgId, email, role);
    } catch {
      setProblem({ at, text: "The change could not be saved. Try again." });
      return false;
    }
    if (typeof result === "string") {
      setProblem({ at, text: memberRefusalWords(result) });
      if (result === "forbidden" || result === "gone") { setChanged([]); reload(); } // the world moved under this page: read it again
      return false;
    }
    setProblem(undefined);
    setChanged((before) => withMember(before, result));
    setSaid(`${result.email} is now ${result.role}.`);
    return true;
  };
  const add = async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const email = data.get("email");
    const role = data.get("role");
    if (typeof email !== "string" || typeof role !== "string") return;
    if (await apply("form", email, role as Role)) form.reset();
  };

  return (
    <Page bar={<OrgNav orgId={orgId} current="members" />}>
      <h1>Members{org ? ` of ${org.name}` : ""}</h1>
      {refused !== undefined && <p role="alert" className="refusal">{REFUSED[refused]}</p>}
      {refused === undefined && (
        <>
          <p className="hint">{owner ? "You run this organisation: add people who have signed up, and change roles." : "Who is in this organisation and what each may do. Only an owner changes roles."}</p>
          <table className="audit members">
            <caption>Members, oldest first</caption>
            <thead>
              <tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Role</th></tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr key={member.userId} data-role={member.role}>
                  <th scope="row">{member.name}{member.userId === me?.id ? <span className="hint"> (you)</span> : null}</th>
                  <td>{member.email}</td>
                  <td>
                    <RoleCell member={member} editable={owner} onChange={(role) => { void apply(member.userId, member.email, role); }} />
                    {problem?.at === member.userId && <p role="alert" className="row-refusal">{problem.text}</p>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {next !== null && <button type="button" disabled={loading} onClick={more}>Show more members</button>}
          {owner && (
            <form className="add-member" aria-label="Add a member" onSubmit={(event) => void add(event)}>
              <label>Email <input name="email" type="email" autoComplete="off" required /></label>
              <label>
                Role{" "}
                <select name="role" defaultValue="viewer">
                  {ROLES_TO_OFFER.map((role) => <option key={role} value={role}>{role}</option>)}
                </select>
              </label>
              <button type="submit" className="primary">Add</button>
              {problem?.at === "form" && <p role="alert" className="refusal">{problem.text}</p>}
            </form>
          )}
          <dl className="roles-legend" aria-label="What each role may do">
            {ROLES_TO_OFFER.map((role) => <div key={role}><dt>{role}</dt><dd>{ROLE_WORDS[role]}</dd></div>)}
          </dl>
          <p aria-live="polite" className="visually-hidden">{said}</p>
        </>
      )}
    </Page>
  );
}
