import { expect, test } from "vitest";
import { FailureReason } from "@noon/contracts";
import { failureReason } from "./sdk.ts";

test("a failed run is named after what the USER can do about it, and every name fits the contract", () => {
  expect(failureReason("success", "authentication_failed")).toBe("token_invalid"); // measured: an expired setup-token arrives as result=success, is_error=true
  expect(failureReason("success", "oauth_org_not_allowed")).toBe("token_invalid");
  expect(failureReason("success", "rate_limit")).toBe("rate_limited");
  expect(failureReason("success", "overloaded")).toBe("provider_unavailable");
  expect(failureReason("success", "billing_error")).toBe("account_problem");
  expect(failureReason("error_max_turns", undefined)).toBe("too_many_steps");
  expect(failureReason("error_during_execution", undefined)).toBe("agent_failed");
  expect(failureReason("success", "something_new_from_a_newer_sdk")).toBe("agent_failed"); // an unknown value is not a crash
  for (const api of ["authentication_failed", "rate_limit", "overloaded", "billing_error", undefined]) expect(FailureReason.safeParse(failureReason("success", api)).success).toBe(true);
});
