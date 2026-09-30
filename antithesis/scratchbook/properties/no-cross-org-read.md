---
id: no-cross-org-read
a0: 6
observable: nobody ever sees a document, member, job, usage or audit row of an org they do not belong to, unless that one document was shared with them
type: unreachable
priority: P0
site: harness:anytime_stranger_probe
guard: Sometimes("a stranger asked for another org's document and was answered 404")
guard_site: apps/api/src/rbac.int.test.ts:33
evidence: apps/api/src/rbac.int.test.ts, packages/db/src/scope.typecheck.test.ts, apps/api/src/idempotency.int.test.ts:103, e2e/share-and-revoke.spec.ts
---

# no-cross-org-read

**A0 invariant 6: no cross-org read.**

## Property

Every API response and every sync `welcome`/`op` a user receives carries data of an org they are a member of, or of
the one document shared with them (at the share's role). Revoked, the share gives nothing at once. The same holds
when a request races a role change or a revoke.

## Assertion (Z.2b)

- Harness: `anytime_stranger_probe`, a driver user in a second org asks for the first org's documents, jobs,
  usage, audit, members and opens its rooms: `Unreachable("a stranger got a 2xx or a welcome")`. Runs while the
  faults run, so a failover or a Redis wipe cannot open a door.
- SUT: the one door is `db.forOrg(orgId)` (packages/db/src/index.ts:843); there is no unscoped query on the public
  type (`scope.typecheck.test.ts` proves it at compile time). Its runtime anchor would be in the api's document
  routes; the harness probe is the observable one.

## Vacuity guard

`Sometimes` that a probe actually reached a real document id of the other org and was refused. A probe with a
made-up id proves nothing. Today the same check is `rbac.int.test.ts:33` (every route, every role, 404 for a
stranger).

## Evidence today

`rbac.int.test.ts` (routes x roles, share and revoke at :151), `idempotency.int.test.ts:103` (another tenant's key
never reads this job), `e2e/share-and-revoke.spec.ts`.
