"""Builds docs/handbook/lesson-1.html. Every code block is cut from the real repo by anchor text,
so the page cannot show code that does not exist; a missing anchor fails the build."""
import html, pathlib, re, subprocess
root = pathlib.Path(__file__).resolve().parents[2]
commit = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=root, capture_output=True, text=True).stdout.strip()

def cut(path, start, end=None, include_end=False):
    src = (root / path).read_text()
    i = src.index(start)
    j = len(src) if end is None else src.index(end, i + len(start)) + (len(end) if include_end else 0)
    body = src[i:j].rstrip()
    return (f'<p class="label">From <span class="mono">{path}</span></p>'
            f'<div class="scroll"><pre><code>{html.escape(body)}</code></pre></div>')

def vs(rows, head=("TypeScript (this repo)", "Java / Spring", "Python / FastAPI")):
    body = "".join("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in rows)
    return f'<div class="scroll"><table><tr>{"".join(f"<th>{h}</th>" for h in head)}</tr>{body}</table></div>'

def case(title, body): return f'<div class="break"><p class="label">Case study · found by review</p><p><strong>{title}</strong></p>{body}</div>'
def note(body): return f'<p class="note">{body}</p>'

S = []
def section(sid, title, *parts): S.append((sid, title, "".join(parts)))

section("map", "The map: one request, five files",
  "<p>Epic 1 built the part of the system that is ordinary on purpose: a typed HTTP API over Postgres. Follow one request, <code>POST /orgs/:orgId/workspaces</code>, and you have met every file worth knowing.</p>",
  vs([("1", "<span class='mono'>apps/api/src/app.ts</span>", "identity middleware: who is calling? No caller, no entry (401)"),
      ("2", "<span class='mono'>apps/api/src/app.ts</span>", "org middleware: is this caller a member of this org? If not, 404"),
      ("3", "<span class='mono'>packages/contracts</span>", "the body is parsed against a Zod schema; a bad field is a 400 that names it"),
      ("4", "<span class='mono'>packages/db</span>", "<code>db.forOrg(orgId).createWorkspace()</code>: the only door to tenant data"),
      ("5", "Postgres", "constraints and foreign keys have the last word")], head=("Step", "Where", "What happens")),
  "<p>Three packages, one direction of dependency: <span class='mono'>contracts</span> knows nothing; <span class='mono'>db</span> and <span class='mono'>session-token</span> import it; <span class='mono'>api</span> imports all three. Nothing imports <span class='mono'>api</span>.</p>",
  vs([("<span class='mono'>packages/*</span> with <code>exports</code> in package.json", "Maven modules", "packages in a uv/poetry workspace"),
      ("Hono app built by a function, <code>buildApp({ db, identify, sessions })</code>", "Spring context + <code>@RestController</code>", "<code>FastAPI()</code> + <code>Depends</code>"),
      ("dependencies are function ARGUMENTS", "dependency injection container", "<code>Depends(...)</code>")]),
  note("<strong>The biggest style difference from Spring:</strong> there is no container, no annotations, no reflection. A dependency is a parameter. A test passes a different argument. That is the whole dependency-injection story in this codebase."))

section("contracts", "1 · One schema, two jobs",
  "<p>Lesson 0 ended on <em>types vanish at runtime</em>. This is the answer. A Zod schema is a runtime value that can check data; <code>z.infer</code> derives the static type from it. One definition, so the check and the type cannot drift apart.</p>",
  cut("packages/contracts/src/index.ts", "export const Id = z.uuid();", "export const Document = z.object("),
  "<p>Three TypeScript things are happening in that excerpt:</p><ul>"
  "<li><strong>A value and a type share a name.</strong> <code>export const Org</code> and <code>export type Org</code> do not clash: TypeScript keeps values and types in two separate namespaces. <code>Org.parse(x)</code> uses the value; <code>const o: Org</code> uses the type. Java has no equivalent; it is the idiom for \"schema + its type\".</li>"
  "<li><strong><code>typeof Org</code></strong> here is the <em>type-level</em> <code>typeof</code>: \"the static type of this value\". (The runtime <code>typeof</code> from Lesson 0 only knows eight JavaScript types. Same keyword, two languages.)</li>"
  "<li><strong><code>z.strictObject</code></strong> (used for request bodies, below) rejects unknown keys, so a typo like <code>nmae</code> is an error, not silently ignored.</li></ul>",
  cut("packages/contracts/src/index.ts", "export const CreateOrgBody", "// --- AI runs (F9)"),
  vs([("Zod schema + <code>z.infer</code>", "DTO class + Bean Validation annotations", "pydantic <code>BaseModel</code>"),
      ("explicit <code>.parse()</code> at each boundary", "framework binds and validates for you", "framework binds and validates for you"),
      ("types erased; only the schema exists at runtime", "class exists at runtime", "class exists at runtime")]),
  case("A name that satisfied the contract still crashed the database.",
       "<p>The first <code>Name</code> was <code>z.string().trim().min(1).max(200)</code>. Two reviewers independently sent a name containing a NUL byte. The contract said yes, Postgres said no (text cannot hold NUL), and the client got a 500. The fix is the <code>.regex(/^\\P{Cc}*$/u)</code> line: <code>\\P{Cc}</code> means \"not a control character\", and the <code>u</code> flag turns on Unicode property escapes. <em>A contract must be at least as strict as the strictest system behind it.</em></p>"))

section("closure", "2 · Privacy without <code>private</code>: the closure",
  "<p>The most important rule in a multi-tenant system: <strong>no query may forget the org filter.</strong> In Java you would reach for a <code>private</code> field and code review. Here the rule is made <em>unwritable</em>.</p>",
  cut("packages/db/src/index.ts", "export type Db = {", "  close(): Promise<void>;\n};", include_end=True),
  cut("packages/db/src/index.ts", "export function createDb(", "  async function rows<T>("),
  "<p><code>pool</code> is a local variable of <code>createDb</code>. The functions in the returned object <em>close over</em> it: they can use it, nothing else can reach it. There is no field to make public by mistake, no reflection to bypass it, and no subclass. That is a <strong>closure</strong>, and it is how this codebase does encapsulation.</p>",
  vs([("function returning an object of functions; state in the closure", "class with <code>private final</code> fields", "class with <code>_underscore</code> convention"),
      ("<code>type Db = { ... }</code> describes the shape", "<code>interface Db</code>", "<code>Protocol</code>"),
      ("truly unreachable", "reachable by reflection", "reachable by anyone")]),
  "<p><strong>Why not a class?</strong> TypeScript's <code>private</code> is a compile-time note that vanishes at runtime (JavaScript's <code>#field</code> is real, but then every method needs <code>this</code>, and <code>this</code> gets lost the moment you pass a method as a callback; you will meet that lint rule in section 8). An object of closures has no <code>this</code> at all.</p>",
  "<p>And a test proves the door stays shut. <code>@ts-expect-error</code> means \"the next line MUST be a type error\"; if it ever compiles, the typecheck layer fails:</p>",
  cut("packages/db/src/scope.typecheck.test.ts", "function unscopedAccessIsImpossible", "test("),
  note("<strong>Three layers, not one.</strong> The closure makes the unscoped query unwritable; the compile-time test notices if someone adds a door; and the database refuses a document whose org differs from its workspace's org (a composite foreign key, section 4). Each layer was mutation-checked: remove it, watch a test go red, put it back."))

section("boundary", "3 · Parse at the boundary, in both directions",
  "<p>The <span class='mono'>pg</span> driver returns rows typed as <code>any</code>. Rather than trust it, every row is parsed once, where it enters our code, and converted from the database's <code>snake_case</code> to the contract's shape:</p>",
  cut("packages/db/src/index.ts", "// Rows arrive as `any`", "type ShareRole ="),
  "<p><code>.transform()</code> makes a schema whose <em>input</em> type and <em>output</em> type differ: in goes a row with a <code>Date</code>, out comes an <code>Org</code> with an ISO string. The annotation <code>(r): Org =></code> makes the compiler check that the transform really produces the contract.</p>",
  case("Validate BEFORE the write, not only after the read.",
       "<p>The first version parsed rows only on the way out. The database check was <code>length(name) &gt;= 1</code>; the contract trims first. So <code>\"   \"</code> was <em>stored</em> (length 3) and then <em>unreadable</em> (trims to empty). One such row made every later <code>listWorkspaces()</code> for that org throw, forever, and nothing in the API could delete it. Two reviewers found it independently.</p>"
       "<p>The fix has two halves: inputs go through the same <code>Name.parse()</code> <strong>before</strong> the insert, and the column check became <code>name = btrim(name)</code>. The rule: <em>a row the reader cannot parse must never be storable.</em></p>"),
  cut("packages/db/src/index.ts", "    // Inputs are parsed with the SAME contract", "    listOrgsFor:"))

section("sql", "4 · Let the database do what it is good at",
  "<p>Application code checks first; the database has the last word. Three pieces of SQL carry real weight.</p>",
  "<p><strong>A composite foreign key</strong> makes \"a document's org equals its workspace's org\" a fact of the schema, not a hope about the code:</p>",
  cut("packages/db/migrations/0001_init.sql", "create table documents (", "create index documents_workspace", ),
  "<p><strong><code>insert ... select</code></strong> creates the row only if the workspace exists <em>in this org</em>. No check-then-insert, so no race:</p>",
  cut("packages/db/src/index.ts", "        createDocument: async ({ workspaceId, title }) => {", "        listDocuments:"),
  "<p><strong>One statement, two writes.</strong> An org must never exist without an owner. A data-modifying CTE does both inserts atomically, with no explicit transaction (Postgres runs every data-modifying <code>with</code> exactly once, to completion, whether or not its result is read):</p>",
  cut("packages/db/src/index.ts", "    createOrg: async ({ name, ownerId }) => {", "    listOrgsFor:"),
  "<p><strong>Keyset paging.</strong> <code>OFFSET</code> gets slower with every page and skips rows when data changes underneath it. A keyset cursor says \"everything after this row\":</p>",
  cut("packages/db/src/index.ts", "// Keyset paging on (created_at, id).", "export function createDb("),
  case("A JavaScript <code>Date</code> is too coarse to be a cursor.",
       "<p>Postgres <code>timestamptz</code> keeps microseconds; a JS <code>Date</code> keeps milliseconds. Rows inserted in the same millisecond would be skipped or repeated if the cursor went through a <code>Date</code>. So the cursor carries <em>Postgres's own text</em> for the timestamp. Drill 2 is this bug, planted in a copy of the code.</p>"),
  vs([("hand-written SQL, parameters as <code>$1</code>", "JPA / jOOQ / JdbcTemplate", "SQLAlchemy"),
      ("ordered <span class='mono'>.sql</span> files + an advisory lock", "Flyway / Liquibase", "Alembic"),
      ("rows parsed by Zod", "entity mapping", "ORM models")]),
  note("<strong>Why no ORM?</strong> A dozen queries do not pay for one, and the hard statements later in this project (the fenced journal append in epic 7) need exact SQL anyway. The trade: you read real SQL, and nothing generates it behind your back."))

section("http", "5 · The HTTP layer: a handler cannot forget to validate",
  cut("apps/api/src/app.ts", "async function body<S extends z.ZodType>", "function pageQuery"),
  "<p>Read the signature slowly: <code>&lt;S extends z.ZodType&gt;(c, schema: S): Promise&lt;z.infer&lt;S&gt;&gt;</code>. It is <strong>generic over the schema</strong>: pass <code>CreateOrgBody</code> and the return type is <em>that schema's</em> inferred type. So in a handler, <code>const { name } = await body(c, CreateOrgBody)</code> gives a <code>name: string</code> with no cast and no annotation. On failure it <em>throws</em> a ready-made 400, which keeps every handler's happy path a straight line:</p>",
  cut("apps/api/src/app.ts", '  app.post("/orgs", async (c) => {', '  app.get("/orgs", async (c) => {'),
  "<p><strong><code>satisfies</code></strong> appears all over <span class='mono'>app.ts</span>: <code>{ error: \"not_found\" } satisfies ErrorBody</code> asks the compiler to check the literal against the type <em>without changing the literal's own type</em>. A plain annotation would widen it; <code>as</code> would not check it at all.</p>",
  "<p><strong>Errors.</strong> Anything unexpected becomes a bare 500. Database errors echo input, table and constraint names, so none of it goes to the client; the log is one JSON object per line, so a newline inside a message cannot forge a second log entry:</p>",
  cut("apps/api/src/app.ts", "  app.onError((err, c) => {", "  return app;"),
  case("One request took the API from 58 MB to 806 MB.",
       "<p>Nothing limited the size of a request body. A reviewer sent one 200 MB POST and watched the container's memory. The fix is one middleware (<code>bodyLimit</code>, 64 KB, <code>413</code>), plus a demand for <code>application/json</code>: a browser may send <code>text/plain</code> cross-site <em>without a preflight</em>, which becomes a cross-site write the day cookies exist.</p>"))

section("auth", "6 · Identity: a function type, and failing closed",
  "<p>Who is calling? In development a header answers; epic 8 added sign-in as a second strategy of the same type. The interesting part is the <em>shape</em>: identity is a function type, and the app receives one as an argument.</p>",
  cut("apps/api/src/identity.ts", "/** Works out who is calling.", None),
  vs([("<code>type Identify = (c, db) =&gt; Promise&lt;User | undefined&gt;</code>", "<code>interface AuthenticationProvider</code> + a bean", "a <code>Depends</code> callable"),
      ("the strategy is a REQUIRED argument of <code>buildApp</code>", "profile-specific beans", "dependency overrides")]),
  "<p>A one-method interface in Java is just a function type here. And it is a <em>required</em> parameter with no default: forget it and the code does not compile, so development auth cannot reach production by omission.</p>",
  cut("apps/api/src/app.ts", "  // Identity fails CLOSED:", '  app.use("*", requireUser);', include_end=True),
  cut("apps/api/src/app.ts", "  // EVERYTHING about one org lives behind this middleware", '  org.get("/", need("viewer"), (c) => c.json(c.var.org));'),
  "<p><strong>404, never 403.</strong> A <code>403</code> says \"this org exists, and you may not see it\". That confirms a fact the caller had no right to. So \"not a member\" and \"no such org\" are <em>one query</em> and <em>one answer</em>. The test walks every per-org route as an outsider and compares status, bytes and headers with the answer for an org that does not exist.</p>",
  case("Three ways the first version could have leaked, all found by review.",
       "<ul><li><strong>\"Anything except production\" is two values too many.</strong> <code>NODE_ENV=test</code> also enabled the header. Now only the literal <code>\"development\"</code> does, and <em>unset means production</em>.</li>"
       "<li><strong>Auth was opt-in per path.</strong> Only <code>/orgs/*</code> was guarded, so the next top-level route would have been public by default. Now every route needs a caller except an explicit allowlist. The very next bead added such a route and needed no auth code at all.</li>"
       "<li><strong>No test proved the real wiring.</strong> Tests handed the strategy to <code>startServer</code> themselves, so <span class='mono'>main.ts</span> could wire the wrong one and the whole gate stayed green. A new test runs the <em>real entry point in a child process</em> with a clean environment. It was mutation-checked: wire it wrong, the test goes red.</li></ul>"))

section("token", "7 · A session token, and a function that returns its failure",
  "<p><code>POST /documents/:id/session</code> answers \"where do I connect for live editing, and with what?\". The token is a standard HS256 JWT made with <span class='mono'>node:crypto</span>. Two decisions differ from what a typical JWT library does by default.</p>",
  cut("packages/session-token/src/index.ts", "type VerifyResult =", "const nowSeconds"),
  "<p>That is a <strong>discriminated union</strong> (Lesson 0, section 3) used as a return type. A bad token is an <em>expected input</em>, not an exceptional event, so <code>verify</code> does not throw: it returns <code>{ ok: false, reason }</code>, and the compiler forces the caller to look at <code>ok</code> before it can touch <code>claims</code>.</p>",
  vs([("return a union: <code>{ok:true,...} | {ok:false,reason}</code>", "checked exception, or <code>Optional</code>/<code>Either</code>", "raise, or return a tuple"),
      ("the compiler forces the check", "the compiler forces the catch (checked only)", "nothing forces anything")]),
  cut("packages/session-token/src/index.ts", "  // Signature first, over the exact bytes received", "  let json: unknown;"),
  "<ul><li><strong>The algorithm is pinned.</strong> The token's own <code>alg</code> header is never used to decide how to verify; the header must equal ours byte for byte. The classic attacks (<code>alg: none</code>, swapping the algorithm) have nothing to grab.</li>"
  "<li><strong>Constant-time comparison</strong> (<code>timingSafeEqual</code>) before anything inside the token is parsed.</li>"
  "<li><strong>A list of secrets</strong>, so a secret can be rotated without an outage: give verifiers <code>[new, old]</code>, switch the signer, wait out the 60-second lifetime, drop the old one.</li></ul>",
  case("Several different strings were the same token.",
       "<p>Node decodes base64url leniently: padding, <code>+</code> and <code>/</code>, stray characters and the unused bits of the last character all decode to the same bytes. A reviewer showed four equivalent last characters for one real token. Harmless today; but the day something is keyed on the token <em>string</em> (a replay cache, a revocation list), flipping one character walks around it. The <code>canonical</code> line above requires the one true encoding.</p>"),
  note("<strong>What is deliberately NOT in the token: the role.</strong> A token is checked once, when the socket opens, and the socket then lives for hours. A role inside it would be stale for the whole session. The sync server will read the role itself and be told when it changes (epic 8)."))

section("ops", "8 · Configuration, startup and shutdown",
  "<p>Environment variables are untrusted strings like any other input, so they get a schema too. There are <strong>no defaults for secrets or addresses</strong>: a missing value stops the process instead of pointing it at something with a well-known password.</p>",
  cut("apps/api/src/config.ts", "const Env = z.object({", "export type SessionConfig"),
  cut("packages/process/src/index.ts", "export function createShutdown(", None),
  "<p>Small file, four TypeScript idioms: <code>??=</code> (assign only if currently null/undefined) makes shutdown run <em>once</em>, so a second signal cannot crash it; <code>Promise.race</code> puts a deadline on the work (Docker sends SIGKILL ten seconds after SIGTERM); <code>as const</code> keeps <code>\"done\"</code> a literal type instead of widening to <code>string</code>; and <code>exit</code> is a parameter, which is why this is testable without killing the test runner.</p>",
  "<p>In <span class='mono'>main.ts</span> the steps are written <code>() =&gt; server.close()</code>, not <code>server.close</code>. Passing a method by itself detaches it from its object and loses <code>this</code>; the lint rule <code>unbound-method</code> caught exactly that. (An object of closures, section 2, has no such problem.)</p>",
  vs([("<code>/health</code>: is the process up? (never touches the database)", "Actuator liveness", "a liveness route"),
      ("<code>/ready</code>: can it do its job? (<code>select 1</code>) drives the container healthcheck", "Actuator readiness", "a readiness route")], head=("Probe", "Spring", "FastAPI")),
  case("Postgres was listening on every network interface, with its password in the repo.",
       "<p>Compose published the port on <code>0.0.0.0</code> and the superuser password was a committed default. On any shared network, anyone could have connected as the database owner. Now ports bind to <code>127.0.0.1</code>, compose contains no passwords and refuses to start without them, and <span class='mono'>init.sh</span> generates random ones into the git-ignored <span class='mono'>.env</span>.</p>"))

section("role", "9 · Least privilege in the database",
  "<p>The API does not connect as the database owner. A one-shot <span class='mono'>migrate</span> step runs as the owner, applies migrations, and provisions a login role that can read and write data and do <em>nothing else</em>: no schema changes, no migration history, no temp tables, no other databases. Tests prove each refusal (<code>42501 insufficient_privilege</code>).</p>",
  cut("packages/db/src/index.ts", "function scramVerifier(password: string): string {", "/**\n * Creates (or resets)"),
  "<p>Role DDL cannot take bind parameters, so a password would have to be written into the SQL text, where a failing statement copies it into the server log. Instead the client computes what Postgres would store anyway, a SCRAM verifier, and sends that. About ten lines of <span class='mono'>node:crypto</span>.</p>",
  case("Setting what you name is not the same as resetting.",
       "<p>The first provisioning ran <code>alter role ... nosuperuser nocreatedb</code>. A reviewer created a role with <code>BYPASSRLS</code>, replication and a dangerous role membership, ran our provisioning over it, and everything it had not named <em>survived</em>. The test could not have caught it: it always provisioned a brand-new role. Now every attribute is reset and memberships are revoked, and the test starts from a deliberately over-privileged role. <em>Test against the dirty state, not the clean one.</em></p>"))

section("limits", "10 · What the type system could not see",
  "<p>Every bug below passed <code>tsc</code> in strict mode, the linter and the first round of tests. They were found by a second pass whose only job was to refute \"done\". Types prove shapes; they say nothing about whitespace, time, memory, networks or privileges.</p>",
  vs([("whitespace-only name stored, then unreadable forever", "validation only on the read side", "parse before the write; DB check on the trimmed value"),
      ("NUL byte in a name became a 500", "contract looser than Postgres", "refuse control characters in <code>Name</code>"),
      ("idle connection killed by Postgres crashed the process", "no <code>pool.on('error')</code> listener", "add one; log the message only (the object carries the password)"),
      ("two processes migrating at once", "bookkeeping table created outside the lock", "create it inside the advisory lock"),
      ("<code>-c search_path=${schema}</code> took extra settings", "libpq options are space-separated", "plain identifiers only"),
      ("200 MB body inflated memory 14x", "no body limit", "64 KB cap, 413"),
      ("database open to the local network", "port on 0.0.0.0 + committed password", "127.0.0.1, generated secrets"),
      ("role kept privileges across re-provisioning", "set, not reset", "reset everything; test a dirty role"),
      ("<code>NODE_ENV=test</code> enabled dev auth", "\"not production\" is too broad", "one literal value; unset means production"),
      ("next route would have been public", "auth opt-in per prefix", "fail closed with an allowlist"),
      ("wrong wiring in main.ts stayed green", "tests injected the dependency", "run the real entry point in a child process"),
      ("four strings verified as one token", "lenient base64url decoding", "require the canonical encoding")], head=("What went wrong", "Why", "Fix")),
  note("<strong>The habit to take away:</strong> after every test passes, ask \"what production change would make this test fail?\" and try it. If nothing does, the test proves nothing. That is mutation-checking, and it caught a test of mine that broke two rules at once and so could not notice when one was deleted."))

toc = "".join(f'<li><a href="#{sid}">{title}</a></li>' for sid, title, _ in S)
sections = "".join(f'<section id="{sid}"><h2>{title}</h2>{body}</section>' for sid, title, body in S)
style = re.search(r"<style>.*?</style>", (root / "docs/handbook/lesson-0.template.html").read_text(), re.S).group(0)
page = (root / "docs/handbook/lesson-1.template.html").read_text()
page = page.replace("{{STYLE}}", style).replace("{{TOC}}", toc).replace("{{SECTIONS}}", sections).replace("{{COMMIT}}", commit)
(root / "docs/handbook/lesson-1.html").write_text(page)
print("built", len(page), "bytes at", commit)
