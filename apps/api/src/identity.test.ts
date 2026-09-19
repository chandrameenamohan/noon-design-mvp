import { expect, test } from "vitest";
import { chooseIdentity, devHeaderIdentity, noIdentity } from "./identity.ts";

test("the dev-header identity is chosen only outside production", () => {
  expect(chooseIdentity("production")).toBe(noIdentity);
  expect(chooseIdentity("development")).toBe(devHeaderIdentity);
  expect(chooseIdentity("test")).toBe(devHeaderIdentity);
});
