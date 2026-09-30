---
id: dangerous-windows-reached
observable: the run really hit each fault window the P0 properties are about, so a green run means something
type: reachability
priority: P1
site: harness:finally_windows_reached
evidence: scripts/chaos/no-loss.ts:49, scripts/chaos/rebuild.ts:15, scripts/chaos/kill-worker-resumes.ts:92, scripts/chaos/fenced.ts:158
---

# dangerous-windows-reached

Owner's method (ai-engine scratchbook, `dangerous-windows-reached`): one reachability property that names the
windows, so each always's guard can point at one of them and a report shows which were reached.

## Windows

| R | Window | Reached when | Guard of |
|---|---|---|---|
| R1 | sync owner dies with an op in flight | ledger has an op `unsettled` at the kill | [[acknowledged-op-never-lost]], [[op-applied-at-most-once]] |
| R2 | owner paused past its lease, then resumes and appends | `Fenced` thrown to a room | [[zombie-owner-append-fenced]], [[journal-seq-contiguous]] |
| R3 | Postgres cut or paused with a room open | room broadcast read-only | [[storage-outage-visible-read-only]] |
| R4 | worker killed mid-run, some steps journaled | attempt 1 running with 0 < steps < n | [[killed-worker-job-resumes]] |
| R5 | Redis wiped with jobs waiting and running | waitingAtWipe > 0 and runningAtWipe > 0 | [[redis-loss-jobs-rebuilt]], [[job-claimed-once-per-attempt]] |
| R6 | two peers edit the same node concurrently | op validated against a moved document | [[peers-converge]], [[document-always-a-tree]] |
| R7 | a worker paused past `staleMs` wakes up | a write under a stale attempt | [[superseded-attempt-writes-nothing]] |

## Assertion (Z.2b)

`finally_windows_reached`: one `Reachable`/`Sometimes` per row, from the driver's ledger and the SUT-side guards.
The chaos scripts already refuse "vacuous" runs for R1 and R5 (`no-loss.ts:49-50`, `rebuild.ts:15-16`).

R7 has no chaos script today (only `apps/worker/src/crash.int.test.ts:81`).
