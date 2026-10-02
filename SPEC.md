# SPEC — Noon-like MVP

**Thesis.** A multiplayer canvas where a design is a tree of real design-system
components, edited live by a human, an AI agent and git through one ordered
write path, and always running as real code in a sandbox.

Status: approved design, 2026-09-19. HLD background: Lesson 0001 "Noon in Eight
Boxes". This project is also a course: see §7.

---

## 1. Users and core jobs

| Who | Core job |
|---|---|
| Designer (browser) | Compose a page from design-system components with teammates, see it run as real code, ship it as a pull request |
| AI agent (peer) | Carry out a natural-language design instruction by editing the same tree, visibly and cancellably |
| Engineer (git) | Push code changes to the repo and see them appear on the open canvas, or get a clear conflict |
| Org admin | Control who can see and edit what; read an audit trail; see AI usage per org |
| The learner | Read a handbook chapter per epic and complete drills alone (§7) |

## 2. Keystone decisions and constraints

1. **One room, one order.** Each document has exactly one in-memory room. The
   room is the only sequencer. Client clocks are never used.
2. **One write path.** Browser, AI agent and git peer all submit ops through
   `packages/peer-client`. No other code path mutates a document.
3. **Four ops.** `add_node`, `move_node`, `remove_node`, `set_prop`.
   Envelope in: `{opId, baseSeq, op}`. The actor `{kind: user|agent|git, id, runId?}` is
   STAMPED BY THE ROOM from the peer's verified session, never sent by the peer:
   a client-supplied actor could claim to be anyone, and attribution (audit, usage,
   "the AI did this") would be worthless.
   Out: `{seq, opId, actor, op}` to all, or `{opId, rejected: reason}` to the sender.
4. **Conflict rules.** Last writer wins per `(nodeId, key)` by `seq`. A remove
   beats any concurrent edit to the removed node or its descendants. `index`
   clamps to the valid range. Moves that would create a cycle are rejected.
   An add or move whose target parent was concurrently removed is dropped the
   same way: silently for the sender, never seen by other peers.
   "Descendant" is judged at SEQUENCING time: if B moves a child out of P and A
   removes P, the child survives only if the move was sequenced first. Both
   orders converge; the UI may tell B when a rescued node was lost.
   `index` on add and move is the node's FINAL position among the parent's
   children. Node ids are minted by peers as random ids and never re-used:
   an id that was removed must not be added again, or an edit meant for the dead
   node would land on the new one.
   Ids and prop names may not be names on `Object.prototype` (`constructor`,
   `__proto__`...): they become object keys. Prop text may not contain control
   characters other than tab and newline; `-0` is refused.
5. **Idempotency by `opId`.** Resending an op never applies it twice; the room
   answers with the original `seq`. An op that changes nothing is answered to
   its sender alone with `ack`: no `seq`, no broadcast, and its resend is again
   an `ack`. Each actor has an op budget in the room (a token bucket); over it
   the op is refused with `rate_limited` and `retryAfterMs`, the room refuses
   that peer's later ops too until the refused one returns (order is kept), and
   a peer that keeps sending SOONER than it was told to is closed with `4429`
   (a peer that waits as told is never dropped). The budget is per actor
   (kind, id, run) and is charged as the op arrives. `peer-client` keeps at
   most 50 unanswered ops on the wire and, after a refusal, restarts at one op
   and grows by one per answer, so an honest peer is slowed, never dropped.
   `peer-client` does not send a local edit that changes nothing in the
   document the user sees. A reject reason a client does not know means "not
   applied": it resyncs, it never ends the session.
6. **Canvas model.** A document is one page: a tree of instances of the sample
   app's components (Stack, Card, Button, Text, Image, Input) with typed props.
   No absolute positioning, no freeform shapes.
7. **Manifest is generated, not written.** The component manifest (components
   and prop types) is extracted from the sample app's TypeScript and committed;
   the gate fails if it drifts. `validate(doc, op, manifest)` takes it as a parameter.
8. **Constrained projection.** One document ↔ one generated TSX file of a fixed
   shape. doc → TSX is deterministic. TSX → ops is attempted only when the file
   still fits the shape; otherwise the push is a conflict. All other repo code
   is read-only to the canvas.
9. **Stores, one job each.** Postgres: relational data, jobs, usage, audit, and
   the op journal (append-only table). MinIO: snapshots. Redis: queues, rate
   limits, leases. Losing Redis never loses document data. Journal append
   happens before broadcast. A room snapshots every N ops or T seconds
   (tunable) and when its last peer leaves, so a never-idle session still snapshots.
10. **Tenancy and attribution from day one.** Every tenant-owned table has
    `org_id` (`orgs` IS the tenant; `users` are global identities that join
    orgs through `memberships`, which is what lets a document be shared with
    someone outside the org); a new table without `org_id` must say why. `db`
    exposes only an org-scoped accessor; every op carries its actor. Document
    id is a UUID and is the room key.
11. **Routing hook from day one.** Peers obtain `{wsUrl, token}` from
    `POST /documents/:id/session`; nothing hardcodes a sync address. One sync
    process until epic 7.
12. **Stack.** TypeScript, Node.js 24, pnpm workspaces, plain REST + WebSocket,
    shared Zod contracts (types inferred, runtime validation at every trust
    boundary), React + Vite for `web`, Docker Compose locally, Gitea as the
    local git host.
13. **AI.** Claude Agent SDK for TypeScript in the worker, authenticated by
    `CLAUDE_CODE_OAUTH_TOKEN` (the owner's subscription; `ANTHROPIC_API_KEY`
    must be unset in the worker). Auth is environment-driven so an API key can
    replace it. The agent's only tools are ours (the four ops + read tree +
    read manifest), served by an in-process MCP server. No file, shell or web tools.
14. **Packaging.** One codebase, one image, one process per role.
    `apps/`: `web`, `api`, `sync`, `worker` (queues `ai | git | ship | sandbox`,
    independent concurrency). `packages/`: `contracts` (leaf) ← `doc-model`
    (pure, no I/O) ← `codegen`, `peer-client`; `design-system`; `db`.
    `seed/sample-app/` is outside the workspace with its own lockfile and is
    pushed to Gitea at bootstrap.
15. **Git peer state.** Bare mirror in a volume, ephemeral worktree per job.
    The sandbox does its own clone.
16. **Identity before epic 8.** Until F23 lands, the caller's user and org come
    from a development-only header that `api` trusts only when
    `NODE_ENV != production`; session tokens and `org_id` scoping are real from
    epic 1. Epic 8 adds real sign-in; the header stays, and only when
    `NODE_ENV=development` (changed 2026-09-30, E8.1).

## 2a. Rules learned from the real dependencies (`learning-tests/`)

Each rule comes from a script that ran against the real thing. Re-run the
script when upgrading that dependency.

**Node + TypeScript (no build step is sound).** Relative imports carry the
literal `.ts` extension. Only erasable syntax (no `enum`, value `namespace`,
parameter properties, decorators). Never run with `--preserve-symlinks`
(workspace packages stop being type-stripped). Aliases via package.json
`imports`, never tsconfig `paths`. Node cannot run `.tsx`: JSX stays in `web`
and the sample app. Type errors do not stop execution, so `tsc` in the gate is
the only guard. `node --test` needs a file or glob, not a directory.

**Postgres (`pg`).** `seq` is `bigint` and arrives as a string: convert once at
the `db` boundary. Tell a duplicate `seq` from a duplicate `op_id` by
`err.constraint`, not only `23505`. A failed statement aborts its transaction;
use `INSERT ... ON CONFLICT DO NOTHING RETURNING` for dedupe. The fenced append
is one statement (`INSERT ... SELECT ... FOR UPDATE` on the lease row). Always
release pool clients in `finally`.

**WebSocket (`ws`).** A killed peer is noticed at once; a frozen or partitioned
one only by a ping/pong heartbeat, so the room runs one. `send()` never throws:
watch `bufferedAmount` and drop slow peers. Reject bad tokens in
`handleUpgrade` with a real HTTP status. Close codes 4000-4999 carry our
reasons. When enforcing `maxPayload` the server must handle `'error'` (or the
process dies) and sees 1006 on its own side.

**Redis + BullMQ.** Lease = `SET NX PX` plus a fencing token from `INCR` in the
same Lua script; renew and release are compare-and-set in Lua. A holder with a
blocked event loop cannot know it lost the lease, so the journal append checks
the token (F22). BullMQ `add()` with an existing `jobId` returns a job object
even when nothing was stored: trust the Postgres `jobs` row, not that return
value. Workers need `maxRetriesPerRequest: null`. `FLUSHALL` loses all jobs, so
queues are rebuilt from Postgres.

**MinIO.** Image from `quay.io/minio/minio` (Docker Hub refuses pulls). Snapshot
keys zero-pad `seq` so they sort numerically. No reverse listing: the latest
snapshot `seq` is recorded in Postgres. `IfNoneMatch: '*'` guards against two
writers of one key. Missing key is `err.name === 'NoSuchKey'`. Gzip by hand.

**Agent SDK.** Isolation is `tools: []` + `mcpServers` + `allowedTools:
['mcp__<server>__<tool>']` + `settingSources: []` (plus `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1`, which still leaves 2 built-in skills). **One tool whose Zod schema
the SDK cannot convert (`z.record(k, v)`) silently empties the WHOLE MCP
server's tool list; the model then writes text that looks like a tool call
(3 of 3 runs) and sometimes claims success, while no handler ever runs**: use `z.object({}).catchall(z.unknown())`,
and at startup the worker asserts that every one of our tools appears in the
init message's tool list, failing the run otherwise. Tool errors are
`isError: true` results the model can react to. Cancel with `AbortController`
(`interrupt()` only works with streaming input). The result message carries
token usage and `total_cost_usd`. The CLI is bundled with the package.

**Gitea.** `admin` is a reserved username. Registering a webhook fires a
synthetic push (`before` all zeros): ignore it. Signature is
`X-Gitea-Signature`, hex HMAC-SHA256 of the raw body. A failed delivery is NOT
retried, so the git peer also reconciles by fetching the mirror when a document
opens and on a timer; `X-Gitea-Delivery` dedupes. A second PR for the same
branch returns 409: Ship finds the open PR by `head.ref` and pushes to its branch.

**Sandbox (Vite in Docker).** Push the generated file with `docker exec ... cat >`
(about 50 ms, hot update, state kept); no bind mount. The generated file exports
ONLY components, or every edit becomes a full reload. `server.host: true`; one
published port serves HTTP and HMR. Bake `node_modules` into the image (0.3 s
start vs 12 s). Syntax errors show an overlay and recover without a restart. After a container
restart Vite's client reloads the page by itself (about 1.2 s, a full reload),
but only if the new container answers on the SAME origin: a document's preview
address must stay stable across restarts.

**Manifest + projection.** Extraction needs the type checker (aliases, `Omit`,
intersections) plus an AST pass (defaults). Optional means
`SymbolFlags.Optional`, not "type includes undefined". Keep only props declared
in the design system's own files (one component otherwise yields 291 DOM
props). Output is sorted, so regenerate + diff is the drift check. Each
generated element carries `data-node-id`; comments lose their element under
manual edits. Shape breakers detected individually: non-literal prop, spread,
conditional, `.map()`, extra statement or hook, second export.

## 3. Features (numbered, with observable acceptance)

### Epic 1 — Monorepo, typed API, Postgres
- **F1. Bootstrap.** On a clean clone, `./init.sh` brings up the dev
  environment and a smoke test prints PASS; `make check` exits 0.
- **F2. Orgs, workspaces, documents over HTTP.** A caller can create an org, a
  workspace in it, and a document in the workspace, then list and fetch them.
  A body that violates the contract gets `400` with the failing field named.
  A request scoped to org A never returns a row of org B (`404`, not `403`).
- **F3. Session endpoint.** `POST /documents/:id/session` returns a `wsUrl`
  and a short-lived token; an unknown document returns `404`.

### Epic 2 — Sync room, canvas, presence
- **F4. Live shared editing.** Two browsers on the same document: adding,
  moving, removing a node or changing a prop in one appears in the other in
  under 200 ms locally, and both trees are identical afterwards.
- **F5. Optimistic edits with reconcile.** The editor sees their own edit
  immediately. When two users set the same prop concurrently, both end with the
  value of the op the server sequenced last. An edit to a node that was
  concurrently removed disappears without an error dialog.
- **F6. Validation.** A move that would create a cycle, an unknown component,
  or a prop of the wrong type is rejected; the sender's view rolls back and
  shows the reason; other peers never see it.
- **F7. Presence.** Each peer sees the others' name, cursor and selection.
  A closed tab's presence vanishes from others within 5 s. Presence is never
  stored (nothing about it survives a sync restart). Presence belongs to the
  CONNECTION (two tabs are two presences); its name and actor come from the
  session token, never from a message; the cursor is a fraction of the canvas;
  it is not an op (no seq, no queue, no persist); a peer silent for 5 s is
  forgotten by the viewers, because a dead connection says no goodbye.
- **F8. Idle persistence (pre-journal).** A document reopened after all peers
  left shows its last state. *Known limit until F18:* a sync crash may lose
  edits since the last idle save.

- **F8a. Reconcile simulator.** `make sim` runs a seeded in-process simulator
  that drives the real `doc-model` and the real `peer-client` reconcile with
  several simulated peers under random delay, drop and reorder, and asserts:
  all peers converge, no op applied twice, last-writer-wins by `seq`, no cycle.
  Same seed, same run. A failing seed prints a minimal op trace. Seeds are
  committed; it runs in `make check`. Breaking a conflict rule makes a named
  seed fail. *Limits:* no simulated Postgres, Redis or WebSocket, about 300
  lines, dropped if it forces the room to be restructured. Durability, failover
  and fencing (F18, F21, F22) are verified only against real processes and §4a.

- **F14. Manifest drift guard.** Changing a component's props in the sample app
  without regenerating the manifest makes `make check` fail and name the component.
  *(Lives in epic 2: validation needs the manifest from the first op.)*

### Epic 3 — AI agent peer
- **F9. Run an instruction.** A user types an instruction (for example "add a
  payment card with a card-number input and a primary Pay button"); an AI peer
  appears in presence; nodes appear on every open canvas one by one; the run
  ends with status `succeeded`, `failed` or `cancelled` visible to the user.
- **F10. Cancel.** Pressing cancel ends the run within 3 s; ops already applied
  remain; the AI peer leaves presence.
- **F11. Same rules for the AI.** An invalid AI op is rejected like any other
  and reported back to the agent as a tool error; a human editing during a run
  is an ordinary concurrent edit. Every AI op carries `actor.kind = agent` and
  its `runId`.
- **F12. Usage recorded.** After a run, the run's input/output tokens and
  estimated cost are stored against the org and visible via the API.

### Epic 4 — Code projection and sandbox
- **F13. Deterministic codegen.** The same document always produces
  byte-identical TSX; the file type-checks against the sample app.
- **F15. Live preview.** The canvas shows an iframe of the sample app running
  in a container for the document's working branch (created in the sandbox's
  own clone when the document is first opened; F17 later pushes this same branch). After an edit, the preview reflects
  it within 3 s without a full reload. If the container dies, the iframe shows
  "rebuilding" and recovers without user action.

### Epic 5 — Git peer and ship (full loop)
- **F16a. Push in.** An engineer pushes a commit that changes a generated file
  within its fixed shape; the open canvas updates with ops whose actor is
  `git`, without a reload.
- **F16b. Conflict.** A push that breaks the fixed shape changes nothing on the
  canvas; the document shows a conflict banner naming the commit and file.
- **F17. Ship.** Pressing Ship produces a branch and an open pull request in
  Gitea containing the generated file; pressing it again updates the same PR
  rather than opening a second one.

### Epic 6 — Durability
- **F18. No acknowledged edit is lost.** `kill -9` on sync during editing:
  clients reconnect by themselves, every op that was acknowledged is present,
  no op appears twice, and unacknowledged ops are resent and applied once.
- **F19. Snapshot + replay.** Opening a document loads the newest snapshot and
  replays only journal rows after it; a document with 10,000 journaled ops
  opens in under 2 s locally.

### Epic 7 — Multi-node
- **F20. One room globally.** With two sync processes, all peers of a document
  land in the same room; two different documents may live on different nodes.
- **F21. Failover.** Killing the node that owns a room moves the room to the
  other node; clients reconnect via `/session`; F18's guarantees hold.
- **F22. Fencing.** A sync process paused (`docker pause`) past its lease and
  then resumed cannot append to the journal; it closes its sockets; the
  document's journal has no gap and no duplicate `seq`. The same holds under a
  scripted network partition between a sync node and Redis.

### Epic 8 — Auth, tenancy, RBAC, audit
- **F23. Sign-in and sessions.** A user signs up, signs in and out; an
  unauthenticated request gets `401`.
- **F24. Roles.** Org roles `owner | editor | viewer`. A viewer can open a
  document and see live edits and presence but every op they send is rejected.
  Only an owner can change roles or shares. Role changes apply to open
  sessions within 10 s.
- **F25. Sharing.** A document can be shared with a user outside the workspace
  at `viewer` or `editor`; revoking the share closes their live session.
- **F26. Audit.** Sign-ins, role and share changes, AI runs, ships and rejected
  pushes are listed in an org audit view with who, what and when. Audit rows
  cannot be updated or deleted through the API.

### Epic 9 — Job hardening and AI primitives
- **F27. Idempotent job creation.** Repeating "start AI run" or "ship" with
  the same idempotency key returns the same job, never a second one.
- **F28. Crash-safe jobs.** `kill -9` on the worker mid-job: the job is retried
  after its heartbeat goes stale and completes without duplicate ops or PRs.
- **F29. No starvation.** A long AI run does not delay git push handling
  (a push is reflected on the canvas in under 5 s during an active AI run).
- **F30. Streamed run progress.** The run's progress (tool calls, status) is
  streamed to the browser and survives a page reload mid-run.
- **F31. Limits and cost.** A per-org rate limit on AI runs returns `429` with
  a retry time; an org usage view shows tokens and estimated cost per run,
  per user and per day.

## 4. Failure modes (what the user sees)

| Failure | Behavior |
|---|---|
| `api` dies | Requests are safe to retry; job-creating POSTs are idempotent (F27) |
| `sync` dies | Banner "reconnecting"; F18 guarantees; presence rebuilds |
| Zombie `sync` | Its writes are rejected by fencing (F22); no user-visible effect |
| `worker` dies | Jobs resume (F28); AI run may show `failed` with partial ops kept |
| Sandbox dies | "rebuilding", then recovers (F15) |
| Redis lost | Queues rebuilt from Postgres `jobs`; leases re-acquired; no document data lost |
| Postgres or MinIO down | Rooms refuse new ops with a visible read-only status; nothing is silently dropped |
| AI token missing or rate-limited | Run fails fast with a clear reason; canvas unaffected |

## 4a. Final verification: a local Antithesis-style harness (end of W3)

Same method the owner used in `~/repos/ai-engine`: not the hosted platform, but
a local harness built so it can be handed to Antithesis unchanged. Rule:
**write properties, then attack the system while they are checked; change
configuration, never code** (if the slice needs a code change to boot, that is
a finding).
- **A0. Properties first.** A property catalog (`antithesis/scratchbook/`)
  produced with Antithesis's published `antithesis-research` skill
  (`npx skills add antithesishq/antithesis-skills`, no account needed): each
  property phrased on a business observable, typed `always` / `sometimes` /
  `unreachable`, with priority, an evidence file, and the place its assertion
  lives. Starts from the seven invariants: peers converge, no acknowledged op
  lost, no op applied twice, no `seq` gap or duplicate, no cycle, no cross-org
  read, no duplicate job or PR. Every `always` has a `sometimes` vacuity guard
  proving its path really ran.
- **A1. The harness (`deploy/antithesis/`).** A hermetic Compose slice (no
  internet) of the unchanged app images with stores behind toxiproxy; a driver
  image carrying the Antithesis JavaScript SDK in local-output mode
  (`ANTITHESIS_SDK_LOCAL_OUTPUT`, one file per process) and the real test
  template layout (`/opt/antithesis/test/v1/noon/` with `first_`,
  `parallel_driver_`, `anytime_`, `finally_` commands); an op ledger so
  `finally` accounts for every submitted op; the AI peer is a scripted stub (no
  model calls, no token in any image). Faults at the trust boundaries in four
  shapes: unavailable (toxiproxy toggle), slow (latency toxic), dies mid-step
  (`docker kill -9`), stalls (`docker pause`). `run.sh up | baseline | <named
  scenario> | chaos N | report | reset | down`; `report` aggregates PASS/FAIL
  per property.
- **A2. Run and fix.** `baseline` is all PASS; each named scenario and
  `chaos 20` run; every FAIL is written as *sequence → false belief →
  consequence → smallest fix*, filed as a bead, fixed under the normal gate
  with a regression test, and its scenario flips from FAIL to PASS.
- **Carried-over pitfalls:** open the fault before the workload or slow the
  system (a fast pipeline outruns a late fault); trigger faults off log lines,
  not sleeps; the runner must survive failing rounds (no `set -e` deaths);
  one-shot passes prove nothing, so repeat; verify the harness's own properties
  first; restart-before-check hides crashes.
- A hosted Antithesis run is optional later and needs a tenant; the directory
  is kept `snouty validate`-ready for it.

## 5. Non-goals

- Freeform vector drawing, freehand shapes, absolute positioning, a Figma or
  Excalidraw clone: a design is a tree of real components, so it can become code.
- Offline editing, CRDTs, operational transform.
- Undo/redo (ops are designed to be invertible; nothing else is built).
- AI writing or changing component code, files, or anything outside the tree.
- Parsing arbitrary code back into the document.
- Cloud deployment, Kubernetes, Terraform, backups, HA for Postgres or MinIO.
  (Showing the app from the owner's laptop through a tunnel is in scope: E11.)
- Real GitHub, a GitHub App, webhooks over the public internet.
- SSO, SCIM, billing, payments, email.
- Multiple pages per document, comments, version history UI, assets upload.
- A pixel-perfect UI. Until epic Z the frontend only drives the backend; E10
  then gives it a polished editor that feels like Figma, in Noon's own style,
  over the same component tree (owner decision, 2026-09-30).
  Its component library is a panel under the layers tree, not a tab beside
  it: a tile dragged onto a layer row needs both on screen (owner decision,
  2026-10-02).
- Offering this to other users on a Claude subscription token (not permitted
  by Anthropic; an API key is required before anyone else uses it).

## 6. Deliberately not building yet

Per-user undo and "undo this AI run"; AI visual self-check via sandbox
screenshots; a dedicated log store for the journal; real GitHub integration;
cloud deployment with Kubernetes and SLOs/observability; multi-page documents;
a read-only journal replay scrubber colored by actor.
The design leaves room for each; none may be started without a spec change.

## 7. The course (part of the product)

- **C1. Handbook chapter per epic**, published as an artifact page: how the
  code was written, every TypeScript and Node construct it uses explained from
  zero, the internals a principal engineer should know, and trade-offs against
  Java and Python. Includes the distributed-systems and AI design of that epic.
- **C2. "Your turn" drills per epic**, done by the learner alone: extend a
  type, fix a planted bug that turns a named test red, and explain one design
  decision before reading the chapter's rationale. An epic is not done until
  its drills exist and their starting state is red where stated.

## 8. End-to-end verification scenario

Run by one Playwright script plus shell steps, on a clean clone, with two sync nodes:

1. `./init.sh`; `make check` is green. (F1)
2. Owner signs up, creates an org, workspace and document; invites a viewer,
   and shares the document at `editor` with a user outside the workspace. (F2, F23, F24, F25)
3. Owner and editor open the document in two browsers; each sees the other's
   cursor. Both build a small tree; both set the same prop at once; trees
   converge. The viewer sees it live; the viewer's attempted edit is rejected.
   An invalid move is rejected with a reason. `make sim` passes. (F3–F7, F8a, F20, F24)
4. The preview iframe shows the running page and follows edits. (F13, F15)
5. Owner starts an AI run; nodes stream in on both canvases while the editor
   keeps editing; a second run is started and cancelled; a repeated start with
   the same idempotency key returns the same job. Usage shows tokens for the
   org. (F9–F12, F27, F30, F31)
6. During an AI run, an engineer pushes an in-shape change: the canvas updates
   within 5 s. A shape-breaking push shows a conflict banner. (F16a, F16b, F29)
7. `kill -9` the sync node owning the room mid-edit: clients reconnect to the
   other node, which recovers the room from snapshot plus journal replay; no
   acknowledged op is lost or duplicated. A scripted partition between a sync
   node and Redis gives the same result. `docker pause` a node
   past its lease and resume it: its append is rejected; the journal has no gap
   or duplicate `seq`. (F18, F19, F21, F22)
8. `kill -9` the worker mid-run: the job resumes and finishes without duplicate
   ops. (F28)
9. Owner presses Ship twice: exactly one open PR in Gitea contains the
   generated file, and that file is byte-identical to a fresh codegen of the
   final document. (F13, F17)
10. Owner revokes the outside editor's share: that session closes. The audit
    view lists the sign-ins, role change, AI runs, rejected push, ship and
    revoke. (F25, F26)
11. The manifest drift guard fails when a sample-app prop is changed without
    regenerating. (F14)
12. Every epic has a published handbook chapter and drills. (C1, C2)

F8 is superseded by F18 once epic 6 lands and is verified only at the end of epic 2.
