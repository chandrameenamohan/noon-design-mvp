// Run by init.sh. No dependencies: Node 24 has fetch and a WebSocket client built in.
// Proves the path a browser will take: api session -> WebSocket with the token -> op -> sequenced.
const api = process.env["API_URL"] ?? "http://localhost:3000";
const headers = { "x-dev-user": "init-smoke@example.com", "content-type": "application/json" };
const post = async (path: string, body?: unknown): Promise<Record<string, string>> => {
  const res = await fetch(`${api}${path}`, { method: "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!res.ok) throw new Error(`POST ${path} -> ${String(res.status)}`);
  return (await res.json()) as Record<string, string>;
};

const org = await post("/orgs", { name: "init.sh smoke" });
const workspace = await post(`/orgs/${org["id"] ?? ""}/workspaces`, { name: "smoke" });
const doc = await post(`/orgs/${org["id"] ?? ""}/workspaces/${workspace["id"] ?? ""}/documents`, { title: "smoke" });
const session = await post(`/documents/${doc["id"] ?? ""}/session`);

const opId = crypto.randomUUID();
const socket = new WebSocket(session["wsUrl"] ?? "", ["noon.v1", session["token"] ?? ""]);
const outcome = await new Promise<string>((resolve) => {
  const timer = setTimeout(() => { resolve("timed out after 5 s"); }, 5000);
  socket.addEventListener("error", () => { clearTimeout(timer); resolve("the WebSocket failed to open"); });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as { type: string; seq?: number; opId?: string };
    if (message.type === "welcome") {
      socket.send(JSON.stringify({ type: "op", opId, baseSeq: 0, op: { type: "add_node", nodeId: "smoke", parentId: "root", index: 0, component: "Stack", props: {} } }));
    } else if (message.type === "op" && message.opId === opId) {
      clearTimeout(timer);
      resolve(message.seq === 1 ? "ok" : `expected seq 1, got ${String(message.seq)}`);
    } else if (message.type === "rejected") {
      clearTimeout(timer);
      resolve(`the op was rejected: ${JSON.stringify(message)}`);
    }
  });
});
socket.close();
// The org (and with it the workspace and document) is removed by init.sh, which has database access.
process.stdout.write(`${JSON.stringify({ smoke: "sync", org: org["id"], outcome })}\n`);
process.exit(outcome === "ok" ? 0 : 1);
