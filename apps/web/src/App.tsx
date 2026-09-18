import { HealthResponse } from "@noon/contracts";

// Until the API exists (epic 1), the page proves the contract package is wired in.
const selfCheck = HealthResponse.parse({ status: "ok", service: "web" });

export function App() {
  return (
    <main>
      <h1>Noon MVP</h1>
      <p>
        {selfCheck.service}: {selfCheck.status}
      </p>
    </main>
  );
}
