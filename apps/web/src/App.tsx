import { useState } from "react";
import { HealthResponse } from "@noon/contracts";
import { createDocument } from "./api.ts";
import { Canvas } from "./Canvas.tsx";

const selfCheck = HealthResponse.parse({ status: "ok", service: "web" });

export function App() {
  // ponytail: the address bar is the router. ?doc=<id> is a document; anything else is home.
  const documentId = new URLSearchParams(location.search).get("doc");
  const [error, setError] = useState<string>();
  if (documentId) return <Canvas documentId={documentId} />;

  const create = async (): Promise<void> => {
    try {
      const url = new URL(location.href);
      url.searchParams.set("doc", await createDocument());
      location.assign(url);
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
      <button type="button" onClick={() => void create()}>New document</button>
      {error !== undefined && <p role="alert">{error}</p>}
    </main>
  );
}
