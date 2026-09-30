---
sut_path: /Users/cm/100x/personal/noon-design-mvp
commit: 764ad75a3db71d412bee986f08a5ff58aeca7200
updated: 2026-10-01
external_references:
  - path: /Users/cm/100x/personal/noon-design-mvp/SPEC.md
    why: §4a names the seven A0 invariants this catalog starts from; §4 (failure modes) and §8 (end-to-end scenario) give the P1 properties
  - path: https://github.com/antithesishq/antithesis-skills/tree/main/antithesis-research
    why: the antithesis-research skill; its references/property-catalog.md and scratchbook-artifacts.md fix this file's format
  - path: /Users/cm/repos/ai-engine/antithesis/scratchbook/
    why: the owner's scratchbook for Conduit, made with the same skill; its catalog rows (Priority, SUT instrumentation) are copied here
  - path: /Users/cm/repos/ai-engine/deploy/antithesis/README.md
    why: the owner's harness and its property table (P1..P11 always, S2..S6 sometimes vacuity guards)
---

# Property catalog: Noon (sync rooms, journal, jobs, ship)

## Summary

Twenty-two properties: thirteen `Always`, three `Unreachable`, four eventually-liveness checks, one `Sometimes`, one
`Reachable`. The first nine are the seven A0 invariants of SPEC §4a. Invariant 7, "no duplicate job or PR", is
three properties because it has three observables: an idempotency key, a job claim and a pull request. Twelve more
come from SPEC §4's failure modes and the guarantees the P0s rely on. One is the reachability table for the fault
windows.

Every `Always`, `Unreachable` and eventually check has a named vacuity guard: a `Sometimes` that proves its path ran,
and where it is observed. `make catalog-check` and its unit test (`scripts/catalog-check.test.ts`, so `make check`)
fail when a property lacks an observable, type, priority, site, evidence, guard, or a section below.

**Method.** This catalog follows Antithesis's `antithesis-research` skill (fetched read-only from
`antithesishq/antithesis-skills` into a scratch directory; not installed, because builders may not write under
`.claude/`). Its format is used for this file, the `properties/{slug}.md` evidence files, `existing-assertions.md` and
`property-relationships.md`. The skill's other artifacts (`sut-analysis.md`, `deployment-topology.md`, `evaluation/`)
and its multi-agent discovery and evaluation passes were not produced: this scratchbook is the Z.2a catalog, and
`deployment-topology.md` is Z.2b's input.

**Priority scale.** P0: an A0 invariant (data loss, a duplicate effect, or a tenant leak). P1: a SPEC §4 failure mode,
or a guarantee a P0 depends on. P2: product quality, or reachability of an interleaving.

**No SDK assertion exists in the SUT yet** (existing-assertions.md). Each "Site" row is where Z.2b puts one:
`path:line` in the SUT, or `harness:<test command>` for a check only the driver can make. The pure checks the chaos
scripts already call (`noLossViolations`, `runViolations`, `leaseViolations`) should be called from the test template,
not rewritten. All seven chaos scripts PASSed in the 2026-09 full run.

**Machine-readable fields.** Each evidence file starts with flat `key: value` front matter (`id`, `a0`, `observable`,
`type`, `priority`, `site`, `guard`, `guard_site`, `evidence`) that `scripts/catalog-check.ts` reads. `type` is the
SPEC §4a assertion kind: `always`, `sometimes`, `unreachable`, `reachability`, or `eventually` (liveness asserted by an
`eventually_` or `finally_` command after faults stop).

## Index

| A0 | slug | type | priority | site |
|---|---|---|---|---|
| A0-1 | peers-converge | always | P0 | `harness:finally_peers_converge` |
| A0-2 | acknowledged-op-never-lost | always | P0 | `apps/sync/src/room.ts:226` |
| A0-3 | op-applied-at-most-once | always | P0 | `apps/sync/src/room.ts:346` |
| A0-4 | journal-seq-contiguous | always | P0 | `packages/db/src/index.ts:630` |
| A0-5 | document-always-a-tree | always | P0 | `apps/sync/src/room.ts:223` |
| A0-6 | no-cross-org-read | unreachable | P0 | `harness:anytime_stranger_probe` |
| A0-7 | one-job-per-idempotency-key | always | P0 | `packages/db/src/index.ts:889` |
| A0-7 | job-claimed-once-per-attempt | always | P0 | `apps/worker/src/worker.ts:103` |
| A0-7 | one-open-pr-per-document | always | P0 | `apps/worker/src/ship.ts:161` |
| - | zombie-owner-append-fenced | unreachable | P1 | `packages/db/src/index.ts:630` |
| - | one-owner-per-room | always | P1 | `packages/db/src/index.ts:619` |
| - | storage-outage-visible-read-only | always | P1 | `apps/sync/src/room.ts:233` |
| - | room-recovers-after-owner-death | eventually | P1 | `harness:eventually_room_writable` |
| - | killed-worker-job-resumes | eventually | P1 | `apps/worker/src/worker.ts:145` |
| - | superseded-attempt-writes-nothing | always | P1 | `apps/worker/src/worker.ts:106` |
| - | redis-loss-jobs-rebuilt | eventually | P1 | `apps/worker/src/worker.ts:145` |
| - | no-edit-without-edit-role | unreachable | P1 | `apps/sync/src/room.ts:246` |
| - | revoked-share-loses-access | eventually | P1 | `harness:eventually_revoked_share_closed` |
| - | shipped-page-equals-codegen | always | P1 | `apps/worker/src/ship.ts:105` |
| - | dangerous-windows-reached | reachability | P1 | `harness:finally_windows_reached` |
| - | failed-ai-run-leaves-document-valid | always | P2 | `apps/worker/src/ai.ts:86` |
| - | ai-and-person-edit-together | sometimes | P2 | `apps/sync/src/room.ts:226` |

## Categories

1. **Document integrity under faults**: the journal is the truth of a document. An acknowledged op is in it once,
   at a contiguous `seq`, and every peer converges on a tree rebuilt from it. This is SPEC §4a's core; a violation is
   lost or corrupted user work.
2. **Ownership and fencing**: one sync node owns a room at a time. A frozen owner cannot write, and a dead owner's
   room comes back elsewhere. Every property in category 1 assumes this holds.
3. **Jobs, idempotency and ship**: AI runs, previews and ships run once per request and once per attempt, survive a
   worker death or a Redis wipe, and ship exactly one pull request.
4. **Tenancy and access**: nobody reads another org's data; roles and revokes take effect.
5. **Reachability**: the run entered the fault windows and interleavings the other properties are about.

---

## 1. Document integrity under faults

### peers-converge — Peers converge on the room's document

| | |
|---|---|
| **Type** | Safety |
| **Property** | Once the workload is quiet and every peer has heard up to the room's `seq`, every peer's confirmed document equals the room's, and equals the latest snapshot plus a replay of the journal. |
| **Invariant** | Harness `Always("peers converge on the room's document")` in `finally_peers_converge`: canonical serializations compared across peers and against a snapshot + journal replay read from Postgres. `Always`, because a divergent peer is wrong whenever it is observed. The in-process twin is apps/sync/src/sim.ts:132, :201. |
| **Antithesis Angle** | Concurrent edits with a sync kill or pause between one peer's send and the room's broadcast; the reconnecting peer must rebase its pending ops on a room recovered by another node. |
| **Why It Matters** | Two people see different pages and neither knows. The product's core promise (SPEC F3-F7, F18). |
| **Priority** | P0 (A0-1) |
| **Guard** | `Sometimes("the room applied an op whose sender had not yet seen the room's latest op")` at apps/sync/src/room.ts:299 |

**Open Questions:**

- Does a peer's "confirmed document" exclude its pending (unacknowledged) ops at the moment `finally_` reads it, or must the driver wait for zero pending first?

### acknowledged-op-never-lost — An acknowledged op is never lost

| | |
|---|---|
| **Type** | Safety |
| **Property** | Every op whose sender received its acknowledgement is in `op_journal` at exactly the acknowledged `seq`, and survives any crash, failover or storage blip. |
| **Invariant** | SUT `Always("an op is announced only after the journal took it")` at the broadcast that is the acknowledgement (room.ts:226). Harness `finally_ledger` turns each `noLossViolations` result (scripts/chaos/no-loss.ts:47) into an `Always` failure. `Always`, because every acknowledgement is a promise. |
| **Antithesis Angle** | Kill or pause the owning sync node, or cut Postgres, in the window between the journal insert and the broadcast, and between the broadcast and the peer's receipt. |
| **Why It Matters** | A user saw "saved" and the edit is gone. SPEC §8 step 7. |
| **Priority** | P0 (A0-2) |
| **Guard** | `Sometimes("an op was in flight when the fault struck")` at scripts/chaos/no-loss.ts:50 (already refuses a vacuous PASS) |

**Open Questions:**

- Does snapshot compaction (apps/sync/src/snapshots.ts) ever drop a journal row that a later snapshot does not yet hold, if MinIO is down while it runs?

### op-applied-at-most-once — A resent op is applied at most once

| | |
|---|---|
| **Type** | Safety |
| **Property** | For every (document, sender, opId) there is at most one journal row. A resend is answered with the original row and never applied again, including an AI run's replayed steps after a worker death. |
| **Invariant** | SUT `Always("a resend caught by the journal is not applied")` at room.ts:346, the branch where `op_journal_op` caught a resend the room had forgotten. Harness `finally_ledger`: no opId journaled twice (no-loss.ts:56); per AI run, ops = opIds = nodes (rebuild.ts:25). |
| **Antithesis Angle** | Resends after reconnecting to a *different* node, whose memory holds nothing, so only the journal can catch them; a forged high `baseSeq`. |
| **Why It Matters** | A duplicated drag moves a node twice; a duplicated add makes two nodes. |
| **Priority** | P0 (A0-3) |
| **Guard** | `Sometimes("the room answered a resend from the journal with its original row")` at apps/sync/src/room.ts:286 |

**Open Questions:**

- None

### journal-seq-contiguous — Journal seqs have no gap and no duplicate

| | |
|---|---|
| **Type** | Safety |
| **Property** | For every document the journal's `seq`s above the latest snapshot are contiguous: no gap, no repeat, whatever failed along the way. |
| **Invariant** | SUT `Always("seq is the next number")` at the one insert into `op_journal` (packages/db/src/index.ts:630). Harness `anytime_journal_contiguous`: `count(distinct seq) = max - min + 1` per document. `op_journal_seq` rules out a repeat; only a gap needs the check. |
| **Antithesis Angle** | Appends that fail mid-stream (Postgres cut, fenced) while later ops are queued behind them. |
| **Why It Matters** | A gap makes replay skip an edit; a repeat makes two edits claim one place. Recovery trusts `seq`. |
| **Priority** | P0 (A0-4) |
| **Guard** | `Sometimes("a journal append failed while ops were flowing")` at apps/sync/src/room.ts:341 |

**Open Questions:**

- None

### document-always-a-tree — The document is always a tree

| | |
|---|---|
| **Type** | Safety |
| **Property** | After every applied op the room's document passes `checkDoc`: no node is its own ancestor, none is a child twice, none is unreachable from the root. |
| **Invariant** | SUT `Always("the room's document is a tree")` right after `applyOpInto` (room.ts:223), with `checkDoc(doc)`'s problems as details. `Always`, because a cycle is corruption from that op onward. |
| **Antithesis Angle** | Two peers' crossing moves (A under B, B under A) racing through one room, across a failover. |
| **Why It Matters** | A cycle hangs every tree walk: the layers panel, codegen, ship. |
| **Priority** | P0 (A0-5) |
| **Guard** | `Sometimes("a move into the node's own subtree was refused as a cycle")` at packages/doc-model/src/validate.ts:55 |

**Open Questions:**

- `checkDoc` walks the whole document on every op: should Z.2b run it only when the SDK is in local-output mode?

## 2. Ownership and fencing

### zombie-owner-append-fenced — A fenced owner never appends

| | |
|---|---|
| **Type** | Safety |
| **Property** | Once a newer owner has claimed the document, no append carrying the old claim lands in `op_journal`. |
| **Invariant** | `Unreachable("an append landed with a claim that is not the document's")`. The claim check and the insert are one statement (index.ts:630), so the check is made from the harness: every journal row was written while its node held the lease. `Unreachable`, because any occurrence is two writers. |
| **Antithesis Angle** | `docker pause` of the owner past its lease ttl, or a sync-to-Redis partition, then resume with appends queued. |
| **Why It Matters** | Two nodes number one document; users on the new owner lose the zombie's writes or see them twice. SPEC §4 "Zombie sync", F22. |
| **Priority** | P1 |
| **Guard** | `Sometimes("a room's append was refused as Fenced")` at apps/sync/src/fence.ts:17 |

**Open Questions:**

- None

### one-owner-per-room — One owner per room

| | |
|---|---|
| **Type** | Safety |
| **Property** | For each document the lease token only increases, and the journal's `fence_token` equals the live lease's token. |
| **Invariant** | SUT `Always("a claim only moves the fence forward")` at the claim (index.ts:619). Harness `anytime_lease_matches_fence`, the `leaseViolations` check in scripts/chaos/rebuild.ts:31. |
| **Antithesis Angle** | Redis FLUSHALL or restart while a room is open (the token counter resets); owner kill during a claim. |
| **Why It Matters** | Every category-1 property assumes a single writer. |
| **Priority** | P1 |
| **Guard** | `Sometimes("a document's room moved to another sync node")` at scripts/chaos/kill-owner-failover.ts:102 |

**Open Questions:**

- None

### storage-outage-visible-read-only — A storage outage is visible as read-only

| | |
|---|---|
| **Type** | Safety |
| **Property** | The first failed or hung append makes the room read-only and tells every peer before the refusal it caused; no op is acknowledged while read-only; the held op lands once when storage returns. |
| **Invariant** | SUT `Always("read-only is broadcast before any refusal it causes")` at room.ts:233 and `Always("no ack while read-only")` at room.ts:252. |
| **Antithesis Angle** | Postgres cut or paused (latency past `journalTimeoutMs`) with ops in flight from several peers. |
| **Why It Matters** | SPEC §4: "nothing is silently dropped". |
| **Priority** | P1 |
| **Guard** | `Sometimes("a room went read-only because its journal failed")` at apps/sync/src/room.ts:234 |

**Open Questions:**

- SPEC §4 names MinIO down too; which user-visible status does a MinIO outage give, given that ops go to Postgres and only snapshots go to MinIO?

### room-recovers-after-owner-death — A room recovers after its owner dies

| | |
|---|---|
| **Type** | Liveness |
| **Property** | After faults stop, every document a driver peer had open accepts an op again, and the move takes at most one lease ttl plus slack. |
| **Invariant** | Harness `eventually_room_writable`: each peer's probe op is acknowledged within a budget (`Always` in an `eventually_` command, per the test template's liveness form); the move time is reported as a measurement. |
| **Antithesis Angle** | Owner killed while peers are mid-reconnect; both nodes restarted close together. |
| **Why It Matters** | The safety properties hold trivially on a room that never comes back. SPEC §4 "sync dies". |
| **Priority** | P1 |
| **Guard** | `Sometimes("the owner of a room with connected peers was killed")` at scripts/chaos/kill-owner-failover.ts:102 |

**Open Questions:**

- None

## 3. Jobs, idempotency and ship

### one-job-per-idempotency-key — One job per idempotency key

| | |
|---|---|
| **Type** | Safety |
| **Property** | For each (org, user, key) at most one job exists, and every request with that key within 24 h is answered with it; at most one ship is queued per document. |
| **Invariant** | SUT `Always("a key names one job")` after the key's transaction (index.ts:889). Harness `finally_jobs`: no key names two job ids. |
| **Antithesis Angle** | The same start sent twice concurrently, and again after an api kill between the insert and the response. |
| **Why It Matters** | A retried click starts two AI runs (twice the tokens) or two ships. F27. |
| **Priority** | P0 (A0-7) |
| **Guard** | `Sometimes("a repeated start was answered with the job its key had made")` at packages/db/src/index.ts:891 |

**Open Questions:**

- None

### job-claimed-once-per-attempt — A job is claimed once per attempt

| | |
|---|---|
| **Type** | Safety |
| **Property** | A handler starts only through `jobs.claim` (queued -> running, one statement); two queue messages for one job give one running attempt. |
| **Invariant** | SUT `Always("claimed job was queued")` at worker.ts:103. Harness `finally_jobs`: `attempts` = 1 + the worker kills that landed inside the job (rebuild.ts:24). |
| **Antithesis Angle** | Redis wipe (the sweep re-offers every queued row) racing BullMQ redelivery. |
| **Why It Matters** | A job run twice writes its ops twice or opens two pull requests. |
| **Priority** | P0 (A0-7) |
| **Guard** | `Sometimes("a duplicate or stale queue message found nothing to claim")` at apps/worker/src/worker.ts:104 |

**Open Questions:**

- None

### one-open-pr-per-document — One open pull request per document

| | |
|---|---|
| **Type** | Safety |
| **Property** | Each document has at most one open pull request for its branch, however many ships, concurrent presses or killed ship workers. |
| **Invariant** | SUT `Always("at most one open pull for this branch")` after `POST /pulls` (ship.ts:161). Harness `finally_ship`: Gitea's open pulls per branch are at most 1. |
| **Antithesis Angle** | Two ship workers, or a killed-and-retried ship, reaching `POST /pulls` together. |
| **Why It Matters** | SPEC §8 step 9: "exactly one open PR". |
| **Priority** | P0 (A0-7) |
| **Guard** | `Sometimes("ship found the branch's pull request already open (409)")` at apps/worker/src/ship.ts:163 |

**Open Questions:**

- The `pullsInFlight` queue (ship.ts:131) serializes within one process only; with two ship-worker replicas, is Gitea's 409 the only guard? `(partial: ship.int.test.ts:96 proves two concurrent ships in one process; no two-process test)`

### killed-worker-job-resumes — A killed worker's job resumes

| | |
|---|---|
| **Type** | Liveness |
| **Property** | A job left running by a dead worker is queued again once its heartbeat is stale, and ends `succeeded` as its next attempt with each step journaled once. |
| **Invariant** | Harness `eventually_jobs_settle`: every started job reaches a terminal status within a budget; `Always` that no retry began before the heartbeat was stale. |
| **Antithesis Angle** | `kill -9` of the ai, sandbox or ship worker mid-step; a second kill during the retry. |
| **Why It Matters** | SPEC §4 "worker dies", F28. |
| **Priority** | P1 |
| **Guard** | `Sometimes("a worker was killed while its job was running")` at scripts/chaos/kill-worker-resumes.ts:92 |

**Open Questions:**

- None

### superseded-attempt-writes-nothing — A superseded attempt writes nothing

| | |
|---|---|
| **Type** | Safety |
| **Property** | A write under an attempt that is no longer the job's latest changes nothing: not status, progress, usage or result. |
| **Invariant** | SUT `Always("a write under a stale attempt matched no row")` at the job-row writes keyed by `mine` (worker.ts:106). |
| **Antithesis Angle** | `docker pause` of a worker past `staleMs`, then resume while attempt 2 runs. |
| **Why It Matters** | A slow worker overwrites a finished run's result or double-counts usage. |
| **Priority** | P1 |
| **Guard** | `Sometimes("a stalled attempt woke up after its job was given to another attempt")`, reached today only by apps/worker/src/crash.int.test.ts:81 |

**Open Questions:**

- Which job-row writes carry the attempt in their WHERE clause, and do usage writes too?

### redis-loss-jobs-rebuilt — Jobs are rebuilt after Redis is lost

| | |
|---|---|
| **Type** | Liveness |
| **Property** | After a Redis FLUSHALL or restart, every job that was waiting or running finishes, each claimed once, and no document data is lost. |
| **Invariant** | Harness `eventually_jobs_settle` plus `runViolations` (scripts/chaos/rebuild.ts:13). |
| **Antithesis Angle** | Wipe while jobs are both waiting and running, and while a room is open (the lease counter resets too). |
| **Why It Matters** | SPEC §4 "Redis lost": queues are rebuilt from Postgres. |
| **Priority** | P1 |
| **Guard** | `Sometimes("jobs were waiting and running at the wipe")` at scripts/chaos/rebuild.ts:15 |

**Open Questions:**

- None

### shipped-page-equals-codegen — The shipped page equals the codegen

| | |
|---|---|
| **Type** | Safety |
| **Property** | The file in the pull request is byte-identical to `generate(document, manifest)` of the document the ship read. |
| **Invariant** | SUT `Always("the blob is the codegen of the document read for this ship")` at ship.ts:105. Harness `finally_ship`: Gitea's file compared with codegen at the ship's recorded `seq`. |
| **Antithesis Angle** | A push racing the ship (the `branch_busy` path); edits landing between the read and the commit. |
| **Why It Matters** | SPEC §8 step 9; the product ships code nobody reviewed. |
| **Priority** | P1 |
| **Guard** | `Sometimes("a ship pushed a commit to the document's branch")` at apps/worker/src/ship.ts:109 |

**Open Questions:**

- Does the ship record the `seq` it read, so that `finally_ship` can rebuild the exact document?

### failed-ai-run-leaves-document-valid — A failed AI run leaves the document valid

| | |
|---|---|
| **Type** | Safety |
| **Property** | A run that ends in anything but `succeeded` has a reason, sends no op after its end, and keeps the ops it had applied. |
| **Invariant** | SUT `Always("no op of this run is sent after it ended")` on the cancel path (ai.ts:86). Harness `finally_jobs`: no journal row of the run after its end. |
| **Antithesis Angle** | Cancel, sync death or worker stop between a tool call and its op's acknowledgement. |
| **Why It Matters** | SPEC §4 "AI token missing or rate-limited"; F10. |
| **Priority** | P2 |
| **Guard** | `Sometimes("an AI run ended early with ops already applied")`, observed today at apps/worker/src/ai.int.test.ts:192 |

**Open Questions:**

- None

## 4. Tenancy and access

### no-cross-org-read — No cross-org read

| | |
|---|---|
| **Type** | Safety |
| **Property** | Every API response and sync message a user receives carries data only of their own orgs, or of the one document shared with them. |
| **Invariant** | Harness `Unreachable("a stranger got a 2xx or a welcome")` in `anytime_stranger_probe`: a user of a second org probes the first org's documents, jobs, usage, audit and rooms while faults run. `Unreachable`, because one leak is the failure. |
| **Antithesis Angle** | Probes during a failover, a Redis wipe, and a role change or revoke in flight. |
| **Why It Matters** | A tenant leak. SPEC §2, F23. |
| **Priority** | P0 (A0-6) |
| **Guard** | `Sometimes("a stranger asked for another org's real document and was answered 404")`, observed today at apps/api/src/rbac.int.test.ts:33 |

**Open Questions:**

- Is there a sync-side path (presence, the 4409 redirect) that names another org's document or users?

### no-edit-without-edit-role — No edit without the edit role

| | |
|---|---|
| **Type** | Safety |
| **Property** | No journal row belongs to an actor who, when the op's turn came, lacked edit rights on the document. |
| **Invariant** | SUT `Unreachable("an op was journaled for a peer that may not edit")` near room.ts:246. Harness `finally_ledger`: every op of the driver's viewer settled `forbidden`. |
| **Antithesis Angle** | A demotion racing an editor's queued ops; the demotion announcement lost on one node. |
| **Why It Matters** | F24; SPEC §8 step 3. |
| **Priority** | P1 |
| **Guard** | `Sometimes("an op from a peer without edit rights was refused")` at apps/sync/src/room.ts:247 |

**Open Questions:**

- None

### revoked-share-loses-access — A revoked share loses access

| | |
|---|---|
| **Type** | Liveness |
| **Property** | After a revoke, within a bound, the outsider's session is closed, REST reads of the document return 404 and a reconnect is refused. |
| **Invariant** | Harness `eventually_revoked_share_closed`: the outsider's peer is closed and its probes are refused within the bound. |
| **Antithesis Angle** | The revoke announcement lost (Redis partition) while the outsider stays connected. |
| **Why It Matters** | F25; SPEC §8 step 10. |
| **Priority** | P1 |
| **Guard** | `Sometimes("a share was revoked while its holder had the document open")`, observed today at e2e/share-and-revoke.spec.ts:26 |

**Open Questions:**

- Is the bound "at once" (the announcement) or 60 s (the token's life, apps/sync/src/server.ts:152) when the announcement is lost? `(partial: server.ts:78 re-reads roles on "all"; the lost-announcement bound is not tested)`

## 5. Reachability

### dangerous-windows-reached — The fault windows were reached

| | |
|---|---|
| **Type** | Reachability |
| **Property** | The run entered each fault window a P0 or P1 property is about (R1-R7 in the evidence file). |
| **Invariant** | One `Reachable` per window in `finally_windows_reached`, fed by the driver's ledger and the SUT-side guards. `Reachable`, because what matters is that the window was hit. |
| **Antithesis Angle** | This is the explorer's steering signal: which windows it has not yet reached. |
| **Why It Matters** | A green run that never reached a window proves nothing (the noon-elo.3 "vacuous" lesson). |
| **Priority** | P1 |

**Open Questions:**

- None

### ai-and-person-edit-together — The AI and a person edit together

| | |
|---|---|
| **Type** | Reachability |
| **Property** | At least once, the room accepts an agent op and a user op back to back on one document. |
| **Invariant** | SUT `Sometimes("an agent op and a user op were accepted back to back")` at room.ts:226. `Sometimes(cond)`, because the condition is a semantic state, not a line. |
| **Antithesis Angle** | Interleaves the agent peer with humans for the category-1 properties. |
| **Why It Matters** | F9; SPEC §8 step 5. |
| **Priority** | P2 |

**Open Questions:**

- None

---

## Assumptions

- The harness runs the unchanged app images from docker-compose.yml, with toxiproxy in front of Postgres, Redis and
  MinIO (SPEC §4a A1); the AI peer is the scripted stub (scripts/chaos/stub-worker.ts), not a model.
- Line numbers are at commit 764ad75; `make catalog-check` fails if a cited file shrinks past a cited line, but not
  if the line's meaning moves.

## Open Questions

- Should the harness pin `journalTimeoutMs`, the lease ttl and `staleMs` below production values, so that faults
  land inside the windows within one run? `(needs human input)`: a configuration choice SPEC §4a leaves open.

## What Z.2b must build to assert these

- **An op ledger in the driver** (every submit, its state at the fault, its settled outcome): feeds
  `finally_ledger`, which is `noLossViolations` plus the per-document seq query. Covers A0-2, A0-3, A0-4, and the
  harness half of zombie-owner-append-fenced and no-edit-without-edit-role.
- **The test-template commands** named in the Site and Guard rows: `finally_peers_converge`, `finally_ledger`,
  `finally_jobs`, `finally_ship`, `finally_windows_reached`, `anytime_stranger_probe`, `anytime_lease_matches_fence`,
  `anytime_journal_contiguous`, `eventually_room_writable`, `eventually_jobs_settle`,
  `eventually_revoked_share_closed`, and drivers `parallel_driver_start_twice` (A0-7) and crossing moves from two
  peers (A0-5's guard).
- **SUT-side SDK calls** at the `path:line` sites (Always/Unreachable) and guard sites (Sometimes), in local-output
  mode. Configuration, not behaviour: an assertion must never change what the code does.
- **A second org and an outside user** in `first_` setup, for no-cross-org-read and revoked-share-loses-access.
- **A slow, multi-step scripted AI stub**, so kills and cancels land mid-run (R4, failed-ai-run-leaves-document-valid).

## Gaps

- No chaos script pauses a **worker** past `staleMs` (R7, superseded-attempt-writes-nothing): only an integration
  test reaches it. Z.3 "worker stalls" should.
- **MinIO down** (SPEC §4 lists it with Postgres) has no chaos script; storage-outage-visible-read-only is evidenced
  for Postgres only.
- no-cross-org-read is evidenced by integration tests, never under faults: the stranger probe is new work in Z.2b.
