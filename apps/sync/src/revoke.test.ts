import { randomUUID } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import WebSocket from "ws";
import type { ClientMessage, Role } from "@noon/contracts";
import { ROOT_ID } from "@noon/doc-model";
import { signSessionToken } from "@noon/session-token";
import { startSyncServer, type RunningSyncServer } from "./server.ts";

// A role read that can be changed (or hung) mid-test, for sessions that are already open: no Postgres needed.
// testing.ts reaches for Redis's password at import, so these peers are plain sockets with their own tokens.
const SECRET = "test-only-session-secret-0123456789abcdef";
const ORG = "22222222-2222-4222-8222-222222222222";
let server: RunningSyncServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

type Peer = { ws: WebSocket; userId: string; types: string[]; welcomed: Promise<unknown>; closed: Promise<number> };
function join(url: string, documentId: string): Peer {
  const userId = randomUUID();
  const ws = new WebSocket(`${url}/documents/${documentId}`, ["noon.v1", signSessionToken({ userId, orgId: ORG, documentId, secret: SECRET, ttlSeconds: 60 })]);
  ws.on("error", () => undefined);
  const types: string[] = [];
  // Listening from the start: the welcome can come in the same packet as the upgrade's answer.
  const welcomed = new Promise((resolve) => ws.on("message", (data: WebSocket.RawData) => {
    const type = (JSON.parse(String(data)) as { type: string }).type;
    types.push(type);
    if (type === "welcome") resolve(type);
  }));
  return { ws, userId, types, welcomed, closed: new Promise((resolve) => ws.once("close", resolve)) };
}
const addOp = (): ClientMessage => ({ type: "op", opId: randomUUID(), baseSeq: 0, op: { type: "add_node", nodeId: randomUUID(), parentId: ROOT_ID, index: 0, component: "Stack", props: {} } });
const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// noon-dtf.3.1: a revoke closed the editor's socket (4404) but left it able to edit, and ws still hands over the
// frames that arrive while the close handshake is under way: an op sent in that round trip was committed AFTER the
// revoke, and every other peer received it.
test("an op a revoked editor sent while its socket was being closed is not accepted", async () => {
  const documentId = randomUUID();
  const access = new Map<string, Role | undefined>();
  server = await startSyncServer({ port: 0, secrets: [SECRET], roles: (_org, _doc, userId) => Promise.resolve(access.get(userId)) });
  const watcher = join(server.url, documentId);
  access.set(watcher.userId, "owner");
  const editor = join(server.url, documentId);
  access.set(editor.userId, "editor");
  await Promise.all([watcher.welcomed, editor.welcomed]);

  access.delete(editor.userId);
  await server.recheck({ orgId: ORG, userId: editor.userId }); // the server has sent its close (4404)...
  editor.ws.send(JSON.stringify(addOp())); // ...and this op is already on its way, before the editor reads that close
  expect(await editor.closed).toBe(4404);
  await settle(100);
  expect(watcher.types).not.toContain("op");
});

// noon-dtf.2.2: a role read had no deadline. One on a silently hung Postgres connection held the 30 s sweep (which
// never overlaps itself) until TCP gave up, disabling the backstop for an unannounced revoke all that time.
test("a role read that never answers counts as failed and is asked again, so a sweep is not held up by it", async () => {
  const documentId = randomUUID();
  let reads = 0;
  let revoked = false;
  server = await startSyncServer({
    port: 0, secrets: [SECRET], journalTimeoutMs: 50, recoverMs: 10,
    roles: () => {
      if (!revoked) return Promise.resolve("editor");
      reads += 1;
      return reads === 1 ? new Promise<never>(() => undefined) : Promise.resolve(undefined); // hung, then the answer
    },
  });
  const outsider = join(server.url, documentId);
  await outsider.welcomed;
  revoked = true;
  await server.recheck("all");
  expect(await outsider.closed).toBe(4404);
  expect(reads).toBe(2);
});

// noon-dtf.2.3: the api announces a change once, best effort. With its Redis away (the sync nodes' up), only the sweep
// applies it, and at the default 30 s that broke F24's "role changes apply to open sessions within 10 s".
test("a revoke nobody announced still closes the session within F24's 10 s, at the default sweep", { timeout: 15_000 }, async () => {
  const documentId = randomUUID();
  let revoked = false;
  server = await startSyncServer({ port: 0, secrets: [SECRET], roles: () => Promise.resolve(revoked ? undefined : "editor") });
  const outsider = join(server.url, documentId);
  await outsider.welcomed;
  revoked = true;
  const started = performance.now();
  expect(await outsider.closed).toBe(4404);
  expect(performance.now() - started).toBeLessThan(10_000);
});
