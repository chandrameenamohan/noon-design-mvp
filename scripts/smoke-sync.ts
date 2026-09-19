// Run by init.sh against the real containers. Proves the path every peer takes, with the client
// every peer uses: api session -> @noon/peer-client -> WebSocket with the token -> op -> acknowledged.
import { SessionResponse } from "@noon/contracts";
import { manifest } from "@noon/design-system";
import { connectPeer } from "@noon/peer-client";

const api = process.env["API_URL"] ?? "http://localhost:3000";
const headers = { "x-dev-user": "init-smoke@example.com", "content-type": "application/json" };
const post = async (path: string, body?: unknown): Promise<unknown> => {
  const res = await fetch(`${api}${path}`, { method: "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!res.ok) throw new Error(`POST ${path} -> ${String(res.status)}`);
  return res.json();
};
const idOf = (created: unknown): string => (created as { id: string }).id;

const org = idOf(await post("/orgs", { name: "init.sh smoke" }));
const workspace = idOf(await post(`/orgs/${org}/workspaces`, { name: "smoke" }));
const doc = idOf(await post(`/orgs/${org}/workspaces/${workspace}/documents`, { title: "smoke" }));

const outcome = await new Promise<string>((resolve) => {
  const timer = setTimeout(() => { resolve(`timed out after 5 s (status: ${peer.status})`); }, 5000);
  let submitted = false;
  const peer = connectPeer({
    manifest,
    session: async () => SessionResponse.parse(await post(`/documents/${doc}/session`)),
    onRejected: (rejection) => { clearTimeout(timer); resolve(`the op was rejected: ${rejection.reason}`); },
    onStatus: (status) => { if (status === "closed") resolve(`the peer closed: ${String(peer.closedBecause)}`); },
    onChange: () => {
      if (peer.status !== "live") return;
      if (!submitted) {
        submitted = true;
        const result = peer.submit({ type: "add_node", nodeId: "smoke", parentId: "root", index: 0, component: "Stack", props: {} });
        if (!result.ok) resolve(`the op was refused locally: ${result.reason}`);
      } else if (peer.pendingCount === 0) {
        clearTimeout(timer);
        resolve("ok"); // first: close() reports "closed" through onStatus, and the first resolve wins
        peer.close();
      }
    },
  });
});
// The org (and with it the workspace and document) is removed by init.sh, which has database access.
process.stdout.write(`${JSON.stringify({ smoke: "sync", org, outcome })}\n`);
process.exit(outcome === "ok" ? 0 : 1);
