"""Builds docs/handbook/lesson-4.html. Every code block is cut from the real repo by anchor text,
so the page cannot show code that does not exist; a missing anchor fails the build."""
import html, os, pathlib, re, subprocess
here = pathlib.Path(__file__).resolve()
root = pathlib.Path(os.environ.get("NOON_ROOT") or (here.parents[2] if (here.parents[2] / "SPEC.md").exists() else pathlib.Path.cwd()))
out = pathlib.Path(os.environ.get("NOON_OUT") or root / "docs/handbook")
commit = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=root, capture_output=True, text=True).stdout.strip()

def cut(path, start, end=None, include_end=False):
    src = (root / path).read_text()
    i = src.index(start)
    j = len(src) if end is None else src.index(end, i + len(start)) + (len(end) if include_end else 0)
    body = src[i:j].rstrip()
    return (f'<p class="label">From <span class="mono">{path}</span></p>'
            f'<div class="scroll"><pre><code>{html.escape(body)}</code></pre></div>')

def vs(rows, head=("TypeScript (this repo)", "Java", "Python")):
    body = "".join("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in rows)
    return f'<div class="scroll"><table><tr>{"".join(f"<th>{h}</th>" for h in head)}</tr>{body}</table></div>'

def case(title, body): return f'<div class="break"><p class="label">Case study · found by review, by a verifier, or by a test that flaked</p><p><strong>{title}</strong></p>{body}</div>'
def note(body): return f'<p class="note">{body}</p>'
m = lambda s: f"<span class='mono'>{s}</span>"

S = []
def section(sid, title, *parts): S.append((sid, title, "".join(parts)))

section("map", "The map: a document becomes code, and code becomes a running page",
  "<p>Epic 4 closes half of keystone 8: <strong>one document is one generated TSX file of a fixed shape, and the same document is always the same bytes.</strong> The other half, reading a file back into ops, is epic 5. What this epic adds around that one pure function is a running page: a container per document that serves the file with the customer's own dev server, a job that keeps the file in step with the document, and a frame on the canvas that shows it. Nothing in the room changed. The preview is one more peer, and it never writes.</p>",
  vs([("1", m("packages/codegen/src/index.ts"), "<code>generate(doc, manifest)</code>: total, deterministic, one file whose only export is <code>Page</code>"),
      ("2", m("apps/api/src/app.ts"), "<code>POST /documents/:id/preview</code>: one <code>INSERT</code> under a per-org cap; the job row IS the preview; 201 even when Redis is away"),
      ("3", m("apps/worker/src/main.ts"), "<code>WORKER_QUEUE=sandbox</code>: the only process holding the Docker socket drains this queue, four... eight at a time"),
      ("4", m("apps/worker/src/preview.ts"), "the handler joins the room as a silent peer, projects from <code>peer.confirmed</code>, and loops: alive? moved? anyone here?"),
      ("5", m("apps/worker/src/sandbox.ts"), "<code>startSandbox</code>: one container per document, single-flight, port chosen once, ready probed from inside"),
      ("6", m("apps/worker/sandbox/Dockerfile"), "baked <code>node_modules</code>, the container's own clone on <code>noon/&lt;id&gt;</code>, a preview entry of ours wrapped around the customer's Vite"),
      ("7", m("apps/worker/src/sandbox.ts"), "<code>pushPage</code>: <code>docker exec cat &gt; \"$PAGE\"</code>, ~20 ms; Vite hot-updates, React keeps its state"),
      ("8", m("apps/web/src/Preview.tsx"), "asks <code>GET .../preview</code> once a second, never caches the URL; an iframe with an opaque origin, keyed on the URL"),
      ("9", m("apps/worker/src/sandbox.ts"), "<code>reapSandboxes</code>: every 30 s, its own pool only, list Docker first and ask Postgres second")], head=("Step", "Where", "What happens")),
  "<p>Four ideas carry the epic. <strong>Choose the literal from the value, never from what a schema claims</strong> (section 1). <strong>Uniqueness is not ownership</strong> (section 3). <strong>A child process, like a promise, needs an end from outside</strong> (section 4). And <strong>every resource needs an owner label before it gets a reaper</strong> (section 6). Sections 7 and 8 are about a browser security boundary that broke the design twice before it held.</p>",
  vs([("a pure function from a tree to one source file", "JavaPoet, or a template engine with a sorted walk", "<code>ast.unparse</code>, or Jinja2 with the same discipline"),
      ("a dev server in a container per document, driven over the docker CLI", "Testcontainers' <code>GenericContainer</code>; <code>docker-java</code>", "<code>testcontainers-python</code>; the <code>docker</code> SDK"),
      ("a file pushed with <code>docker exec</code> on stdin", "<code>ProcessBuilder</code> and its <code>OutputStream</code>", "<code>subprocess.run(input=...)</code>"),
      ("a reaper on a timer, scoped by a label", "a <code>@Scheduled</code> cleanup; Testcontainers' ryuk with a session label", "a beat task; the same label idea")], head=("This repo", "Java world", "Python world")))

section("codegen", "1 · One document, one file, the same bytes",
  "<p>The first decision is what <em>deterministic</em> has to mean here. Not \"the same on my machine today\": epic 5 opens a pull request whose file must equal a fresh generation, and a sandbox pushes the file into a container on every confirmed op. A generator that sorted differently on two machines would show a diff that nobody made.</p>",
  cut("packages/codegen/src/index.ts", "/**\n * Keystone 8:", "const BANNER"),
  "<p>So the walk starts at <code>rootId</code> and never at the key order of <code>doc.nodes</code>; props are written in name order; the import line is sorted; and nothing reads the clock, the random generator or the environment. The walk is an explicit stack rather than recursion, for a reason that is not style: a document restored from a snapshot can be deeper than any call stack, and the room's depth cap is the room's rule, not this function's.</p>",
  cut("packages/codegen/src/index.ts", "  // An explicit stack, not recursion", "    const id = frame.open;"),
  "<p>The file exports the page component and nothing else. That is not tidiness either. The sandbox learning test measured that Vite's Fast Refresh keeps React state across an edit only while a module exports components alone; one extra export (a <code>BUILD_ID</code>, say) turns every edit into a full page reload, and E4.3's promise of \"within 3 s without a reload\" rests on this line:</p>",
  cut("packages/codegen/src/index.ts", "  const importLine =", "/**\n * One prop value"),
  cut("packages/codegen/src/index.test.ts", "test(\"the file exports the page component and nothing else\"", "test(\"every element carries its node id\""),
  "<p><strong>Refusing is the point.</strong> A document can outlive its design system: a component dropped, a prop renamed, a type changed. Generating <em>without</em> the prop would compile, and epic 5 would read the file back as a document with that prop deleted. So every drift has a name, and the function is total: it never throws, because its caller is a queue handler, and an exception there is a job that fails as <code>internal</code> while a reason is something a person can be shown.</p>",
  cut("packages/codegen/src/index.ts", "// ponytail: not exported until a caller needs", "type Frame ="),
  cut("packages/codegen/src/index.ts", "export function generate(", "function project("),
  "<p>The property test is the one that kills every future silent drop at once: over four thousand seeded ops, whenever a document generates, the file names exactly the props each node holds.</p>",
  cut("packages/codegen/src/index.test.ts", "test(\"whenever a document is generated", "// --- found by the E4.1 verifier"),
  "<p>And F13 is proven the way a customer's CI would prove it: the generated file is written beside the sample app's own pages and the sample app's own <code>tsc</code> is run on it.</p>",
  cut("packages/codegen/src/sample-app.int.test.ts", "// F13: what the canvas generates must compile", "const add ="),
  vs([("<code>JSON.stringify(value)</code> as a JavaScript string literal", "JavaPoet's <code>$S</code>; <code>StringEscapeUtils</code>", "<code>json.dumps</code>; <code>repr</code> for Python source"),
      ("<code>String(-0)</code> is <code>\"0\"</code>: a different number", "<code>Double.toString(-0.0)</code> is <code>\"-0.0\"</code>: the sign survives", "<code>repr(-0.0)</code> is <code>'-0.0'</code>: the sign survives"),
      ("<code>typeof x === \"string\"</code> before anything becomes code", "the static type, or <code>instanceof String</code>", "<code>isinstance(x, str)</code>"),
      ("<code>Object.keys</code> misses non-enumerable and Symbol keys; <code>Reflect.ownKeys</code> sees them", "reflection sees private fields that getters do not show", "<code>vars()</code> misses <code>__slots__</code> and properties"),
      ("<code>push(...arr)</code> overflows the stack at about 130 000 arguments", "varargs build one array: heap-bound, not stack-bound", "<code>f(*args)</code>: no fixed cap, but the C stack still has one")]),
  case("A lying <code>toString</code> answered \"Button\" to the identifier check and code to the template; the file ran <code>alert(1)</code>.",
       "<p>The E4.1 verifier built a manifest whose component name was an object with a <code>toString</code> that answers \"Button\" the first time and <code>Button /&gt;; alert(1); &lt;Button</code> the second. The identifier regex saw the first answer; the template literal saw the second. The lesson is general: <em>a value converted to a string twice can answer twice.</em> Anything that becomes code is checked with <code>typeof</code> before it is looked at, and every literal is chosen from the value's own type, never from what the manifest says the value is. Asking <code>checkProp</code> and believing it would turn a prop type nobody wrote a case for into a way to write arbitrary source.</p>"
       + cut("packages/codegen/src/index.ts", "      // A string, or nothing: a value that is converted", "      if (node.component === ROOT_COMPONENT)")
       + cut("packages/codegen/src/index.ts", "        // The literal is chosen from the VALUE", "      const missing =")
       + cut("packages/codegen/src/index.test.ts", "test(\"a component name that is not a string", "test(\"-0 is written")),
  case("<code>-0</code> was written as <code>0</code>, and <code>NaN</code> would have compiled.",
       "<p><code>String(-0)</code> is <code>\"0\"</code>: a different number, and <code>validate()</code> accepts <code>-0</code>, so the file must carry it. <code>String(NaN)</code> is the bare identifier <code>NaN</code>, which compiles and is not the document's value; so is <code>Infinity</code>. Every value is a JSX <em>expression</em>, never a quoted attribute, because JSX string attributes have no backslash escapes. The whole of the value-to-source rule fits in one function, and its final fallback is documented as unreachable rather than faked as tested:</p>"
       + cut("packages/codegen/src/index.ts", "/**\n * One prop value as JavaScript source")),
  case("A hidden prop was dropped while the file was called complete.",
       "<p><code>Object.keys</code> lists the enumerable string keys. <code>Object.hasOwn</code>, which the required-prop check uses, sees a non-enumerable one too. So a prop defined with <code>enumerable: false</code>, or keyed by a Symbol, passed the required check and vanished from the file: a silent drop, the one thing this module exists to prevent. One comparison refuses both: <code>Reflect.ownKeys</code> counts every own key, Symbols included.</p>"
       + cut("packages/codegen/src/index.ts", "      // Every OWN key, not only the enumerable strings", "      for (const key of Object.keys(node.props).sort())")
       + cut("packages/codegen/src/index.test.ts", "test(\"a prop that is not enumerable", "test.each<[string, () => unknown]>([")),
  case("A well-formed document with 200 000 children was called malformed.",
       "<p>doc-model's <code>subtree()</code> collected children with <code>stack.push(...children)</code>. Spreading passes every child as an <em>argument</em>, and about 130 000 of them overflow the call stack: <code>RangeError</code>, caught by the net, reported as <code>malformed_doc</code>. A loop pushes one at a time and has no such limit. The generator's own walk was already iterative; the helper it called was not.</p>"
       + cut("packages/doc-model/src/index.ts", "function subtree(doc: Doc, id: string)", "  return [...seen];\n}", True)
       + cut("packages/codegen/src/index.test.ts", "test(\"a very wide document is generated", "// --- fixtures that deliberately")),
  note("<strong>Principal-level point:</strong> the generator trusts its inputs' <em>shapes</em> (the contract, checked by doc-model) and nothing about their <em>values</em>. Both names that become code (a component, a prop) are checked against an identifier regex after they have been found in the manifest, and every value is written from its runtime type. A schema tells you what something should be; only the value tells you what it is."))

section("container", "2 · A container per document, ready in a second",
  "<p>The sandbox is the sample app's own dev server, in a container, one per document. The image is built with the sample app as its context, so nothing of this monorepo is in it. Two facts from the learning test shape the Dockerfile: <code>node_modules</code> is <em>baked</em> at build time (first HTTP 200 in about 0.35 s, against 10 to 18 s when installed at container start), and it is installed inside Linux, because Vite's bundler is a native binary per platform.</p>",
  cut("apps/worker/sandbox/Dockerfile", "# The sandbox: the sample app's own dev server", "# The seed repository"),
  "<p>Each container makes its <em>own clone</em> of the seed, on the document's working branch <code>noon/&lt;id&gt;</code>, checked out over the baked <code>node_modules</code>. Only on the first start: a restarted container keeps its working tree, which is the whole point of restarting rather than recreating. \"Cloned\" means HEAD resolves, not \".git exists\", because a clone killed halfway leaves a <code>.git</code> behind.</p>",
  cut("apps/worker/sandbox/Dockerfile", "# The container's OWN clone", "COPY <<'EOF' /home/node/preview/index.html"),
  cut("apps/worker/sandbox/Dockerfile", "COPY --chmod=755 <<'EOF' /home/node/start.sh"),
  "<p>On the worker's side, <code>sandbox.ts</code> starts one and says where it answers. Docker itself is the registry: the container's name is the document's, and there is no table that can fall out of step with what is running.</p>",
  cut("apps/worker/src/sandbox.ts", "/**\n * The sandbox: one container per document working branch", "const UUID"),
  "<p><strong>The port is chosen once.</strong> Docker's own choice (<code>-p 127.0.0.1::5173</code>) is re-rolled on every <code>docker start</code> (measured: 49755, then 49767). Vite's client heals a lost connection by polling the server it was loaded from and reloading when it answers, on the <em>same origin</em> only. So the worker picks the host port, from the document id so two documents rarely want the same one, and writes it into the container's configuration, where a restart finds it.</p>",
  cut("apps/worker/src/sandbox.ts", "/**\n * Starts the document's sandbox, or finds the one already running", "export function startSandbox"),
  cut("apps/worker/src/sandbox.ts", "/** Makes sure the container exists and is running", "/** True when the container exists and is now running"),
  "<p>Read the last sentence of the first comment again: <em>a stopped container does not hold its port</em>. If something takes it meanwhile, <code>docker start</code> fails and the sandbox comes back fresh on another one. The port is a preference the system keeps when it can, and the URL is read after ready, from the container that answered, every time. Section 7 is where the canvas learns to live with that.</p>",
  "<p><strong>Ready is asked from inside.</strong> The worker runs in compose, where <code>localhost</code> is not the host, and the port is published on the host's loopback only. A probe run with <code>docker exec</code> inside the container works wherever the caller is. Only the probe's own \"not yet\" (exit code 3) is polled; any other failure is an answer.</p>",
  cut("apps/worker/src/sandbox.ts", "/**\n * Polls the dev server from INSIDE the container", "/**\n * One docker CLI call"),
  cut("apps/worker/src/sandbox.int.test.ts", "test(\"a stopped sandbox comes back on the SAME url", "test(\"a clone that died halfway"),
  vs([("<code>set -e</code> in a start script; one command per line", "a <code>Dockerfile</code> <code>RUN</code> chain has the same trap; Gradle's exec tasks fail per task", "<code>subprocess.run(check=True)</code> per call, never one shell string"),
      ("the host port chosen from the document id, stepping on collision", "the same with any container client; Testcontainers picks random ones on purpose (tests, not previews)", "the same"),
      ("a probe with <code>docker exec node -e fetch(...)</code>", "Testcontainers' <code>Wait.forHttp</code>, from the host", "<code>wait_for_logs</code>, or a host-side HTTP wait"),
      ("an exit code chosen so nothing else produces it", "an exit code per outcome, the same idea", "the same")]),
  case("A clone that failed went on to serve an empty app.",
       "<p>The first start script had <code>git init &amp;&amp; git remote add &amp;&amp; git fetch &amp;&amp; git checkout</code> on one line under <code>set -e</code>. The fetch failed (the test points <code>SEED_REPO</code> at a path that does not exist), and the script carried on to start Vite over nothing. <code>set -e</code> exits on a failing <em>statement</em>; inside an <code>&amp;&amp;</code> chain, only the last command's status is the statement's, so a failure anywhere before it is ignored by design. One command per line, and now a failed clone is a container that exits with git's words in its logs, which the start reports at once instead of polling out the deadline:</p>"
       + cut("apps/worker/src/sandbox.int.test.ts", "test(\"a sandbox whose dev server can never start says so at once", "// --- E4.2b:")),
  case("An exec that raced the container's death had an EMPTY stderr.",
       "<p>The first ready loop decided \"the container is gone\" by matching Docker's error text. Under load, an exec that hit the container in the moment of its death failed with no message at all, and the loop polled it for a minute. <em>Ask the system, do not parse its prose:</em> on any failure that is not the probe's own \"not yet\", the loop asks <code>container inspect</code> whether it is running, and an exited container is reported with its logs, stderr included, because git's \"fatal\" lands there.</p>"
       + cut("apps/worker/src/sandbox.int.test.ts", "test(\"a sandbox removed while it is starting", "test(\"a sandbox whose dev server can never start")))

section("ownership", "3 · Uniqueness is not ownership",
  "<p>Docker refuses a second container with the same name. It is tempting to read that as \"one container per document, solved\". The E4.2a verifier ran ten concurrent starts of one document, and the starts <em>removed each other's containers</em>. The trace: one caller wins <code>docker run</code>. The other nine see a name conflict, take the next turn, find the container and it is not running yet, try <code>docker start</code>, and get \"port not available\", because the winner holds it. The code for \"port taken while stopped\" then does what it says: removes the leftover and tries the next port. The leftover was the winner. Callers got URLs nothing listened on, and once document A's URL served document B.</p>"
  "<p>The name stops two <em>containers</em>. It says nothing about who may <em>act</em> on the one that exists. That is a different question, answered at two scopes: inside a process, concurrent starts of one document share one attempt; across processes, only the one holding the document's unfinished <code>sandbox</code> job starts it.</p>",
  cut("apps/worker/src/sandbox.ts", "export function startSandbox(documentId", "async function start("),
  cut("packages/db/migrations/0008_sandbox_jobs.sql", "-- E4.2b: the `sandbox` queue."),
  "<p>The single-flight map is the whole in-process answer: a <code>Map</code> from document to the promise of its attempt, deleted in <code>finally</code>. Ten callers get the same promise, so nine of them never touch Docker. Across processes, the same partial unique index pattern as lesson 3's one AI run per document: the row is the right to start, and Postgres decides who holds it. With those two in place, the \"taken by something else while stopped\" branch becomes safe, and its comment says exactly under what condition:</p>",
  cut("apps/worker/src/sandbox.ts", "/** True when the container exists and is now running", "/**\n * Puts the generated file"),
  "<p>And the URL is read <em>after</em> ready, from the container that answered, never remembered from before an await that somebody else may have finished differently:</p>",
  cut("apps/worker/src/sandbox.ts", "async function start(documentId", "/** Makes sure the container exists"),
  cut("apps/worker/src/sandbox.int.test.ts", "test(\"one container per document: ten concurrent starts", "test(\"a stopped sandbox comes back"),
  vs([("a <code>Map&lt;id, Promise&gt;</code> for single-flight, deleted in <code>finally</code>", "<code>ConcurrentHashMap.computeIfAbsent(id, k -&gt; CompletableFuture...)</code>; Guava's <code>LoadingCache</code> does it for you", "a <code>dict[str, asyncio.Task]</code>; or an <code>asyncio.Lock</code> per key"),
      ("the JavaScript event loop makes get-then-set atomic with no lock", "two threads can both miss the map: <code>computeIfAbsent</code> or a lock", "the same as JS under asyncio; a real lock under threads"),
      ("a partial unique index as the cross-process rule", "the same SQL through Flyway; JPA cannot express it", "the same; Django <code>UniqueConstraint(condition=...)</code>"),
      ("a number read after the await, not before", "the same rule: a value read before a blocking call is stale after it", "the same")]),
  note("<strong>The rule, in one line:</strong> uniqueness is not ownership. A unique name, a unique key, a unique port can tell you that two things cannot coexist. None of them tells a loser that what it found belongs to the winner. One starter per resource, at every scope that can start one."))

section("process", "4 · A child process needs an end from outside",
  "<p>Lesson 3's theme was that anything a program awaits needs an end from outside. A child process is the sharpest case, because it lives outside the event loop: a promise that never settles is a leak, but a <code>docker</code> CLI that never exits is a leak <em>and</em> a process holding the parent alive. Every docker call here ends at the start's deadline, and the abort is handled by hand.</p>",
  cut("apps/worker/src/sandbox.ts", "/**\n * One docker CLI call, resolving with what it printed"),
  "<p>Three things in twenty lines. <strong>The abort listener is removed in the callback</strong>, or every finished call would leave a listener on a long-lived signal. <strong>The error names the subcommand and quotes stderr</strong>, because \"exit 1\" tells nobody anything, and <code>docker logs</code> replays the container's stderr on the CLI's stderr, so for that one subcommand both streams are the answer. <strong>stdin has an error listener</strong>, for a reason that is a case study below.</p>",
  cut("apps/worker/src/sandbox.ts", "/**\n * Puts the generated file into the running sandbox", "/** Is the document's container running?"),
  "<p><code>pushPage</code> is how the generated file gets in: <code>docker exec --interactive &lt;name&gt; sh -c 'cat &gt; \"$PAGE\"'</code>, with the file on stdin. The target path is the container's own <code>PAGE</code> environment variable, set when it was created, so nothing from the caller reaches the shell. The learning test measured this the fastest and the most reliable of three ways in (about 20 ms; a bind mount missed updates two or three times in ten).</p>",
  vs([("<code>execFile</code>'s <code>signal</code> sends SIGTERM on abort, whatever <code>killSignal</code> says (Node 24, measured)", "<code>Process.destroy()</code> is SIGTERM; <code>destroyForcibly()</code> is SIGKILL, and you choose", "<code>Popen.terminate()</code> vs <code>kill()</code>; <code>run(timeout=)</code> kills"),
      ("<code>child.kill(\"SIGKILL\")</code> from our own abort listener", "<code>onExit().orTimeout(...)</code> then <code>destroyForcibly()</code>", "<code>wait_for(proc.wait(), t)</code> then <code>proc.kill()</code>"),
      ("a write to a dead child's stdin emits <code>error</code> (EPIPE); unheard, it is an uncaught exception", "an <code>IOException</code> on the <code>OutputStream</code>, where you write", "<code>BrokenPipeError</code>, where you write"),
      ("a live child keeps the event loop alive", "a child does not keep the JVM alive; a non-daemon thread does", "the interpreter exits; the child is orphaned")]),
  case("A docker CLI that ignores SIGTERM outlived the call and kept the worker alive.",
       "<p>The first version used <code>execFile</code>'s own <code>signal</code> option with <code>killSignal: \"SIGKILL\"</code>. Measured on Node 24: the abort sends SIGTERM regardless. A CLI that ignores SIGTERM (a wedged daemon's client will) then outlives the call, and the event loop with it. So the abort is listened for here and the kill is explicit. The test's stub traps TERM and records its pid; after the deadline, <code>process.kill(pid, 0)</code> must throw ESRCH. The stub gets a 3 s window rather than 0.5 s, because macOS scans a brand-new executable on its first run and a stub killed before it ever ran would prove nothing.</p>"
       + cut("apps/worker/src/sandbox.int.test.ts", "test(\"a docker CLI that ignores SIGTERM is killed anyway", "test(\"a sandbox that runs but never answers")),
  case("A child that exited before reading its stdin would have killed the worker (EPIPE).",
       "<p>Found by the E4.2b re-verify. <code>pushPage</code> writes the file into the CLI's stdin. If the CLI exits first (the container is gone, the daemon refused, the CLI was just killed at the deadline), the write fails with EPIPE, and a stream error nobody listens for is an uncaught exception: the whole sandbox worker dies, every preview with it, over one push that the exit code had already reported as failed. One listener, and the exit code is the only reporter. The test pushes 4 MB (bigger than a pipe's buffer, so the write is still in flight when the child is gone) at a docker that exits at once, and then waits 200 ms for the exception that must not come.</p>"
       + cut("apps/worker/src/sandbox.int.test.ts", "test(\"a docker that exits without reading the page", "test(\"a push to a sandbox that is not running")),
  case("A wedged Docker daemon is abandoned at the deadline; a cancelled start ends at once.",
       "<p>A CLI that takes its arguments and waits for ever (the stub is <code>exec sleep 3600</code>) is ended by the deadline alone, and the error says which deadline. A cancel is a different name, because a stopping worker and a broken sandbox are different stories for the row.</p>"
       + cut("apps/worker/src/sandbox.int.test.ts", "test(\"a docker that never answers is abandoned at the deadline", "test(\"a docker CLI that ignores SIGTERM")))

section("queue", "5 · The sandbox queue: a job is the right to a container",
  "<p>The preview is a job, on a queue of its own, with the same machinery as an AI run: a row in <code>jobs</code> is the truth, a message is a pointer, <code>claim()</code> is one <code>UPDATE</code>, the sweep re-offers what Redis lost. What is new is what the job <em>is</em>. An AI run ends when the model does. A sandbox job runs for as long as somebody has the document open, and the row is the right to start and keep that document's container (section 3's index).</p>",
  cut("apps/worker/src/preview.ts", "/**\n * The `sandbox` queue's handler", "export function createPreviewHandler"),
  "<p>The handler joins the room as a peer that never writes and never sets a presence, and it projects from <code>peer.confirmed</code>: the optimistic tree holds ops the server may still refuse, and a preview of a document that never existed is worse than a preview a moment late. Then one loop with one tick, because every question in it needs a clock anyway and a loop has exactly one place where it ends.</p>",
  cut("apps/worker/src/preview.ts", "    try {\n      await start();", "\n    } catch (err) {\n      if (!signal.aborted)"),
  "<p>Read the order. Told to stop? Then the peer closed for good? Then anyone here? Then alive? Then moved? The push is paced 300 ms apart, which is not logic but the learning test's measured calibration: unpaced pushes outran Vite's watcher in the browser while the file itself was right. And a URL is reported <em>null</em> before a restart, so the canvas stops framing a dead port and says \"rebuilding\".</p>",
  cut("apps/worker/src/preview.ts", "    /**\n     * The address to announce once the sandbox HOLDS", "    const peer = connectPeer("),
  "<p>What a running job has to say before it ends goes through <code>report()</code>, validated with the contract the reader will use, and only while the job is running. And what is in use, for the reaper, is a question the database answers across every org:</p>",
  cut("packages/db/src/index.ts", "      async report({ jobId, orgId }, output)", "    }),\n\n    getDocumentForMember"),
  "<p>The worker gained two lines for this epic and both are about a partial map. A process drains only the queues it has handlers for, and it checks the handler <em>before</em> it claims:</p>",
  cut("apps/worker/src/worker.ts", "/** One function per queue.", "export type RunningWorker"),
  cut("apps/worker/src/worker.ts", "  async function run(data: unknown)", "    // ponytail: a poll per running job"),
  cut("apps/worker/src/worker.ts", "  /**\n   * Jobs of each queue at once", "  sweepMs?: number;"),
  cut("apps/worker/src/preview.int.test.ts", "test(\"the preview follows the CONFIRMED document", "test(\"a sandbox that dies is started again"),
  vs([("a loop with one tick; every question has a clock", "a <code>@Scheduled(fixedDelay)</code> method per question, and four clocks", "an <code>asyncio</code> loop with one <code>sleep</code>, the same"),
      ("project from <code>peer.confirmed</code>, never the optimistic tree", "read committed, not your own uncommitted write", "the same"),
      ("<code>JobFailure(\"sync_unreachable\")</code>: a name for the row", "a checked exception per reason, mapped to a status", "an exception class per reason"),
      ("a handler map that is <code>Partial&lt;Record&lt;QueueName, ...&gt;&gt;</code>", "<code>EnumMap</code> with absent keys; a <code>@Profile</code> per listener", "<code>celery -Q sandbox</code>: the process names its queues")]),
  case("A container that died between the liveness check and the push failed the job instead of restarting it.",
       "<p>The loop asks \"alive?\" once a second and \"moved?\" every tick. A container killed in between (OOM, say) made the push throw, and the throw ended the job as <code>internal</code>, with the document open and nobody left to bring the sandbox back. Now a failed push asks whether the container is running: if it is, the failure is real; if not, the liveness check is forced on the next tick, which restarts it and pushes the page after. The test's docker is a script that removes the container the first time it is asked to exec a push.</p>"
       + cut("apps/worker/src/preview.int.test.ts", "test(\"a container that dies DURING a push", "test(\"a handler whose peer is closed for good")),
  case("A peer closed for good froze <code>others</code>, and the job never idled out.",
       "<p>The idle rule is \"nobody present for a minute\", read from <code>peer.others</code>. A peer the room closes for good (4404 for a document that is not there, 4500, a protocol error) keeps its last <code>others</code>, and a job that still \"sees\" someone holds its container for ever. A closed peer is a named failure now, the same name lesson 3 gave the AI run when the sync server went away.</p>"
       + cut("apps/worker/src/preview.int.test.ts", "test(\"a handler whose peer is closed for good")),
  case("A worker claimed a job of a queue it had no handler for, and failed it as <code>internal</code>.",
       "<p>The handler lookup used the row's queue, after the claim. A sandbox ref delivered on the AI queue (misrouted, or forged by anyone holding the Redis password) was claimed by the AI worker, found no handler, and was finished as <code>failed</code>: someone else's job, ended by a process that could never have run it. Checking the handler before the claim leaves it queued for its own worker. The claim is still the only way to start; it is just not the first question.</p>"
       + cut("apps/worker/src/run.int.test.ts", "  // A sandbox ref delivered on the AI queue (misrouted", "  await aiOnly.close();")))

section("pools", "6 · One queue per process, one pool per stack, a reaper with an owner",
  "<p>Two decisions about <em>who runs what</em>, both made by a security review before the code was written. First: a worker process drains exactly one queue. The sandbox queue needs the Docker daemon, whose socket is root on the host. The AI queue runs a model's subprocess under a capability ceiling. They never share a process, because one escape from the subprocess would otherwise be a hand on the socket.</p>",
  cut("apps/worker/src/config.ts", "  // ONE queue per process. The sandbox queue needs the Docker daemon", "  // Each running sandbox job holds a container"),
  cut("docker-compose.yml", "  worker-sandbox:", "    healthcheck:"),
  cut("apps/worker/src/run.int.test.ts", "test(\"a worker drains only the queues it has handlers for", "  // A sandbox ref delivered on the AI queue"),
  "<p>Second: every sandbox carries a <em>pool</em> label, and a reaper removes only its own pool's. This one was learned the hard way: the compose stack, <code>make clean-clone</code> and every test file share one Docker daemon, and the compose reaper deleted the test suite's sandboxes mid-run. Same daemon, same label, no owner.</p>",
  cut("apps/worker/src/sandbox.ts", "  /**\n   * Whose sandboxes these are", "  /** The docker CLI."),
  cut("apps/worker/src/main.ts", "function sandboxHandlers(): Handlers {", "const worker = await startWorker("),
  "<p>The reaper itself is a dozen lines, and the order of its two questions is the case study below:</p>",
  cut("apps/worker/src/sandbox.ts", "/**\n * The reaper: removes every sandbox", "async function portOf"),
  cut("apps/worker/src/sandbox.int.test.ts", "test(\"the reaper sweeps only its own pool", "test(\"the reaper lists the containers BEFORE"),
  vs([("one process per queue, chosen by <code>WORKER_QUEUE</code>", "one deployable per role; Spring profiles per listener", "<code>celery worker -Q ai</code> and <code>-Q sandbox</code> as two services"),
      ("a <code>noon.sandbox=&lt;pool&gt;</code> label as the owner", "Testcontainers labels every container with a session id, and ryuk reaps by it", "the same, in <code>testcontainers-python</code>"),
      ("the reaper takes a function, so the order of its questions is its own", "a <code>Supplier&lt;Set&lt;String&gt;&gt;</code> for the same reason", "a callable"),
      ("one reaper, one sweep at a time, on one timer", "<code>@Scheduled</code> with a lease (ShedLock) once there are two instances", "celery beat with a lock; E7 for us")]),
  case("The reaper asked Postgres, then listed the containers: a job starting in between lost its container.",
       "<p>Found by the E4.2b re-verify. The first reaper took a <code>Set</code>: <code>main.ts</code> asked Postgres what was in use, then called it with the answer, and the reaper listed the containers. Between the answer and the list, a sandbox job started a document's container. The list had it; the answer did not; it was removed mid-start, and the job that owned it found a URL nothing listened on. Reverse the order and the race is gone: a container that is in the list existed before Postgres was asked, so whatever job made it had its row by then and is in the answer. Making the reaper take a <em>function</em> puts the order where it cannot be got wrong by a caller. (That bug is planted in drill 2.)</p>"
       + cut("apps/worker/src/sandbox.int.test.ts", "test(\"the reaper lists the containers BEFORE", "test.each([\"\", \"Has Space\"")),
  note("<strong>Two rules from this section</strong>, each learned by losing something: every resource needs an owner label before it gets a reaper, or one environment's cleanup eats another's; and when a cleanup reads two systems that change under it, read the one it will act on first, and the one that grants exemptions second."))

section("canvas", "7 · The canvas frames the page",
  "<p>E4.3 is the api and the frame. The canvas <code>POST</code>s to make sure a preview is on its way, and <code>GET</code>s, once a second, where it answers. Membership only, like runs. The job row is the preview; the queue only tells a worker to look.</p>",
  cut("apps/api/src/app.ts", "  // F15: the document's running page.", "  app.notFound(notFound);"),
  "<p>Under the route, one <code>INSERT ... SELECT</code> does three things: takes the org and document from the documents table (tenancy from the row, never from the caller), counts this org's other unfinished sandbox jobs against a cap, and lets the partial unique index answer \"already one\" with <code>on conflict do nothing</code>. Then a <em>second statement</em> reads the preview as it now is, because a CTE would share the write's snapshot (lesson 3's cancel bug, remembered).</p>",
  cut("packages/db/src/index.ts", "        openPreview: async ({ documentId, createdBy }) => {", "        getRun: async (documentId, id) =>"),
  cut("packages/db/src/index.ts", "      /** A second statement, after any write", "      // An id that is not a UUID cannot name anything"),
  "<p>The URL only counts while the job runs: a finished job's last address may belong to another document by now. And it is parsed on the way <em>out</em> with the same contract the canvas parses it with on the way <em>in</em>: loopback, http(s), or nothing. A row that says otherwise reads as \"no URL\", never as a 500 and never as a frame of another site.</p>",
  cut("packages/db/src/index.ts", "// The URL only counts while the job runs", "const IDENTIFIER"),
  cut("packages/contracts/src/index.ts", "/**\n * What a running `sandbox` job reports", "// --- Usage (F12)"),
  cut("apps/api/src/preview.int.test.ts", "test(\"the URL is read from the RUNNING job", "test(\"a stored URL that is not a loopback"),
  "<p>The frame. Opened on request, because a preview holds a container (1 CPU, 1 GiB) for as long as the document is open and most visits only edit. The URL is asked for once a second and never kept. No URL while the job is live means the worker is restarting the container: \"rebuilding\". A preview that ended is simply opened again. And the iframe is <em>keyed</em> on the URL: a new address is a new page, and an iframe whose <code>src</code> changes keeps nothing worth keeping.</p>",
  cut("apps/web/src/Preview.tsx", "/**\n * The running page (F15)"),
  cut("apps/web/src/api.ts", "// --- The preview (F15)"),
  vs([("a cap as a count inside the <code>INSERT</code>; a bounded overshoot, named", "<code>SELECT ... FOR UPDATE</code> on the org row makes it exact and serial", "<code>pg_advisory_xact_lock(org)</code>; the same trade"),
      ("a contract applied on the way out of the store and on the way into the UI", "a DTO validated twice: at the repository and at the controller", "a pydantic model at both edges"),
      ("polling once a second from a <code>useEffect</code>, cleaned up on unmount", "the same from any client; SSE is the upgrade", "the same"),
      ("<code>&lt;iframe key={url}&gt;</code>: a new element, not a mutated one", "n/a", "n/a")]),
  case("Two opens in the same instant can both pass the per-org cap.",
       "<p>Not a bug found; a bug <em>declined</em>, and named. The count inside the <code>INSERT</code> is one statement, but two statements in the same instant each count three and each insert a fourth: an org can hold five for a moment, never unbounded. Compare the per-document rule in the same query, which is exact, because it is a unique index and Postgres decides who was first. The comment says what the ceiling is and what the upgrade is (an advisory lock per org). Drill 3's third question is about why the two rules are built differently.</p>"
       + cut("apps/api/src/preview.int.test.ts", "test(\"one org holds at most 4 previews")))

section("origin", "8 · The opaque origin",
  "<p>This section is a browser rule that broke the design twice before it held, and neither break was visible from the code. Every preview is <code>http://127.0.0.1:&lt;port&gt;</code>: the same host, only the port differs. Without an opaque origin, one document's page could read storage another left on a reused port, and outlive the container that set it. So the E4.2a security review required <code>sandbox=\"allow-scripts\"</code> with <em>no</em> <code>allow-same-origin</code>. The canvas does that. The consequences took three fixes.</p>"
  "<p><strong>First break: nothing rendered.</strong> A frame with an opaque origin sends <code>Origin: null</code>, the literal string, on every module request. Vite's default CORS allows any localhost origin and refuses everything else, \"null\" included. The page loaded, its first import was refused, and the frame stayed blank. Measured, in the browser. The E4.2a note said \"lock <code>server.cors</code> to the canvas origin\", which could never have worked: no request from inside the frame ever carries the canvas's origin. The fix is a Vite config of our own, wrapped around the customer's (which may say anything), allowing exactly \"null\" and no real origin. That is also <em>stricter</em> for real sites: another local dev server can no longer read this one's source.</p>",
  cut("apps/worker/sandbox/Dockerfile", "# The dev server's config: OURS, wrapped around the customer's", "COPY <<'EOF' /home/node/preview/placeholder.tsx"),
  cut("apps/worker/src/sandbox.int.test.ts", "test(\"the preview renders inside the canvas's sandboxed iframe", "test(\"a sandbox that was never started"),
  "<p><strong>Second break: it never healed.</strong> The learning test showed Vite's client polling a lost server and reloading when it answered again, on the same origin, in about 1.2 s. Inside the opaque-origin frame that never happens: the client's reconnect goes through a SharedWorker, which the browser refuses to origin \"null\". So a restarted container on the same port would sit behind a frame that polls a server it can never rejoin. The canvas has to load a new URL, and it does exactly when the URL changes; so every start announces a distinct one.</p>",
  cut("learning-tests/sandbox/test.ts", "// 7. \"Killing the container and starting a new one", "\n//\n// ------"),
  cut("apps/worker/src/preview.ts", "      // A new address for every start", "    const peer = connectPeer("),
  "<p><strong>Third: a page left open on a reused port.</strong> A tab opened on the preview directly (not the canvas) has a real origin, and its Vite client <em>does</em> reload when its port answers again. If another document's sandbox took that port meanwhile, the reload would show that document, possibly another org's. The URL names the document it expects, and the sandbox's entry renders nothing for any other:</p>",
  cut("apps/worker/src/sandbox.ts", "/**\n * The address the canvas frames.", "const starting = new Map"),
  cut("apps/worker/sandbox/Dockerfile", "COPY <<'EOF' /home/node/preview/main.tsx", "# The dev server's config"),
  cut("apps/worker/src/sandbox.int.test.ts", "    // A URL naming ANOTHER document (a stale iframe", "    await tab.getByText(\"first\").waitFor();"),
  vs([("<code>sandbox=\"allow-scripts\"</code> without <code>allow-same-origin</code>: origin \"null\"", "language-neutral; a Spring dev meets it as <code>Origin: null</code> in <code>CorsConfiguration</code>", "the same in <code>django-cors-headers</code>"),
      ("<code>cors: { origin: \"null\" }</code>, injected around the customer's config", "an <code>allowedOrigins</code> list that names the literal \"null\"; never <code>*</code> with credentials", "<code>CORS_ALLOWED_ORIGINS = [\"null\"]</code>"),
      ("a per-start <code>&amp;started=</code> so the frame reloads", "a cache-buster with a purpose: a new element, not a fresh fetch", "the same"),
      ("<code>?doc=</code> checked by the page against what it was built for", "an audience check on a token: this page is for this document", "the same")]),
  case("The E4.2a note said \"lock cors to the canvas origin\". It could never work.",
       "<p>It read well and it was wrong, and the way to find out was to run the frame in a real browser and watch the network tab. The lesson is not about CORS. It is that a note from a review is a hypothesis, and the fix that follows it must be <em>measured</em> against the thing it names, not implemented from the note. The ceiling of the fix is named too: any site's opaque-origin frame passes, until the per-document hostname proxy (bead noon-9gz) puts an unguessable name in front of every sandbox.</p>"),
  note("<strong>What the opaque origin bought:</strong> a preview cannot read cookies, storage or service workers, its own or anyone's, and it cannot be the canvas's origin for any purpose. What it cost: a CORS rule of our own, a reload the canvas drives, and a self-heal path (section 2's stable port) that now only matters for tabs opened on the preview directly. Both sides are written down where the next reader will look."))

section("testing", "9 · Testing a program that runs containers",
  "<p>Everything in this epic touches a daemon that is root on the host, takes seconds to answer, and is shared with every other test file and the dev stack. The tests get three things right that the code alone could not.</p>"
  "<p><strong>Docker is a program on PATH, so a fake Docker is a shell script.</strong> A wedged daemon is <code>exec sleep 3600</code>; a stubborn CLI traps TERM; a daemon that loses the container mid-push is a script that removes it before delegating to the real CLI. No mocking library, and the code under test is the real <code>dockerCli</code>. Image variants are built from a two-line Dockerfile on stdin.</p>",
  cut("apps/worker/src/sandbox-testing.ts", "// Shared by the integration tests that run real sandboxes."),
  cut("apps/worker/src/sandbox.int.test.ts", "beforeAll(async () => {\n  await buildImage();", "afterAll(async () => {"),
  "<p><strong>Every file owns its pool and its port range.</strong> The pool, so no reaper (the compose one, another file's) sweeps it. The range, so a test that holds a port on the host cannot collide with another file's sandbox. The e2e layer goes one further: it runs the <em>real</em> sandbox worker from source, in a pool of its own, and stops the compose workers for the duration, because they share the jobs table and would take e2e's jobs into the compose pool.</p>",
  cut("playwright.config.ts", "    // The REAL sandbox worker, from source, in a pool of its own", "    { command: `API_TARGET"),
  cut("e2e/setup.ts", "// The e2e layer shares Postgres and Redis with the dev stack, so the dev stack's WORKERS", "export default function setup"),
  cut("e2e/preview.spec.ts", "test(\"the preview follows an edit within 3 s", "test.describe("),
  "<p><strong>A self-heal test must not be vacuous.</strong> The learning test's first version passed before the kill, because the page already showed what it waited for. The e2e pushes a label a fresh container would never show, kills the container, and waits for that label to come back: only then has the new container been given the document, not merely started.</p>",
  cut("e2e/preview.spec.ts", "test.describe(\"when the container dies\""),
  vs([("a fake docker is a shell script on PATH", "Mockito on a <code>DockerClient</code> interface, or a fake binary the same way", "<code>unittest.mock</code> on <code>subprocess.run</code>, or a fake binary"),
      ("a pool label per test file; a port range per file", "Testcontainers does the label for you; ports are random", "the same"),
      ("the real worker from source under Playwright, printing a line when ready", "a Spring context in the test JVM; or the real jar with a health wait", "the real process with <code>wait_for_logs</code>"),
      ("a structural assertion (<code>node_modules</code> in the image) over a timing one", "assert on the artifact, not on a stopwatch", "the same")]),
  case("A flaky e2e was a bug: the URL was announced before the page was pushed.",
       "<p>Under load, one run of the self-heal test stayed on the fresh container's empty page for good. The handler had reported the new URL as soon as the container was ready; the canvas framed it; the frame loaded the placeholder; and the push that followed landed while Vite's watcher was still scanning the clone, so the file changed and nobody was told. Now the address is held back until the sandbox <em>holds</em> the document (the peer is live and the pushed seq is the current one), and the test records what the page file contained at the moment each URL was announced. <em>A flaky test is a bug report</em>; this was the fifth one in this project to be a real bug.</p>"
       + cut("apps/worker/src/preview.ts", "        if (announce !== undefined && peer.status === \"live\"", "        await sleep(tickMs")
       + cut("apps/worker/src/preview.int.test.ts", "    await docker(\"rm\", \"--force\", sandboxName(run.documentId));\n    // Back, with the document's page", "  } finally {")),
  case("An 8 s bound that told \"baked\" from \"installed\" failed once under load.",
       "<p>Baked <code>node_modules</code> was proven by a stopwatch: about 1 s cold against 10.6 s to install, with the bound between them. At load average 117 the cold start took longer than 8 s and the test called the image unbaked. The fact being proven is structural (the directory is in the image before any container starts), so the assertion is structural now, and the stopwatch is a smoke bound only.</p>"
       + cut("apps/worker/src/sandbox.int.test.ts", "  // Baked: node_modules is IN THE IMAGE", "test(\"the sandbox works in ITS OWN clone")),
  note("<strong>Never run two Docker-using suites at once.</strong> Each one's cleanup removes the other's containers and turns results into noise. It happened this session, and it is why mutation runs of these suites go in the background, one at a time."))

section("limits", "10 · What the type system could not see, epic 4 edition",
  "<p>Everything below compiled under <code>strict</code>, passed the linter and the first tests.</p>",
  vs([("a lying <code>toString</code> put <code>alert(1)</code> in the generated file", "a value converted to a string twice answered twice", "<code>typeof</code> before anything becomes code; literals from the value"),
      ("<code>-0</code> was written as <code>0</code>", "<code>String(-0)</code> is <code>\"0\"</code>", "<code>Object.is(value, -0)</code>"),
      ("<code>NaN</code> would have compiled as a bare identifier", "<code>String(NaN)</code> is valid source", "refuse non-finite numbers"),
      ("a hidden prop was dropped and the file called complete", "<code>Object.keys</code> and <code>Object.hasOwn</code> disagree on enumerability", "compare <code>Reflect.ownKeys</code> length"),
      ("a 200 000-child document was called malformed", "<code>push(...children)</code> overflowed the stack at ~130k arguments", "a loop"),
      ("a prop set to <code>undefined</code> would have compiled without it", "\"present\" and \"has a value\" differ", "refuse; epic 5 would read it back as a deletion"),
      ("ten concurrent starts removed each other's containers", "name uniqueness is not ownership; \"port taken\" was the winner", "single-flight in-process; a unique job across processes"),
      ("a failed clone served an empty app", "<code>set -e</code> ignores a failure inside <code>a &amp;&amp; b &amp;&amp; c</code>", "one command per line"),
      ("an exec racing the container's death had an empty stderr", "prose was parsed", "ask <code>State.Running</code>"),
      ("a stubborn docker CLI outlived the deadline", "Node 24's <code>signal</code> sends SIGTERM whatever <code>killSignal</code> says", "kill with SIGKILL from our own listener"),
      ("a docker that exited early would have killed the worker (EPIPE)", "an unheard stream error is an uncaught exception", "<code>child.stdin.on(\"error\")</code>"),
      ("the compose reaper deleted the test suite's sandboxes", "same daemon, same label, no owner", "a pool label; reap only your own"),
      ("the reaper removed a sandbox that was starting", "asked Postgres first, listed Docker second", "list first, ask second; the reaper takes a function"),
      ("a worker failed someone else's job as <code>internal</code>", "the handler was looked up after the claim", "check the handler before the claim"),
      ("a container dying during a push failed the job", "a throw is a failure, whatever caused it", "ask whether it is running; force the liveness check"),
      ("a closed peer held a container for ever", "<code>others</code> froze at its last value", "fail as <code>sync_unreachable</code>"),
      ("nothing rendered in the sandboxed iframe", "<code>Origin: null</code>; Vite's default CORS refused it", "an injected config allowing exactly \"null\""),
      ("\"lock cors to the canvas origin\" was a review note that could never work", "the frame never sends the canvas's origin", "measure the fix against the thing it names"),
      ("a restarted sandbox never came back in the frame", "Vite's reconnect uses a SharedWorker, refused to origin \"null\"", "a new URL per start; the iframe keyed on it"),
      ("a flaky e2e: the frame stayed on the empty page", "the URL was announced before the page was pushed", "announce once the sandbox holds the document"),
      ("a stale tab on a reused port could show another document", "the same port, a different container", "<code>?doc=</code> checked by the page"),
      ("an 8 s bound failed under load", "a structural fact proven with a stopwatch", "assert on the image, not the clock"),
      ("two opens in an instant can pass the per-org cap", "a count is not an index", "named as a bounded overshoot; an advisory lock is the upgrade")], head=("What went wrong", "Why", "Fix")),
  note("<strong>The pattern, extended again:</strong> lessons 2 and 3 said types prove shapes and say nothing about order, time, repetition, memory, who is speaking, or what a subprocess does. Epic 4 adds three more blind spots. Types cannot see what a value's <code>toString</code> will say the second time. They cannot see who owns a resource, only that it is unique. And they cannot see a browser's security boundary: what <code>Origin</code> a request will carry, what a SharedWorker will refuse. Every one was answered the same way: measure the real thing once, then assert on what it did."))

toc = "".join(f'<li><a href="#{sid}">{title}</a></li>' for sid, title, _ in S)
sections = "".join(f'<section id="{sid}"><h2>{title}</h2>{body}</section>' for sid, title, body in S)
style = re.search(r"<style>.*?</style>", (root / "docs/handbook/lesson-0.template.html").read_text(), re.S).group(0)
page = (pathlib.Path(__file__).parent / "lesson-4.template.html").read_text()
page = page.replace("{{STYLE}}", style).replace("{{TOC}}", toc).replace("{{SECTIONS}}", sections).replace("{{COMMIT}}", commit)
(out / "lesson-4.html").write_text(page)
print("built", len(page), "bytes at", commit, "with", page.count('<p class="label">From'), "code blocks")
