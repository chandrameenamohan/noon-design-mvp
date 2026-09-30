import { expect, test } from "vitest";
import { generate } from "@noon/codegen";
import { manifest } from "@noon/design-system";
import { emptyDoc } from "@noon/doc-model";
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
    WebSocketImpl: function NoSocket() { opened.push("socket"); throw new Error("no socket may be opened for a conflict"); } as unknown as typeof WebSocket,
  });
  const noBase = () => { opened.push("base"); return Promise.resolve({ tsx: undefined, earlierIds: new Set<string>() }); };

  const outcome = await toOps(event, { documentId: DOC, path, tsx: `${inShape.tsx}\nconsole.log("hi");\n` }, noBase);
  expect(outcome).toMatchObject({ kind: "conflict", reason: "extra_statement" });
  expect(await toOps(event, { documentId: DOC, path, refused: "not_a_file" }, noBase)).toEqual({ kind: "conflict", reason: "not_a_file", detail: path });
  expect(opened).toEqual([]);
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
    { kind: "applied", ops: 0, refused: 0 },
  ];
  for (const outcome of outcomes) await keepConflict(store, event, page, outcome);
  expect(calls).toEqual([
    ["record", DOC, { commit: event.after, file: path, reason: "spread", detail: "line 3: a spread" }],
    ["clear", DOC],
  ]);
});
