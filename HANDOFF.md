# HANDOFF: Noon-like MVP

Updated 2026-09-30 ~22:30, branch **`build/epics`** (HEAD `07189cc` + Lesson 10 if it landed).
**Read this first, then run `bd prime`.** Facts and owner decisions only; where a file is the
source of truth, this points at it.

## 0. First five minutes of the next session

1. `git branch --show-current` must say `build/epics`. `git log --oneline -3`. Check whether
   **Lesson 10 (`noon-2h1.9`)** landed (a commit starting `noon-2h1.9`). If not, re-run it (§6).
2. `cat .claude/settings.local.json` must allow `Bash(git commit --no-verify:*)` (owner-created;
   `--no-verify` is allowed on `build/epics` ONLY, never on `main`).
3. `uptime`. Before any Docker suite, follow §5 (list heavy processes for the owner to stop).
4. Recreate the builder rules file from §7 in the new session's scratchpad.

## 1. Who and what

Owner (chandrameenamohan@gmail.com): Java/Python backend engineer preparing for Noon's "Fullstack
Backend Architect" role, learning TypeScript from zero, wants principal-engineer depth.
Project: multiplayer design canvas where a user, an AI agent, git and a sandbox preview all edit or
render one document. Claude writes ALL code; each epic ships a handbook lesson (artifact + PDF) and
drills that start RED. Owner reads lessons at their own pace: **do not pause for them.**

## 2. Locked decisions

- Process: owner's `software_development_workflow_v6.md`, FULL tier, W3 BUILD. **Never use the
  Workflow tool.** Orchestrate with Agent-tool subagents.
- **Owner 2026-09-29/30:** main session only orchestrates (spawn, record bd, publish); **one
  separate subagent per bead**, one at a time (serial). Builders: `opus`; **E10 and lessons: `fable`**;
  routine verification: `sonnet`; review panels / hard refutation: `fable`. Tell every agent "YOU
  are the only one on this bead; do not spawn sub-agents".
- **Verification is parked:** every bead since E4.3 was built with lint + typecheck + unit + its own
  unit tests only, committed with `--no-verify` on `build/epics`. Integration, e2e and chaos tests
  are WRITTEN BUT NEVER RUN. Beads stay OPEN until verified (each has a "Built on build/epics
  <hash> ... Verify parked" comment). Merge `build/epics` into `main` only after verification.
- Node 24, TS ~6.0, native type stripping (no enums/param properties), own sync (not Yjs), Claude
  Agent SDK with `CLAUDE_CODE_OAUTH_TOKEN` (never `ANTHROPIC_API_KEY`).
- Ponytail mode: laziest working thing, `ponytail:` comments with ceiling + upgrade path; never
  simplify away validation at trust boundaries, data-loss prevention, security, accessibility.
- Web browsing: gstack `/browse` only. Secrets: `.env` git-ignored, never print it.
- Tracking: `bd` only (never TodoWrite, never `bd edit`). Memories: `bd remember`.
- **SPEC §5 changed 2026-09-30** (commit `ccfea2c`): E10 polished Figma-feel editor in scope
  (no freeform/freehand drawing); E11 laptop hosting via tunnel in scope; x-dev-user stays,
  development only.
- **Order (owner):** E9 → E10 → parked verification + Z → E11.

## 3. What is built on `build/epics` (verify parked)

| Epic | Beads | Lesson |
|---|---|---|
| E4 | 4.3 `f992425`, 4.H `1ed5e4d` | https://claude.ai/artifact/TuhCaR764R39h3siAMvbXD |
| E5 (+ `noon-l96` public preview `d708bd8`/`560ee27`, `noon-9gz` sandbox isolation `5c741fc`) | 5.1 `3a516fb`, 5.2 `8e97ae9`, 5.3a `90a51cc`, 5.3b `b6eb0dc`, 5.4 `cb2b399`, 5.5 `48ac4f6`, 5.H `cbdb35b` | https://claude.ai/artifact/1XtuLMnTdVKjQyAhH5RxgH |
| E6 | 6.1a `eb42cec`, 6.1b `bb7e8a9`, 6.2 `06302b8`, 6.3 `e72665c`, 6.H `0dfe1b2` | https://claude.ai/artifact/EK2C6s3ak4VfzqSnCsmAT8 |
| E7 | 7.1 `3048ff8`, 7.2 `b89cfd9`, 7.3 `b702dcd`, 7.H `d53f8f4` | https://claude.ai/artifact/VjAqznb7ssT5JZKRHax4wh |
| E8 | 8.1 `9615ec7`, 8.2 `220eb88`, 8.3 `90819fc`, 8.4 `ad00176`, 8.H `a99c7d3` | https://claude.ai/artifact/LHfrnyrc7yfzAYqjYCmPL1 |
| E9 | 9.1 `4c52308`, 9.2a `0ff6a0e`, 9.2b `a3beda8`, 9.4 `d88146e`, 9.5 `ee59857`, 9.6 `1c9db7c`, 9.H `e1f0402` | https://claude.ai/artifact/MBmUZdhQLJChGmbH7LpZcH |
| E10 (`noon-2h1.*`, fable) | .1 `13f8b3e`, .2 `fe68673`, .3 `25357cf`, .4 `9c570f6`, .5 `b3046a5`, .6 `6cccf25`, .7 `d4e895f`, .8 `5fad6b9`, cleanup `noon-92o` `07189cc` | .9 Lesson 10: in progress at handoff |

Every bead's `bd show <id>` comments hold: design, tests written-but-unrun, ponytail shortcuts,
and **VERIFY notes** (things the verifier must check). PDFs: `docs/handbook/lesson-N.pdf`.

## 4. What is left (in order)

1. **`noon-2h1.9` Lesson 10** (if not landed; fable). Then close nothing yet (verify parked).
2. **Bugs** (opus, one at a time): `noon-3m1` (props cap UTF-16 vs socket UTF-8 bytes),
   `noon-ibo` (e2e canvas p95), `noon-91u` (git peer resume after kill; push-ops idempotent;
   Ship retry keeps commit record), `noon-37s` (usage not recorded for failed runs; token/cost
   scope). Plus: `docs/handbook/build-lesson-7.py` anchor broken by E8.2 (see `bd show noon-98h.4`);
   Pyright "group of None" warning in build-lesson-5..9.py (harmless).
3. **Parked verification pass** (quiet machine, §5): per epic E4→E10 in order: `./init.sh` rerun
   first (adds MINIO_PASSWORD, GITEA_*, webhook secret to `.env`; builds MinIO/Gitea/toxiproxy/
   worker-git/worker-ship/sync-2), then `make check` + `make chaos` + `make drills`, fix failures
   test-first (expect real bugs: none of these suites ever ran), regenerate screenshot baselines
   listed in bead comments, then a fresh verifier per bead and a **review panel for R beads**
   (5.3a, 5.5, 6.1a, 6.2, 7.1, 7.3, 8.1-8.4, 9.1, 9.2a, 9.5, 9.6, 10.8). Close beads as they pass.
4. **Z** (`noon-cs6.*`): Z.1 SPEC §8 scenario script, Z.2a property catalog, Z.2b local
   Antithesis-style harness (toxiproxy, owner's `~/repos/ai-engine/deploy/antithesis` method),
   Z.3 fault runs → bug beads → fixes. Z.1 now depends on E10.9.
5. Merge `build/epics` → `main` (through the full hook, no `--no-verify`).
6. **E11** (`noon-3g7`): move the public demo to the verified build (§8).

## 5. Quiet machine protocol (owner rule)

Before any Docker suite: `ps -Ao pid,pcpu,comm -r | head -20`, identify each heavy process, and
**give the owner a table of what to stop (name, PID, CPU, what it is); the owner kills them, never
you.** Keep Docker's `com.apple.Virtualization.VirtualMachine` and `claude`. Known offenders on
this machine: `opencode`, `omnigent` python server, `hakimo-gastown` (`gc supervisor run` +
its `dolt sql-server` + `bd send-metrics`), other projects' containers (`vision-system_*`).
Never run two Docker-using suites at once. A 30 s "not ready within" under load is noise: re-run
that one file before changing code.

## 6. Running an agent (pattern that worked)

Spawn in background with `name: b-<bead>`, `run_in_background: true`, prompt = "Builder for bead
<id> (<one line>). First read and follow <scratchpad>/builder-rules.md exactly. Then `bd show
<id>` incl. comments, read commits <hashes> ..." plus bead-specific risks. After each report:
`bd comments add <id> "Built on build/epics <hash> by <agent> (<model>) ... Verify parked."`,
hand-offs as comments on the next bead, bugs via `bd create -t bug`. Lessons: fable, copy the
previous lesson's builder pattern, publish with the Artifact tool, URL into index.md before commit.
Agents send their report twice (message + idle notification): record once.

## 7. Builder rules (recreate as <scratchpad>/builder-rules.md)

- Repo, branch `build/epics` (never switch, never touch `main`). You are the only agent on your
  bead; don't spawn sub-agents. Read `bd show`, related `bd memories`, HANDOFF §2, SPEC sections.
- Implement fully, test-first, no stubs; ponytail rules; match surrounding code; Node 24 TS rules.
  Write the bead's named integration/e2e/chaos tests even though you can't run them.
- RUN only `make lint typecheck unit` + your new unit tests (and `pnpm exec jscpd .`, `knip` clean).
  No `make check`, integration, e2e, chaos. Serial. Known flake: codegen index.test.ts:363 timeout.
- Commit only your paths: `git commit --no-verify -F <msgfile> -- <paths>`. If denied: stage, report
  "COMMIT DENIED". Message: "<bead key> <what the user can now do>", body = WHY, line
  "Gate: lint+typecheck+unit green; integration/e2e/chaos parked (host load), to run on build/epics
  before merging to main.", trailer `Co-Authored-By: Claude <Opus 5.5|Fable 5.1> <noreply@anthropic.com>`.
- Never touch HANDOFF.md, PROMPT_23_SEP.md, .beads/*, .claude/*, .env. No bd close/update/remember.
  Missing input: report "NEEDS INPUT". Report under 150 words.
- Live demo: never touch port 5173 or `../noon-demo`; screenshot with your own Vite (e.g. 5199);
  never apply migrations to the shared dev Postgres (the demo api uses it).

## 8. Public demo (ngrok) — running, keep it alive

- URL https://unpuffed-overtamely-zoey.ngrok-free.dev, basic auth user `noon`, password in
  `~/.config/noon/ngrok-pass` (never commit it). `/preview/` is exempt from basic auth (opaque-origin
  frame modules carry no credentials); previews are guarded by the per-container token.
- Pieces: `ngrok http 5173 --traffic-policy-file ~/.config/noon/ngrok-policy.yml`; Vite from the
  **frozen worktree** `../noon-demo` at `560ee27`: `cd ../noon-demo && PUBLIC_HOST=unpuffed-overtamely-zoey.ngrok-free.dev pnpm --filter @noon/web dev`;
  compose api/sync/worker-sandbox containers built ~5c741fc, api run with
  `SYNC_PUBLIC_URL=wss://<host>/sync PREVIEW_PUBLIC_URL=https://<host>`. These background
  processes die with this session: restart ngrok + demo Vite if the owner wants the demo up.
- **Do NOT rebuild the compose stack from `build/epics` until verified**: new sync needs MinIO,
  Gitea, two nodes (`SYNC_PUBLIC_URL=sync=wss://<host>/sync,sync-2=wss://<host>/sync-2`), and the
  web needs the new api. E11 moves demo worktree + containers together to a verified commit.
- The old compose file now needs `MINIO_PASSWORD`; until `./init.sh` reruns, use
  `docker exec noon-design-mvp-postgres-1 ...` instead of `docker compose exec`.
- Cloudflare tunnel `noon` + DNS `noon.sennamind.com` + Access app exist, idle (owner chose ngrok).

## 9. Where things are written down

`SPEC.md` (spec), `BEADS.md` + `.beads/key-map.json` (bead graph, incl. E10), `bd memories`,
`bd show <id>` comments (per-bead build notes + VERIFY notes), `VERIFICATION.md`, `Makefile`
(`make chaos`, `make drills` added this run), `docs/handbook/` (lessons, builders, PDFs).
