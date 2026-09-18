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
   Envelope in: `{opId, baseSeq, actor{kind: user|agent|git, id, runId?}, op}`.
   Out: `{seq, opId, actor, op}` to all, or `{opId, rejected: reason}` to the sender.
4. **Conflict rules.** Last writer wins per `(nodeId, key)` by `seq`. A remove
   beats any concurrent edit to the removed node or its descendants. `index`
   clamps to the valid range. Moves that would create a cycle are rejected.
   An add or move whose target parent was concurrently removed is dropped the
   same way: silently for the sender, never seen by other peers.
5. **Idempotency by `opId`.** Resending an op never applies it twice; the room
   answers with the original `seq`.
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
10. **Tenancy and attribution from day one.** Every table has `org_id`; `db`
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
    epic 1. Epic 8 replaces the header, nothing else.

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
  stored (nothing about it survives a sync restart).
- **F8. Idle persistence (pre-journal).** A document reopened after all peers
  left shows its last state. *Known limit until F18:* a sync crash may lose
  edits since the last idle save.

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
- **F14. Manifest drift guard.** Changing a component's props in the sample app
  without regenerating the manifest makes `make check` fail and name the component.
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
| `api` dies | Requests retry; creating POSTs are idempotent |
| `sync` dies | Banner "reconnecting"; F18 guarantees; presence rebuilds |
| Zombie `sync` | Its writes are rejected by fencing (F22); no user-visible effect |
| `worker` dies | Jobs resume (F28); AI run may show `failed` with partial ops kept |
| Sandbox dies | "rebuilding", then recovers (F15) |
| Redis lost | Queues rebuilt from Postgres `jobs`; leases re-acquired; no document data lost |
| Postgres or MinIO down | Rooms refuse new ops with a visible read-only status; nothing is silently dropped |
| AI token missing or rate-limited | Run fails fast with a clear reason; canvas unaffected |

## 4a. Final verification on Antithesis (end of W3)

After all nine epics pass `make check` and the §8 scenario, the system is run
once more on Antithesis (antithesis.com), a hosted deterministic-simulation
platform that runs our containers under injected faults and replays any failure.
- **A1. Packaged for Antithesis.** The Compose stack builds as container images
  pushed to the Antithesis registry, with a test template (workload commands
  that drive concurrent user, AI-stub and git edits) and JavaScript SDK
  assertions for the invariants: peers converge, no acknowledged op lost, no op
  applied twice, no `seq` gap or duplicate, no cycle, no cross-org read, no
  duplicate job or PR.
- **A2. Run and triage.** At least one full run completes; every reported
  failure is reproduced, turned into a bead, fixed under the normal gate, and
  covered by a regression test; a re-run shows those properties passing.
- The AI agent is replaced by a scripted stub peer during these runs (no model
  calls or subscription token leave the machine).
- *Dependency:* access is by request to Antithesis (registry + credentials);
  if access is not granted, A1's artifacts are still built and verified
  locally, and A2 is reported as blocked, not skipped silently.

## 5. Non-goals

- Freeform vector drawing, absolute positioning, a Figma clone.
- Offline editing, CRDTs, operational transform.
- Undo/redo (ops are designed to be invertible; nothing else is built).
- AI writing or changing component code, files, or anything outside the tree.
- Parsing arbitrary code back into the document.
- Cloud deployment, Kubernetes, Terraform, backups, HA for Postgres or MinIO.
- Real GitHub, a GitHub App, webhooks over the public internet.
- SSO, SCIM, billing, payments, email.
- Multiple pages per document, comments, version history UI, assets upload.
- A polished UI. The frontend exists to drive the backend.
- Offering this to other users on a Claude subscription token (not permitted
  by Anthropic; an API key is required before anyone else uses it).

## 6. Deliberately not building yet

Per-user undo and "undo this AI run"; AI visual self-check via sandbox
screenshots; a dedicated log store for the journal; real GitHub integration;
cloud deployment with Kubernetes and SLOs/observability; multi-page documents.
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
   An invalid move is rejected with a reason. (F3–F7, F20, F24)
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
