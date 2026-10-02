# Noon: hermetic slice + Antithesis-style properties (SPEC §4a A1)

A Docker Compose reproduction of Noon (api, two sync nodes, the workers, their stores) that runs with **no
internet**, is driven by a workload, and is checked with Antithesis SDK assertions while faults are opened at the
trust boundaries. The method is the owner's from `~/repos/ai-engine/deploy/antithesis`: not the hosted platform,
but a local harness built so it can be handed to Antithesis unchanged. The rule: **write properties, then attack the
system while they are checked; change configuration, never code.**

The properties are the 23 of `antithesis/scratchbook/property-catalog.md` (22 from Z.2a, one added by Z.3 for a
push). `driver/properties.ts` lists them, and a unit test fails when that list and the catalog drift apart.

```
driver ──REST──▶ api ──▶ toxiproxy:5432/6381 ──▶ Postgres, Redis
   │                                                  ▲
   └─WebSocket─▶ sync, sync-2 ──▶ toxiproxy:5433/5434 (Postgres), :6379/:6380 (Redis), :9000 (MinIO)
                                                      ▲
worker (scripted AI), worker-ship, worker-git ──▶ toxiproxy:5432/6381, :3000 (Gitea) ──▶ Gitea ──:3100──▶ api (webhook)
```

| service | what |
|---|---|
| `api`, `sync`, `sync-2`, `worker-ship`, `worker-git`, `migrate` | the image the repo's `Dockerfile` builds, **unchanged**, with the entrypoints of `docker-compose.yml` |
| `worker`, `worker-2` | the scripted AI stub (`driver/stub-worker.ts`): the real worker loop, AI handler, tools and peer-client, a scripted agent where the model would be. No model call, no token in any image. `worker-2` is a standby, started only by the scenarios that kill or freeze `worker` |
| `postgres`, `redis`, `minio`, `gitea` | the stores. Postgres logs every write with its parameters (`log_statement=mod`), which is how a fenced append is seen |
| `toxiproxy` | between every app service and every store, one listener per consumer, so a fault can be aimed at one sync node |
| `driver` | the app image + `antithesis-sdk` + the workload + the test template under `/opt/antithesis/test/v1/noon/`. It reads the stores **directly**, never through toxiproxy: a fault must not blind the judge |

Not in the slice: `worker-sandbox` (previews). It needs the host's Docker socket, which a hermetic slice cannot
give, so "preview" is not among the jobs this harness kills.

**It booted on configuration alone**: no app code was changed. What had to be set: `SYNC_PUBLIC_URL` to the nodes'
names inside the network (the driver is the "browser"), `NODE_ENV=development` (the `x-dev-user` identity),
`AI_RUNS_PER_HOUR` raised, Gitea in offline mode with its webhook allowed to dial toxiproxy.

**Timing is configuration** (owner, 2026-10-01: never code): `LEASE_TTL_MS=4000` (default 10 s) and the stub
worker's `STALE_MS=6000` (default 15 s). `journalTimeoutMs` has no variable in the app, so it stays 5 s; and
`worker-ship` runs the app's own `main.ts`, so its `staleMs` stays 15 s.

## Run it

```bash
deploy/antithesis/run.sh up            # build both images, start the slice, first_setup (about a minute, cached)
deploy/antithesis/run.sh baseline      # quiet workload, then one of each fault window -> all PASS, all guards hit
deploy/antithesis/run.sh report
deploy/antithesis/run.sh sync-killed   # one named scenario, then the checks (see run.sh for the twelve names)
deploy/antithesis/run.sh chaos 6       # six rounds, a random scenario each
deploy/antithesis/run.sh no-internet
deploy/antithesis/run.sh down
```

The named checks: `make harness-baseline-all-pass`, `make harness-vacuity-guards-hit`, `make harness-no-internet`.

The harness is its own compose project (`noon-antithesis`), its one network is `internal`, and it publishes no
port: it neither touches nor can be reached from the dev stack. State of a run lives in `.run/` (git-ignored): the
SDK's output (`sdk/`, one file per process), the op ledger (`ledger/`), the jobs the drivers started, the cues.

A run is a PASS only when every property that was evaluated holds, every command and scene finished (one that
could not do its work asserted nothing), and no app container was found dead beyond the fault's own victim. run.sh
exits non-zero otherwise, for a named scenario, `baseline` and each `chaos` round alike.

## What `baseline` is

Half the catalog's vacuity guards are fault events ("a worker was killed while its job was running"). A run with no
fault cannot hit them, so `baseline` has two parts, and says so as it runs:

1. **quiet**: every `parallel_driver_` command once, no fault (`run.sh quiet` runs only this);
2. **one of each fault window**, each the mildest form that reaches it: Postgres cut from the sync nodes, a room's
   owner killed under a burst (Postgres's answers slowed first, so the kill finds an append committed and not yet
   announced), the owner frozen past its lease with an append still on its way to Postgres, the AI worker killed
   mid-run, the AI worker frozen past `staleMs`, Redis flushed with jobs waiting and running, Gitea's webhook
   delivery refused at a push.

It is the harness proving its own assertions can fail and can fire (SPEC §4a: "verify the harness's own properties
first"). Attacking in depth (repeats, random timing, new faults) is Z.3's, with `chaos N` and the named scenarios.

## The test template

`first_setup` makes two orgs (an owner, an editor, a viewer; an outsider; a stranger with an org of their own) and
Gitea's repo. Then, each a process of its own that knows nothing about faults:

| command | what it does |
|---|---|
| `parallel_driver_edit` | two people build a tree, set the same prop at once, and make crossing moves |
| `parallel_driver_viewer_edit` | a viewer tries to edit |
| `parallel_driver_start_twice` | the same AI start three times under one idempotency key |
| `parallel_driver_ai_and_person` | a person edits while an AI run builds |
| `parallel_driver_end_run_early` | a run cancelled mid-way, and one the provider refuses mid-way |
| `parallel_driver_stale_message` | a run cancelled while its message waits in Redis |
| `parallel_driver_ship` | Ship, an edit, Ship again (and a retry of the second press) |
| `parallel_driver_share_revoke` | an outsider works in a shared document; the share is revoked |
| `parallel_driver_engineer_push` | an engineer pushes an in-shape change to a shipped page while its document is open |
| `anytime_stranger_probe`, `anytime_journal_contiguous`, `anytime_lease_matches_fence` | run beside every fault. Two faults leave the stranger's probe until they are over: `webhook-dropped` (the probe opens a session, which asks for the reconcile the scenario is timing) and `worker-store-unavailable` (the api's Postgres is the thing cut) |
| `eventually_room_writable`, `eventually_jobs_settle`, `eventually_revoked_share_closed`, `eventually_push_on_canvas` | after the faults stop |
| `finally_ledger`, `finally_peers_converge`, `finally_jobs`, `finally_ship`, `finally_sut_logs`, `finally_windows_reached` | the judgement |

**The op ledger.** Every op a driver peer submits is kept (`driver/ledger.ts`, on `scripts/chaos/no-loss.ts`'s
`createLedger`): its fate when the fault struck and how it settled, what its sender had seen, which connection
answered it. One file per document and process, so `finally_ledger`, a later process, holds all of them against
the journal with `noLossViolations`; `runViolations` and `leaseViolations` (`scripts/chaos/rebuild.ts`) judge the
jobs and the lease the same way. Called, not rewritten.

## Where each property is asserted

The catalog puts thirteen sites inside the SUT (`apps/sync/src/room.ts:226` ...). The images are unchanged, so each
is asserted from what the SUT shows outside itself. `P` is the property's assertion, `G` its vacuity guard.

| property | P: what is checked | G: what proves the path ran |
|---|---|---|
| peers-converge | each editing peer's confirmed document (hash at its seq) = a replay of the journal to that seq | an op acknowledged further on than its sender's own queue explains |
| acknowledged-op-never-lost | `noLossViolations`: acknowledged = journaled at that seq; nothing lost or refused | a ledger entry unanswered when a fault struck |
| op-applied-at-most-once | no opId journaled twice, no row nobody submitted; per AI run ops = opIds = nodes | an op answered over a LATER connection, by a room under another lease token, at a row journaled before that connection existed |
| journal-seq-contiguous | per document `count = max(seq)`, `min = 1`, no repeat (any time, and at the end) | the room went read-only on an op, which stayed pending with no seq taken |
| document-always-a-tree | the journal replayed op by op: `checkDoc` after every one | the room refused a move as `cycle` (crossing moves by two peers) |
| no-cross-org-read | a stranger's 41 requests for this org's real ids, and a socket: any 2xx or welcome is the failure | a real document id answered 404 |
| one-job-per-idempotency-key | every answer under one key names one job; one job row for that request | concurrent and repeated starts answered with the same id |
| job-claimed-once-per-attempt | `runViolations`: succeeded, attempts = 1 + the faults it was owed, each step once | a job cancelled while its message waited in Redis; the message left Redis; `attempts = 0` |
| one-open-pr-per-document | Gitea: open pulls whose head is the document's branch = 1 | two succeeded ships of one document naming the same pull request |
| zombie-owner-append-fenced | Postgres's statement log: an append under a claim that was no longer the document's, whose row is in the journal with no rightful append to explain it | such an append was attempted at all |
| one-owner-per-room | `leaseViolations` around each fault; any time: lease token = `fence_token`, and never below one seen | the room is held by another node after the fault |
| storage-outage-visible-read-only | all three peers read-only; no op heard while down; local edits refused; the held op lands at `seq + 1` | the peers were told read-only while Postgres was cut |
| room-recovers-after-owner-death | a probe op is acknowledged in every ledger document; the move took under two ttls + slack | the killed node was the owner, with both peers on it |
| killed-worker-job-resumes | every job ends; a retry starts no sooner than `staleMs` after the last heartbeat | at the kill: `running`, attempt 1, some but not all steps journaled |
| superseded-attempt-writes-nothing | after the stalled worker wakes: `succeeded`, attempts 2, each step once, at most one usage row | the worker's log: "job taken over after a silence: stopping this attempt" |
| redis-loss-jobs-rebuilt | every run that was waiting or running at the wipe succeeds (claimed once: above) | `LLEN bull:ai:wait > 0` and runs `running` at the flush |
| no-edit-without-edit-role | a journal row whose actor is the viewer is the failure | the viewer's ops settled `forbidden` |
| revoked-share-loses-access | the outsider's open session closes; later `/session` and `/run` are 404 and a new peer never goes live | the outsider was live at the revoke |
| shipped-page-equals-codegen | the file on the branch = `generate()` of the journal replayed to SOME seq (a ship records none) | a ship's output names a commit |
| dropped-webhook-push-reaches-canvas | per push the driver's engineer made: one journal row of the git peer, stamped with the commit, carrying the pushed label; in `webhook-dropped`, on the open canvas within 60 s | a push made with the webhook's listener cut is a `git_events` row with no delivery id, and reached the journal |
| dangerous-windows-reached | R1..R7, one `reachable` each | - |
| failed-ai-run-leaves-document-valid | ended as expected, with a reason; no journal row of the run after `finished_at`; ops = opIds = nodes | a run that ended `cancelled` or `failed` with rows in the journal |
| ai-and-person-edit-together | adjacent seqs, one `agent`, one `user` | - |

`finally_sut_logs` is the one check that reads the SUT's logs (run.sh copies them under `.run/logs/`). Inside
Antithesis there are none there and it asserts nothing: the platform has the containers' output itself.

## Results (2026-10-01, this machine)

| run | outcome |
|---|---|
| `up` | the unchanged images boot in the slice on configuration alone |
| `no-internet` | PASS: the network is internal, nothing is published, no model credential; from `driver`, `api`, `sync`, `worker`, `worker-ship` an address, a name and the model's host are all unreachable while a neighbour answers |
| `quiet` | 18/22 PASS, 10/20 guards: what a fault-free run can reach, and no more |
| `baseline` | **22/22 properties PASS, 20/20 vacuity guards hit, R1..R7 reached**; no app container found dead beyond each fault's own victim |
| Z.3: `baseline`, each named scenario at least three times, `chaos 20` | `reports/2026-10-01-z3-scenarios.md`: the runs, the machine's load during each, and every finding. With Z.3's property the baseline is 23/23 and 21/21 |

**The checks can fail.** With one row deleted from a quiet document's journal (as the database owner, then put
back), `finally_ledger`, `finally_peers_converge` and `anytime_journal_contiguous` reported
acknowledged-op-never-lost, journal-seq-contiguous and peers-converge FAIL, naming the document, the op and the
seq. A PASS here is not the absence of a check.

## Findings while building it

No property failed. Two things the SUT does that the next bead (Z.3) must know to aim its faults:

1. **A frozen sync node did not append what arrived while it was frozen, and does not log that it was fenced.**
   Observed: with the owner paused past its lease and six edits sent into its socket, the woken node logged
   "lease 1 lost" and Postgres saw no append from it (the first form of `sync-paused` here: 0 stale appends, one
   run). The likely reason is in `server.ts`: the lease keeper's timer is due when the node wakes, marks the room
   lost and closes its sockets, and a frame read after that is dropped (`if (opened.lost) return`). The fence is
   reached by an append that had already LEFT the owner when it froze, which is why `sync-paused` now delays the
   owner's traffic to Postgres by `2 x ttl + 2 s` first. And when the fence does refuse that append, the node logs
   only "lease 1 lost" and "journal append took 12151 ms", never `server.ts`'s "fenced by a newer owner's claim":
   the room was already dropped when the refusal came back. The refusal is visible in Postgres's statement log
   alone (`driver/pglog.ts`, `finally_sut_logs`). Nothing is written, so not a bug. `scripts/chaos/fenced.ts` used
   to count `fencedAppends` from the sync log, a count that said nothing either way: it is gone (noon-98h.3.1).
2. **A killed or frozen worker's job is retried after BullMQ's stall check, not after `staleMs`.** The sweep puts
   the row back to `queued` once the heartbeat is stale (6 s here) and offers it again, but BullMQ still holds the
   dead worker's message as active under that job id and drops the offer. The run starts again only when BullMQ's
   own stalled-job check re-delivers it: measured 62 s after the dead worker's last heartbeat. Shortening `staleMs`
   does not shorten the retry. Within the property (the job resumes, and not before it is stale).
   Fixed since (`noon-elo.2.6`, not yet re-run here): the workers' BullMQ lock lasts `staleMs` and their stall check
   runs every `sweepMs`, so the message is free about when the row is: the bound is now `staleMs` plus a few sweeps
   (about 25 s with the app's 15 s and 5 s; Z.3's 6 s stale and 1 s sweeps: about 9 s).

Z.3's findings (a sync node killed by a reset on a refused upgrade, fixed; what a slow Postgres does to opening a
document; what a job-store outage longer than `staleMs` does to a healthy run) are in
`reports/2026-10-01-z3-scenarios.md`.

## What Antithesis adds over this

The harness proves the slice is hermetic and the properties are checkable. It cannot search: toxiproxy and Docker
apply one fault at one moment, chosen by hand, and `chaos N` only varies which and when. Antithesis runs the same
compose file and test template thousands of times with faults, pauses and reorderings it chooses, and hands back the
exact timeline of a failure. Handing this over needs a tenant, the two images pushed to its registry, and `snouty
validate` on this directory. The scenes (`driver/scenes.ts`) and `run.sh` are local only.
