import { useEffect, useState, type SyntheticEvent } from "react";
import { HealthResponse, type ErrorBody, type User } from "@noon/contracts";
import { createDocument, signIn, signOut, signUp, whoAmI } from "./api.ts";
import { Canvas } from "./Canvas.tsx";

const selfCheck = HealthResponse.parse({ status: "ok", service: "web" });

/** What the api's refusal NAME means to the person at the form. The api never says which of email or password was wrong. */
const refusals: Partial<Record<ErrorBody["error"], string>> = {
  invalid_credentials: "That email and password do not match an account.",
  email_taken: "An account with that email already exists. Sign in instead.",
  invalid_body: "Enter a valid email, a name, and a password of 8 to 128 characters.",
  too_many_attempts: "Too many attempts. Wait a minute, then try again.",
};

export function App() {
  // ponytail: the address bar is the router. ?doc=<id> is a document; anything else is home.
  const documentId = new URLSearchParams(location.search).get("doc");
  if (documentId) return <Canvas documentId={documentId} />;
  return <Home />;
}

function Home() {
  // undefined: still asking the api who this is.
  const [me, setMe] = useState<User | null>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    whoAmI().then(setMe, (problem: unknown) => { setError(problem instanceof Error ? problem.message : String(problem)); });
  }, []);

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
    <main>
      <h1>Noon MVP</h1>
      <p>
        {selfCheck.service}: {selfCheck.status}
      </p>
      {me === null && <SignIn onSignedIn={setMe} />}
      {me && (
        <>
          <p>Signed in as {me.name} ({me.email})</p>
          <button type="button" onClick={() => void create(me)}>New document</button>{" "}
          <button type="button" onClick={() => void leave()}>Sign out</button>
        </>
      )}
      {error !== undefined && <p role="alert">{error}</p>}
    </main>
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
      if (typeof result === "string") setRefusal(refusals[result] ?? "Something went wrong. Try again.");
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
        <button type="submit" value="signin" disabled={busy}>Sign in</button>
        <button type="submit" value="signup" disabled={busy}>Sign up</button>
      </div>
      {refusal !== undefined && <p role="alert">{refusal}</p>}
    </form>
  );
}
