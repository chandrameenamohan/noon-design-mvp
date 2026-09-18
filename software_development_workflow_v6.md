# Workflow — Prompt Pack (v6, orchestrated)

v5 was prompts + the smallest set of best-in-class tools. v6 keeps all of that
and moves the machine work into **dynamic workflows**: a **lead** model plans,
routes and judges; **executor** models build and verify. The human checkpoints
stay prompts, because a workflow runs in the background and cannot stop to ask.

**Three principles:**
1. Align, don't control; keep the problem head-sized. *(unchanged)*
2. **Prompts at the human gates, workflows between them.**
3. **The lead decides, the script enforces, `make check` is the only judge of done.**

## What changed from v5

| v5 | v6 |
|---|---|
| 15 steps, run one prompt at a time | 3 human conversations + 5 workflows |
| One model does everything | **Fable 5 leads**; **Opus 5 / Sonnet 5 execute**, routed per task |
| Challenge, Leap, spec review = single-agent prompts | **v6-frame**: lens panel, leap tournament, adversarially verified spec audit |
| Learning tests, beads, gate = three steps | **v6-prepare**: one agent per dependency, lead-routed bead graph + critics, gate *proven* red layer by layer |
| Steps 5, 6, 7, 8, 9 = build, loop, review, parallelize, provenance | **v6-build**: one loop does all five, with an escalation ladder |
| Stop hook + `PW_LOOP` as the brake | **pre-commit hook** is the primary brake (fires in every worktree); an independent verifier re-runs the gate |
| ralph-loop / bash loop | Kept as fallback only (see v5 §6) |

## The stack

| Layer | Tool |
|---|---|
| Orchestration | Claude Code **Workflow** tool (scripts in `.claude/workflows/`) |
| Lead | **Fable 5**, falls back to **Opus 5** automatically |
| Executors | **Opus 5** (hard / judgment) and **Sonnet 5** (well-specified / volume) |
| Method skills | **Superpowers** (brainstorming, TDD, verification, worktrees, writing-skills) |
| Task graph + memory | **bd / beads** |
| Deterministic gate | `make check`: eslint, tsc, vitest, knip, jscpd, Playwright + axe (v5 §4, unchanged) |
| Cross-vendor review | **Polly** (`omni polly`, `/cross-review`) — optional, code only, out of band (W3.5) |
| Built-ins | `/simplify`, `/code-review`, worktrees |

---

## Roles, routing, fallback

```
You ── human gates: Sharpen · Scope · compression · SPEC · bead graph · merge to main
 │
 ▼
Workflow script   deterministic: loops, fan-out, worktrees, retries, stop rules
 ├─ LEAD        Fable 5  ──(unavailable)──▶  Opus 5
 │              plans · routes each task · judges · re-plans every round
 └─ EXECUTORS   Opus 5 | Sonnet 5, chosen by the lead per task
```

**Routing rules** (the lead gets these verbatim; tune them in Compound):

| Route to | When |
|---|---|
| **Sonnet 5** | Well-specified, single-module, clear observable acceptance. Learning tests, gate mutations, merges, re-runs, summaries, provenance notes. |
| **Opus 5** | Ambiguous acceptance, cross-module or architectural change, concurrency, security, data migration, adversarial verification and judging, anything Sonnet already failed. |
| **Effort** | `low` mechanical · `medium` default · `high` hard · `xhigh` only for a second Opus attempt. |

**Escalation ladder** (per bead, enforced by the script, not the model):

```
routed sonnet:  sonnet → sonnet (with failure notes) → opus/high → BLOCKED "NEEDS INPUT"
routed opus:    opus → opus/xhigh → BLOCKED "NEEDS INPUT"
```

**Lead fallback.** `agent()` returns `null` when a subagent dies on a terminal
API error, so the lead helper tries Fable, then Opus, and records which one led.
We use the **same workflow with an Opus lead**, not an agent team: you keep
resume, `/workflows` progress, budgets and deterministic stop rules. Use a Claude
Code agent team only for open-ended exploration where teammates must talk to
each other and the next step is genuinely unknown.

**Shared preamble.** Paste this after `meta` in every v6 script:

```js
const M = { lead: 'fable', leadFallback: 'opus', strong: 'opus', fast: 'sonnet' }

const str = { type: 'string' }, bool = { type: 'boolean' }, int = { type: 'integer' }
const arr = items => ({ type: 'array', items })
const oneOf = (...vals) => ({ type: 'string', enum: vals })
const S = (props, req) => ({ type: 'object', properties: props, required: req || Object.keys(props) })
const VERDICT = S({ refuted: bool, reason: str })

async function lead(prompt, schema, label, phaseName) {
  const base = { schema, effort: 'high', phase: phaseName }
  let r = null
  try { r = await agent(prompt, { ...base, model: M.lead, label: 'lead:' + label }) } catch (e) { r = null }
  if (r) return { ...r, leadModel: M.lead }
  log('Fable lead unavailable for ' + label + ', falling back to Opus lead')
  let o = null
  try { o = await agent(prompt, { ...base, model: M.leadFallback, label: 'lead-fallback:' + label }) } catch (e) { o = null }
  return o ? { ...o, leadModel: M.leadFallback } : null
}

const ROUTING = [
  'Routing rules for executors:',
  '- sonnet: well-specified single-module work with clear observable acceptance; learning tests, gate mutations, merges, re-runs, summaries, provenance notes.',
  '- opus: ambiguous acceptance, cross-module or architectural change, concurrency, security, data migration, adversarial verification and judging, anything sonnet already failed.',
  '- effort: low for mechanical, medium default, high for hard; never xhigh on a first attempt.',
  '- parallelSafe only if the bead touches modules no other bead in the batch touches and has no ordering dependency.',
  '- needsReview for consequential beads: public API, data, security, money, user flows people depend on.',
].join('\n')
```

---

## Tiers

| Scope | Runs |
|---|---|
| **LIGHTNING** (≤ ~1h) | Sharpen → 3-line spec → build in session → `make check` → `/simplify`. **No workflows.** |
| **ASSIGNMENT** | Sharpen → Scope → HLD sign-off → SPEC-lite → `v6-prepare` (skip Learn if no external deps) → `v6-build` with `maxParallel: 2`. |
| **FULL** | Everything below, in order. |

Workflows need an explicit opt-in: say **"use a workflow: v6-build"** (or put
`ultracode` in the prompt). Check **Dynamic workflow size** in `/config`:
`v6-build` on a real project needs more than the medium (~10 agents) guideline.

---

## P · PROBE (once per machine, before trusting v6)

Three things are unverified until this passes: the model names the Workflow tool
accepts, how a bad or unavailable model fails (`null` vs. throw), and whether
your brakes fire inside workflow agents.

```js
export const meta = {
  name: 'v6-probe',
  description: 'Check model routing, lead fallback behaviour, and gate brakes inside workflow agents',
  phases: [{ title: 'Models' }, { title: 'Brakes' }],
}

const ID = { type: 'object', properties: { model: { type: 'string' } }, required: ['model'] }

phase('Models')
const models = await parallel(['fable', 'opus', 'sonnet'].map(m => () =>
  agent('Return your exact model id.', { model: m, effort: 'low', schema: ID, label: 'probe:' + m })))
let bogus = null
try {
  bogus = await agent('Return your exact model id.', { model: 'no-such-model', effort: 'low', schema: ID, label: 'probe:bogus' })
} catch (e) { bogus = 'threw: ' + e.message }

phase('Brakes')
const brakes = await agent(
  'Report: (1) Is .git/hooks/pre-commit installed and does it run make check? ' +
  '(2) Install dependencies if missing, introduce a deliberate lint error, attempt a commit, and report whether the hook blocked it. ' +
  '(3) Does a Stop or SubagentStop hook fire for you? Then revert everything (git checkout -- . && git clean -fd). Never leave a commit.',
  { model: 'sonnet', effort: 'low', isolation: 'worktree', label: 'probe:brakes' })

return { models, bogusModel: bogus, brakes }
```

**Pass criteria:** each model returns its own id; the bogus call returns `null`
or throws (the lead helper handles both); the pre-commit hook blocked the commit.
If `fable` is rejected by name, change `M.lead` in the preamble.

---

## 0 · SHARPEN (human, unchanged)

```
I'm going to describe something in rough, possibly imperfect English.
This is ONLY an alignment handshake — not the spec, not the build.

Before doing ANY work:
1. Restate what you understand I want, in your own words.
2. List every assumption you'd have to make to proceed.
3. Ask about anything ambiguous — one batch, only the non-obvious ones.
4. In one or two sentences: is this even the right thing to build? If you see
   a materially simpler path, say so now.

Then STOP. Do NOT start the spec or any code until I answer.

My request: <ROUGH DUMP>
```

## 0.25 · SCOPE (human, now also picks orchestration weight)

```
Classify the SCOPE of this build using AskUserQuestion: LIGHTNING, ASSIGNMENT
or FULL (see the Tiers table in software_development_workflow_v6.md). Harness
weight bends to the constraint; the QUALITY BAR DOES NOT.

After I pick: restate the tailored step list, which v6 workflows we run and
with which args (maxParallel, maxRounds), a rough time budget per phase if
there's a clock, and for ASSIGNMENT produce the HLD first. Then STOP.
```

---

## W1 · FRAME (workflow: `v6-frame`)

Replaces v5 **0.5 Challenge**, **1.5 Out-of-the-box**, and adds a spec audit.
Run it twice:

- **Before the spec:** `{ idea, only: ["challenge"] }`. You decide: proceed, simplify, or rethink.
- **After SPEC.md:** `{ idea, specPath: "SPEC.md", only: ["leap", "audit"] }`. You decide whether the leap enters the spec and which audit problems to fix.

```js
export const meta = {
  name: 'v6-frame',
  description: 'Challenge panel, leap tournament and verified spec audit, led by Fable (Opus fallback)',
  whenToUse: 'Challenge before writing SPEC.md; leap + audit after it',
  phases: [
    { title: 'Challenge', detail: 'lens agents argue against the idea; lead ranks the top objections' },
    { title: 'Leap', detail: 'one candidate per lens; lead judges; Opus attacks the winner' },
    { title: 'Audit', detail: 'SPEC.md auditors, each problem adversarially verified' },
  ],
}

// <shared preamble here>

const idea = (args && args.idea) || 'see ' + ((args && args.specPath) || 'SPEC.md')
const specPath = args && args.specPath
const nonGoals = (args && args.nonGoals) || (specPath ? 'as listed in ' + specPath : 'none stated yet')
const run = (args && args.only) || ['challenge', 'leap', 'audit']
const out = {}

if (run.includes('challenge')) {
  phase('Challenge')
  const LENSES = [
    { key: 'skeptic', ask: 'Is this the right thing to build at all? What problem is it really solving, and is there a more direct way?' },
    { key: 'simpler', ask: 'Is there a materially simpler approach that gets ~80% of the value?' },
    { key: 'regret', ask: 'Which part is most likely wrong or regretted in six months? Name the load-bearing assumption.' },
    { key: 'user', ask: 'From the user\'s seat: what will they actually do, and what here will they not care about?' },
    { key: 'not-build', ask: 'What would you NOT build here, and why?' },
  ]
  const OBJ = S({ objections: arr(S({ claim: str, why: str, severity: oneOf('high', 'medium', 'low') })) })
  const objections = (await parallel(LENSES.map(l => () =>
    agent('Argue AGAINST this idea from one angle only. ' + l.ask + '\nIdea: ' + idea + '\nNon-goals: ' + nonGoals + '\nPush back hard; no compliments.',
      { model: M.fast, effort: 'medium', schema: OBJ, phase: 'Challenge', label: 'challenge:' + l.key })
  ))).filter(Boolean).flatMap(r => r.objections)

  out.challenge = await lead(
    'You are the lead. Merge these objections, drop duplicates and weak ones, return the top 3 ranked by how much they should change the plan, and a verdict.\nIdea: ' + idea + '\nObjections: ' + JSON.stringify(objections),
    S({ verdict: oneOf('proceed', 'simplify', 'rethink'), summary: str, top: arr(S({ claim: str, why: str, response: str })) }),
    'challenge', 'Challenge')
}

if (run.includes('leap')) {
  phase('Leap')
  const LEAP_LENSES = [
    { key: '10x', ask: 'What would a team 10x more ambitious build instead?' },
    { key: 'capability', ask: 'What becomes possible ONLY because of a capability we already have?' },
    { key: 'evangelize', ask: 'What would make a user evangelize this unprompted?' },
    { key: 'remove-work', ask: 'What removes an entire category of future work?' },
  ]
  const CAND = S({ idea: str, unlocks: str, minimalVersion: str, breaksNonGoal: str })
  const candidates = (await parallel(LEAP_LENSES.map(l => () =>
    agent('Propose ONE genuine leap for this project: not polish, not a longer feature list. Lens: ' + l.ask + '\nProject: ' + idea + '\nNon-goals: ' + nonGoals + '\nbreaksNonGoal: name the non-goal it breaks, or "none".',
      { model: M.fast, effort: 'high', schema: CAND, phase: 'Leap', label: 'leap:' + l.key })
  ))).filter(Boolean)

  const judged = candidates.length ? await lead(
    'Judge these leap candidates against each other. Pick THE ONE and a runner-up by 0-based index. Respect non-goals unless the gain clearly justifies breaking one.\nProject: ' + idea + '\nCandidates: ' + JSON.stringify(candidates),
    S({ winner: int, runnerUp: int, theOne: str, unlocks: str, minimalVersion: str, runnerUpSummary: str, rationale: str }),
    'leap-judge', 'Leap') : null

  const attack = judged ? await agent(
    'Attack this proposed leap as hard as you can. Give its strongest objection and every non-goal it breaks. survives=false if the objection is fatal.\nLeap: ' + judged.theOne + '\nMinimal version: ' + judged.minimalVersion + '\nNon-goals: ' + nonGoals,
    { model: M.strong, effort: 'high', schema: S({ strongestObjection: str, breaksNonGoals: arr(str), survives: bool }), phase: 'Leap', label: 'leap:attack' }) : null

  out.leap = { judged, attack, candidates }
}

if (run.includes('audit') && specPath) {
  phase('Audit')
  const AUDITS = [
    { key: 'observable', ask: 'Every numbered feature has an OBSERVABLE acceptance description (what a user or caller sees), not an implementation detail.' },
    { key: 'contradictions', ask: 'No two features, non-goals or constraints contradict each other.' },
    { key: 'failure-modes', ask: 'Failure modes and edge cases for each core job are stated.' },
    { key: 'non-goals', ask: 'No feature quietly violates a non-goal or the "deliberately not building yet" note.' },
    { key: 'e2e', ask: 'The end-to-end verification scenario exercises every feature.' },
  ]
  const PROBLEMS = S({ problems: arr(S({ feature: str, problem: str, evidence: str })) })
  const found = await pipeline(AUDITS,
    a => agent('Read ' + specPath + '. Audit ONE property: ' + a.ask + ' Report only real problems, with quoted evidence.',
      { model: M.fast, effort: 'medium', schema: PROBLEMS, phase: 'Audit', label: 'audit:' + a.key }),
    (r, a) => parallel(((r && r.problems) || []).map(p => () =>
      agent('Try to REFUTE this claimed problem in ' + specPath + '. Default refuted=true if uncertain.\nProblem: ' + JSON.stringify(p),
        { model: M.strong, effort: 'medium', schema: VERDICT, phase: 'Audit', label: 'audit-verify:' + a.key })
        .then(v => (v && !v.refuted) ? { ...p, check: a.key } : null)
    )).then(vs => vs.filter(Boolean))
  )
  out.audit = found.filter(Boolean).flat()
}

return out
```

**Human gate:** read the verdict, the leap + its attack, and the confirmed audit
problems. If the leap enters the spec, re-run `only: ["challenge"]` on it.

---

## 1 · PLAN → SPEC (human, unchanged)

Interactive by design (one question at a time), so it stays a prompt:

```
Use the superpowers brainstorming skill. I want to build: <1–4 SENTENCES>.

Stay at product + high-level architecture: users and their core jobs, UX,
edge cases, failure modes, explicit non-goals, key technical CONSTRAINTS.
Do NOT pin low-level implementation — a wrong low-level decision cascades.
Ask only non-obvious questions; dig into the hard parts I haven't considered.

BEFORE writing any design doc: give me a TEN-SENTENCE COMPRESSION — the core
thing, the keystone decision, the one genuinely hard part. If it won't fit in
ten sentences, say so: the design is too tangled and we simplify first.
Wait for me to confirm the compression.

Then write SPEC.md: one-line thesis; numbered features each with an
OBSERVABLE acceptance description; non-goals; a "deliberately not building
yet" note; an end-to-end verification scenario that proves the whole thing.
```

## 1.9 · GATE SETUP (single agent, before W2)

`v6-prepare` proves the gate, so the gate must exist first. Use the v5 §4
Makefile and Playwright fixture, then:

```
Create VERIFICATION.md and the scaffolding so `make check` runs TODAY, with
these exact layers: lint, typecheck, unit, knip, jscpd, Playwright e2e using
the console-clean + axe fixture and toHaveScreenshot on key states. Create
init.sh (boots dev env + smoke test). Stubbed checks must FAIL, not pass.
Install .git/hooks/pre-commit that runs `make check` and blocks on red.
State what we are deliberately NOT verifying yet and why.
```

---

## W2 · PREPARE (workflow: `v6-prepare`)

Replaces v5 **2 Learning tests**, **3 Beads** (draft only) and **proves 4 Gate**.
Args: `{ specPath: "SPEC.md", assumptions?: "...", gateLayers?: [...] }`.

```js
export const meta = {
  name: 'v6-prepare',
  description: 'Learning tests, lead-routed bead graph with critics, and layer-by-layer gate proof',
  whenToUse: 'After SPEC.md and the gate scaffolding exist, before any build',
  phases: [
    { title: 'Learn', detail: 'one learning test per external dependency, adversarially checked' },
    { title: 'Decompose', detail: 'lead drafts routed bead graph; critics; lead revises' },
    { title: 'Gate proof', detail: 'break each gate layer in a throwaway worktree; it must go red' },
  ],
}

// <shared preamble here>

const specPath = (args && args.specPath) || 'SPEC.md'
const assumptions = (args && args.assumptions) || 'infer from ' + specPath
const layers = (args && args.gateLayers) || ['lint', 'typecheck', 'unit', 'deadcode', 'dup', 'e2e']

phase('Learn')
const deps = await agent(
  'Read ' + specPath + ' and the codebase. List every external dependency we rely on but cannot read or control (SDKs, third-party APIs, frameworks, CLIs) where we depend on specific behavior, with the concrete behaviors we assume. Stated assumptions: ' + assumptions,
  { model: M.fast, effort: 'medium', schema: S({ deps: arr(S({ name: str, kind: str, assumptions: arr(str) })) }), phase: 'Learn', label: 'learn:list' })

const LT = S({ name: str, file: str, ran: bool, wrongAssumptions: arr(S({ assumed: str, actual: str })), summary: str })
const learning = await pipeline((deps && deps.deps) || [],
  d => agent(
    'Write a LEARNING TEST for ' + d.name + ' under learning-tests/' + d.name.replace(/[^a-zA-Z0-9_-]/g, '-') + '/: a small script that exercises the REAL dependency (no mocks), logs actual output, then asserts each assumed behavior. Findings comment at the top. Run it. Where an assumption is wrong, fix the findings and report assumed vs actual. If credentials or network are missing, ran=false and say exactly what is needed.\nAssumed behaviors: ' + JSON.stringify(d.assumptions),
    { model: M.fast, effort: 'medium', schema: LT, phase: 'Learn', label: 'learn:' + d.name }),
  (r, d) => r && agent(
    'Adversarially check the learning test for ' + d.name + ' at ' + r.file + '. Refute it if it mocks the dependency, did not really run, or its findings do not match its logged output. Default refuted=true if uncertain.\nReport: ' + JSON.stringify(r),
    { model: M.strong, effort: 'medium', schema: VERDICT, phase: 'Learn', label: 'learn-verify:' + d.name })
    .then(v => ({ ...r, verdict: v }))
)

phase('Decompose')
const BEAD = S({
  key: str, epic: str, title: str, acceptance: str, checks: str, outOfScope: str,
  dependsOn: arr(str), touches: arr(str),
  model: oneOf('sonnet', 'opus'), effort: oneOf('low', 'medium', 'high'),
  parallelSafe: bool, needsReview: bool, reason: str,
})
const GRAPH = S({ epics: arr(S({ key: str, title: str })), beads: arr(BEAD), tooBig: bool, simplerCut: str })
const lessons = JSON.stringify(learning.filter(Boolean).map(l => ({ name: l.name, ran: l.ran, wrong: l.wrongAssumptions, refuted: l.verdict && l.verdict.refuted })))
const graphPrompt = [
  'You are the lead. Read ' + specPath + ' and draft a beads graph. DO NOT create anything in bd.',
  '- Beads are OUTCOME-level ("User can replay a level"), not implementation-prescriptive ("Add replayLevel() to X").',
  '- Group into epics. dependsOn lists bead keys that must close first. touches lists the modules each bead will change.',
  '- Every bead: observable acceptance; checks as lint -> typecheck -> unit:<names> -> e2e:<named check>; explicit out of scope.',
  '- Route every bead with the rules below and give a one-line reason.',
  '- tooBig=true with a simplerCut if the graph cannot be scanned at a glance.',
  ROUTING,
  'Learning-test results (corrected assumptions): ' + lessons,
].join('\n')

const draft = await lead(graphPrompt, GRAPH, 'decompose', 'Decompose')
let graph = draft, critiques = []
if (draft) {
  const CRITICS = [
    { key: 'outcome', ask: 'Are beads outcome-level rather than implementation steps? Are any too big for one focused session?' },
    { key: 'dod', ask: 'Is every acceptance observable, every check named, every out-of-scope explicit?' },
    { key: 'edges-routing', ask: 'Are dependency edges correct and acyclic, is parallelSafe truthful given touches, and does each model route follow the routing rules?\n' + ROUTING },
  ]
  critiques = (await parallel(CRITICS.map(c => () =>
    agent('Critique this bead graph on ONE axis: ' + c.ask + ' Report only concrete issues, each with a fix.\nGraph: ' + JSON.stringify(draft),
      { model: M.strong, effort: 'medium', schema: S({ issues: arr(S({ beadKey: str, issue: str, fix: str })) }), phase: 'Decompose', label: 'critic:' + c.key })
  ))).filter(Boolean).flatMap(r => r.issues)
  if (critiques.length) {
    graph = (await lead(graphPrompt + '\n\nRevise your draft: apply the critic issues that are right, ignore the ones that are wrong.\nDraft: ' + JSON.stringify(draft) + '\nIssues: ' + JSON.stringify(critiques),
      GRAPH, 'decompose-revise', 'Decompose')) || draft
  }
}

phase('Gate proof')
const GATE = S({ layer: str, violation: str, targetRed: bool, checkRed: bool, output: str })
const gateProof = await pipeline(layers, layer => agent(
  'You are in a throwaway git worktree. Install dependencies if missing. Prove the ' + layer + ' layer of the gate works: introduce the SMALLEST deliberate violation that "make ' + layer + '" should catch (e.g. an unused export for deadcode, a copied block for dup, a console.error or axe violation for e2e). Run "make ' + layer + '" then "make check" and report whether each went red, with the failing output. Then revert everything (git checkout -- . && git clean -fd). Never commit.',
  { model: M.fast, effort: 'low', isolation: 'worktree', schema: GATE, phase: 'Gate proof', label: 'gate:' + layer }))
const holes = layers.filter((l, i) => !gateProof[i] || !gateProof[i].targetRed || !gateProof[i].checkRed)
if (holes.length) log('GATE HOLES (layers that did not go red): ' + holes.join(', '))

return { learning, graph, critiques, gateProof, holes }
```

**Human gate:** fix every gate hole before continuing. Scan the bead graph
(`tooBig`? routing sensible?). Then create it in the session:

```
Create the approved bead graph in bd exactly as returned by v6-prepare.
Each bead body carries:
  Acceptance (observable): ...
  Checks: lint -> typecheck -> unit:<names> -> e2e:<named check>
  Out of scope: ...
  Routing: model=<sonnet|opus> effort=<...> parallelSafe=<...> needsReview=<...> touches=<...> reason=<...>
  "Do not weaken, delete, or skip these checks to pass."
Add every dependsOn edge with `bd dep add`. Show `bd ready` when done.
```

---

## W3 · BUILD (workflow: `v6-build`)

Replaces v5 **5 Build**, **6 Let go**, **7 Review**, **8 Parallelize**, **9 Provenance**.
Args: `{ maxRounds: 20, maxParallel: 4 }`.

**Preconditions:** main checkout clean and green; `v6-probe` passed; `v6-prepare`
reported no gate holes; beads created in bd.

Each round:
1. **Plan:** the lead reads bd, recovers in-progress beads, picks a batch, routes it, and claims every bead. Only this step and Record touch bd state.
2. **Build:** parallel-safe beads run in worktrees at the same time; the rest run one at a time in the main checkout. Every executor climbs the escalation ladder.
3. **Integrate:** worktree branches merge one at a time; a red `make check` undoes the merge.
4. **Verify:** a fresh agent tries to *refute* "done" against the definition of done. Beads marked `needsReview` get the review panel, and each finding must survive a refute.
5. **Record:** close, `bd remember` (including model + escalations), bug beads for confirmed findings.
6. **Stop** when `bd ready` is empty, a round closes nothing, or no lead is available.

```js
export const meta = {
  name: 'v6-build',
  description: 'Bead loop: lead routes each bead to Opus or Sonnet, parallel worktrees, verify, review, provenance',
  whenToUse: 'After beads exist in bd and v6-prepare proved the gate red on every layer',
  phases: [
    { title: 'Plan', detail: 'lead reads bd, picks and routes a batch, claims it' },
    { title: 'Build', detail: 'executors build beads; escalation ladder on failure' },
    { title: 'Integrate', detail: 'merge worktree branches one at a time under make check' },
    { title: 'Verify', detail: 'adversarial DoD check; review panel for consequential beads' },
    { title: 'Record', detail: 'close, bd remember, file bug beads' },
  ],
}

// <shared preamble here>

const MAX_ROUNDS = (args && args.maxRounds) || 20
const MAX_PARALLEL = (args && args.maxParallel) || 4

const PLAN = S({
  done: bool, notes: str,
  batch: arr(S({ id: str, title: str, model: oneOf('sonnet', 'opus'), effort: oneOf('low', 'medium', 'high'), parallelSafe: bool, needsReview: bool, reason: str })),
})
const BUILD = S({ id: str, gateGreen: bool, blocked: bool, branch: str, commit: str, notes: str, evidence: str })
const MERGE = S({ merged: bool, gateGreen: bool, notes: str })
const VERIFY = S({ refuted: bool, failures: arr(str), evidence: str })
const FINDINGS = S({ findings: arr(S({ title: str, severity: oneOf('blocking', 'major', 'minor'), file: str, evidence: str })) })
const FINAL = S({ closed: bool, status: str, bugBeads: arr(str), remembered: bool })

function ladder(b) {
  return b.model === 'opus'
    ? [{ model: M.strong, effort: b.effort || 'high' }, { model: M.strong, effort: 'xhigh' }]
    : [{ model: M.fast, effort: b.effort || 'medium' }, { model: M.fast, effort: b.effort || 'medium' }, { model: M.strong, effort: 'high' }]
}

function buildPrompt(b, inWorktree, prior) {
  return [
    'Implement exactly ONE bead: ' + b.id + ' (' + b.title + '). Read its Definition of Done with "bd show ' + b.id + '".',
    inWorktree
      ? 'You are in a fresh git worktree. Install dependencies if missing. Commit on this worktree branch and report the branch name.'
      : 'You are in the main checkout. First discard uncommitted work from any previous attempt: git checkout -- . && git clean -fd (the last commit is green).',
    'Implement it FULLY: TDD, no stubs, no "simple version for now". Search the codebase before assuming something is missing.',
    'Run this bead\'s checks, run /simplify on your diff, re-run lint/typecheck/unit, then make check. Put the ACTUAL output in evidence.',
    'Commit only when make check is green; write the WHY (decisions, rejected alternative) in the commit body. Do not weaken, delete, or skip any check.',
    'Do NOT run bd close, bd update or bd remember: the orchestrator owns bead state.',
    'Missing input: blocked=true, notes "NEEDS INPUT: ...". Never fabricate. Subjective acceptance: blocked=true, notes "NEEDS REVIEW: ...".',
    prior ? 'A previous attempt failed. Its notes: ' + prior.notes : '',
  ].filter(Boolean).join('\n')
}

async function buildWithLadder(b, isolation) {
  const steps = ladder(b)
  let prior = null
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]
    const r = await agent(buildPrompt(b, !!isolation, prior),
      { model: s.model, effort: s.effort, isolation, schema: BUILD, phase: 'Build', label: 'build:' + b.id + ':' + s.model + '#' + (i + 1) })
    if (r && (r.gateGreen || r.blocked)) return { ...r, attempts: i + 1, finalModel: s.model }
    prior = r || { notes: 'executor died without a result' }
    if (i < steps.length - 1) log(b.id + ': attempt ' + (i + 1) + ' on ' + s.model + ' failed; escalating to ' + steps[i + 1].model + '/' + steps[i + 1].effort)
  }
  const last = steps[steps.length - 1]
  return { id: b.id, gateGreen: false, blocked: true, branch: '', commit: '', evidence: '', notes: 'NEEDS INPUT: escalation ladder exhausted. Last notes: ' + (prior && prior.notes), attempts: steps.length, finalModel: last.model }
}

async function review(b) {
  const DIMS = [
    { key: 'spec', ask: 'Does the implementation satisfy every acceptance criterion and out-of-scope rule in the DoD (bd show ' + b.id + ')? For UI beads drive the running app with Playwright and cite what you saw.' },
    { key: 'correctness', ask: 'Bugs in this bead\'s diff: logic errors, unhandled failure modes, races, broken edge cases.' },
    { key: 'security', ask: 'Security issues this bead\'s diff introduces: injection, authz gaps, secrets, unsafe input handling.' },
  ]
  const found = await pipeline(DIMS,
    d => agent('Review bead ' + b.id + ' (find its commits with git log). ' + d.ask + ' Report correctness gaps only, not style.',
      { model: M.strong, effort: 'high', schema: FINDINGS, phase: 'Verify', label: 'review:' + d.key + ':' + b.id }),
    (r, d) => parallel(((r && r.findings) || []).map(f => () =>
      agent('Try to REFUTE this review finding on bead ' + b.id + '. Read the code and reproduce if possible. Default refuted=true if uncertain.\nFinding: ' + JSON.stringify(f),
        { model: M.fast, effort: 'medium', schema: VERDICT, phase: 'Verify', label: 'refute:' + d.key + ':' + b.id })
        .then(v => (v && !v.refuted) ? { ...f, dimension: d.key } : null)
    )).then(vs => vs.filter(Boolean))
  )
  return found.filter(Boolean).flat()
}

const history = []
for (let round = 1; round <= MAX_ROUNDS; round++) {
  phase('Plan')
  const plan = await lead([
    'You are the lead orchestrator, round ' + round + '. Work in the main checkout. Do not implement anything.',
    '1. Run "bd list --status in_progress --json" and "bd ready --json". In-progress beads left by a crashed run come first.',
    '2. If nothing is ready or in progress, return done=true with an empty batch.',
    '3. Pick this round\'s batch: at most ' + MAX_PARALLEL + ' parallelSafe beads touching disjoint modules, plus at most 2 serial beads.',
    '4. Route each bead: start from the Routing line in its body, apply the rules below, and use the history (a bead that escalated before starts on opus).',
    '5. Claim each chosen bead: bd update <id> --claim.',
    ROUTING,
    'History of previous rounds: ' + JSON.stringify(history.slice(-40)),
  ].join('\n'), PLAN, 'plan#' + round, 'Plan')

  if (!plan) { log('No lead available (Fable and Opus both failed). Stopping.'); break }
  log('Round ' + round + ' led by ' + plan.leadModel + ': ' + plan.batch.length + ' bead(s). ' + plan.notes)
  if (plan.done || plan.batch.length === 0) { log('LOOP-COMPLETE: bd ready is empty.'); break }

  const par = plan.batch.filter(b => b.parallelSafe)
  const ser = plan.batch.filter(b => !b.parallelSafe)
  const landed = []

  phase('Build')
  const parBuilt = await pipeline(par, b => buildWithLadder(b, 'worktree'))

  phase('Integrate')
  for (let i = 0; i < par.length; i++) {
    const b = par[i], r = parBuilt[i]
    if (!r || !r.gateGreen) { landed.push({ b, r, ok: false }); continue }
    const m = await agent(
      'In the main checkout, merge branch ' + r.branch + ' (bead ' + b.id + '), then run make check. If the merge conflicts or make check is red, undo the merge completely (git merge --abort, or git reset --hard to the pre-merge commit) and explain why.',
      { model: M.fast, effort: 'medium', schema: MERGE, phase: 'Integrate', label: 'merge:' + b.id })
    landed.push({ b, r, ok: !!(m && m.merged && m.gateGreen), mergeNotes: m ? m.notes : 'merge agent died' })
  }

  phase('Build')
  for (const b of ser) {
    const r = await buildWithLadder(b, undefined)
    landed.push({ b, r, ok: !!(r && r.gateGreen) })
  }

  let closed = 0
  for (const x of landed) {
    let verdict = null, findings = []
    if (x.ok) {
      verdict = await agent(
        'Adversarially verify bead ' + x.b.id + ' is really done. Read its DoD (bd show ' + x.b.id + '), run make check in the main checkout, and test each acceptance criterion against real behavior (drive the app with Playwright for UI). Default refuted=true if any criterion is unproven.',
        { model: M.fast, effort: 'medium', schema: VERIFY, phase: 'Verify', label: 'verify:' + x.b.id })
      if (verdict && !verdict.refuted && x.b.needsReview) findings = await review(x.b)
    }
    const fin = await agent([
      'Record the outcome of bead ' + x.b.id + ' in bd, working in the main checkout.',
      'Build: ' + JSON.stringify(x.r),
      x.mergeNotes ? 'Merge: ' + x.mergeNotes : '',
      'Verify: ' + JSON.stringify(verdict),
      'Confirmed review findings: ' + JSON.stringify(findings),
      'Rules:',
      '- Close it (bd close) ONLY if the build landed, verify was not refuted, and no finding is blocking.',
      '- Blocked with NEEDS INPUT or NEEDS REVIEW: bd update ' + x.b.id + ' --status blocked with the reason in notes.',
      '- Otherwise put it back to open with notes on what failed (including blocking findings), so a later round retries it.',
      '- Each confirmed non-blocking finding becomes a bug bead (bd create) linked with bd dep add; return their ids.',
      '- If closed: read its commits and bd remember the decision trail: intent, key decisions and WHY, the rejected alternative, and the executor (' + (x.r ? x.r.finalModel + ' after ' + x.r.attempts + ' attempt(s), routed ' + x.b.model : 'none') + '). Someone with zero context must be able to reconstruct WHY.',
    ].filter(Boolean).join('\n'),
      { model: M.fast, effort: 'low', schema: FINAL, phase: 'Record', label: 'record:' + x.b.id })

    if (fin && fin.closed) closed++
    history.push({
      round, id: x.b.id, routed: x.b.model,
      finalModel: x.r ? x.r.finalModel : null, attempts: x.r ? x.r.attempts : 0,
      landed: x.ok, refuted: verdict ? verdict.refuted : null, findings: findings.length,
      status: fin ? fin.status : 'unknown',
    })
  }

  log('Round ' + round + ': closed ' + closed + ' of ' + landed.length)
  if (closed === 0) { log('No progress this round. Stopping (no-progress brake).'); break }
}

return { history }
```

**Human gate:** read `history`. Everything `blocked` needs you. The main branch
is green at every commit (pre-commit). Merge to your real main when satisfied.

---

## W3.5 · CROSS-VENDOR REVIEW (optional, code only — Polly)

Every reviewer in `v6-build` is a Claude model, so they share Claude's blind
spots. **Polly** ([omnigent](https://github.com/omnigent-ai/omnigent)) routes an
implementer's diff to a reviewer from a *different vendor* (Claude Code, Codex,
OpenCode, Cursor, Hermes, Gemini/Antigravity; Pi as review specialist) and loops
blocking issues back as fixes until clean. That independence is the only thing
v6 cannot produce by itself.

**Scope: code diffs only.** `/cross-review` takes an implementer's diff, not a
document. SPEC.md, bead descriptions and DoDs stay with the Claude critics in
`v6-frame` and `v6-prepare`. If you want a second vendor on those, run one
auditor through `omni run` with a non-Claude agent — you don't need Polly.

**When to run it:** after a `v6-build` round, on the beads that carried
`needsReview` and closed. Not on every bead — the gate plus the Claude review
panel already covers the rest.

```
# once
omni polly                     # web UI at http://localhost:6767

# in Polly, per reviewed bead
/cross-review <commit range for bead <id>>
```

**Out of band, not nested.** Polly is its own orchestrator with its own
worktrees and UI. Do NOT call it from inside `v6-build`: two orchestrators
fighting over worktrees and the main checkout is how you lose a green main.
Run it between rounds, with the main checkout clean.

**Feeding findings back:**

```
For each Polly cross-review finding on bead <id>: verify it against the code
yourself (default to "not a real problem" if uncertain). For each one that
survives, create a bug bead with `bd create`, link it with `bd dep add`, and
record the reviewing vendor in the bead body. Do not fix anything now — the
next v6-build round picks them up under the normal gate.
```

**Trade-offs:** a second vendor's credentials and cost; findings live in Polly's
UI rather than in `v6-build`'s `history`; an extra manual step per round; and
Polly's own worktrees on disk alongside v6's.

**Unverified:** whether `/cross-review` can be driven headlessly from a script.
The published docs show `omni polly` opening a UI, and the only headless note
concerns *worker* panes, not review. Until that is tested, treat W3.5 as a
human-triggered gate; if it turns out to be scriptable, it becomes a fourth
review dimension inside `v6-build`'s `review()`.

---

## RELOAD (workflow: `v6-reload`, every cold start)

Replaces v5 **5.5**. Args: `{ specPath: "SPEC.md" }`.

```js
export const meta = {
  name: 'v6-reload',
  description: 'Whiteboard-sized reload of project state with a per-feature spec drift check',
  whenToUse: 'Start of any session on an existing project',
  phases: [{ title: 'Read' }, { title: 'Drift' }, { title: 'Synthesize' }],
}

// <shared preamble here>

const specPath = (args && args.specPath) || 'SPEC.md'

phase('Read')
const [state, trail, features] = await parallel([
  () => agent('Summarize bead state from bd list --json and bd ready --json: done, in progress, blocked (with reasons), open, grouped by epic.',
    { model: M.fast, effort: 'low', phase: 'Read', label: 'read:bd' }),
  () => agent('Summarize the decision trail from the notes saved with bd remember and the last 50 commit bodies: key decisions with WHY, rejected alternatives, routing and escalation notes.',
    { model: M.fast, effort: 'low', phase: 'Read', label: 'read:decisions' }),
  () => agent('List the numbered features in ' + specPath + ' with their acceptance descriptions.',
    { model: M.fast, effort: 'low', schema: S({ features: arr(S({ number: str, name: str, acceptance: str })) }), phase: 'Read', label: 'read:spec' }),
])

phase('Drift')
const drift = await pipeline((features && features.features) || [], f => agent(
  'Has the implementation DRIFTED from this SPEC feature? Read the code and tests that implement it. drifted=true only with concrete evidence.\nFeature: ' + JSON.stringify(f),
  { model: M.fast, effort: 'medium', schema: S({ drifted: bool, how: str, evidence: str }), phase: 'Drift', label: 'drift:' + f.number })
  .then(d => d && { feature: f.name, ...d }))

phase('Synthesize')
return await lead(
  'Reload the human\'s mental model of this project, whiteboard-sized: the core idea in 2-3 sentences; done / in progress / open; key decisions and WHY; the one or two things they have most likely forgotten that would bite them; every place implementation drifted from the spec.\nBead state: ' + state + '\nDecision trail: ' + trail + '\nDrift checks: ' + JSON.stringify(drift.filter(Boolean)),
  S({ coreIdea: str, done: arr(str), inProgress: arr(str), open: arr(str), decisions: arr(S({ decision: str, why: str })), likelyForgotten: arr(str), drift: arr(str) }),
  'reload', 'Synthesize')
```

---

## COMPOUND (workflow: `v6-compound`, between projects)

Replaces v5 **10**, and now also **tunes the routing rules** from real
escalation data. Args: `{ projects: ["/path/a", "/path/b"] }`. Proposes only;
nothing is written.

```js
export const meta = {
  name: 'v6-compound',
  description: 'Mine past sessions and routing history; propose skills and routing-rule changes (read-only)',
  whenToUse: 'Between projects, roughly monthly',
  phases: [{ title: 'Mine' }, { title: 'Propose' }],
}

// <shared preamble here>

const projects = (args && args.projects) || []

phase('Mine')
const MINED = S({
  cleanPatterns: arr(str), circlePatterns: arr(str), manualWorkflows: arr(str),
  routingMisses: arr(S({ beadKind: str, routedTo: str, shouldHaveBeen: str, evidence: str })),
})
const mined = await pipeline(projects, p => agent(
  'For the project at ' + p + ', review the last month of Claude Code session transcripts (under ~/.claude/projects/) and its bd history. Find: (a) prompt patterns that led to clean outcomes vs. going in circles; (b) recurring manual workflows that should be skills; (c) routing misses: beads routed to sonnet that escalated, or routed to opus that were mechanical (use the executor notes saved with bd remember).',
  { model: M.fast, effort: 'medium', schema: MINED, phase: 'Mine', label: 'mine:' + p }))

phase('Propose')
return await lead(
  'Using the superpowers writing-skills skill as your standard, propose a refreshed skill set and routing-rule changes from these findings. Do NOT write any files.\nCurrent routing rules:\n' + ROUTING + '\nFindings: ' + JSON.stringify(mined.filter(Boolean)),
  S({ newSkills: arr(S({ name: str, trigger: str, why: str })), staleSkills: arr(S({ name: str, change: str })), routingRuleChanges: arr(S({ rule: str, change: str, evidence: str })), summary: str }),
  'compound', 'Propose')
```

**Human gate:** approve the diff, then apply with `writing-skills` and update
`ROUTING` in the shared preamble. Package Sharpen, Scope and the bead-creation
prompt as a personal plugin, and save the six scripts under `.claude/workflows/`
so they run by name.

---

## Order of operations

**Brand-new project (FULL):**
```
P Probe (once) → 0 Sharpen → 0.25 Scope
→ W1 v6-frame {only: challenge}          ▸ you: proceed / simplify / rethink
→ 1 Brainstorm + compression → SPEC.md   ▸ you: confirm compression + spec
→ W1 v6-frame {only: leap, audit}        ▸ you: leap in? fix audit problems
→ 1.9 Gate setup + pre-commit
→ W2 v6-prepare                          ▸ you: zero gate holes, approve graph → create beads
→ W3 v6-build                            ▸ you: unblock, merge
→ W3.5 Polly /cross-review (optional)    ▸ you: confirm findings → bug beads
→ v6-reload at every cold start · v6-compound between projects
```

**Brownfield change:** Sharpen → `v6-frame {only: challenge}` → read the real
code → mini-spec → `v6-prepare {gateLayers: existing}` → create beads →
`v6-build {maxParallel: 1}`.

**Assignment:** Sharpen → Scope → HLD sign-off → SPEC-lite → `v6-prepare` →
`v6-build {maxParallel: 2}` → `/simplify`.

**Lightning:** Sharpen → Scope → 3-line spec → build in session → `make check` →
`/simplify`. No workflows.

**Fallback if workflows are unavailable:** v5 §5–§8 (ralph-loop or the bash loop).

---

## Known risks and open checks

1. **Unverified until `v6-probe` passes:** model names, how an unavailable model fails, whether hooks fire in workflow agents.
2. **Worktrees don't have `node_modules`.** Executors are told to install first; that costs time on every parallel bead.
3. **bd from worktrees.** Only Plan and Record touch bead state, both in the main checkout. Executors only run `bd show`; confirm that reads correctly from a worktree.
4. **Cost.** A round on a Sonnet bead with review is about 8 agents; an escalated one is more. Keep lead calls to plan, judge and synthesize. Raise **Dynamic workflow size** deliberately.
5. **Opt-in.** Every run needs "use a workflow: v6-…" or `ultracode`.
6. **Serial verify.** Verify and Record run one bead at a time so `make check` and Playwright never share ports; that trades wall-clock for safety.
7. **Resume.** If a run dies, re-invoke with `resumeFromRunId`; completed agents return cached results, and Plan recovers in-progress beads.
8. **Polly (W3.5) is unverified and out of band.** Headless `/cross-review` is untested; run it only between rounds, on a clean main checkout, never concurrently with `v6-build`.

> The pack in one line: **transfer intent, require compression, hold the gate,
> keep the judgment for yourself, and let the lead spend the right model on
> each task.** Superpowers supplies the discipline, bd the memory, the gate the
> brake, the workflow the hands.
