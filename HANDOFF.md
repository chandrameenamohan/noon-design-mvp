# HANDOFF: Noon-like MVP

Updated 2026-10-01 ~20:20. **`main` = `4d485c8`**, pushed to the private GitHub repo; `build/epics` is that plus this handoff commit (not pushed).
**Read this first, then run `bd prime`.** Facts and owner decisions only; where a file or a bead is the
source of truth, this points at it.

## 0. First five minutes of the next session

1. `git branch --show-current` must say `build/epics`. `git status --short`: about 19 files are modified
   or untracked ON PURPOSE (Z.3's unfinished work, §4.1). Do not revert, stash or commit them blindly.
2. `cat .claude/settings.local.json` must allow `Bash(git commit --no-verify:*)` (`build/epics` only).
3. `uptime`. Before any Docker suite, follow §5.
4. Recreate the builder rules from §7 in the new session's scratchpad (the old scratchpad is gone).
5. Check the demo is up (§8): `curl -s localhost:5173/api/ready`. If the owner wants it and it is down,
   restart per §8.

## 1. Who and what

Owner (chandrameenamohan@gmail.com): Java/Python backend engineer preparing for Noon's "Fullstack
Backend Architect" role, learning TypeScript from zero, wants principal-engineer depth.
Project: multiplayer design canvas where a user, an AI agent, git and a sandbox preview all edit or
render one document. Claude writes ALL code; each epic ships a handbook lesson and drills that start RED.
The owner showcased the running app to a Noon engineer on 2026-10-01.

## 2. Locked decisions

- Process: owner's `software_development_workflow_v6.md`, FULL tier, W3 BUILD.
- **Orchestration (owner, 2026-09-30):** the main session only orchestrates (spawn, record in bd,
  publish). Run in parallel whatever can run in parallel; **the Workflow tool is allowed** (this
  replaced the older "never use Workflow"). Docker suites: one at a time, always.
- **Models:** `opus` and `sonnet` execute (builders, bug fixes, routine runs). `fable` only judges and
  verifies (review panels, per-bead verifiers). If fable's limit is low, use `opus` for those too.
- **`main` takes only gated code.** The gate is `make clean-clone` fully green on the exact commit,
  then a fast-forward. `--no-verify` is for commits on `build/epics` only. Never weaken a check.
- Node 24, TS ~6.0, native type stripping (no enums/param properties), own sync (not Yjs), Claude
  Agent SDK with `CLAUDE_CODE_OAUTH_TOKEN` (never `ANTHROPIC_API_KEY`).
- Ponytail mode: laziest working thing, `ponytail:` comments with ceiling + upgrade path; never
  simplify away validation at trust boundaries, data-loss prevention, security, accessibility.
- Web browsing: gstack `/browse` only. Secrets: `.env` git-ignored, never print it.
- Tracking: `bd` only (never TodoWrite, never `bd edit`). Memories: `bd remember`.
- **Order:** Z.3 → its review panel → second merge to `main` → E11.
- **The owner never wants a process killed by Claude.** List heavy processes; the owner stops them.

## 3. What is done

| Item | State |
|---|---|
| E4–E10 (all task beads and epics) | Built, suites green, a fresh verifier per bead, review panels for R beads. **Closed.** |
| Original bugs `noon-3m1`, `noon-ibo`, `noon-91u`, `noon-37s`, `noon-6zq`, `noon-l5f` | Fixed and closed |
| Z.1 `noon-cs6.1` | `make scenario` green on a clean clone (SPEC §8 on two sync nodes). Closed. |
| Z.2a `noon-cs6.2` | 22-property catalog under `antithesis/scratchbook/`, `make catalog-check`. Closed. |
| Z.2b `noon-cs6.4` | `deploy/antithesis/` harness, baseline 22/22 properties, 20/20 guards. Closed. |
| Merge | `main` fast-forwarded to `4d485c8` on 2026-10-01 20:13 after a green gate on that commit: unit 1183, integration 384, e2e 44/44, canvas p95 86 ms. |
| Handbook | All 10 lesson pages rebuilt at HEAD and committed with PDFs |

Per-bead detail (design, fixes, VERIFY notes, panel findings, verifier verdicts) is in `bd show <id>`.

## 4. What is left (in order)

### 4.1 Z.3 `noon-cs6.3` — ON HOLD, unfinished, uncommitted

Its builder was put on hold at 15:40 for the showcase and the merge. Its agent does not survive the
session, so **spawn a new opus builder** and give it `bd show noon-cs6.3` (the ON HOLD comment has the
full state) plus this list:

- **Uncommitted in the working tree, keep it:** `deploy/antithesis/{run.sh,driver/*,test/v1/noon/*}`,
  `antithesis/scratchbook/{property-catalog.md,property-relationships.md,properties/dropped-webhook-push-reaches-canvas.md}`,
  the `Dockerfile` comment, and `apps/sync/src/snapshots.ts` + its test.
- **Pass 1, one run each:** baseline 22/22; the seven named scenarios PASS; the new `webhook-dropped`
  scenario PASS (reconcile brought the push in 28 s); `worker-store-unavailable` PASS.
- **Failures were harness bugs:** 3 of 4 MinIO runs failed on the builder's own scene (it expects edits
  submitted before the welcome to be held; they are refused locally). `store-slow 2000` did not finish
  (editors not live in 20 s): undiagnosed.
- **`snapshots.ts` adds a timeout on every MinIO call (`noon-mo3.3.1`).** No scenario has shown it is
  needed. Decide: keep it with its unit test, or drop it.
- **Left:** fix the MinIO scene; verifier nits `noon-cs6.4.1` and `.2` in `run.sh` (`.3` is done);
  repeat each scenario; `run.sh chaos 20`; the report under `deploy/antithesis/reports/`; lint,
  typecheck, unit, knip, jscpd (the tree currently has one lint and one knip finding in these edits);
  commit with key `noon-cs6.3`.
- Then: a fable verifier and a fable review panel (it is an R bead), close `noon-cs6.3` and `noon-cs6`.
- **Agents stall:** three builders today went idle "waiting for a monitor" for 1–3 hours. Tell each to
  wait for the completion notification and never go idle mid-run, and check on any agent that has been
  silent for 30 minutes.

### 4.2 Second merge

After Z.3 is committed: `make clean-clone` on the new HEAD, fast-forward `main`
(`git fetch . build/epics:main`), push **only when the owner asks** (§9).

### 4.3 E11 `noon-3g7`

The public demo already serves the current build through ngrok (§8). What remains is the planned move
to the Cloudflare tunnel (`noon.sennamind.com`, tunnel and Access app exist, idle) and a restart recipe
that does not depend on a Claude session.

### 4.4 Waiting on the owner

- **Seven lesson pages not republished:** lessons 2, 3, 4, 7, 8, 9, 10. Lessons 1, 5, 6 are done. The
  auto-mode classifier denied the rest, in subagents and in the main session. It needs a permission
  rule allowing the Artifact tool; do not retry without one. URLs are in `docs/handbook/index.md`.
- **Public repo refresh and README:** offered, not yet asked for (§9).
- **63 open P3 bugs** from panels and verifiers (`bd list --status=open`). The four to fix before any
  real launch: `noon-wv8.6.3` (Gitea write token in the sandbox worker), `noon-elo.7.1` (per-email
  sign-in lockout), `noon-dtf.2.4` (a demoted creator's AI run still spends), `noon-wv8.6.2` (ship
  report not fenced by attempt).

## 5. Quiet machine protocol (owner rule)

Before any Docker suite: `ps -Ao pid,pcpu,comm -r | head -20`, identify each heavy process, and **give
the owner a table (name, PID, CPU, what it is); the owner stops them.** Keep Docker's
`com.apple.Virtualization.VirtualMachine` and `claude`. Known offenders: `opencode serve`, `omnigent`
python (25 processes), `hakimo-gastown` (`bd send-metrics`, its `dolt`, a `mysqld` that restarts),
Zoom with screen share, other projects' containers.

What today taught:
- The gate itself drives the load to 28–40. A Zoom call or `opencode` on top makes timing specs fail.
- At load ~150 with 15 GB of swap nothing can be trusted; wait for the load to fall under ~6.
- **Never run e2e or `make check` in the main checkout while the demo is up:** `e2e/setup.ts` stops the
  compose workers. Use `make clean-clone` (own compose project `noon-clean`, own ports).
- `make chaos` cannot run on the dev stack while its api hands out the ngrok `wsUrl`; it runs in the clone.
- The two duration-asserting specs (`canvas.spec` p95, `progress.spec` first step) now run in a
  Playwright project `timed`, alone, after the others. If one fails again, read the per-edit split it
  prints before blaming load.

## 6. Running agents (what worked)

- One builder per bead, background, `name: b-<bead>`, prompt = "read `<scratchpad>/builder-rules.md`,
  then `bd show <id>` incl. comments, …" plus the bead's risks. Reports under 150–200 words.
- After each report: `bd comments add <id> "Built on build/epics <hash> by <agent> (<model>) …"`.
  Agents send their report twice (message + idle notification): record once.
- Verifiers and panels: the Workflow script pattern used today (one fable agent per bead, schema-typed
  verdict, a refuter per must-fix) handled 51 beads in about 20 minutes.
- **zsh gotcha:** `for b in $V` does not split words in zsh. Pass all ids to one `bd close id1 id2 …`.
  `bd close` refuses a bead whose dependencies are open: use `--force` when those are verified too.
- Only one agent may use Docker at a time; say so in every prompt, and name the dev stack as off limits.

## 7. Builder rules (recreate as `<scratchpad>/builder-rules.md`)

- Repo, branch `build/epics` (never switch, never touch `main`). You are the only agent on your bead;
  don't spawn sub-agents. Read `bd show`, related `bd memories`, HANDOFF §2, SPEC sections.
- Implement fully, test-first, no stubs; ponytail rules; match surrounding code; Node 24 TS rules.
- Run `make lint typecheck unit` plus your new unit tests, `pnpm exec jscpd .` and `knip`. Run a Docker
  suite only when the prompt says Docker is yours, and only through `make clean-clone` or the
  harness's own compose project. Never `make check` or e2e in the main checkout.
- Run anything over a few minutes in the background to a log and wait for its completion notification.
  Never go idle while a run is in progress or after a failure you have not diagnosed.
- Commit only your paths: `git commit --no-verify -F <msgfile> -- <paths>`. Message: "<bead key> <what
  the user can now do>", body = WHY, trailer `Co-Authored-By: Claude <model> <noreply@anthropic.com>`.
- Never touch `HANDOFF.md`, `PROMPT_23_SEP.md`, `.beads/*`, `.claude/*`, `.env`. No `bd
  close/update/remember/create`. Missing input: report "NEEDS INPUT".
- Never kill a process you did not start. Never pull the MinIO image (local only, §8).
- Live demo: never touch ports 5173/5199, the `noon-design-mvp` compose project, or ngrok.

## 8. Public demo (ngrok) — serving the CURRENT build

- URL https://unpuffed-overtamely-zoey.ngrok-free.dev, basic auth user `noon`, password in
  `~/.config/noon/ngrok-pass` (never commit it). Local: http://localhost:5199.
- Smoke-tested end to end on 2026-10-01 through the public URL: sign-up, document, sync, a real AI run
  (17 s, token valid), preview, Ship (PR in Gitea), usage. A new account must create an organisation
  first. The PR link is `http://localhost:3002/...`, so it opens only on this machine.
- **Pieces and how to restart them:**
  - ngrok (pid 42176 at handoff): `ngrok http 5173 --traffic-policy-file ~/.config/noon/ngrok-policy.yml`
  - public web: `cd apps/web && PUBLIC_HOST=unpuffed-overtamely-zoey.ngrok-free.dev pnpm exec vite --port 5173 --strictPort`
  - local web: `cd apps/web && pnpm exec vite --port 5199 --strictPort`
  - api with public addresses: `H=unpuffed-overtamely-zoey.ngrok-free.dev; SYNC_PUBLIC_URL="sync=wss://$H/sync,sync-2=wss://$H/sync-2" PREVIEW_PUBLIC_URL="https://$H" docker compose up -d --no-build --wait api`
  - The two Vite servers were started from the previous Claude session and may die with it.
- The old frozen worktree `../noon-demo` is no longer served; the owner approved stopping it.
- **MinIO image:** no registry serves `quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z` any more. It
  exists as a local image and as `~/.config/noon/minio-RELEASE.2025-09-07T16-13-09Z.tar`; `init.sh`
  loads the tarball when the image is missing. A machine without the tarball cannot run `./init.sh`.

## 9. GitHub

- **Private:** https://github.com/chandrameenamohan/noon-design-mvp = remote `origin`, full history,
  `main` and `build/epics` at `4d485c8`.
- **Public:** https://github.com/chandrameenamohan/noon-design-mvp-public = ONE commit, a snapshot of
  `1eb02c0` WITHOUT this file. The owner chose this over making the private repo public, because this
  file holds their email, the job-preparation line, their employer's name and the demo URL.
- To refresh the public repo: `git archive <branch>` into a scratch dir, delete `HANDOFF.md`, grep for
  personal details, commit with the GitHub no-reply email, push. Never push history or this file there.
- **Every push needs the owner's say-so.** The `bd` issue data is not on GitHub.

## 10. Where things are written down

`SPEC.md` (spec), `BEADS.md` + `.beads/key-map.json` (bead graph), `bd memories` (owner rules and
lessons: `owner-model-policy`, `verification-pass-2026-10-01`, `merge-2026-10-01`, `public-demo-state`,
`github-remote`, `handbook-republish-pending`, `zsh-loop-gotcha`), `bd show <id>` comments (per-bead
build notes, panel findings, verifier verdicts), `VERIFICATION.md`, `Makefile` (`check`, `chaos`,
`drills`, `scenario`, `clean-clone`, `catalog-check`, `harness-*`), `docs/handbook/` (lessons,
builders, PDFs), `deploy/antithesis/README.md` (the harness), `antithesis/scratchbook/` (properties).
An explainer for showcasing, "Noon Design to Code": https://claude.ai/artifact/AZ1Y6vJYUfqD4w6u2YaUZt
