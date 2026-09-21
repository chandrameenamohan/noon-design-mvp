# HANDOFF: Noon-like MVP

Updated 2026-09-21, end of epic 3 (commit `e034cd7`). **Read this first, then run `bd prime`.**
Everything here is either a decision the owner made or a fact about the repo; where a file is the
source of truth, this points at it instead of repeating it.

**Next session's job: epic 4, code projection and the sandbox preview.** Jump to section 6.

## 1. Who and what

The owner (chandrameenamohan@gmail.com) is a Java/Python backend engineer preparing for Noon's
"Fullstack Backend Architect" role. They are learning TypeScript from zero, and want
principal-engineer depth: TS/Node internals, design choices, trade-offs versus Java and Python.

The project: a Noon-like MVP. A multi-user design canvas where a **user, an AI agent, git and a
sandbox preview** all edit or render the same document. TypeScript monorepo, distributed backend,
every datastore added in the epic that needs it.

**Claude writes ALL the code.** Each epic ships with a handbook lesson explaining how it was
written. The owner reads lessons at their own pace and has said so explicitly:
**"continue on the completion of it. I can go through lessons on my own pace."** Do not pause for them.

## 2. Decisions that are locked (do not re-litigate)

- Process: the owner's own `software_development_workflow_v6.md`, FULL tier. We are in **W3 BUILD**.
- **NEVER use the Workflow tool** (the owner reserves dynamic workflows for other work). Use
  Agent-tool subagents plus in-session work.
- Runtime Node.js 24 (Bun rejected). TypeScript pinned `~6.0.0` (typescript-eslint lacks TS 7).
  Native type stripping, no build step: `.ts` import extensions, `erasableSyntaxOnly`
  (no enums, no parameter properties), `verbatimModuleSyntax`.
- Sync: our own server-authoritative, Figma-style design (one room per document orders ops). Not Yjs.
- Git and sandbox: local first (local git server, Docker sandbox).
- AI agent: **Claude Agent SDK for TypeScript, authenticated with `CLAUDE_CODE_OAUTH_TOKEN`**
  (a `claude setup-token` value in `.env`). NOT an Anthropic API key; `ANTHROPIC_API_KEY` must be
  UNSET in the worker (it outranks the OAuth token, and the worker refuses to start if it is set).
- Final verification (epic Z): a LOCAL Antithesis-style harness, the same method as the owner's
  `~/repos/ai-engine/deploy/antithesis` (SPEC §4a). Bugs it finds get fixed.
- Lessons: one artifact page per epic + a printable **PDF sent with SendUserFile** + drills that
  start RED for the owner to solve alone.
- Ponytail mode is active (laziest working solution; mark shortcuts with `ponytail:` comments naming
  the ceiling and the upgrade path). Never simplify away validation at trust boundaries, data-loss
  prevention, security, accessibility.
- Web browsing: the gstack `/browse` skill only; never `mcp__claude-in-chrome__*`.
- Secrets: `.env` is git-ignored. **Never print, log or copy its contents.**
- Commits: never `--no-verify` (the pre-commit hook runs `make check`). Use the `Co-Authored-By:`
  and `Claude-Session:` trailers the session's own attribution reminder gives you.
- Task tracking: `bd` (beads) only. No TodoWrite. Never `bd edit`. `bd prime` after compaction.
- **Subagent models** (owner, 2026-09-20): choose by the task. `fable` JUDICIOUSLY, for genuinely
  deep work (review panels, hard refutation with races, writing lessons). `sonnet` is fine for what
  sonnet does well (routine verification, running suites, searches). `opus` in between.

## 3. Where things are written down

| What | Where |
|---|---|
| The approved spec (keystones §2, rules learned §2a, features F1-F31 §3, failure modes §4, Antithesis §4a, e2e scenario §8) | `SPEC.md` |
| The bead graph, readable | `BEADS.md`; key -> bd id map in `.beads/key-map.json` |
| Lessons learned per bead (the real project memory) | `bd memories` / `bd prime` |
| Deferred review findings | `bd show <id>` NOTES on the bead that will own them |
| Verification layers | `VERIFICATION.md`, `Makefile` |
| Handbook index, lesson builders, PDFs | `docs/handbook/` |
| Drills | `drills/lesson-N/` (`sh drills/lesson-N/check.sh`) |

Helper used every session:
`K() { python3 -c "import json;print(json.load(open('.beads/key-map.json'))['$1'])"; }` then `bd show $(K E4.1)`.

## 4. State: epics 0, 1, 2 and 3 are BUILT

`make check` is green at HEAD (`e034cd7`), the tree is clean, and the docker stack is healthy.

**One thing is outstanding, and it needs the owner.** E3.2, E3.3, E3.4 and E3.H are finished,
reviewed and verified, but they are still open in bd for a single reason: the live check
`node scripts/live-agent.ts` cannot pass, because `CLAUDE_CODE_OAUTH_TOKEN` in `.env` is rejected
by the provider (401, on the host as well as inside the container). Every real AI run ends
`failed / token_invalid`, which is the designed answer, not a bug. Ask the owner to run
`claude setup-token` and put the value in `.env`, then:

```
docker compose up -d worker && node scripts/live-agent.ts   # expect: outcome ok
# then close, in this order: E3.2, E3.3, E3.4, E3.H, and the epic
```

This does NOT block epic 4: E4.1 depends only on E2.2b, and E4.2a's other dependencies are done.

Each epic-3 bead carries a STATUS note saying it is done; `bd memories e3-` holds the lessons
(`e3-1-jobs-queue-worker`, `e3-2-ai-peer`, `e3-3-instruction-cancel`, `e3-4-usage`, `e3-h-lesson-3`).

Published for the owner (private artifacts):
- 0001 HLD: https://claude.ai/artifact/J2DVNLFHkKrLPwLyghFBc4
- Lesson 0 (TS primer): https://claude.ai/artifact/3qLjxgH6vjT2bUnEa52omY
- Lesson 1 (epic 1): https://claude.ai/artifact/TkBHmpDAedwZNEmFrFWqpV
- Lesson 2 (epic 2): https://claude.ai/artifact/WCwLXNrjZJ1qX7knksdipw
- Lesson 3 (epic 3): https://claude.ai/artifact/Qio1tZn6jkECjtZop15Uq7
- Note, not a lesson: multiplayer approaches compared,
  https://claude.ai/artifact/DNmGqNoLDGLtJBNEGaoFEF
- PDFs: `docs/handbook/lesson-{0,1,2,3}.pdf`, `notes-multiplayer-approaches.pdf`.
  Drills for lessons 1, 2 and 3 are RED on purpose.

### What exists (one line each)

- `packages/contracts`: Zod schemas = the wire and HTTP contracts. Op (4 kinds, discriminated
  union), ClientMessage, ServerMessage, RejectReason, Actor, Presence, Manifest, Run, UsageAmount,
  UsageReport, FailureReason, MAX_COST_USD.
- `packages/db`: `createDb` (pool private in a closure), org-scoped `forOrg(orgId)`, migrations
  0001-0007, `documentStore()`, `jobStore()` (claim / finish / queued / cancelRequested /
  recordUsage), runs (createRun / getRun / cancelRun), `usage()`, `provisionAppRole`.
  `testing.ts` = throwaway schemas.
- `packages/session-token`: HMAC session tokens (claims: user, org, doc, aud "sync", knd, run, nam).
- `packages/process`: `createShutdown`, env schemas.
- `packages/queue`: BullMQ producer. A message carries ONLY `{queue, jobId, orgId}`; `enqueue` and
  `ping` have deadlines (with Redis away ioredis reconnects for ever and nothing settles).
- `packages/design-system`: manifest GENERATED from `seed/sample-app` types with the TS compiler
  API (`make manifest`; drift fails the gate). Components: Stack, Card, Button, Text, Image, Input.
- `packages/doc-model`: `plan()` + pure `applyOp` + in-place `applyOpInto`, `changes`, `validate`,
  `checkDoc`, `random-ops` (seeded).
- `packages/peer-client`: **the single write path** (ESLint enforces it). `replica.ts` is pure;
  `peer.ts` is the wire. `submit()` returns `{ ok, opId, settled }` with ONE outcome per op, exactly
  once (the simulator asserts it). `confirmed` and `seq` are exposed **for epic 4's codegen and
  epic 5's git peer: project from CONFIRMED, never from the optimistic document.**
- `apps/api`: Hono. Orgs, workspaces, documents, `POST /documents/:id/session`, and the runs routes
  (`POST /documents/:id/runs`, `GET .../runs/:runId`, `POST .../runs/:runId/cancel`,
  `GET /orgs/:orgId/usage`). Identity until epic 8: header `x-dev-user`, development only.
- `apps/sync`: `room.ts` is pure (no sockets); `server.ts` is the wire. `sim.ts` + `sim-seeds.ts` +
  `sim-cli.ts`: the reconcile simulator (`make sim`).
- `apps/worker`: `worker.ts` (claim -> cancel poll -> handler -> recordUsage -> finish; plus the
  sweep that re-offers `queued` rows), `ai.ts` (one run, raced against a single `ended` promise:
  `timed_out` / `sync_unreachable` / `worker_stopped` / `cancelled`), `sdk.ts` (the Agent SDK with a
  capability ceiling, `checkInit`, `wrapInstruction`, `usageOf`, `failureReason`), `tools.ts` (six
  tools, each `peer.submit` then `await settled`).
- `apps/web`: React 19 + Vite. `?doc=<id>` canvas (wireframe from the manifest), inspector,
  presence, refusal sentences, and `AiPanel.tsx`. Vite proxies `/api`.
- `e2e/`: Playwright. Runs api:3100 + sync:3101 + vite:5174 + `stub-worker.ts`:3102 FROM SOURCE.
  `setup.ts` stops the compose worker and migrates from source; `teardown.ts` cleans up and starts
  the worker again. Fixture: console-clean + axe after every test.
- `learning-tests/`: nine standalone dependency probes (ws, postgres, node-ts, redis, minio, gitea,
  sandbox, ts-manifest, agent-sdk). Their findings are SPEC §2a.
  **Read `learning-tests/sandbox/test.ts`'s FINDINGS header before epic 4.**

## 5. The per-bead loop (follow it exactly)

1. `bd update $(K <key>) --claim`; read `bd show` INCLUDING NOTES (earlier reviews left findings there).
2. Failing test FIRST. Watch it fail for the right reason.
3. Build the minimum. Mutation-check every guard you add: break the rule, demand a red test.
   (Two tests in epic 3 passed with their guard removed. Both were caught this way.)
4. `make check`. If sync or peer-client changed: rebuild containers and run the live smoke test
   BEFORE committing:
   `PATH="$PATH:/Applications/Docker.app/Contents/Resources/bin" docker compose build api sync && docker compose up -d`
   then `API_URL=http://localhost:3000 node scripts/smoke-sync.ts`, then clean up:
   `docker compose exec -T postgres psql -U noon -d noon -qc "delete from orgs where name = 'init.sh smoke'; delete from users where email = 'init-smoke@example.com'"`
5. Commit (the hook runs the gate; about two minutes).
6. Verifier agent told to REFUTE by running code. For beads with `needsReview=true` also a review
   panel: (a) spec + correctness, (b) security. Reviewers are READ-ONLY. See section 2 for models.
   **Tell every agent explicitly: "YOU are the only one covering these N claims; other agent names
   you see are finished leftovers; do not spawn sub-agents."** They invent colleagues otherwise; it
   happened four times, and one verifier silently skipped six of its ten claims.
7. **Never edit the working tree while agents run.** Draft in the scratchpad instead.
8. Fix findings test-first. Large fix pass => re-verify with a fresh agent.
9. `bd close` with a reason, `bd remember` the shape + lessons, `bd note` deferred findings on the
   bead that owns them.
10. End of epic: lesson built from source by anchor (`docs/handbook/build-lesson-N.py`, copy
    lesson 3's builder and template), drills that start RED for the right reason (assertion, not
    import error) and are solvable, `node docs/handbook/make-pdf.mjs lesson-N`, publish the HTML
    with the Artifact tool, SendUserFile the PDF, update `docs/handbook/index.md` and the `drills`
    Makefile target, close the epic.

Environment facts: `docker` is not on PATH (use `/Applications/Docker.app/Contents/Resources/bin`);
Postgres and Redis run in compose and integration + e2e tests need them (`./init.sh` boots
everything); the project's Redis is on host port **6380**, because the owner's machine runs its own
on 6379; `pnpm exec` runs from the repo root; `tsc` with file args needs `--ignoreConfig`.

## 6. NEXT: epic 4, code projection and the sandbox preview

The document becomes code. One document maps to one generated TSX file, that file runs in a
container, and the canvas shows it live. Keystone 8 (SPEC §2): **one document ↔ one generated TSX
file of a fixed shape; doc → TSX is deterministic; all other repo code is read-only to the canvas.**
Reading TSX back into ops is epic 5, not this one.

Order, with each bead's own checks (`bd show $(K E4.1)` etc.; BEADS.md has the full rows):

| Bead | Acceptance | Checks |
|---|---|---|
| **E4.1** | The same document always generates byte-identical TSX: one file, **exports only the page component**, every element carries `data-node-id`; it type-checks inside the sample app (F13) | `unit:codegen-deterministic`, `integration:codegen-typechecks-in-sample-app` |
| **E4.2a** | An image with baked `node_modules` starts one container per document working branch (its own clone of the seed repo until Gitea exists) and reports a ready URL | `integration:sandbox-start-ready` |
| **E4.2b** | The generated file is pushed with `docker exec` and hot-updates (state preserved); driven by a `sandbox` queue with its own concurrency; idle containers are reaped | `integration:sandbox-push-hot-update`, `integration:sandbox-reap` |
| **E4.3** | The canvas shows the running page in an iframe; an edit shows within 3 s without a full reload; if the container dies the iframe shows "rebuilding" and recovers unaided (F15) | `e2e:preview-follows-edit-within-3s`, `e2e:preview-self-heals` |
| **E4.H** | Chapter 4 + drills | `check:drills-red`, `check:chapter-recorded` |

E4.2a and E4.2b are `needsReview=true`. E4.1 touches only `packages/codegen` (new).

### What the sandbox learning test already measured (do not re-derive)

`learning-tests/sandbox/test.ts` ran all of this for real. Its header is the source; the short form:

- **Vite in a container** needs `server.host: true` plus a published port, or the host-side request
  hangs. `hmr.clientPort` was NOT needed with a single port mapping: Vite's client computes the
  websocket URL from the page's own `location.port`.
- **Pushing the file**: `docker exec` (`cat > file`) is the pick. Median about 20 ms to the DOM
  change, tied with `docker cp`, roughly twice as fast as a bind mount, and strictly more reliable.
  Bind-mount pushes failed to propagate at all in 2 of 10 and 3 of 10 trials in separate runs.
  Space pushes about 300 ms apart, or the harness outruns the dev server's own watch pipeline.
- **Fast Refresh keeps React state only if the edited module exports ONLY components.** Adding one
  non-component export (a `BUILD_ID` constant, say) turns every edit into a full page reload. This
  is why E4.1's acceptance says "exports only the page component": it is not style, it is the
  mechanism E4.3's three-second promise rests on.
- **Cold start**: a baked-`node_modules` image reached its first HTTP 200 in 338-350 ms. Installing
  at container start took 10.6-17.7 s. That is the whole reason E4.2a says "baked".
- **A syntax error** shows Vite's error overlay, the container survives, and writing valid content
  back recovers it with no restart.
- **Cross-origin iframe embedding works** with Vite's default dev server: no `X-Frame-Options`, no
  CSP `frame-ancestors`.
- **Killing the container** makes Vite's client log "server connection lost. Polling for restart",
  and the existing tab self-heals about 1.2 s after a new container comes up, with no reload call
  from the page. E4.3's "recovers unaided" is therefore achievable, but the test must not fake it:
  the earlier version of that learning test was vacuous because it matched on a value the page
  already showed.

### Rules this epic must respect

- **Project from `peer.confirmed`, never from the optimistic document.** The optimistic tree
  contains ops the server has not accepted and may refuse. Codegen that runs on a guess would push
  code for a document that never existed. `confirmed` and `seq` were exposed in epic 3 for exactly
  this.
- **Determinism means byte-identical**, so: a fixed key order, no `Date`, no `Math.random`, no
  `Object.keys` iteration over a map whose order can vary, and a stable order for props. Test it by
  generating twice from the same document and comparing bytes, and by generating from two documents
  built by different op orders that end in the same state.
- The sandbox is a **new queue on the existing worker** (`packages/queue`'s `QUEUES` is
  `["ai"]` today and carries a `ponytail:` comment saying the others arrive with their epics).
  A handler for a new queue must race its work against the cancel and stop signals the way `ai.ts`
  does: the worker only ASKS, and epic 3's note in `worker.ts` says so where you will read it.
- Anything a program awaits needs an end from outside. That was epic 3's theme and it applies
  double here: `docker` commands, container readiness polls, and HTTP probes all need deadlines.
- A container per document is a resource. The reaper in E4.2b is not optional bookkeeping; without
  it a laptop runs out of containers.

### Notes already waiting on later beads

`bd show` these before you touch them: E9.5 (usage only for finished runs; token and cost scopes
differ; no periods), E8.2 (a viewer can start a run and read the org's costs), E9.6 (per-org
fairness, a reaper for jobs left `running`), E3.2 (a run that hits the budget cap reports
`agent_failed`, should be `budget_exceeded`), E6.1a, E7.1, E8.1.

Then epics 5 (git peer + ship), 6 (journal + snapshots), 7 (multi-node with fencing), 8 (auth,
RBAC, audit), 9 (job hardening), Z (SPEC §8 scenario + the local Antithesis-style harness). Each
with its lesson, PDF and drills.

## 7. Hard-won rules (the short list; the long one is `bd memories`)

- Validate before the write, with the same contract. **A contract must be at least as strict as the
  strictest system behind it, and the inputs must be at least as strict as the contract.** Both
  boundaries: epic 3 broke each one once.
- Auth fails closed. Prove real wiring with a child-process test of `main.ts`.
- Attach listeners before the first `await`. In Node, "I called it" and "it happened" differ: save
  first, then close.
- Bounded memory needs a rule for what falls outside it (`baseSeq` / `stale`).
- "Would this op change the document?" is NOT "was it applied?". An id is a claim, content is the fact.
- Rate limit where work ARRIVES. Cheap requests must not share an eviction pool with expensive ones.
- **Anything a program awaits needs an end from outside.** A `Promise.race` leaves three things
  behind: the loser (attach `.catch`, abort it), the timer (clear it), and any listener the loser
  registered (remove it). A wait loop you race must be cancelled too.
- **The truth is in Postgres; a queue message is a pointer.** Then a lost, duplicated, stale or
  forged message can do nothing, and a sweep can recover from any of them.
- **Put the invariant where no code path can walk around it**: CHECK constraints, a partial unique
  index as a business rule. "Count, then insert" is two statements and races; the index is one.
- A data-modifying CTE shares one snapshot with its outer query. Read "how it is now" in a second
  statement.
- A test named "X never happens" must COUNT X. Loose bounds hide off-by-ones. Never wait for
  EXACTLY n of something that keeps growing: a poll looks before and after the moment.
- A flaky test is a bug report: four of them were real bugs.
- An oracle must not share code with what it judges. After building a simulator, sweep thousands of
  seeds once and commit the ones that fail.
- Forward compatibility must cover new VALUES inside known message types, not only new types.
- React: open connections in an effect, never in render/useMemo; a library that defers its start
  must check "was I closed meanwhile?".
- When a subagent writes something you will publish, read the AUTHORED surface and prove the
  generated artifact is exactly its product (rebuild, compare bytes). Cheaper and stronger than
  skimming the output.
