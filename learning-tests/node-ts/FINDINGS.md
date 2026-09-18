# Findings: Node 24 native TypeScript support in a pnpm-workspace monorepo, no build step

Environment: Node v24.17.0, pnpm 9.15.4, macOS (darwin). This folder is its own
isolated pnpm workspace (`pnpm-workspace.yaml` here, `apps/demo` + `packages/lib`),
so `pnpm install` run with cwd inside this folder uses THIS workspace root, not
the parent repo's. Run with `./run.sh`. All 22 checks pass (0 fail) as of this
writing.

## 1. `node file.ts` runs with no flag on Node 24.17

**Confirmed.** `node apps/demo/src/a1-no-flag.ts` ran a `.ts` file with an
`interface` and a typed `const` directly, exit 0, output `a1-ok sum=3`, and
printed **no experimental warning at all**. Node 24 shipped type-stripping
as stable (unflagged) — no `(node:...) ExperimentalWarning` line, unlike
`--experimental-transform-types` (see #4) which does print one.

## 2. Workspace package reached through a node_modules symlink

**Confirmed, with a real gotcha.** `@nt/lib`'s `exports` map points at
`./src/index.ts`. pnpm links it into `apps/demo/node_modules/@nt/lib` as a
symlink whose realpath is `.../learning-tests/node-ts/packages/lib` (outside
any `node_modules` directory). By default:

```
node apps/demo/src/a2-workspace-import.ts
```

succeeds — `a2-ok widget={"id":1,"name":"gadget"}`. Node resolves the
symlink to its real path before applying the "no stripping in
node_modules" rule, so pnpm's symlink-based workspace linking is exactly
what makes this design work.

**With `--preserve-symlinks` it breaks**, confirming the mechanism above —
Node then evaluates the check against the symlink path itself (which
literally contains `node_modules`) instead of the realpath, and throws:

```
Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types is
currently unsupported for files under node_modules, for
"file:///.../apps/demo/node_modules/@nt/lib/src/index.ts"
```

Rule to adopt: never run these apps with `--preserve-symlinks`.

## 3. Relative imports must include the `.ts` extension

**Confirmed exactly as assumed.**
- `import { shout } from "./helper.ts"` -> works.
- `import { shout } from "./helper"` (extensionless) -> fails:
  `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../src/helper' imported from .../a3-ext-none.ts`
- `import { shout } from "./helper.js"` (compiled-extension convention) -> fails:
  `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../src/helper.js' imported from .../a3-ext-js.ts`

Rule to adopt: all relative specifiers in source must use the literal `.ts`
extension; the common "import with `.js`, TS resolves it to `.ts`" trick
does not apply here because there is no `tsc`/bundler doing that resolution
-- it's plain Node ESM resolution.

## 4. Non-erasable syntax fails under plain stripping

**Confirmed for all four**, each with a distinct, specific error:

| Construct | Error |
|---|---|
| `enum Color { ... }` | `SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript enum is not supported in strip-only mode` |
| `namespace Shapes { export const x = 0; }` | `SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript namespace declaration is not supported in strip-only mode` |
| `constructor(public x: number)` | `SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript parameter property is not supported in strip-only mode` |
| `@log` class-method decorator | `SyntaxError: Invalid or unexpected token` (decorator syntax isn't even parsed in strip-only mode -- no dedicated error code, it's a raw parse failure) |

**`--experimental-transform-types` does change this**: `node
--experimental-transform-types a4-enum-transform.ts` ran the same enum
successfully (`a4-enum-transform 0,1,2`), but at a real cost -- it printed:

```
(node:...) ExperimentalWarning: Transform Types is an experimental feature and might change at any time
```

i.e. it is explicitly labeled experimental/unstable (unlike plain type
stripping, which is stable in Node 24), so adopting it trades the "just
strip whitespace, deterministic" guarantee for a flag whose behavior/output
can still change.

## 5. `import type` / `export type` required for type-only imports

**Confirmed.** `types-only.ts` exports only `interface Config` and `type
Mode` (no runtime exports survive stripping). Importing `Config` as a value
(`import { Config } from "./types-only.ts"`) fails at **runtime** (not a
type error) with:

```
SyntaxError: The requested module './types-only.ts' does not provide an export named 'Config'
```

Using `import type { Config } from "./types-only.ts"` runs fine
(`a5-good {"debug":true}`) because the import is erased entirely.

`tsconfig.json` with `verbatimModuleSyntax: true` makes `tsc --noEmit`
catch the bad case at typecheck time, before you'd ever hit the runtime
error:

```
apps/demo/src/a5-import-type-bad.ts(4,10): error TS1484: 'Config' is a type and must be imported using a type-only import when 'verbatimModuleSyntax' is enabled.
```

Rule to adopt: turn on `verbatimModuleSyntax` repo-wide so this class of
bug is caught by `tsc --noEmit` in CI, not at runtime in production.

## 6. Type errors do not stop execution

**Confirmed.** `const bad: number = "not a number";` runs fine under
`node` (exit 0, `a6-ran-anyway bad=not a number`) because type annotations
are simply stripped/ignored, not checked. `tsc --noEmit` on the same file
reports:

```
apps/demo/src/a6-type-error.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.
```

Rule to adopt: `tsc --noEmit` MUST be a required CI gate -- it is the only
thing standing between the team and shipping type-broken code, since
`node` will happily run it.

## 7. Stack traces match source exactly, no source maps

**Confirmed**, once the check target was corrected. `willThrow()` on line 5
of `a7-stack-trace.ts` has a `const y: number = ...` type annotation
earlier on the same line as the `throw new Error("boom")`. The reported
stack frame was `a7-stack-trace.ts:5:47`. Column 47 in the raw `.ts` source
(annotations included) is exactly where `new Error(...)` starts -- V8
always reports a thrown error's frame at the `new Error` expression, not
the `throw` keyword (true in plain JS too, unrelated to stripping). Since
that column matches the raw source text 1:1, this confirms Node replaces
stripped type syntax with equal-length whitespace, so it never shifts
column positions of the code that follows on the same line. No source maps
needed or produced.

## 8. `tsconfig.json` "paths" are ignored at runtime; package.json "imports" work

**Confirmed.** `apps/demo/tsconfig.json` declares `"paths": { "@app/*":
["./src/*"] }`, but `import { shout } from "@app/helper.ts"` fails at
runtime:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@app/helper.ts' imported from .../a8-tsconfig-paths.ts
```

`apps/demo/package.json`'s `"imports": { "#helper": "./src/helper.ts" }`
(Node's own subpath-imports feature) works as the drop-in, build-free
alternative: `import { shout } from "#helper"` -> `a8-imports-ok WORKS!`.

Rule to adopt: don't rely on tsconfig `paths` for internal aliasing in
this design -- use package.json `imports` (`#foo`) instead, since Node
resolves it natively.

## 9. `.tsx` cannot be run by Node directly

**Confirmed.** `node a9-jsx.tsx` fails immediately:

```
TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".tsx" for .../a9-jsx.tsx
```

Node's type stripping does not include a JSX transform at all (not even
under `--experimental-transform-types`, which was not tested further here
since the extension itself is rejected before any flag-gated code path
runs). Any server code that needs JSX (e.g. SSR templates) needs a build
step or a different runtime path; the no-build-step design only covers
plain `.ts`/`.mts`/`.cts`.

## 10. `node --watch` restarts on a change in an imported workspace package's `.ts` file

**Confirmed the restart behavior, but the earlier claim that `--watch-path`
"was required" was WRONG -- it was never tested against a control run, and
now that it has been, `--watch-path` turns out to be unnecessary here.**

`run.sh` now runs both experiments and logs both outcomes:

- **Control: `node --watch apps/demo/src/a10-watch.ts` with NO
  `--watch-path` at all.** Log (from `./run.sh`, "control watch log (no
  --watch-path)"):
  ```
  a10-watch-tick LIB_VERSION=1 t=1789761357471
  Completed running '.../a10-watch.ts'. Waiting for file changes before restarting...
  Restarting '.../a10-watch.ts'
  a10-watch-tick LIB_VERSION=2 t=1789761359152
  Completed running '.../a10-watch.ts'. Waiting for file changes before restarting...
  ```
  It restarted and picked up `LIB_VERSION=2` with **no `--watch-path` at
  all**. This was reproduced twice independently, including once with the
  process's cwd set to `apps/demo` (not the workspace root) -- same
  result. So Node's default watch-mode already follows the module graph
  (via the pnpm symlink's realpath into `packages/lib/src/index.ts`), not
  just the entry file's own directory tree.

- **With `--watch-path=<repo root>` (the original experiment, kept for
  comparison):** same outcome -- `LIB_VERSION=1` then `LIB_VERSION=2`
  after the edit.

**True result:** for this scenario (a workspace package reached through a
pnpm `node_modules` symlink, imported from the entry file), `--watch-path`
is **not required** -- default `node --watch` dependency-graph watching
already covers it, because Node resolves the symlink to its realpath and
watches that real file. The earlier "was required" claim in this doc was
an assumption stated as fact without a control run; retracted.

Caveat/scope: this only shows the default behavior covers *files reachable
via the import graph*. It says nothing about files that are NOT imported
(e.g. config files, non-imported data files) -- that's a separate scenario
`--watch-path` would still matter for, but it was not tested here.

## 11. `node --test` discovers and runs `*.test.ts` files natively

**Confirmed, with one real caveat.** `math.test.ts` uses `node:test`,
`node:assert/strict`, and imports `double` from `@nt/lib/utils` (a second
`exports` subpath resolving to `./src/utils.ts`) -- all typed with `.ts`
throughout.
- `node --test apps/demo/test/math.test.ts` (explicit file) -> discovers
  and runs it: `pass 1`.
- `node --test` run with cwd inside `apps/demo` (no path argument, relying
  on default test-file discovery) -> also finds and runs it: `pass 1`.
- **Assumed -> actual**: passing a *directory* as the positional argument
  (`node --test apps/demo/test`) does **not** recursively search that
  directory as one might expect from some other test runners. It fails
  outright with `Error: Cannot find module '.../apps/demo/test' ...
  code: 'MODULE_NOT_FOUND'` -- Node tries to `require()` the path as a
  single module rather than treating it as a search root. Use an explicit
  file/glob, or rely on cwd-based auto-discovery with no argument.

## Wrong assumptions (summary)

- Assumption 7: minor test-design correction only, not a real wrong
  assumption -- the thrown-error stack column points at `new Error(...)`,
  not the `throw` keyword (standard V8 behavior); once compared correctly
  it matches the raw source exactly, confirming the hypothesis.
- Assumption 11: assumed `node --test <directory>` would search that
  directory; actual behavior is it tries to `require()` the directory
  path directly and fails with `MODULE_NOT_FOUND`. Must pass an explicit
  file (or glob) or rely on cwd-based auto-discovery.
- Assumption 10: assumed `--watch-path` "was required" for `node --watch`
  to restart on a change to the imported workspace package's file; a
  control run (`node --watch` with no `--watch-path`) shows it restarts
  identically without it. Corrected above with both logs side by side.

Everything else behaved exactly as assumed, with exact error text captured
above and reproducible via `./run.sh`.
