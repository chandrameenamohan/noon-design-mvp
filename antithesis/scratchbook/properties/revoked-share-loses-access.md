---
id: revoked-share-loses-access
observable: once an owner revokes an outside user's share, that user's open page closes, sees no further edits and cannot come back
type: eventually
priority: P1
site: harness:eventually_revoked_share_closed
guard: Sometimes("a share was revoked while its holder had the document open")
guard_site: e2e/share-and-revoke.spec.ts:26
evidence: e2e/share-and-revoke.spec.ts:26, apps/api/src/rbac.int.test.ts:151
---

# revoked-share-loses-access

F25, SPEC §8 step 10.

## Property

After a revoke, within a bound (the session token lives 60 s; the announcement closes live sessions at once), the
outsider's session is closed, every REST read of the document is 404 and a reconnect is refused (401). Holds when
the revoke announcement is lost (a sync node that missed it re-reads roles, `apps/sync/src/server.ts:78`).

## Assertion (Z.2b)

`eventually_revoked_share_closed`: the driver's outside peer is closed and probes return 404/401 within the bound.
Pairs with [[no-cross-org-read]], whose stranger probe covers "cannot come back" continuously.

## Vacuity guard

`Sometimes` that the revoke happened while the outsider was connected (a revoke of an idle share proves only the
REST half).

## Evidence today

`e2e/share-and-revoke.spec.ts:26`, `rbac.int.test.ts:151`.
