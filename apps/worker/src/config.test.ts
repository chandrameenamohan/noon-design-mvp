import { expect, test } from "vitest";
import { loadConfig } from "./config.ts";

const good = { DATABASE_URL: "postgres://app:pw@db:5432/noon", REDIS_URL: "redis://redis:6379", SESSION_TOKEN_SECRET: "s".repeat(32), SYNC_URL: "ws://sync:3001" };

// unit:worker-refuses-api-key
test("the worker refuses to start when ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) is set, even to nothing", () => {
  // Either one OUTRANKS the OAuth token inside the SDK, even when empty: the runs would be billed to
  // a different account (or fail) and nothing here would say why.
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
    for (const value of ["sk-ant-whatever", ""]) {
      expect(() => loadConfig({ ...good, [name]: value }), `${name}=${JSON.stringify(value)}`).toThrow(new RegExp(`${name} must be unset`));
    }
  }
  expect(() => loadConfig({ ...good, ANTHROPIC_API_KEY: "sk-ant-secret-value" })).not.toThrow(/secret-value/); // never echo a value
});

test("the OAuth token is optional at startup (a run without it fails fast, by name), everything else is required", () => {
  expect(loadConfig(good)).toMatchObject({ oauthToken: undefined, model: "claude-opus-5", sessions: { secret: good.SESSION_TOKEN_SECRET, syncUrl: "ws://sync:3001" } });
  expect(loadConfig({ ...good, CLAUDE_CODE_OAUTH_TOKEN: "" }).oauthToken).toBeUndefined(); // an empty line in .env means unset
  expect(loadConfig({ ...good, CLAUDE_CODE_OAUTH_TOKEN: "tok", AI_MODEL: "claude-haiku-4-5" })).toMatchObject({ oauthToken: "tok", model: "claude-haiku-4-5" });
  for (const missing of ["DATABASE_URL", "REDIS_URL", "SESSION_TOKEN_SECRET", "SYNC_URL"]) {
    expect(() => loadConfig({ ...good, [missing]: undefined }), missing).toThrow(new RegExp(missing));
  }
  expect(() => loadConfig({ ...good, SYNC_URL: "http://sync:3001" })).toThrow(/SYNC_URL/);
});
