import { expect, test } from "vitest";
import { refusalWords } from "./signIn.ts";

// The api's sign-in limit is a 5-minute window (E9.6); the form says the api's Retry-After, not "a minute".
test("over the attempt limit, the form names the api's Retry-After, rounded up to whole minutes", () => {
  expect(refusalWords({ error: "too_many_attempts", retryAfterSeconds: 300 })).toBe("Too many attempts. Try again in 5 minutes.");
  expect(refusalWords({ error: "too_many_attempts", retryAfterSeconds: 61 })).toBe("Too many attempts. Try again in 2 minutes.");
  expect(refusalWords({ error: "too_many_attempts", retryAfterSeconds: 45 })).toBe("Too many attempts. Try again in 45 seconds.");
  expect(refusalWords({ error: "too_many_attempts" })).toBe("Too many attempts. Try again in a few minutes.");
});

test("the other refusals keep their words, and an unknown name gets an honest general sentence", () => {
  expect(refusalWords({ error: "invalid_credentials" })).toBe("That email and password do not match an account.");
  expect(refusalWords({ error: "email_taken" })).toBe("An account with that email already exists. Sign in instead.");
  expect(refusalWords({ error: "internal" })).toBe("Something went wrong. Try again.");
});
