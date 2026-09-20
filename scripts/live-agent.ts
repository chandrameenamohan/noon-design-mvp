// live:agent-adds-node. Outside `make check`: it calls the real model (the owner's subscription) and
// needs the dev stack up (./init.sh) with CLAUDE_CODE_OAUTH_TOKEN in .env.
//   node scripts/live-agent.ts            (API_URL defaults to http://localhost:3000)
// A run is created through the api, the worker's agent edits the document through the sync server,
// and this script watches the ops arrive as a second peer would.
import { manifest } from "@noon/design-system";
import { connectPeer } from "@noon/peer-client";

const api = process.env["API_URL"] ?? "http://localhost:3000";
const headers = { "x-dev-user": "live-agent@example.com", "content-type": "application/json" };
const post = async (path: string, body?: unknown): Promise<Record<string, string>> => {
  const res = await fetch(`${api}${path}`, { method: "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!res.ok) throw new Error(`POST ${path} -> ${String(res.status)} ${await res.text()}`);
  return (await res.json()) as Record<string, string>;
};

const org = await post("/orgs", { name: "live agent" }); // clean up afterwards: delete from orgs where name = 'live agent'
const ws = await post(`/orgs/${org["id"] ?? ""}/workspaces`, { name: "ws" });
const doc = await post(`/orgs/${org["id"] ?? ""}/workspaces/${ws["id"] ?? ""}/documents`, { title: "Checkout" });
const docId = doc["id"] ?? "";

const watcher = connectPeer({ manifest, session: async () => post(`/documents/${docId}/session`) as Promise<{ wsUrl: string; token: string }> });
const run = await post(`/documents/${docId}/runs`, { instruction: "Add a payment card: a Card titled Payment that contains an Input for the card number and a primary Button labelled Pay." });
const started = Date.now();
let status = "queued";
let error: string | null = null;
while (status === "queued" || status === "running") {
  if (Date.now() - started > 180_000) throw new Error("the run did not finish within 3 minutes");
  await new Promise((r) => setTimeout(r, 1000));
  const now = (await (await fetch(`${api}/documents/${docId}/runs/${run["id"] ?? ""}`, { headers })).json()) as { status: string; error: string | null };
  ({ status, error } = now);
}
await new Promise((r) => setTimeout(r, 500));
const nodes = Object.values(watcher.confirmed.nodes).filter((n) => n.id !== "root").map((n) => ({ component: n.component, props: n.props, parent: n.parentId }));
watcher.close();
const has = (component: string): boolean => nodes.some((n) => n.component === component);
const outcome = status === "succeeded" && has("Card") && has("Button") && has("Input") ? "ok" : "FAILED";
process.stdout.write(`${JSON.stringify({ live: "agent-adds-node", outcome, status, error, seconds: Math.round((Date.now() - started) / 1000), seq: watcher.seq, nodes }, null, 1)}\n`);
process.exit(outcome === "ok" ? 0 : 1);
