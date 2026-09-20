# HANDOFF: Noon-like MVP

Written 2026-09-20 at commit `0f7320f`, updated at `2e00802` (end of epic 3). Read this first in a new session, then run
`bd prime`. Everything here is either a decision the user made or a fact about the repo; where a
file is the source of truth, this points at it instead of repeating it.

## 1. Who and what

The user (chandrameenamohan@gmail.com) is a Java/Python backend engineer preparing for Noon's
"Fullstack Backend Architect" role. They are learning TypeScript from zero ("Typescript 101"), and
want principal-engineer depth: TS/Node internals, design choices, trade-offs versus Java and Python.

The project: a Noon-like MVP. A multi-user design canvas where a **user, an AI agent, git and a
sandbox preview** all edit or render the same document. TypeScript monorepo, distributed backend,
every datastore that is needed, added in the epic that needs it.

**Claude writes ALL the code.** Each epic ships with a handbook lesson that explains how it was
written. The user reads lessons at their own pace. Their last standing instruction:
**"continue on the completion of it. I can go through lessons on my own pace."** Do not pause for them.

## 2. Decisions that are locked (do not re-litigate)

- Process: the user's own `software_development_workflow_v6.md`, FULL tier. We are in **W3 BUILD**.
- **NEVER use the Workflow tool** (the user reserves dynamic workflows for other work). Use parallel
  Agent-tool subagents plus in-session work.
- Runtime Node.js 24 (Bun rejected). TypeScript pinned `~6.0.0` (typescript-eslint lacks TS 7).
  Native type stripping, no build step: `.ts` import extensions, `erasableSyntaxOnly`
  (no enums, no parameter properties), `verbatimModuleSyntax`.
- Sync: our own server-authoritative, Figma-style design (one room per document orders ops). Not Yjs.
- Git and sandbox: local first (local git server, Docker sandbox).
- AI agent: **Claude Agent SDK for TypeScript, authenticated with `CLAUDE_CODE_OAUTH_TOKEN`**
  (a `claude setup-token` long-lived token, already in `.env`). NOT an Anthropic API key;
  `ANTHROPIC_API_KEY` must be UNSET in the worker (it outranks the OAuth token). Anthropic's terms
  forbid offering claude.ai login to third parties: fine for the owner's local MVP only; keep auth
  env-driven so an API key can be swapped in.
- Final verification (epic Z, part of W3): a LOCAL Antithesis-style harness, the same method as the
  user's `~/repos/ai-engine/deploy/antithesis` (SPEC §4a). Bugs it finds get fixed.
- Lessons: one artifact page per epic + a printable **PDF of every lesson, sent with SendUserFile**
  + drills that start RED for the user to solve alone.
- Ponytail mode is active (laziest working solution; mark shortcuts with `ponytail:` comments that
  name the ceiling and the upgrade path). Never simplify away validation at trust boundaries,
  data-loss prevention, security, accessibility.
- Web browsing: the gstack `/browse` skill only; never `mcp__claude-in-chrome__*`.
- Secrets: `.env` is git-ignored and holds `CLAUDE_CODE_OAUTH_TOKEN` and generated secrets.
  **Never print, log or copy its contents.**
- Commits: never `--no-verify` (the pre-commit hook runs `make check`). Trailers:
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and the session's `Claude-Session:` line.
- Task tracking: `bd` (beads) only. No TodoWrite. Never `bd edit`. `bd prime` after compaction.

## 3. Where things are written down

| What | Where |
|---|---|
| The approved spec (keystones §2, rules learned §2a, features F1-F31 §3, failure modes §4, Antithesis §4a, e2e scenario §8) | `SPEC.md` |
| The bead graph, readable | `BEADS.md`; key -> bd id map in `.beads/key-map.json` (e.g. `E3.1` -> `noon-tqx.1`) |
| Lessons learned per bead (the real project memory) | `bd memories` / `bd prime` (written with `bd remember`) |
| Deferred review findings | `bd show <id>` NOTES on the bead that will own them |
| Verification layers | `VERIFICATION.md`, `Makefile` |
| Handbook index, lesson builders, PDFs | `docs/handbook/` |
| Drills | `drills/lesson-N/` (`sh drills/lesson-N/check.sh`) |
| Claude's auto-memory | `~/.claude/projects/-Users-cm-100x-personal-noon-design-mvp/memory/` |

Helper used all session:
`K() { python3 -c "import json;print(json.load(open('.beads/key-map.json'))['$1'])"; }` then `bd show $(K E3.1)`.

## 4. State: epics 0, 1, 2 and 3 are BUILT

`make check` is green at HEAD. Epic 3's work is finished, reviewed and verified, but E3.2, E3.3,
E3.4 and E3.H are **still open in bd for ONE reason**: the live check
`node scripts/live-agent.ts` cannot pass, because `CLAUDE_CODE_OAUTH_TOKEN` in `.env` is rejected
by the provider (401, on the host as well as in the container). Every real run ends
`failed / token_invalid`, which is the designed answer. **Ask the owner to run `claude setup-token`
and put the value in `.env`**, then:

```
docker compose up -d worker && node scripts/live-agent.ts   # expect: outcome ok
bd close <E3.2> <E3.3> <E3.4> <E3.H> and the epic
```

Everything else in epic 3 is done: each bead has a STATUS note saying so, and `bd memories e3-`
holds its lessons (e3-1-jobs-queue-worker, e3-2-ai-peer, e3-3-instruction-cancel, e3-4-usage,
e3-h-lesson-3).

Lessons published (private to the user):
- 0001 HLD: https://claude.ai/artifact/J2DVNLFHkKrLPwLyghFBc4
- Lesson 0 (TS primer): https://claude.ai/artifact/3qLjxgH6vjT2bUnEa52omY
- Lesson 1 (epic 1): https://claude.ai/artifact/TkBHmpDAedwZNEmFrFWqpV
- Lesson 2 (epic 2): https://claude.ai/artifact/WCwLXNrjZJ1qX7knksdipw
- Lesson 3 (epic 3): https://claude.ai/artifact/Qio1tZn6jkECjtZop15Uq7
- Note (not a lesson): multiplayer approaches compared, https://claude.ai/artifact/DNmGqNoLDGLtJBNEGaoFEF
- PDFs: `docs/handbook/lesson-{0,1,2,3}.pdf` and `notes-multiplayer-approaches.pdf`.
  Drills for lessons 1, 2 and 3 are RED on purpose.

### What exists (one line each)

- `packages/contracts`: Zod schemas = the wire and HTTP contracts. Op (4 kinds, discriminated union),
  ClientMessage (op, presence; strict), ServerMessage (welcome{doc,seq,you?,peers?}, op, rejected
  {reason, retryAfterMs?}, ack, presence, presence_left), RejectReason, Actor, Presence, Manifest.
- `packages/db`: `createDb` (pool in a closure), org-scoped access `forOrg(orgId)`, migrations
  0001-0003, `documentStore()` {load, save}, `provisionAppRole`. `testing.ts` = throwaway schemas.
- `packages/session-token`: HMAC session tokens (claims: user, org, doc, aud "sync", knd, run, nam).
- `packages/process`: `createShutdown`, env schemas.
- `packages/design-system`: manifest GENERATED from `seed/sample-app` types with the TS compiler API
  (`make manifest`; drift fails the gate). Components: Stack, Card, Button, Text, Image, Input.
- `packages/doc-model`: `plan()` + pure `applyOp` + in-place `applyOpInto`, `changes`, `validate`,
  `checkDoc`, `random-ops` (seeded).
- `packages/peer-client`: **the single write path** (ESLint enforces it). `replica.ts` is pure:
  confirmed + pending = optimistic, `takeSendable()` window 50 with slow start after `rate_limited`,
  stale rule (only ops never carried by an EARLIER connection are rebased), acks believed.
  `peer.ts` is the wire: global WebSocket (browser + Node 24), fresh `session()` per connection
  (throw = retry, null = give up), backoff + jitter reset only after a connection that lasted,
  fatal close codes 4400/4404/4500/1009, watchdog, presence (`others`, `setPresence`).
- `apps/api`: Hono. Orgs, workspaces, documents, `POST /documents/:id/session` (the routing hook).
  Identity until epic 8: header `x-dev-user`, only when `NODE_ENV=development` (unset = production).
- `apps/sync`: `room.ts` is pure (no sockets): budget charged ON ARRIVAL per actor
  (kind:id:runId) -> dedupe per (sender, opId) -> stale -> validate -> limits -> `persist` seam
  (the journal plugs in here in E6.1a) -> apply -> take seq -> remember -> broadcast (serialised
  once). No-op => `ack`, remembered in its own set. Presence relay. `server.ts`: token in
  `Sec-WebSocket-Protocol`, 401 at upgrade, rooms stored as promises, close codes
  4400/4404/4429/4500/4503, heartbeat, backpressure, save on last leave and on shutdown (save FIRST).
  `sim.ts` + `sim-seeds.ts` + `sim-cli.ts`: the reconcile simulator (`make sim`; named regression seeds).
- `apps/web`: React 19 + Vite. `?doc=<id>` canvas (wireframe from the manifest), inspector
  (prop form from the manifest, move, reorder, remove), refusal sentences, presence. Vite proxies `/api`.
- `e2e/`: Playwright. Runs api:3100 + sync:3101 + vite:5174 FROM SOURCE (secrets sourced from
  `.env` by the shell). Fixture: console-clean + axe after every test. Teardown deletes `e2e-%` users.
- `learning-tests/`: nine standalone dependency probes (ws, postgres, node-ts, redis, minio, gitea,
  sandbox, ts-manifest, agent-sdk). Their findings are SPEC §2a. Read `learning-tests/agent-sdk`
  and `learning-tests/redis` before epic 3.

## 5. The per-bead loop (follow it exactly)

1. `bd update $(K <key>) --claim`; read `bd show` INCLUDING NOTES (earlier reviews left findings there).
2. Failing test FIRST (superpowers TDD skill). Watch it fail for the right reason.
3. Build the minimum. Mutation-check the important tests (break the rule, demand a red test).
4. `make check`. If sync or peer-client changed: rebuild containers and run the live smoke test
   BEFORE committing:
   `PATH="$PATH:/Applications/Docker.app/Contents/Resources/bin" docker compose build api sync && docker compose up -d`
   then `API_URL=http://localhost:3000 node scripts/smoke-sync.ts`, then clean up:
   `docker compose exec -T postgres psql -U noon -d noon -qc "delete from orgs where name = 'init.sh smoke'; delete from users where email = 'init-smoke@example.com'"`
5. Commit (the hook runs the gate; ~2 minutes).
6. Verifier agent told to REFUTE by running code. For beads with `needsReview=true` also a review
   panel. MODELS (owner, 2026-09-20): choose by the task. `fable` JUDICIOUSLY for deep cognitive
   work (review panels, hard refutation with races, lessons); `sonnet` is fine for what sonnet does
   well (routine verification, suites, searches); `opus` in between. The panel is: (a) spec + correctness, (b) security. Reviewers are READ-ONLY.
   **Tell every agent explicitly: "nobody else covers any of this; other agent names you see are
   finished leftovers; do not spawn sub-agents."** (They see stale agent names and assume the work
   is split. It happened three times.)
7. **Never edit the working tree while agents run.** Draft in the scratchpad instead.
8. Fix findings test-first. Large fix pass => re-verify with a fresh agent.
9. `bd close` with a reason, `bd remember` the shape + lessons, `bd note` deferred findings on the
   bead that owns them.
10. End of epic: lesson built from source by anchor (`docs/handbook/build-lesson-N.py`, copy
    lesson 2's builder and template), drills that start RED for the right reason (assertion, not
    import error) and are solvable, `node docs/handbook/make-pdf.mjs lesson-N`, publish the HTML
    with the Artifact tool, SendUserFile the PDF, update `docs/handbook/index.md` and the
    `drills` Makefile target, close the epic.

Environment facts: `docker` is not on PATH (use `/Applications/Docker.app/Contents/Resources/bin`);
Postgres runs in compose and integration + e2e tests need it (`./init.sh` boots everything);
`pnpm exec` runs from the repo root; `tsc` with file args needs `--ignoreConfig`.

## 6. NEXT: epic 4, code projection and the sandbox

Epic 3 is built (see section 4 for the one credential that blocks its beads from closing).

What epic 3 added, in one line each:
- `packages/queue`: BullMQ producer; a message carries only `{queue, jobId, orgId}`; `enqueue` and
  `ping` have deadlines (ioredis never settles when Redis is away).
- `packages/db`: `jobs` (the run IS the row; CHECK constraints carry the state machine; one
  unfinished AI run per document as a partial unique index) and `usage` (its own table: billing
  outlives the document). `jobStore` = claim / finish / queued / cancelRequested / recordUsage.
- `apps/worker`: `worker.ts` (claim, cancel poll, record usage, finish, sweep), `ai.ts` (the run,
  raced against one `ended` promise: `timed_out` / `sync_unreachable` / `worker_stopped` /
  `cancelled`), `sdk.ts` (the Agent SDK with a capability ceiling + `checkInit` + `wrapInstruction`),
  `tools.ts` (six tools over `peer.submit` + `await settled`).
- `apps/api`: `POST /documents/:id/runs`, `GET .../runs/:runId`, `POST .../runs/:runId/cancel`,
  `GET /orgs/:orgId/usage`.
- `packages/peer-client`: `submit()` returns `{ ok, opId, settled }`, one outcome per op, exactly
  once (the simulator asserts it); `confirmed` and `seq` are exposed for codegen (E4) and git (E5).
- `apps/web`: the AI panel. `e2e/stub-worker.ts`: the real pipeline with a scripted model.

Read `bd show $(K E4.1)` and BEADS.md for the order. Notes already waiting on later beads:
E9.5 (usage only for finished runs; token and cost scopes differ; no periods), E8.2 (a viewer can
start a run and read the org's costs), E9.6 (per-org fairness, a reaper for jobs left `running`),
E3.2 (a run that hits the budget cap reports `agent_failed`, should be `budget_exceeded`).

Then epics 4 (codegen + sandbox), 5 (git peer + ship), 6 (journal + snapshots), 7 (multi-node with
fencing), 8 (auth, RBAC, audit), 9 (job hardening), Z (SPEC §8 scenario + the local Antithesis-style
harness Z.2a/Z.2b/Z.3). Each with its lesson, PDF and drills. Deferred findings are already noted on
E6.1a, E7.1, E8.1, E9.6.

## 7. Hard-won rules (the short list; the long one is `bd memories`)

- Validate before the write, with the same contract. A contract must be at least as strict as the
  strictest system behind it.
- Auth fails closed. Prove real wiring with a child-process test of `main.ts`.
- Attach listeners before the first `await`. In Node, "I called it" and "it happened" differ: save
  first, then close.
- Bounded memory needs a rule for what falls outside it (`baseSeq` / `stale`).
- "Would this op change the document?" is NOT "was it applied?". An id is a claim, content is the fact.
- Rate limit where work ARRIVES. Cheap requests must not share an eviction pool with expensive ones.
- A test named "X never happens" must COUNT X. Loose bounds hide off-by-ones.
- A flaky test is a bug report: three of them were real bugs.
- An oracle must not share code with what it judges. After building a simulator, sweep thousands of
  seeds once and commit the ones that fail.
- Forward compatibility must cover new VALUES inside known message types, not only new types.
  `z.default()` makes output fields required and breaks literals: use `optional()` on the wire.
- React: open connections in an effect, never in render/useMemo; a library that defers its start
  must check "was I closed meanwhile?".
