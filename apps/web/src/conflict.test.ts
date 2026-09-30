import { expect, test } from "vitest";
import { ConflictReason } from "@noon/contracts";
import { conflictWords } from "./conflict.ts";

const conflict = { commit: "c".repeat(40), file: "src/pages/<img src=x onerror=alert(1)>.tsx", reason: "spread", detail: "line 3: a spread", at: "2026-09-30T00:00:00.000Z" } as const;

test("every reason a push can be refused for has its own sentence", () => {
  const sentences = ConflictReason.options.map((reason) => conflictWords({ ...conflict, reason, detail: "" }).why);
  for (const sentence of sentences) expect(sentence).toMatch(/^[A-Z].*\.$/u);
  expect(new Set(sentences).size).toBe(sentences.length);
});

test("the banner names the commit and the file exactly as pushed, and parse's detail after the sentence", () => {
  expect(conflictWords(conflict)).toEqual({ commit: conflict.commit, file: conflict.file, why: "It spreads props instead of writing each one. (line 3: a spread)" });
});
