"""Builds docs/handbook/lesson-0.html from drills/lesson-0/*.ts so the page shows exactly the code that runs."""
import html, pathlib, re
root = pathlib.Path(__file__).resolve().parents[2]
D = root / "drills/lesson-0"

def code(name, drop_header=True):
    src = (D / name).read_text()
    if drop_header:  # the first comment line repeats the section title
        src = re.sub(r"\A// (Lesson 0|EXPECT)[^\n]*\n", "", src)
    return f'<div class="scroll"><pre><code>{html.escape(src.strip())}</code></pre></div>'

def out(text): return f'<div class="scroll"><pre class="out"><code>{html.escape(text.strip())}</code></pre></div>'

def breakit(name, expect, why):
    return (f'<div class="break"><p class="label">Break it · <span class="mono">{name}</span></p>{code(name)}'
            f'<p><strong>Fails with <span class="mono">{expect}</span>.</strong> {why}</p></div>')

def vs(rows):
    body = "".join(f"<tr><td>{a}</td><td>{b}</td><td>{c}</td></tr>" for a, b, c in rows)
    return f'<div class="scroll"><table><tr><th>TypeScript</th><th>Java</th><th>Python</th></tr>{body}</table></div>'

S = []
S.append(("values", "1 · Values, inference, one number type", "01-values.ts",
  "<p><code>const</code> is a binding that never changes; <code>let</code> may. You rarely write a type on a local variable: the compiler infers it. Notice that a <code>const</code> string gets the <em>literal</em> type <code>\"api\"</code>, not <code>string</code>. That tiny fact powers section 3.</p>",
  vs([("<code>const</code> / <code>let</code>", "<code>final var</code> / <code>var</code>", "no equivalent; everything rebinds"),
      ("one <code>number</code> (64-bit float) + <code>bigint</code>", "<code>int long float double BigInteger</code>", "<code>int</code> (unbounded) + <code>float</code>"),
      ("<code>1 / 2 === 0.5</code>", "<code>1 / 2 == 0</code>", "<code>1 / 2 == 0.5</code>")]),
  "{\n  service: 'api',\n  attempts: 1,\n  half: 0.5,\n  big: 18446744073709551616n,\n  unsafe: 9007199254740992,\n  safe: false\n}\napi took 1 attempt(s)\nnumber",
  ("01-values.broken.ts", "TS2322", "Inference is not \"dynamic typing\". Once <code>attempts</code> is inferred as <code>number</code> it stays one."),
  "<strong>Why it matters here:</strong> document sequence numbers come back from Postgres as <code>bigint</code>, and the driver hands them to us as <em>strings</em>. Adding 1 to that string gives <code>\"101\"</code>… then <code>\"1011\"</code>. We convert once, at the database boundary."))
S.append(("objects", "2 · Object types and structural typing", "02-objects.ts",
  "<p>This is the biggest mental shift from Java. Java is <em>nominal</em>: a class is a <code>HasName</code> only if it says <code>implements HasName</code>. TypeScript is <em>structural</em>: anything with a <code>name: string</code> <em>is</em> a <code>HasName</code>. Python calls this duck typing; TypeScript checks the duck at compile time.</p>",
  vs([("<code>type Org = { id: string }</code>", "<code>record Org(String id)</code>", "<code>@dataclass</code> / <code>TypedDict</code>"),
      ("fits if the shape fits", "fits if it declares <code>implements</code>", "fits if it quacks (checked at runtime, or by mypy <code>Protocol</code>)"),
      ("<code>plan?: \"free\"</code> optional field", "<code>Optional&lt;Plan&gt;</code> or nullable", "<code>plan: str | None = None</code>")]),
  "hello Acme\nhello anything with a name\n{ x: 1, y: 2 } false\nfalse",
  ("02-objects.broken.ts", "TS2353", "Structural does not mean sloppy: on a fresh object literal, an unknown key is treated as a typo."),
  "<strong>Read the last two outputs again.</strong> A plain object passed as a <code>Point</code>, yet <code>instanceof Point</code> is <code>false</code>, and <code>readonly</code> froze nothing. The type checker and the running program are two separate worlds. Section 5 is about the gap between them."))
S.append(("unions", "3 · Unions, literals, narrowing", "03-unions.ts",
  "<p>A value can be <em>one of several</em> types, and a type can be a single literal like <code>\"running\"</code>. Put a literal tag on each member and you get a <strong>discriminated union</strong>: the compiler follows your <code>switch</code> and knows, inside each case, exactly which fields exist. Our whole document protocol (four ops) is one of these.</p>",
  vs([("<code>\"queued\" | \"running\"</code>", "<code>enum RunStatus</code>", "<code>Literal[\"queued\", \"running\"]</code>"),
      ("discriminated union + <code>never</code> check", "sealed interface + pattern <code>switch</code> (Java 21)", "<code>match</code> + <code>assert_never</code>"),
      ("<code>unknown</code> (must narrow) vs <code>any</code> (checker off)", "<code>Object</code>", "<code>object</code> vs <code>Any</code>")]),
  "running | set label on n1\n4 2 0",
  ("03-unions.broken.ts", "TS2322", "Add a fifth op and forget a case: the <code>never</code> line refuses to compile. The compiler finds every place you must update."),
  "<strong>Why no <code>enum</code>?</strong> A TypeScript <code>enum</code> generates real JavaScript, and Node runs our files by <em>deleting</em> types, not compiling them. Literal unions cost nothing at runtime. Section 5's broken file proves it."))
S.append(("functions", "4 · Functions and generics", "04-functions.ts",
  "<p>Functions are ordinary values. Generics look like Java's and are erased like Java's, but you almost never write the type argument: it is inferred from the call. There is no overloading by signature; use optional parameters, defaults, or an object parameter (which doubles as named arguments).</p>",
  vs([("<code>(n: number) =&gt; n * 2</code>", "<code>n -&gt; n * 2</code>", "<code>lambda n: n * 2</code>"),
      ("<code>&lt;T extends { id: string }&gt;</code>", "<code>&lt;T extends HasId&gt;</code>", "<code>TypeVar(\"T\", bound=HasId)</code>"),
      ("<code>f({ title, orgId })</code>", "builder / many overloads", "keyword arguments")]),
  "5 8 [ 'a', 'b' ] [ 'c' ]\n10 undefined\n{ id: 'o1', name: 'Acme' }\norg_1/Checkout",
  ("04-functions.broken.ts", "TS2532", "With <code>noUncheckedIndexedAccess</code> on (it is, repo-wide), <code>xs[0]</code> is <code>number | undefined</code>. Java would throw <code>IndexOutOfBounds</code> at runtime; here you handle the empty case before the code compiles."),
  ""))
S.append(("erased", "5 · Types vanish at runtime", "05-erased.ts",
  "<p><strong>If you keep one idea from this lesson, keep this one.</strong> Node 24 runs a <code>.ts</code> file by replacing every type annotation with spaces and executing what is left. Nothing checks types while the program runs. An <code>as</code> cast is a promise you make to the compiler, not a check. So a JSON body, a WebSocket message, a database row, an environment variable: each is <code>unknown</code> until <em>runtime code</em> proves otherwise.</p>",
  vs([("types erased; <code>as</code> never checks", "generics erased, but casts are checked (<code>ClassCastException</code>)", "hints ignored at runtime unless a library reads them"),
      ("Zod schema → inferred type", "Jackson + Bean Validation", "pydantic model")]),
  "the compiler believes this is Health: { status: 'down', service: 42 }\nchecked for real: api\nthe liar passes the check? false",
  ("05-erased.broken.ts", "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX", "This one fails when you <em>run</em> it, not when you compile it. Node can only delete syntax; an <code>enum</code> needs code generated, so Node refuses. The same goes for <code>namespace</code>, constructor parameter properties and decorators. Our <code>tsconfig</code> sets <code>erasableSyntaxOnly</code> so the compiler rejects them first."),
  "<strong>This is why <code>packages/contracts</code> exists.</strong> Every HTTP body and WebSocket message is defined once as a Zod schema; the TypeScript type is <em>derived</em> from the schema with <code>z.infer</code>, so the check and the type cannot drift apart. It is already in the repo: open <span class=\"mono\">packages/contracts/src/index.ts</span>."))
S.append(("nothing", "6 · Two kinds of nothing", "06-nothing.ts",
  "<p>JavaScript has <code>undefined</code> (\"never set\") and <code>null</code> (\"deliberately empty\"). With <code>strict</code> on, neither is a member of any type unless you say so: a <code>string</code> can never be null, unlike every Java reference. Two operators do most of the work: <code>?.</code> and <code>??</code>.</p>",
  vs([("<code>null</code> and <code>undefined</code>", "<code>null</code>", "<code>None</code>"),
      ("<code>a?.b</code>", "<code>Optional.map</code>", "no operator"),
      ("<code>a ?? d</code> (only null/undefined)", "<code>Optional.orElse</code>", "<code>a if a is not None else d</code> (not <code>a or d</code>)")]),
  "undefined null\nundefined\n16 0\n8 0\n{\"b\":null}",
  ("06-nothing.broken.ts", "TS2375", "<code>exactOptionalPropertyTypes</code>: an optional field may be <em>absent</em>; it may not be <em>present and undefined</em>. The difference is real: <code>JSON.stringify</code> drops one and a database <code>UPDATE</code> built from object keys would overwrite with the other."),
  "<strong>The <code>||</code> trap</strong> is the third output line: <code>0 || 16</code> is <code>16</code> because <code>0</code> is falsy. A layout gap of zero silently becomes sixteen. Use <code>??</code>."))
S.append(("modules", "7 · Modules and the <code>.ts</code> rule", "07-modules.ts",
  "<p>A file is a module; <code>export</code> is its public surface. Because we run TypeScript straight on Node with no build step, two rules apply that you will not see in older tutorials: spell the real file name in relative imports, extension included, and import types with <code>import type</code> so nothing is left dangling after erasure.</p>",
  vs([("file = module, explicit <code>export</code>", "class = file, <code>public</code>, packages", "file = module, everything importable"),
      ("<code>node_modules</code> + package <code>exports</code>", "classpath / module path", "<code>sys.path</code> / site-packages"),
      ("pnpm workspace", "Maven/Gradle multi-module", "uv/poetry workspace")]),
  "{ id: 'org_acme', name: 'Acme' }\ntrue",
  ("07-modules.broken.ts", "ERR_MODULE_NOT_FOUND", "Leaving the extension off is the Java/Python reflex. Node looks for a file literally named <code>./07-lib</code> and finds none."),
  ""))
S.append(("async", "8 · Promises and the single thread", "08-async.ts",
  "<p>Node runs your JavaScript on <strong>one thread</strong>. I/O is non-blocking: <code>await</code> hands the thread back to the event loop until the result arrives. Consequences you will feel in this project: no data races on in-memory state (the sync room's document needs no lock), and one slow synchronous function freezes every request and every socket at once. A blocked event loop is also how a server loses a lease without noticing; epic 7 is built around that.</p>",
  vs([("<code>Promise&lt;T&gt;</code>, <code>async/await</code>", "<code>CompletableFuture&lt;T&gt;</code>, virtual threads", "awaitables, <code>asyncio</code>"),
      ("<code>Promise.all([a, b])</code>", "<code>allOf</code> / structured concurrency", "<code>asyncio.gather</code>"),
      ("one thread + event loop", "many threads, locks", "one thread + event loop (GIL aside)")]),
  "one after another: 103 ms\nconcurrently:      51 ms\ncaught: db is down\n1 sync\n2 microtask\n3 timer",
  ("08-async.broken.ts", "TS2339", "Forget <code>await</code> and you hold the promise, not the value. The compiler catches the property access; our lint rule <code>no-floating-promises</code> catches the case where you ignore the result entirely."),
  ""))

sections = ""
toc = ""
for sid, title, f, intro, table, output, br, note in S:
    toc += f'<li><a href="#{sid}">{title}</a></li>'
    sections += (f'<section id="{sid}"><h2>{title}</h2>{intro}{table}'
                 f'<p class="label">Run it · <span class="mono">node {f}</span></p>{code(f)}'
                 f'<p class="label">What it printed</p>{out(output)}'
                 + (f'<p class="note">{note}</p>' if note else "") + breakit(*br) + "</section>")

page = (root / "docs/handbook/lesson-0.template.html").read_text().replace("{{TOC}}", toc).replace("{{SECTIONS}}", sections)
(root / "docs/handbook/lesson-0.html").write_text(page)
print("built", len(page), "bytes")
