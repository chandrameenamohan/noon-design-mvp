import type { ErrorBody } from "@noon/contracts";
import { waitWords } from "./usage.ts";

/** The api's refusal of a sign-in or sign-up: its error NAME and, over the attempt limit (429), how long to wait. */
export type AuthRefusal = { error: ErrorBody["error"]; retryAfterSeconds?: number };

/** What the api's refusal NAME means to the person at the form. The api never says which of email or password was wrong. */
const WORDS: Partial<Record<ErrorBody["error"], string>> = {
  invalid_credentials: "That email and password do not match an account.",
  email_taken: "An account with that email already exists. Sign in instead.",
  invalid_body: "Enter a valid email, a name, and a password of 8 to 128 characters.",
};

/** The refusal in the user's words. The attempt limit names the api's own Retry-After (E9.6: the window is minutes, not "a minute"). */
export function refusalWords(refusal: AuthRefusal): string {
  if (refusal.error === "too_many_attempts") return `Too many attempts. Try again in ${refusal.retryAfterSeconds === undefined ? "a few minutes" : waitWords(refusal.retryAfterSeconds)}.`;
  return WORDS[refusal.error] ?? "Something went wrong. Try again.";
}
