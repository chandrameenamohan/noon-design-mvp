import { expect, test } from "vitest";
import { AuditAction, type AuditEntry } from "@noon/contracts";
import { auditWords } from "./audit.ts";

const base: AuditEntry = {
  id: "0f9c7a0e-1b2c-4d3e-8f00-000000000001",
  orgId: "0f9c7a0e-1b2c-4d3e-8f00-000000000002",
  actor: { kind: "user", id: "0f9c7a0e-1b2c-4d3e-8f00-000000000003", email: "owner@example.com" },
  action: "signed_in",
  documentId: null,
  detail: {},
  at: "2026-09-30T00:00:00.000Z",
};

test("every action has its own sentence, even with no detail at all", () => {
  const sentences = AuditAction.options.map((action) => auditWords({ ...base, action }).what);
  for (const sentence of sentences) expect(sentence.length).toBeGreaterThan(0);
  expect(new Set(sentences).size).toBe(sentences.length);
});

test("who: the person's email as it was, a push's commit, or the system", () => {
  expect(auditWords(base).who).toBe("owner@example.com");
  expect(auditWords({ ...base, actor: { kind: "git", id: null, email: null }, action: "push_rejected", detail: { commit: "a".repeat(40) } }).who).toBe(`Git, commit ${"a".repeat(12)}`);
  expect(auditWords({ ...base, actor: { kind: "system", id: null, email: null } }).who).toBe("The system");
});

test("what: the details, exactly as typed (markup stays text for the view to render as such)", () => {
  const instruction = `<img src=x onerror="alert(1)"> add a card`;
  expect(auditWords({ ...base, action: "run_started", detail: { run: base.id, instruction } }).what).toBe(`Started an AI run: “${instruction}”`);
  expect(auditWords({ ...base, action: "role_changed", detail: { email: "ed@example.com", role: "editor", previous: "none" } }).what).toBe("Added ed@example.com as editor.");
  expect(auditWords({ ...base, action: "role_changed", detail: { email: "ed@example.com", role: "viewer", previous: "editor" } }).what).toBe("Changed the role of ed@example.com from editor to viewer.");
  expect(auditWords({ ...base, action: "share_granted", detail: { email: "out@example.com", role: "viewer" } }).what).toBe("Shared a document with out@example.com as viewer.");
  expect(auditWords({ ...base, action: "push_rejected", detail: { file: "src/pages/p.tsx", reason: "spread" } }).what).toBe("A push to src/pages/p.tsx was not applied. It spreads props instead of writing each one.");
  expect(auditWords({ ...base, action: "push_rejected", detail: { file: "f", reason: "a reason from a newer build" } }).what).toBe("A push to f was not applied. It broke the page's rules.");
});
