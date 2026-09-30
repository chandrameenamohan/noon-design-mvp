import { expect, test } from "vitest";
import { generate } from "@noon/codegen";
import { manifest } from "@noon/design-system";
import { emptyDoc } from "@noon/doc-model";
import { WaitAgain } from "./git.ts";
import { createPushApplier, keepConflict, type PushOutcome } from "./push.ts";

// E5.4 (F16b), the pure half: a page out of shape is refused BEFORE anything is opened, and the refusal is
// what the banner shows. The rest (the room, Postgres, the canvas) is e2e/conflict.spec.ts.
const DOC = "0f9c7a0e-1b2c-4d3e-8f00-00000000e540";
const event = { id: "0f9c7a0e-1b2c-4d3e-8f00-0000000000ee", ref: `refs/heads/noon/${DOC}`, before: "a".repeat(40), after: "b".repeat(40) };
const path = `src/pages/noon-${DOC}.tsx`;
const inShape = generate(emptyDoc(), manifest);
if (!inShape.ok) throw new Error(inShape.reason);

test("a page out of shape on the document's branch is a conflict, and nothing is opened to the room", async () => {
  const opened: string[] = [];
  const toOps = createPushApplier({
    sessions: { secret: "s".repeat(32), syncUrl: "ws://127.0.0.1:1" },
    manifest,
    documentOrg: (id) => { opened.push(`org ${id}`); return Promise.resolve("org"); },
    shippedCommit: () => Promise.resolve(false),
    pushedNodeIds: () => Promise.resolve(new Set<string>()),
    WebSocketImpl: function NoSocket() { opened.push("socket"); throw new Error("no socket may be opened for a conflict"); } as unknown as typeof WebSocket,
  });
  const noBase = () => { opened.push("base"); return Promise.resolve({ tsx: undefined, earlierIds: new Set<string>() }); };

  const outcome = await toOps(event, { documentId: DOC, path, tsx: `${inShape.tsx}\nconsole.log("hi");\n` }, noBase);
  expect(outcome).toMatchObject({ kind: "conflict", reason: "extra_statement" });
  expect(await toOps(event, { documentId: DOC, path, refused: "not_a_file" }, noBase)).toEqual({ kind: "conflict", reason: "not_a_file", detail: path });
  expect(opened).toEqual([]);
});

test("a commit Ship made is skipped before anything is read or opened: the room already holds that document (E5.5)", async () => {
  const asked: string[] = [];
  const opened: string[] = [];
  const toOps = createPushApplier({
    sessions: { secret: "s".repeat(32), syncUrl: "ws://127.0.0.1:1" },
    manifest,
    documentOrg: () => { opened.push("org"); return Promise.resolve("org"); },
    shippedCommit: (sha) => { asked.push(sha); return Promise.resolve(sha === event.after); },
    pushedNodeIds: () => Promise.resolve(new Set<string>()),
    WebSocketImpl: function NoSocket() { opened.push("socket"); throw new Error("no socket may be opened for a shipped commit"); } as unknown as typeof WebSocket,
  });
  const noBase = () => { opened.push("base"); return Promise.resolve({ tsx: undefined, earlierIds: new Set<string>() }); };
  expect(await toOps(event, { documentId: DOC, path, tsx: inShape.tsx }, noBase)).toEqual({ kind: "skipped", why: "shipped" });
  expect(asked).toEqual([event.after]);
  expect(opened).toEqual([]);
  // Another branch is not asked about at all: only the document's own branch speaks for it.
  expect(await toOps({ ...event, ref: "refs/heads/main" }, { documentId: DOC, path, tsx: inShape.tsx }, noBase)).toEqual({ kind: "skipped", why: "other_branch" });
  expect(asked).toHaveLength(1);
});

test("E6.1b: a document whose room is read-only is not edited and not failed: the event waits (WaitAgain)", async () => {
  const sent: string[] = [];
  class ReadOnlyRoom extends EventTarget {
    constructor() {
      super();
      queueMicrotask(() => { this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify({ type: "welcome", doc: emptyDoc(), seq: 0, readOnly: true }) })); });
    }
    send(frame: string): void { sent.push(frame); }
    close(): void { /* the peer closes it when done */ }
  }
  const toOps = createPushApplier({
    sessions: { secret: "s".repeat(32), syncUrl: "ws://127.0.0.1:1" },
    manifest,
    documentOrg: () => Promise.resolve("0f9c7a0e-1b2c-4d3e-8f00-0000000000aa"),
    shippedCommit: () => Promise.resolve(false),
    pushedNodeIds: () => Promise.resolve(new Set<string>()),
    WebSocketImpl: ReadOnlyRoom as unknown as typeof WebSocket,
  });
  const withStack = generate({ rootId: "root", nodes: { root: { id: "root", component: "Page", props: {}, parentId: null, children: ["n1"] }, n1: { id: "n1", component: "Stack", props: {}, parentId: "root", children: [] } } }, manifest);
  if (!withStack.ok) throw new Error(withStack.reason);
  const page = toOps(event, { documentId: DOC, path, tsx: withStack.tsx }, () => Promise.resolve({ tsx: undefined, earlierIds: new Set<string>() }));
  await expect(page).rejects.toBeInstanceOf(WaitAgain);
  expect(sent.filter((frame) => frame.includes('"type":"op"'))).toEqual([]);
});

test("a refused page becomes the document's conflict, naming commit and file; an applied one clears it; a skipped one changes nothing", async () => {
  const calls: unknown[] = [];
  const store = {
    recordConflict: (documentId: string, conflict: unknown) => { calls.push(["record", documentId, conflict]); return Promise.resolve(); },
    clearConflict: (documentId: string) => { calls.push(["clear", documentId]); return Promise.resolve(); },
  };
  const page = { documentId: DOC, path, tsx: "" };
  const outcomes: PushOutcome[] = [
    { kind: "conflict", reason: "spread", detail: "line 3: a spread" },
    { kind: "skipped", why: "other_branch" },
    { kind: "skipped", why: "no_document" },
    { kind: "skipped", why: "shipped" },
    { kind: "applied", ops: 0, refused: 0 },
  ];
  for (const outcome of outcomes) await keepConflict(store, event, page, outcome);
  expect(calls).toEqual([
    ["record", DOC, { commit: event.after, file: path, reason: "spread", detail: "line 3: a spread" }],
    ["clear", DOC],
  ]);
});

test("noon-91u: the same push applied twice sends the same op ids (the room answers a repeat with its first answer), and asks the journal what it added", async () => {
  const withStack = generate({ rootId: "root", nodes: { root: { id: "root", component: "Page", props: {}, parentId: null, children: ["n1"] }, n1: { id: "n1", component: "Stack", props: {}, parentId: "root", children: [] } } }, manifest);
  if (!withStack.ok) throw new Error(withStack.reason);
  let sent: string[] = [];
  class Room extends EventTarget {
    constructor() {
      super();
      queueMicrotask(() => { this.answer({ type: "welcome", doc: emptyDoc(), seq: 0 }); });
    }
    answer(message: unknown): void { this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(message) })); }
    send(frame: string): void {
      const message = JSON.parse(frame) as { type: string; opId?: string };
      if (message.type !== "op" || message.opId === undefined) return;
      sent.push(message.opId);
      const opId = message.opId;
      queueMicrotask(() => { this.answer({ type: "ack", opId }); });
    }
    close(): void { /* the peer closes it when done */ }
  }
  const asked: string[] = [];
  const toOps = createPushApplier({
    sessions: { secret: "s".repeat(32), syncUrl: "ws://127.0.0.1:1" },
    manifest,
    documentOrg: () => Promise.resolve("0f9c7a0e-1b2c-4d3e-8f00-0000000000aa"),
    shippedCommit: () => Promise.resolve(false),
    pushedNodeIds: (documentId, commit) => { asked.push(`${documentId} ${commit}`); return Promise.resolve(new Set<string>()); },
    WebSocketImpl: Room as unknown as typeof WebSocket,
  });
  const apply = (e: typeof event) => toOps(e, { documentId: DOC, path, tsx: withStack.tsx }, () => Promise.resolve({ tsx: undefined, earlierIds: new Set<string>() }));
  expect(await apply(event)).toEqual({ kind: "applied", ops: 1, refused: 0 });
  const first = sent;
  sent = [];
  await apply(event);
  expect(sent).toEqual(first);
  expect(asked).toEqual([`${DOC} ${event.after}`, `${DOC} ${event.after}`]);
  sent = [];
  await apply({ ...event, after: "c".repeat(40) }); // another commit's op is its own, however alike
  expect(sent).toHaveLength(1);
  expect(sent).not.toEqual(first);
});
