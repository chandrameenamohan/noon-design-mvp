# Bead graph (revision 2, created in bd; key → id map in .beads/key-map.json)

Outcome-level tasks for SPEC.md. One epic = one lesson. Revised after three
critics (size, definition of done, edges). Every bead body will carry:
"Do not weaken, delete, or skip these checks to pass."

**Check kinds** (the kind must fit what is being proven):
| kind | proves | runs in |
|---|---|---|
| `unit:` | pure logic, no I/O | `make check` |
| `typecheck:` | something must NOT compile | `make check` |
| `integration:` | behavior across a real dependency or process (real Postgres, Redis, ws, SDK init) | `make check` (new `integration` layer, added by E1.2; needs `./init.sh` up) |
| `e2e:` | what a user sees in a browser | `make check` |
| `sim:` | reconcile simulator seeds | `make check` |
| `chaos:` | kills, pauses, partitions, stopped stores | `make chaos` (per bead, and in Z.1; too slow and destructive for every commit) |
| `live:` | real model calls with the owner's token | `make live` (on demand; never in `make check`) |
| `check:` | a repo-level rule (drift, import boundaries, drills) | `make check` unless stated |

**Columns:** deps = must close first · touches = modules changed · R = review panel
(public API, data, security, money, flows people depend on). Beads are built one
at a time in the main checkout.

**Ordering rules:** an epic's first bead depends on the previous epic's last
*code* beads, never on its handbook bead, so a chapter cannot stall the build.
To keep lessons close to the code, the first bead of epic N+2 depends on epic
N's handbook bead (never more than one chapter behind).

## E0 — Primer
| key | outcome (observable acceptance) | checks | out of scope | deps | touches | R |
|---|---|---|---|---|---|---|
| E0.H | Lesson 0 "TypeScript for Java and Python engineers" is published before any epic-1 code: only what epic 1 uses (values and inference, object types, `interface` vs `type`, structural typing, unions and literals, narrowing, functions and generics, types vanish at runtime and why Zod, `null`/`undefined`, modules and the `.ts` rule, promises and the event loop, reading `package.json`/`tsconfig`/the workspace), each against Java and Python, with short exercises the learner runs with `node file.ts` | check:chapter-recorded · exercises run under Node 24 and their broken variants fail as stated | anything epic 1 does not use | — | docs/handbook, drills/ | |

## E1 — Monorepo, typed API, Postgres
| key | outcome (observable acceptance) | checks | out of scope | deps | touches | R |
|---|---|---|---|---|---|---|
| E1.1 | `GET /health` on a running `api` returns a body that parses with `HealthResponse`; `./init.sh` starts api and its smoke test calls it; on a fresh clone with no volumes, images or `node_modules`, `./init.sh` then `make check` exit 0 (F1) | integration:api-health · `make clean-clone` (fresh temp clone; run here and in Z.1, not per commit) | any business route | E0.H | apps/api, packages/contracts, docker-compose, Makefile, init.sh | |
| E1.2 | Migrations create orgs, users, memberships (with role), workspaces, documents, every tenant-owned table with `org_id`; `db` is usable only through an org-scoped accessor; the `integration` gate layer exists | integration:db-scope · typecheck:db-unscoped-rejected | auth, sharing | E1.1 | packages/db, Makefile | R |
| E1.3 | A caller can create and fetch an org, and create, list and fetch its workspaces and documents (listing orgs waits for E1.4: without an identity it would return every tenant's org); the api connects as a non-superuser role, refuses to start without `DATABASE_URL`, and never returns database error text; a contract-violating body gets `400` naming the field (F2) | integration:api-crud · integration:api-400-names-field · integration:app-role-not-superuser · integration:api-500-hides-db-error · unit:config-requires-database-url | sharing, roles, idempotency keys (job POSTs only, E9.1) | E1.2 | apps/api, packages/contracts | R |
| E1.4 | `GET /orgs` lists only the orgs the caller is a member of; identity comes from the dev-only header, refused when `NODE_ENV=production`; a caller in org A gets exactly `404`, never `403`, for every org-B row on every route (F2, constraint 16) | integration:api-tenant-404-never-403 · unit:dev-header-refused-in-production | real sign-in | E1.3 | apps/api | R |
| E1.5 | `POST /documents/:id/session` returns `{wsUrl, token}`; token is signed, names document, org and user, and expires; unknown document → `404` (F3) | unit:session-token-claims · unit:session-token-expired-rejected · unit:session-token-wrong-document-rejected · integration:session-404 | the sync server (upgrade-path checks land in E2.3b) | E1.4 | apps/api, packages/contracts | R |
| E1.H | Chapter 1 published; drills exist and start red where stated (C1, C2) | check:drills-red (`make drills` runs each drill's start state and fails if the named test passes) · check:chapter-recorded (URL in docs/handbook/index.md) | — | E1.5 | docs/handbook, drills/ | |

## E2 — Sync room, canvas, presence
| key | outcome | checks | out of scope | deps | touches | R |
|---|---|---|---|---|---|---|
| E2.1a | `seed/sample-app` runs under its own `pnpm dev` and renders the six design-system components (Stack, Card, Button, Text, Image, Input) with typed props | integration:sample-app-builds (its own `tsc` + `vite build`) | codegen, sandbox, Gitea | E1.5 | seed/sample-app | |
| E2.1b | `manifest.json` is generated from those types (checker + AST pass, own-file props only, sorted) and committed; a scripted prop edit without regenerating makes `make check` exit non-zero and name the component (F14, moved from epic 4) | unit:manifest-extract · check:manifest-drift-mutation | codegen | E2.1a | packages/design-system, packages/contracts, Makefile | |
| E2.2a | Contracts for node, the four ops, the envelope (with actor) and every WS message; `applyOp` is pure; any peers applying the same sequence end with identical trees | unit:doc-model-apply-property | validation, networking | E2.1b | packages/contracts, packages/doc-model | R |
| E2.2b | `validate(doc, op, manifest)` rejects, each with a named reason: cycle, unknown component, wrong prop type; and applies keystone 4: remove beats concurrent edits to the node and its descendants, `index` clamps, add/move under a concurrently removed parent is dropped | unit:validate-reasons · unit:remove-precedence · unit:index-clamp · unit:orphan-drop | networking | E2.2a | packages/doc-model | R |
| E2.3a | A room sequences, validates and broadcasts ops; a repeated `opId` returns the original `seq`; rejects go only to the sender; a joining peer receives the document and current `seq` | integration:room-sequence · integration:room-dedupe · integration:room-reject-only-sender | persistence, presence, multi-node | E2.2b, E1.5 | apps/sync, docker-compose, init.sh | R |
| E2.3b | Connection lifecycle: bad, expired or wrong-document token → HTTP `401` at upgrade; a frozen peer (real client, pongs suppressed) is dropped by heartbeat; a slow peer is dropped on `bufferedAmount`; an oversized frame closes that peer and the server survives; when the last peer leaves, the room saves the document and a reopen shows the last state (F8; crash-loss limit stated in code) | integration:upgrade-401-matrix · integration:heartbeat-drops-frozen-peer · integration:drops-slow-peer · integration:oversized-frame-server-survives · integration:reopen-keeps-state | journal, snapshots | E2.3a | apps/sync, packages/db | R |
| E2.4 | `peer-client` applies ops optimistically, reconciles with server order, rolls back rejected ops with the reason, reconnects and resends unacknowledged ops; only `peer-client` may submit ops (F5, keystone 2) | unit:peer-reconcile · integration:peer-resend-after-drop · check:single-write-path (import-boundary lint) | UI | E2.3b | packages/peer-client, eslint.config.js | R |
| E2.5a | Two browsers on one document: a node added in one appears in the other; measured local-commit → peer-DOM p95 over ≥20 edits < 200 ms; trees end identical (F4) | e2e:two-browsers-add-converge (asserts the measured p95) | move/remove/props UI, preview, AI | E2.4 | apps/web, e2e/, Makefile | |
| E2.5b | Move, remove and prop editing from the UI; a rejected edit rolls back and shows its reason; an edit to a concurrently removed node vanishes with no error UI (F5, F6) | e2e:edit-ops-converge · e2e:reject-shows-reason · e2e:concurrent-remove-silent | preview, AI | E2.5a | apps/web | |
| E2.6 | Peers see each other's name, cursor, selection; a closed tab vanishes within 5 s; after a `sync` restart presence is empty and no presence data exists in any store (F7) | e2e:presence · integration:presence-gone-after-sync-restart | — | E2.5a | apps/sync, apps/web, packages/contracts | |
| E2.8 | `make sim` fuzzes real `doc-model` + real `peer-client` under delay/drop/reorder with committed seeds: convergence, no double apply, LWW by `seq`, no cycle; same seed twice in separate processes gives byte-identical traces; a failing seed prints an op trace; breaking a conflict rule fails a named seed; ≤ ~300 lines (F8a) | sim:seeds · sim:determinism · sim:mutation-fails | fake Postgres/Redis/WS | E2.4 | packages/peer-client (test), Makefile | |
| E2.H | Chapter 2 + drills | check:drills-red · check:chapter-recorded | — | E2.5b, E2.6, E2.8 | docs/handbook, drills/ | |

## E3 — AI agent peer
| key | outcome | checks | out of scope | deps | touches | R |
|---|---|---|---|---|---|---|
| E3.1 | Redis joins the dev environment; a run created via `POST /documents/:id/runs` reaches a terminal status readable through the API, having applied zero ops (the worker drains the `ai` queue with a no-op handler) | integration:run-create-to-terminal | idempotency keys, retries (E9) | E2.5b, E2.6, E2.8, E1.H | docker-compose, init.sh, apps/api, apps/worker, packages/db, packages/contracts | R |
| E3.2 | The AI peer runs the Agent SDK isolated to our tools (four ops, read tree, read manifest); at startup it checks the real SDK init tool list and fails the run if any tool is missing (negative case: a `z.record` tool); the worker refuses to start if `ANTHROPIC_API_KEY` is set; it joins via `peer-client` as `actor.kind=agent` with `runId`; invalid ops return as tool errors (F9, F11) | integration:agent-tools-registered (real SDK init, with negative case) · unit:worker-refuses-api-key · integration:agent-adds-node-stub (scripted stub peer) · live:agent-adds-node | visual self-check, file/shell/web tools | E3.1 | apps/worker, packages/peer-client | R |
| E3.3 | A user types an instruction; the AI appears in presence; nodes appear on every canvas one by one; status ends `succeeded`/`failed`/`cancelled`; cancel ends the run within 3 s, applied ops remain, the AI leaves presence; a human editing during the run converges; a missing or rate-limited token fails the run fast with a named reason and an unchanged tree (F9, F10, F11, §4) | e2e:ai-run-streams (stub) · e2e:ai-cancel-within-3s (stub) · integration:ai-token-missing-fails-fast · live:ai-run-end-to-end | progress surviving reload (E9.4) | E3.2 | apps/web, apps/api, apps/worker | |
| E3.4 | After a run, input/output tokens and estimated cost are stored against the org, returned by the org-scoped API, and invisible to another org (F12) | integration:usage-recorded-and-readable · integration:usage-tenant-404 | limits, usage view (E9.5) | E3.2 | apps/worker, apps/api, packages/db, packages/contracts | R |
| E3.H | Chapter 3 + drills | check:drills-red · check:chapter-recorded | — | E3.3, E3.4 | docs/handbook, drills/ | |

## E4 — Code projection and sandbox
| key | outcome | checks | out of scope | deps | touches | R |
|---|---|---|---|---|---|---|
| E4.1 | The same document always generates byte-identical TSX: one file, exports only the page component, every element carries `data-node-id`; it type-checks inside the sample app (F13) | unit:codegen-deterministic · integration:codegen-typechecks-in-sample-app | parsing back | E2.2b (so epics 4-5 can be pulled forward if epic 3 is blocked on the token) | packages/codegen | |
| E4.2a | An image with baked `node_modules` starts one container per document working branch (its own clone of the seed repo until Gitea exists) and reports a ready URL | integration:sandbox-start-ready | pushing files, Gitea | E4.1, E3.1, E2.H | apps/worker, seed/sample-app, docker-compose | R |
| E4.2b | The generated file is pushed with `docker exec` and hot-updates (state preserved); driven by a `sandbox` queue with its own concurrency; idle containers are reaped | integration:sandbox-push-hot-update · integration:sandbox-reap | ship | E4.2a | apps/worker | R |
| E4.3 | The canvas shows the running page in an iframe; an edit shows within 3 s without a full reload; if the container dies the iframe shows "rebuilding" and recovers unaided (F15) | e2e:preview-follows-edit-within-3s · e2e:preview-self-heals | selection overlay or click-through-iframe editing, device frames/zoom, multi-page, screenshots (§6) | E4.2b | apps/web, apps/api, apps/worker | |
| E4.H | Chapter 4 + drills | check:drills-red · check:chapter-recorded | — | E4.3 | docs/handbook, drills/ | |

## E5 — Git peer and ship
| key | outcome | checks | out of scope | deps | touches | R |
|---|---|---|---|---|---|---|
| E5.1 | Gitea joins the dev environment; `init.sh` creates the user, token, repo, pushes `seed/sample-app`, registers the webhook; sandboxes clone from Gitea | integration:gitea-bootstrap | real GitHub | E4.3, E3.H | docker-compose, init.sh, apps/worker | |
| E5.2 | `codegen` parses a fixed-shape TSX file back to a tree and names the reason when it does not fit (non-literal prop, spread, conditional, `.map()`, extra statement/hook, second export); doc→TSX→doc is identity | unit:parse-roundtrip · unit:parse-shape-breakers | arbitrary code | E4.1 | packages/codegen | |
| E5.3a | A Gitea push produces one verified, deduped commit event (HMAC checked, `X-Gitea-Delivery` deduped, synthetic registration push ignored); a missed delivery is still caught by reconcile on document open and on a timer; bare mirror + per-job worktree | integration:webhook-hmac-dedupe-synthetic · integration:missed-webhook-reconciled · integration:worktree-cleaned | applying changes to documents | E5.1 | apps/worker, apps/api, packages/db | R |
| E5.3b | An in-shape change to a generated file appears on the open canvas as ops with `actor.kind=git`, submitted through `peer-client`, without a reload (F16a) | integration:push-becomes-ops · e2e:push-updates-canvas | conflicts | E5.3a, E5.2 | apps/worker, packages/peer-client | R |
| E5.4 | A shape-breaking push changes nothing (tree hash and `seq` identical before and after); the document shows a conflict banner naming commit and file; editing and Ship keep working (F16b) | e2e:conflict-banner-tree-unchanged | merge tooling, conflict resolution UI | E5.3b | apps/worker, apps/web, packages/db | |
| E5.5 | Ship pushes the document's sandbox working branch and opens one PR whose file is byte-identical to a fresh codegen of the document; shipping again updates the same PR (F17, §8 step 9) | integration:ship-once-twice-same-pr-byte-identical | real GitHub | E5.1, E4.1 | apps/worker, apps/api, apps/web | R |
| E5.H | Chapter 5 + drills; **full loop demo** | check:drills-red · check:chapter-recorded | — | E5.4, E5.5 | docs/handbook, drills/ | |

## E6 — Durability
| key | outcome | checks | out of scope | deps | touches | R |
|---|---|---|---|---|---|---|
| E6.1a | Every accepted op is journaled before broadcast, unique on `(document_id, seq)` and `(document_id, op_id)` (told apart by constraint name); if the append fails no peer receives the op and the sender gets a reject; a resent op gets its original `seq` even after a room restart | integration:no-broadcast-on-append-failure · integration:journal-dedupe-after-restart | snapshots, leases | E5.4, E5.5, E4.H | apps/sync, packages/db | R |
| E6.1b | With Postgres unavailable the room refuses ops and every peer shows a read-only status; it recovers when Postgres returns | chaos:postgres-down-read-only | MinIO outage handling beyond the same status | E6.1a | apps/sync, apps/web, packages/contracts, scripts/chaos | |
| E6.2 | Rooms snapshot to MinIO every N ops, every T seconds with peers connected, and on last leave (zero-padded keys, `IfNoneMatch`, latest `seq` in Postgres); opening loads the newest snapshot and replays ONLY later rows (row count asserted); 10,000 ops open in under 2 s (F19). Deletes F8's idle-save path and removes `integration:reopen-keeps-state` from the gate | integration:snapshot-replay-only-later-rows · integration:snapshot-cadence · integration:open-10k-under-2s | backups | E6.1a | apps/sync, packages/db, docker-compose, init.sh | R |
| E6.3 | `kill -9` on sync mid-edit: clients reconnect unaided; every acknowledged op present, none twice, unacknowledged ops applied once (F18). The assertions live in one reusable module | chaos:kill-sync-no-loss | multi-node | E6.2 | apps/sync, packages/peer-client, scripts/chaos | |
| E6.H | Chapter 6 + drills | check:drills-red · check:chapter-recorded | — | E6.3, E6.1b | docs/handbook, drills/ | |

## E7 — Multi-node
| key | outcome | checks | out of scope | deps | touches | R |
|---|---|---|---|---|---|---|
| E7.1 | Two sync processes; a Redis lease with fencing token decides each room's owner; `/session` returns the owner's `wsUrl`; N simultaneous joins split across both nodes yield exactly one owner and one token; different documents may live on different nodes (F20) | integration:one-room-globally · integration:one-room-join-race | failover | E6.3, E6.1b, E5.H | apps/sync, apps/api, docker-compose | R |
| E7.2 | Killing the owner moves the room; clients reconnect via `/session`; E6.3's assertion module passes against the failover run (F21) | chaos:kill-owner-failover (reuses E6.3 assertions) | — | E7.1 | apps/sync, packages/peer-client, scripts/chaos | |
| E7.3 | The journal append carries the fencing token in one statement; a node paused past its lease and resumed cannot append and closes its sockets; same under a scripted sync↔Redis partition; the journal has no gap or duplicate `seq` (F22) | integration:append-stale-token-rejected (real race, with a naive control that fails) · chaos:zombie-fenced · chaos:partition-fenced | Kubernetes | E7.2 | apps/sync, packages/db, scripts/chaos | R |
| E7.H | Chapter 7 + drills | check:drills-red · check:chapter-recorded | — | E7.3 | docs/handbook, drills/ | |

## E8 — Auth, tenancy, RBAC, audit
| key | outcome | checks | out of scope | deps | touches | R |
|---|---|---|---|---|---|---|
| E8.1 | Sign up, sign in, sign out; unauthenticated → `401`; the dev header no longer authenticates; the worker's AI and git peers obtain sessions through a service credential, and an AI run and a git push still work (F23) | integration:auth-flows · integration:dev-header-no-longer-authenticates · e2e:sign-in · integration:service-credential-peers-still-work | SSO, email, password reset | E7.3, E6.H | apps/api, apps/web, apps/worker, packages/db | R |
| E8.2 | Roles owner/editor/viewer: a viewer sees live edits and presence but every op is rejected; only owners change roles; a role change reaches open sessions within 10 s (F24) | integration:rbac-matrix · e2e:viewer-rejected · integration:role-change-live-within-10s | custom roles | E8.1 | apps/api, apps/sync, packages/contracts, packages/db | R |
| E8.3 | A document can be shared with an outside user at viewer/editor; revoking closes their live session AND their automatic reconnect is refused (`/session` → `404`, upgrade → `401`) and they receive no further ops (F25) | e2e:share-and-revoke-reconnect-refused | link sharing | E8.2 | apps/api, apps/sync, apps/web, packages/db | R |
| E8.4 | Sign-ins, role and share changes, AI runs, ships, rejected pushes appear in an org audit view with who/what/when; audit rows cannot be updated or deleted through the API, and the app's DB role lacks UPDATE/DELETE on the table (F26) | integration:audit-written-all-event-types · integration:audit-immutable-db-role · e2e:audit-view | export | E8.3 | apps/api, apps/web, apps/worker, packages/db | R |
| E8.H | Chapter 8 + drills | check:drills-red · check:chapter-recorded | — | E8.4 | docs/handbook, drills/ | |

## E9 — Job hardening and AI primitives
| key | outcome | checks | out of scope | deps | touches | R |
|---|---|---|---|---|---|---|
| E9.1 | Repeating "start AI run" or "ship" with the same idempotency key returns the same job; two simultaneous requests with one key yield exactly one `jobs` row, and the response comes from that row, not from the queue's `add()` (F27) | integration:idempotency-key-race | idempotency for non-job creates | E8.4, E7.H | apps/api, apps/web, packages/db | R |
| E9.2a | `kill -9` on the worker mid-job: the heartbeat goes stale, the job is retried and completes with no duplicate ops or PRs; with the `ai` queue saturated to its concurrency by long stub jobs, a push still reaches the canvas in under 5 s (F28, F29) | chaos:kill-worker-resumes · integration:no-starvation-under-saturation | — | E9.1 | apps/worker, packages/db, scripts/chaos | R |
| E9.2b | After a Redis wipe, queues are rebuilt from the Postgres `jobs` rows and pending jobs complete (F28, §4) | chaos:redis-wipe-rebuild | — | E9.2a | apps/worker, packages/db, scripts/chaos | |
| E9.4 | Run progress (tool calls, status) streams to the browser and survives a reload mid-run (F30) | e2e:progress-survives-reload | persisted full transcript, dedicated log store, replay scrubber (§6) | E9.2a | apps/api, apps/web, apps/worker | |
| E9.5 | Per-org AI rate limit returns `429` with a retry time; an org usage view shows tokens and estimated cost per run, user and day (F31) | integration:rate-limit-429-retry-after · e2e:usage-view | billing | E9.4 | apps/api, apps/web, packages/db | R |
| E9.6 | Every authenticated HTTP route has a per-user rate limit and unauthenticated routes a per-address one; over the limit is `429` with a retry time; minting session tokens (`POST /documents/:id/session`) has its own tighter limit, so a revoked collaborator cannot hammer it (found by the E1.5 review: no bead owned generic HTTP limits; F31 covers AI runs only) | integration:http-rate-limit-429-retry-after · integration:session-mint-limit | a WAF, IP reputation | E9.5 | apps/api | R |
| E9.H | Chapter 9 + drills | check:drills-red · check:chapter-recorded | — | E9.2b, E9.6 | docs/handbook, drills/ | |

## Z — Final verification
| key | outcome | checks | out of scope | deps | touches | R |
|---|---|---|---|---|---|---|
| Z.1 | The SPEC §8 scenario runs as one script on a clean clone with two sync nodes and passes, including `make clean-clone` and `make chaos` | e2e:spec-scenario | — | E9.H, E8.H | e2e, scripts | |
| Z.2a | Property catalog under `antithesis/scratchbook/` built with the `antithesis-research` skill: every property on a business observable, typed and prioritised, with an evidence file, its assertion site, and a `sometimes` vacuity guard per `always`; starts from the seven invariants (A0) | check:catalog-complete (every property has type, priority, site, guard) | assertions in code | Z.1 | antithesis/scratchbook | |
| Z.2b | `deploy/antithesis/`: hermetic Compose slice of unchanged images behind toxiproxy, driver image with the Antithesis JS SDK in local-output mode, real test-template layout, op ledger, scripted AI stub; `run.sh up` then `baseline` reports every property PASS and every vacuity guard hit (A1) | harness:baseline-all-pass · harness:vacuity-guards-hit · harness:no-internet | hosted run, model calls | Z.2a | deploy/antithesis | |
| Z.3 | Named fault scenarios (store unavailable, slow, sync killed, sync paused past lease, worker killed, Redis wiped, webhook dropped) and `chaos 20` run; every FAIL is written as sequence → false belief → consequence → smallest fix, filed as a bead, fixed under the gate with a regression test, and its scenario flips FAIL → PASS (A2) | harness:scenarios-report committed under deploy/antithesis/reports · each fix's regression test in `make check` | hosted Antithesis run (optional later; directory kept `snouty validate`-ready) | Z.2b | deploy/antithesis, whatever the fixes touch | R |

## Spec changes this graph implies
1. F14 (manifest drift guard) moves from epic 4 to epic 2: validation needs the manifest from the first op.
2. §4 "`api` dies" row: "creating POSTs are idempotent" narrows to "job-creating POSTs are idempotent (F27); other requests are safe to retry".
3. Gate layers: `integration` and `sim` join `make check`; `make chaos`, `make live`, `make clean-clone`, `make drills` exist outside it.

Totals: 61 beads (1 primer, 9 handbook, 4 final).
4. E9.6 added after the E1.5 review: generic per-user HTTP rate limiting had no owner.
