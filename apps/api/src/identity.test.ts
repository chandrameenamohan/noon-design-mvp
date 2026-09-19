import { expect, test } from "vitest";
import { chooseIdentity, devHeaderIdentity, noIdentity } from "./identity.ts";

test("the dev-header identity is chosen ONLY in development: every other value trusts nothing", () => {
  expect(chooseIdentity("development")).toBe(devHeaderIdentity);
  expect(chooseIdentity("production")).toBe(noIdentity);
  // A CI-built image promoted with NODE_ENV=test must not accept the header either.
  expect(chooseIdentity("test")).toBe(noIdentity);
});
