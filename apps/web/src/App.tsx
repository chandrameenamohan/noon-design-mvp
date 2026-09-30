import { useEffect, useState, type SyntheticEvent } from "react";
import { HealthResponse, type Org, type User } from "@noon/contracts";
import { createDocument, listOrgs, signIn, signOut, signUp, whoAmI } from "./api.ts";
import { AuditView } from "./AuditView.tsx";
import { Canvas } from "./Canvas.tsx";
import { Page } from "./Shell.tsx";
import { refusalWords } from "./signIn.ts";
import { UsageView } from "./UsageView.tsx";

const selfCheck = HealthResponse.parse({ status: "ok", service: "web" });

export function App() {
  // ponytail: the address bar is the router. ?doc=<id> is a document, ?audit=<orgId> an org's audit trail, ?usage=<orgId>
  // what its AI runs cost; anything else is home.
  const params = new URLSearchParams(location.search);
  const documentId = params.get("doc");
  if (documentId) return <Canvas documentId={documentId} />;
  const auditOrg = params.get("audit");
  if (auditOrg) return <AuditView orgId={auditOrg} />;
  const usageOrg = params.get("usage");
  if (usageOrg) return <UsageView orgId={usageOrg} />;
  return <Home />;
}

function Home() {
  // undefined: still asking the api who this is.
  const [me, setMe] = useState<User | null>();
  const [error, setError] = useState<string>();
  const [orgs, setOrgs] = useState<Org[]>([]);
  useEffect(() => {
    whoAmI().then(setMe, (problem: unknown) => { setError(problem instanceof Error ? problem.message : String(problem)); });
  }, []);
  useEffect(() => {
    if (me) listOrgs().then(setOrgs, () => undefined); // the list is a convenience: without it, home still works
  }, [me]);

  const create = async (owner: User): Promise<void> => {
    try {
      const url = new URL(location.href);
      url.searchParams.set("doc", await createDocument(owner));
      location.assign(url);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    }
  };
  const leave = async (): Promise<void> => {
    try {
      await signOut();
      setMe(null);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    }
  };
  return (
    <Page>
      <h1>Noon MVP</h1>
      <p className="hint">
        {selfCheck.service}: {selfCheck.status}
      </p>
      {me === null && <SignIn onSignedIn={setMe} />}
      {me && (
        <>
          <p>Signed in as {me.name} ({me.email})</p>
          <button type="button" className="primary" onClick={() => void create(me)}>New document</button>{" "}
          <button type="button" onClick={() => void leave()}>Sign out</button>
          {orgs.length > 0 && (
            <section aria-labelledby="orgs-heading">
              <h2 id="orgs-heading">Your organisations</h2>
              <ul>
                {orgs.map((org) => (
                  <li key={org.id}><a href={`/?audit=${org.id}`}>Audit trail of {org.name}</a>{" · "}<a href={`/?usage=${org.id}`}>AI usage of {org.name}</a></li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
      {error !== undefined && <p role="alert" className="refusal">{error}</p>}
    </Page>
  );
}

/** One form, two actions: Sign in uses email and password; Sign up also needs the name others will see. */
function SignIn({ onSignedIn }: { onSignedIn: (user: User) => void }) {
  const [refusal, setRefusal] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const field = (name: string): string => {
      const value = form.get(name);
      return typeof value === "string" ? value : "";
    };
    const creating = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "signup";
    setBusy(true);
    try {
      const result = creating ? await signUp({ email: field("email"), name: field("name"), password: field("password") }) : await signIn({ email: field("email"), password: field("password") });
      if ("error" in result) setRefusal(refusalWords(result));
      else onSignedIn(result);
    } catch {
      setRefusal("The server could not be reached. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="sign-in" aria-label="Sign in" onSubmit={(event) => void submit(event)}>
      <label>
        Email <input name="email" type="email" autoComplete="username" required />
      </label>
      <label>
        Password <input name="password" type="password" autoComplete="current-password" required />
      </label>
      <label>
        Name <input name="name" autoComplete="name" aria-describedby="name-hint" />
      </label>
      <p id="name-hint">Only needed to sign up: the name others see in a document.</p>
      <div className="sign-in-actions">
        <button type="submit" value="signin" className="primary" disabled={busy}>Sign in</button>
        <button type="submit" value="signup" disabled={busy}>Sign up</button>
      </div>
      {refusal !== undefined && <p role="alert" className="refusal">{refusal}</p>}
    </form>
  );
}
