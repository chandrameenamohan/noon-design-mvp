# Handbook

One chapter per epic, published as an artifact page. Drills live in `drills/`.

| Lesson | Topic | Page | Drills |
|---|---|---|---|
| 0001 | High-level design: a Noon-like system in eight boxes | https://claude.ai/artifact/J2DVNLFHkKrLPwLyghFBc4 | quiz on the page |
| 0 | TypeScript for a Java and Python engineer (primer, before epic 1) | https://claude.ai/artifact/3qLjxgH6vjT2bUnEa52omY | `drills/lesson-0/` · `sh drills/lesson-0/check.sh` |
| 1 | A typed API over a tenant-safe database (epic 1): contracts, closures, boundaries, SQL, identity, tokens, config, least privilege, and twelve bugs the types could not see | https://claude.ai/artifact/TkBHmpDAedwZNEmFrFWqpV | `drills/lesson-1/` · `sh drills/lesson-1/check.sh` (D1 extend a type, D2 fix a planted bug, D3 explain a decision) |
| 2 | One room, many peers (epic 2): discriminated unions as a wire protocol, one planner and two appliers, the event loop as a lock, the room's eight checks, exactly-once over a lying connection, pure core and thin shell, WebSockets, optimistic reconcile, rate limiting, presence, React with an external store, types as data, testing concurrency, and seventeen bugs the types could not see | https://claude.ai/artifact/WCwLXNrjZJ1qX7knksdipw | `drills/lesson-2/` · `sh drills/lesson-2/check.sh` (D1 extend the protocol, D2 fix a planted bug, D3 explain a decision) |

Printable copies: `docs/handbook/lesson-0.pdf`, `docs/handbook/lesson-1.pdf`, `docs/handbook/lesson-2.pdf` (rebuild with `node docs/handbook/make-pdf.mjs <lesson>`; on paper the quiz answers are revealed and marked).

Pages are generated, so they cannot drift from the code: Lesson 0 from its exercise files (`python3 docs/handbook/build-lesson-0.py`), Lessons 1 and 2 from the repo's real source by anchor text (`python3 docs/handbook/build-lesson-1.py`, `build-lesson-2.py`; a missing anchor fails the build, which is the signal to update the chapter).
