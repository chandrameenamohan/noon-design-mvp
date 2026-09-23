# HANDOFF: Noon-like MVP

Updated 2026-09-21, mid epic 4 (commit `c429f2b`). **Read this first, then run `bd prime`.**
Everything here is either a decision the owner made or a fact about the repo; where a file is the
source of truth, this points at it instead of repeating it.

**Next session's job: finish epic 4.** E4.2b's verifier + review panel, then E4.3, then E4.H
(Lesson 4). Jump to section 6.

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

## 4. State: epics 0-3 closed; epic 4 half built

`make check` was green at HEAD (`c429f2b`). The docker stack is up, including the new
`worker-sandbox` service.

**FIRST THING NEXT SESSION: commit what is staged.** This file, `scripts/preview.sh`, and a test fix in
`apps/worker/src/sandbox.int.test.ts` (proves "baked" by node_modules in the image instead of an 8 s
bound) are STAGED, not committed: the pre-commit gate failed twice with the host at load average 117
(opencode, Dia and git processes outside this project), each time with DIFFERENT failures. Check
`uptime` first; with a quiet machine, `git commit` (never `--no-verify`). If the sandbox test "a
sandbox removed while it is starting" fails again, the daemon printed a message the regex does not
list (seen once under load: "docker exec: Error response from daemon: ..."): assert on the SPEED
and the absence of "not ready within", not on the daemon's words.

- **Epic 3 is CLOSED** (2026-09-21). The 401 was never the token's fault: it had been pasted into
  `.env` with a line break (line 2 held its last 18 characters). Joined; `node scripts/live-agent.ts`
  printed `outcome ok`. `bd memories env-token` has the diagnosis recipe (keys and lengths only).
- **E4.1 closed** (codegen), **E4.2a closed** (sandbox start). **E4.2b built and committed, NOT closed:**
  it still needs its verifier and review panel (`needsReview=true`). `bd show noon-3rh.3` NOTES has
  the exact status. E4.3 and E4.H are open.
- **The owner can see it running**: `sh scripts/preview.sh` creates a document, opens its sandbox
  job and prints a canvas URL and a preview URL; edits on the canvas appear in the preview in about
  200 ms, without a reload. The canvas needs `pnpm --filter @noon/web dev` (port 5173). This script
  is a stopgap (it inserts the job with psql): E4.3 replaces it with api routes and an iframe.

Published for the owner (private artifacts):
- 0001 HLD: https://claude.ai/artifact/J2DVNLFHkKrLPwLyghFBc4
- Lesson 0 (TS primer): https://claude.ai/artifact/3qLjxgH6vjT2bUnEa52omY
- Lesson 1 (epic 1): https://claude.ai/artifact/TkBHmpDAedwZNEmFrFWqpV
- Lesson 2 (epic 2): https://claude.ai/artifact/WCwLXNrjZJ1qX7knksdipw
- Lesson 3 (epic 3): https://claude.ai/artifact/Qio1tZn6jkECjtZop15Uq7
- Note, not a lesson: multiplayer approaches compared,
  https://claude.ai/artifact/DNmGqNoLDGLtJBNEGaoFEF
- PDFs: `docs/handbook/lesson-{0,1,2,3}.pdf`, `notes-multiplayer-approaches.pdf`. (Lesson 4: not yet.)
  Drills for lessons 1, 2 and 3 are RED on purpose.

### What exists (one line each)

- `packages/contracts`: Zod schemas = the wire and HTTP contracts. Op (4 kinds, discriminated
  union), ClientMessage, ServerMessage, RejectReason, Actor, Presence, Manifest, Run, UsageAmount,
  UsageReport, FailureReason, MAX_COST_USD, **PreviewOutput** (`{url}`, http(s) only: it becomes an iframe src).
- `packages/db`: `createDb` (pool private in a closure), org-scoped `forOrg(orgId)`, migrations
  0001-0008, `documentStore()`, `jobStore()` (claim / finish / queued / cancelRequested /
  recordUsage / **report** (a running job's output, PreviewOutput-validated) / **sandboxesInUse**),
  runs (createRun / getRun / cancelRun), `usage()`, `provisionAppRole`. 0008: one unfinished
  `sandbox` job per document (partial unique index) + `jobs.output jsonb`.
  `testing.ts` = throwaway schemas.
- `packages/session-token`: HMAC session tokens (claims: user, org, doc, aud "sync", knd, run, nam).
- `packages/process`: `createShutdown`, env schemas.
- `packages/codegen` (E4.1): `generate(doc, manifest)` -> `{ok, tsx}` or `{ok:false, reason, detail}`.
  Total (never throws), deterministic, one file whose ONLY export is `Page`, `data-node-id` on
  every element; literals chosen from the value, never from what the manifest claims.
- `packages/queue`: BullMQ producer. `QUEUES = ["ai", "sandbox"]`. A message carries ONLY `{queue, jobId, orgId}`; `enqueue` and
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
  sweep that re-offers `queued` rows; handlers are a PARTIAL map: a process drains only the queues
  it handles, each with its own concurrency). **One queue per process** (`WORKER_QUEUE=ai|sandbox`,
  config.ts): the AI worker runs the Agent SDK's subprocess and must never hold the Docker socket.
  `sandbox.ts` (E4.2a/b: `startSandbox`, `pushPage`, `isRunning`, `reapSandboxes`, `pagePath`,
  `PREVIEW_PATH`), `preview.ts` (the `sandbox` queue's handler: silent peer, projects from
  `peer.confirmed`, restarts a dead container, idles out), `sandbox/Dockerfile` (the sandbox image,
  context = `seed/sample-app`; `make sandbox-image`), `sandbox-testing.ts` (shared test helpers).
  Also `ai.ts` (one run, raced against a single `ended` promise:
  `timed_out` / `sync_unreachable` / `worker_stopped` / `cancelled`), `sdk.ts` (the Agent SDK with a
  capability ceiling, `checkInit`, `wrapInstruction`, `usageOf`, `failureReason`), `tools.ts` (six
  tools, each `peer.submit` then `await settled`).
- `apps/web`: React 19 + Vite. `?doc=<id>` canvas (wireframe from the manifest), inspector,
  presence, refusal sentences, and `AiPanel.tsx`. Vite proxies `/api`.
- `docker-compose.yml`: new `worker-sandbox` service (`WORKER_QUEUE=sandbox`, the ONLY service with
  `/var/run/docker.sock`, runs as root, `SANDBOX_POOL=${COMPOSE_PROJECT_NAME}`). The app image now
  carries the docker CLI (copied from `docker:27-cli`).
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

Environment facts (epic 4 additions first):
- Sandboxes: image `noon-sandbox:dev` (built by `./init.sh`, `make sandbox-image`, and every sandbox
  test's `beforeAll`; first build ~6 min, cached after). Network `noon-sandboxes` (ICC off), ports
  127.0.0.1 only, container name `noon-sandbox-<documentId>`, labels `noon.sandbox=<pool>` and
  `noon.document=<id>`. **A reaper only sweeps its own pool**: compose, clean-clone and every test file
  share one daemon (the compose reaper once deleted the test suite's sandboxes).
- **Never run two Docker-using suites at once** (a mutation run and a test run, say): each one's
  cleanup removes the other's containers and turns results into noise. It happened this session.
- Node 24: `execFile`'s `signal` option sends SIGTERM on abort WHATEVER `killSignal` says (measured);
  `sandbox.ts` kills explicitly with SIGKILL. macOS scans a brand-new executable on its first run
  (>300 ms): a test stub needs a generous window.
- Mutation runs of the Docker suites take 1-3 min per mutant: run them in the background with
  `run_in_background`, never alongside another Docker suite.

Older facts: `docker` is not on PATH (use `/Applications/Docker.app/Contents/Resources/bin`);
Postgres and Redis run in compose and integration + e2e tests need them (`./init.sh` boots
everything); the project's Redis is on host port **6380**, because the owner's machine runs its own
on 6379; `pnpm exec` runs from the repo root; `tsc` with file args needs `--ignoreConfig`.

## 6. NEXT: finish epic 4

Keystone 8 (SPEC §2): **one document <-> one generated TSX file of a fixed shape; doc -> TSX is
deterministic; all other repo code is read-only to the canvas.** Reading TSX back is epic 5.

### Step 1: E4.2b verification (the bead is built; do NOT rebuild it)

Commit `c429f2b`. Run the per-bead loop from step 6: a verifier told to REFUTE by running code, and
the review panel ((a) spec + correctness, (b) security), all three in parallel, read-only, with the
"YOU are the only one... do not spawn sub-agents" line. Claims worth giving the verifier:
the preview follows only CONFIRMED ops, within 3 s, no reload, state kept; one unfinished sandbox job
per document; a dead container is restarted and the URL re-reported; the job ends when nobody is
present for `idleMs`; cancel ends quietly, a stopping worker fails `worker_stopped`; the reaper
removes only its own pool's idle sandboxes and never a document in use; the AI worker can never
claim a sandbox job; `WORKER_QUEUE` refuses anything but exactly one queue. Tell it to use its own
pool and a port range outside 20000-24999, and that the compose `worker-sandbox` is running.
Then fix findings test-first, mutation-check, commit (include `scripts/preview.sh`), close.

### Step 2: E4.3 (the canvas shows the preview)

Acceptance: an iframe of the running page; an edit shows within 3 s without a full reload; if the
container dies the iframe shows "rebuilding" and recovers unaided (F15). Checks:
`e2e:preview-follows-edit-within-3s`, `e2e:preview-self-heals`. Its NOTES (`bd show noon-3rh.4`)
hold binding findings from the E4.2a reviews. The shape they imply:
- api: `POST /documents/:id/preview` (member only; insert the sandbox job `on conflict do nothing`,
  enqueue; return the job) and `GET /documents/:id/preview` (`{status, url | null}` from `jobs.output`
  through `PreviewOutput`). This replaces `scripts/preview.sh`.
- web: iframe `sandbox="allow-scripts"` and NOT `allow-same-origin` (every preview shares host
  127.0.0.1: without an opaque origin a preview could read cookies/storage and survive port reuse).
  Re-read the URL, never cache it: a restarted sandbox can come back on another port, and then the
  iframe must be pointed at it (Vite's own self-heal only covers the SAME origin). "Rebuilding" =
  the preview is unreachable or the job restarted it.
- Lock Vite `server.cors` to the canvas origin, injected so it survives a customer vite.config.
- e2e: setup.ts stops the compose `worker` today; it must also stop `worker-sandbox` (or give e2e its
  own pool and DB) or the compose worker will claim e2e's sandbox jobs. The self-heal test must not
  be vacuous: push something a fresh container would NOT show before killing it (FINDINGS 7).

### Step 3: E4.H (Lesson 4 + drills), then close the epic

Built from source by anchor like lesson 3 (`docs/handbook/build-lesson-3.py` + template), PDF via
`node docs/handbook/make-pdf.mjs lesson-4`, publish with the Artifact tool, send the PDF, drills in
`drills/lesson-4/` that start RED on an assertion, `make drills` target, `docs/handbook/index.md`.
Material the lesson should teach (all real, all in `bd memories e4-`): the lying-toString injection
and "choose the literal from the value"; `-0`, NaN, hidden props; push(...arr) overflow; the
start race where losers removed the winner's container (name uniqueness is not ownership); the
`set -e` + `&&` trap; execFile's SIGTERM; one queue per process and why; pools; why the port is
chosen once and why the URL can still change.

### What the sandbox learning test measured (still the source for E4.3)

`learning-tests/sandbox/test.ts` FINDINGS header. Short form: `server.host: true` + one published
port serves HTTP and HMR; `docker exec` push ~20 ms; Fast Refresh keeps state only if the module
exports only components; baked node_modules ~0.35 s cold start; a syntax error shows an overlay and
recovers; cross-origin iframe embedding works; after a container restart Vite's client polls and
does a full `location.reload()` ~1.2 s after a server answers on the SAME origin.

### Beads waiting, with notes

`noon-9gz` (NEW, security, blocks E5.1): per-document hostname proxy, `--internal` sandbox network,
disk quota, pinned base image, no credentials in SEED_REPO. A low-priority bug bead: one e2e run saw
canvas p95 3072 ms (never reproduced). Older: E9.5, E8.2, E9.6 (add: per-org cap on sandboxes),
E3.2's budget_exceeded naming, E6.1a, E7.1, E8.1.

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
- **Uniqueness is not ownership.** Docker refused a second container with the same name, and ten
  racing starters still removed each other's: a loser read "port taken" (taken by the WINNER) and
  deleted it. One starter per resource: single-flight in-process, a unique job across processes.
- A number remembered before an await can be stale after it: read the port AFTER ready.
- Ask the system, don't parse its prose: an exec that raced a container's death had an EMPTY stderr.
- `set -e` does not stop a script on a failure inside `a && b && c` (except the last): one command
  per line.
- Every resource needs an owner label before it gets a reaper, or one environment's cleanup eats
  another's.
- A test that holds a port must use a range nobody else in the file uses.
- When a subagent writes something you will publish, read the AUTHORED surface and prove the
  generated artifact is exactly its product (rebuild, compare bytes). Cheaper and stronger than
  skimming the output.
