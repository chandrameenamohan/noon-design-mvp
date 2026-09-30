import { describe, expect, test } from "vitest";
import { Document, ErrorBody, Org, Run, Workspace } from "@noon/contracts";
import type { Rule } from "@noon/db";
import { buildApp } from "./app.ts";
import { devHeaderIdentity } from "./identity.ts";
import { TEST_SESSIONS, useTestServer } from "./testing.ts";

// integration:rate-limit-429-retry-after (E9.5, F31). An org may start `limit` AI runs per window, however many api
// instances it asks (two apps over one database here, and requests at the same moment): the next is 429 with a
// Retry-After that is the window's end, to the second. Only runs that are MADE count: a busy document, a refused run
// and a replayed key cost nothing, and a refused request's Idempotency-Key is not used up. Other orgs are untouched.
const ctx = useTestServer();
const instance = (limit: Rule) => buildApp({ db: ctx.db.db, identify: devHeaderIdentity, sessions: TEST_SESSIONS, enqueue: () => Promise.resolve(), aiRunLimit: limit });

const post = (user: string, path: string, body: unknown) =>
  ctx.fetch(path, { method: "POST", headers: { "x-dev-user": user, "content-type": "application/json" }, body: JSON.stringify(body) });
/** An org of `owner`'s with `count` documents (one unfinished run per document, so each run needs its own). */
async function documents(owner: string, count: number): Promise<Document[]> {
  const org = Org.parse(await (await post(owner, "/orgs", { name: "Limits" })).json());
  const ws = Workspace.parse(await (await post(owner, `/orgs/${org.id}/workspaces`, { name: "w" })).json());
  return Promise.all(Array.from({ length: count }, async () => Document.parse(await (await post(owner, `/orgs/${org.id}/workspaces/${ws.id}/documents`, { title: "Page" })).json())));
}
const start = async (app: ReturnType<typeof instance>, user: string, doc: Document, key?: string): Promise<Response> =>
  app.request(`/documents/${doc.id}/runs`, { method: "POST", headers: { "x-dev-user": user, "content-type": "application/json", ...(key === undefined ? {} : { "idempotency-key": key }) }, body: JSON.stringify({ instruction: "add a hero" }) });
const runsOf = async (orgId: string): Promise<number> =>
  Number(((await ctx.db.rawQuery("select count(*)::int as n from jobs where org_id = $1 and queue = 'ai'", [orgId])) as { rows: { n: number }[] }).rows[0]?.n);
/** Seconds to the end of the current window by the DATABASE's clock (the one the limiter reads). */
const secondsLeft = async (windowSeconds: number): Promise<number> =>
  Number(((await ctx.db.rawQuery("select ($1::float8 - mod(extract(epoch from clock_timestamp()), $1::float8::numeric)::float8) as remaining", [windowSeconds])) as { rows: { remaining: number }[] }).rows[0]?.remaining);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("integration:rate-limit-429-retry-after", () => {
  test("ten starts at once across two api instances, limit three: three runs, seven 429s whose Retry-After is the window's end", async () => {
    const rule = { limit: 3, windowSeconds: 3600 };
    const [a, b] = [instance(rule), instance(rule)];
    const docs = await documents("ann@example.com", 10);
    const answers = await Promise.all(docs.map((doc, i) => start(i % 2 === 0 ? a : b, "ann@example.com", doc)));
    const left = await secondsLeft(rule.windowSeconds);
    expect(answers.map((res) => res.status).sort()).toEqual([201, 201, 201, ...Array<number>(7).fill(429)]);
    expect(await runsOf(docs[0]?.orgId ?? "")).toBe(3);
    for (const res of answers.filter((each) => each.status === 429)) {
      const retry = Number(res.headers.get("retry-after"));
      expect(Number.isInteger(retry)).toBe(true);
      expect(Math.abs(retry - left)).toBeLessThanOrEqual(2); // measured a moment later, rounded up
      expect(ErrorBody.parse(await res.json())).toEqual({ error: "rate_limited", retryAfterSeconds: retry });
    }
    // Another org has its own count.
    const [theirs] = await documents("bob@example.com", 1);
    expect((await start(a, "bob@example.com", theirs as Document)).status).toBe(201);
  });

  test("only runs that are made count: a busy document and a refused run cost nothing, and a replayed key is answered, not refused", async () => {
    const app = instance({ limit: 2, windowSeconds: 3600 });
    const [one, two, three] = await documents("cat@example.com", 3) as [Document, Document, Document];
    const key = crypto.randomUUID();
    const first = await start(app, "cat@example.com", one, key);
    expect(first.status).toBe(201);
    const made = Run.parse(await first.json());
    // `one` is busy: 409, and not a hit, so `two` still fits.
    expect((await start(app, "cat@example.com", one)).status).toBe(409);
    expect((await start(app, "cat@example.com", two)).status).toBe(201);
    expect((await start(app, "cat@example.com", three)).status).toBe(429);
    expect((await start(app, "cat@example.com", three)).status).toBe(429); // the refusals did not add up to a longer wait
    // Over the limit, the first request's retry still gets the run it made.
    const replay = await start(app, "cat@example.com", one, key);
    expect(replay.status).toBe(201);
    expect(Run.parse(await replay.json()).id).toBe(made.id);
    expect(await runsOf(one.orgId)).toBe(2);
  });

  test("a refused request's key is not used up: after Retry-After, the same key makes the run, and then replays it", async () => {
    const rule = { limit: 1, windowSeconds: 2 };
    const app = instance(rule);
    const [one, two] = await documents("dan@example.com", 2) as [Document, Document];
    // Start early in a window, so the first run and the refusal fall in the same one.
    const left = await secondsLeft(rule.windowSeconds);
    if (left < 1.5) await sleep(left * 1000 + 50);
    expect((await start(app, "dan@example.com", one)).status).toBe(201);
    const key = crypto.randomUUID();
    const refused = await start(app, "dan@example.com", two, key);
    expect(refused.status).toBe(429);
    const retry = Number(refused.headers.get("retry-after"));
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(rule.windowSeconds);
    await sleep(retry * 1000);
    const later = await start(app, "dan@example.com", two, key);
    expect(later.status).toBe(201); // not 422: the refused request left no claim on the key
    const run = Run.parse(await later.json());
    const again = await start(app, "dan@example.com", two, key);
    expect(again.status).toBe(201);
    expect(Run.parse(await again.json()).id).toBe(run.id);
  });

  test("the running server uses the default limit (AI_RUNS_PER_HOUR, 60): an ordinary start is not refused", async () => {
    const [doc] = await documents("eve@example.com", 1);
    expect((await post("eve@example.com", `/documents/${doc?.id ?? ""}/runs`, { instruction: "add a hero" })).status).toBe(201);
  });
});
