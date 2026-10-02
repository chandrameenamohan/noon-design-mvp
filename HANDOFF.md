# HANDOFF: Noon-like MVP

Updated 2026-10-03 ~01:20. **`main` = `6266431`** after a green gate on that commit; `build/epics` = that + this
handoff commit. Whether they are pushed: `git status -sb` / `git log origin/main -1` (push only on the owner's say-so).
**Read this first, then run `bd prime`.** Facts and owner decisions only; where a file or a bead is the
source of truth, this points at it.

## 0. First five minutes of the next session

1. `git branch --show-current` must say `build/epics`. `git status --short` should be clean apart from
   `.beads/interactions.jsonl`, `PROMPT_23_SEP.md` and a one-line `.gitignore` change (`.gstack/`, not ours).
2. `cat .claude/settings.local.json` must allow `Bash(git commit --no-verify:*)` (`build/epics` only).
3. `uptime`. Before any Docker suite, follow §5.
4. Recreate the builder rules from §7 in the new session's scratchpad (the old scratchpad is gone).
5. `scripts/demo.sh status` (§8). If the owner wants the demo and a piece is down, the OWNER runs
   `scripts/demo.sh up` from their own terminal.
6. `docker` is not on PATH in Claude's shell (`/usr/local/bin/docker` is a dangling OrbStack link). Prefix:
   `export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"`. `scripts/demo.sh` finds it itself.

## 1. Who and what

Owner (chandrameenamohan@gmail.com): Java/Python backend engineer preparing for Noon's "Fullstack
Backend Architect" role, learning TypeScript from zero, wants principal-engineer depth.
Project: multiplayer design canvas where a user, an AI agent, git and a sandbox preview all edit or
render one document. Claude writes ALL code; each epic ships a handbook lesson and drills that start RED.

## 2. Locked decisions

- Process: owner's `software_development_workflow_v6.md`, FULL tier, W3 BUILD.
- **Orchestration:** the main session only orchestrates (spawn, record in bd, publish). Run in parallel
  whatever can; the Workflow tool is allowed. Docker suites: one at a time, always.
- **Models:** `opus` and `sonnet` execute (builders, bug fixes, routine runs). `fable` only judges and
  verifies. **Owner 2026-10-01: use fable frugally** (`bd memories owner-fable-frugal`): one fable verifier
  and one fable reviewer per R bead with tight prompts, no fable refuter per finding (opus refutes and
  re-checks fixes), fable only for a disputed must-fix. If fable's limit is low, use `opus`.
- **`main` takes only gated code.** The gate is `make clean-clone` fully green on the exact commit,
  then a fast-forward (`git fetch . build/epics:main`). `--no-verify` is for commits on `build/epics` only.
  Never weaken a check. A gate failure is diagnosed before any re-run.
- Node 24, TS ~6.0, native type stripping (no enums/param properties), own sync (not Yjs), Claude
  Agent SDK with `CLAUDE_CODE_OAUTH_TOKEN` (never `ANTHROPIC_API_KEY`).
- Ponytail mode: laziest working thing, `ponytail:` comments with ceiling + upgrade path; never
  simplify away validation at trust boundaries, data-loss prevention, security, accessibility.
- Web browsing: gstack `/browse` only. Secrets: `.env` git-ignored, never print it or `~/.config/noon/*`.
- Tracking: `bd` only (never TodoWrite, never `bd edit`). Memories: `bd remember`.
- **The owner never wants a process killed by Claude.** List heavy processes; the owner stops them.
- **Every push needs the owner's say-so.**
- **Public demo: ngrok is permanent** (owner 2026-10-02). The Cloudflare tunnel, DNS and Access app stay idle.

## 3. What is done

| Item | State |
|---|---|
| E0–E10 | Built, verified, closed |
| Z (`noon-cs6`): Z.1, Z.2a, Z.2b, Z.3 | **Closed.** Z.3 report: `deploy/antithesis/reports/2026-10-01-z3-scenarios.md` (12 scenario forms 3/3, baseline 23/23 + 21/21 guards, chaos 20 20/20) |
| Fixes from Z.3 and its gate | `e432e27` refused upgrade + reset killed sync (`noon-cs6.3.1`); `8f2dfcc` silent client held a refused socket (`noon-cs6.3.4`); `8c427e4` MinIO call timeouts (`noon-mo3.3.1`); `46ab89a` api 413 cut the next keep-alive request (`noon-9vy`, found by gate run 1) |
| Second merge | `main` = `46ab89a` after `make clean-clone` green on it (unit 1188, integration 385, e2e 44/44, canvas p95 96 ms); `main` and `build/epics` pushed 2026-10-02 |
| E11 (`noon-3g7`) | **Closed.** `scripts/demo.sh up|down|status` (`e844ed1`); owner verified live canvas + preview in a real browser |
| Fifth merge (P3 sweep) | `main` = `6266431` after `make clean-clone` green on it (unit 1241, integration 402, e2e 47, canvas p95 83 ms). 7 opus builders in worktrees cleared every open P3 bug plus `cs6.3.2` (loading frames, bounded opens, 3 warm Postgres connections: harness store-slow 4000 opens 3/3) and `cs6.3.3` (requeueGate: harness 3/3 attempt 1); two fable reviewers + opus checks; docs pass rebuilt all lessons (republished 1–10). Gates 7–11 each found a first-run test/harness problem or a race, all fixed (see `bd show` comments). |
| Fourth merge | `main` = `6700e74` after `make clean-clone` green on it (unit 1200, integration 387, e2e 44, canvas p95 108 ms). The four pre-launch bugs plus two found on the way: `23d0fbf` read-only Gitea token for worker-sandbox/worker-git (`noon-wv8.6.3`); `a6a73a5` sign-in cap per (email, address) + per-email brake (`noon-elo.7.1`); `6700e74` IPv6 rate keys by /64 (review should-fix); `49c8a04` AI run needs an editor, ends on forbidden (`noon-dtf.2.4`); `b567ae9` same for Ship (`noon-87s`); `45488c8` ship and preview reports fenced by attempt (`noon-wv8.6.2`). One fable reviewer for all: PASS |
| Third merge | `main` = `b25965e` after `make clean-clone` green on it (unit 1188, integration 385, e2e 44, canvas p95 80 ms), run while another project held port 3100. Gate fixes on the way: `7c968f7` e2e api port from `E2E_API_PORT` (clean-clone uses 53100; `noon-njq`), `b25965e` preview restart test race (`noon-3ye`) |

Per-bead detail is in `bd show <id>` comments.

## 4. What is left

- **Open beads (2):** `noon-frc` (a demoted owner's open page keeps Share until it reconnects; owner to decide),
  `noon-lv9` (queue start retry: tsc-visible BullMQ private read; bound the boot wait when Redis is away).
- **All older P3 bugs are fixed and merged** (P3 sweep, §3).
- **Live demo stack needs `./init.sh` before worker-sandbox or worker-git are next recreated:** since
  `23d0fbf` they read a separate `GITEA_READ_TOKEN`, which the demo's `.env` does not have yet; without it
  previews and the git peer cannot clone. `init.sh` is idempotent and mints it.
- **Waiting on the owner:**
  - (done 2026-10-02) lessons 1–10 republished; `.claude/settings.local.json` allows `Artifact` (owner-approved).
  - Public repo refresh and README: offered, not asked for (§9).
  - Rotate the ngrok basic-auth password: it was printed in three agent transcripts on 2026-10-02.
    New value in `~/.config/noon/ngrok-pass` AND `~/.config/noon/ngrok-policy.yml`, then `demo.sh down; up`.
- No handbook lesson for E11 (a hosting script); owner may ask for one.

## 5. Quiet machine protocol (owner rule)

Before any Docker suite: `ps -Ao pid,pcpu,comm -r | head -20`, identify each heavy process, and **give
the owner a table (name, PID, CPU, what it is) plus the commands to stop them; the owner runs them.**
Keep Docker's `com.apple.Virtualization.VirtualMachine`, this session's `claude`, the demo's Vite/ngrok.
Known offenders: `omnigent` (60 processes; quit the app, `pkill -f omnigent`), `opencode serve`,
hakimo-gastown (`tmux -L hakimo-gastown kill-server`; its `bd send-metrics`, and a `mysqld` that
something keeps relaunching: `pkill -f mysqld_safe; pkill -x mysqld`), Slack, Asana, Dia, Zoom, other
projects' containers. Watch swap as well as load (`sysctl vm.swapusage`).

- **Never run e2e or `make check` in the main checkout while the demo is up:** `e2e/setup.ts` stops the
  compose workers. Use `make clean-clone` (own compose project `noon-clean`, own ports).
- `make chaos` cannot run on the dev stack while its api hands out the ngrok `wsUrl`; it runs in the clone.
- The antithesis harness is its own compose project `noon-antithesis`; it never touches the demo.
- Duration-asserting specs run in the Playwright project `timed`, alone, after the others.

## 6. Running agents (what worked)

- One builder per bead, background, `name: b-<bead>`, prompt = "read `<scratchpad>/builder-rules.md`,
  then `bd show <id>` incl. comments, …" plus the bead's risks. Reports under 150–200 words.
- After each report: `bd comments add <id> "Built on build/epics <hash> by <agent> (<model>) …"`.
  Agents send their report twice (message + idle notification): record once.
- **Parallel builders: use `isolation: "worktree"`** (shared-tree commits of one file mix builders' edits).
  Worktrees live under `.claude/worktrees/`; remove them after cherry-picking, or `eslint .` runs out of
  memory walking them. A worktree agent cannot be resumed once its worktree is gone.
- Tests a builder writes without Docker fail on their first gate: budget gate rounds for them.
- Follow-up work for a finished agent: `SendMessage` to its name keeps its context (used for review fixes
  and gate re-runs on 2026-10-02).
- Gate runner: a sonnet agent runs `make clean-clone` once and reports; it never re-runs on failure.
- **Check a running agent's log yourself every ~30 min.** On 2026-10-02 a builder missed its own gate's
  EXIT for two hours ("waiting on gate events"); its log had finished long before.
- **zsh gotchas:** `for b in $V` does not split words; pass all ids to one `bd close id1 id2 …`. A line
  starting `echo =====X` is `=`-expansion: quote it.
- Only one agent may use Docker at a time; say so in every prompt, and name the dev stack as off limits.
- Agents stall "waiting for a monitor": tell each to wait for the completion notification or poll its log.

## 7. Builder rules (recreate as `<scratchpad>/builder-rules.md`)

- Repo, branch `build/epics` (never switch, never touch `main`). You are the only agent on your bead;
  don't spawn sub-agents. Read `bd show`, related `bd memories`, HANDOFF §2, SPEC sections.
- Implement fully, test-first, no stubs; ponytail rules; match surrounding code; Node 24 TS rules.
- Run `make lint typecheck unit` plus your new unit tests, `pnpm exec jscpd .` and `knip`. Run a Docker
  suite only when the prompt says Docker is yours, and only through `make clean-clone` or the
  harness's own compose project. Never `make check` or e2e in the main checkout.
- `docker` is not on PATH: prefix `export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"`.
- Run anything over a few minutes in the background to a log and wait for its completion notification
  (poll the log if none will come). Never go idle while a run is in progress or after an undiagnosed failure.
- Commit only your paths: `git commit --no-verify -F <msgfile> -- <paths>`. Message: "<bead key> <what
  the user can now do>", body = WHY, trailer `Co-Authored-By: Claude <model> <noreply@anthropic.com>`.
- Never touch `HANDOFF.md`, `PROMPT_23_SEP.md`, `.beads/*`, `.claude/*`, `.env`, `~/.config/noon/*`
  contents in output. No `bd close/update/remember/create`. Missing input: report "NEEDS INPUT".
- Never kill a process you did not start. Never pull the MinIO image (local only, §8).
- Live demo: never touch ports 5173/5199/4040, the `noon-design-mvp` compose project, ngrok, or
  `scripts/demo.sh up/down`.

## 8. Public demo (ngrok)

- Host in `~/.config/noon/ngrok-host`; basic auth user `noon`, password `~/.config/noon/ngrok-pass`;
  policy `~/.config/noon/ngrok-policy.yml` (basic auth on everything except `/preview/`). Never commit any.
- **`scripts/demo.sh up|down|status`** (README "Public demo"). `up` starts only missing pieces: the api
  with public addresses, public Vite 5173 (`PUBLIC_HOST`), local Vite 5199, ngrok. Detached; pid files and
  logs in `~/.local/state/noon-demo`. `down` stops only what `up` started and leaves the api's public
  addresses. The owner runs `up` from their own terminal so nothing is a child of a Claude session.
- State 2026-10-02: ngrok pid 71102 (started by `demo.sh`); the two Vites (87710, 73430) are older
  hand-started ones, reparented to launchd, so `down` will not stop them.
- gstack `/browse` cannot send basic auth on WebSocket upgrades: a headless smoke test stops at sign-up;
  the canvas needs a real browser (owner verified 2026-10-02).
- A new account gets an organisation and a document automatically. The PR link is `http://localhost:3002/...`,
  so it opens only on this machine. The preview iframe works through the public URL.
- **MinIO image:** no registry serves `quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z` any more. It
  exists as a local image and as `~/.config/noon/minio-RELEASE.2025-09-07T16-13-09Z.tar`; `init.sh`
  loads the tarball when the image is missing.

## 9. GitHub

- **Private:** https://github.com/chandrameenamohan/noon-design-mvp = remote `origin`, full history.
- **Public:** https://github.com/chandrameenamohan/noon-design-mvp-public = ONE commit, a snapshot of
  `1eb02c0` WITHOUT this file (it holds the owner's email, job-preparation line, employer and demo URL).
- To refresh the public repo: `git archive <branch>` into a scratch dir, delete `HANDOFF.md`, grep for
  personal details, commit with the GitHub no-reply email, push. Never push history or this file there.
- **Every push needs the owner's say-so.** The `bd` issue data is not on GitHub.

## 10. Where things are written down

`SPEC.md`, `BEADS.md` + `.beads/key-map.json`, `bd memories` (`owner-model-policy`, `owner-fable-frugal`,
`merge-2026-10-02`, `public-demo-state`, `github-remote`, `handbook-republish-pending`, `zsh-loop-gotcha`),
`bd show <id>` comments, `VERIFICATION.md`, `Makefile`, `docs/handbook/`, `deploy/antithesis/README.md`
and `reports/`, `antithesis/scratchbook/`, `README.md`. Antithesis explainer for other projects:
`/Users/cm/100x/personal/noon-antithesis-writeup.md`. Showcase explainer:
https://claude.ai/artifact/AZ1Y6vJYUfqD4w6u2YaUZt
