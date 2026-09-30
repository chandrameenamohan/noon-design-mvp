"""Builds docs/handbook/lesson-2.html. Every code block is cut from the real repo by anchor text,
so the page cannot show code that does not exist; a missing anchor fails the build."""
import html, os, pathlib, re, subprocess
root = pathlib.Path(os.environ.get("NOON_ROOT") or pathlib.Path(__file__).resolve().parents[2])
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

def case(title, body): return f'<div class="break"><p class="label">Case study · found by review or by a test that flaked</p><p><strong>{title}</strong></p>{body}</div>'
def note(body): return f'<p class="note">{body}</p>'
m = lambda s: f"<span class='mono'>{s}</span>"

S = []
def section(sid, title, *parts): S.append((sid, title, "".join(parts)))

section("map", "The map: one edit, from a click to everyone's screen",
  "<p>Epic 2 is the heart of the product: several people (and later an AI and a git peer) edit one document at once, and everyone ends up with the same document. The design is the one Figma uses: <strong>the server decides the order</strong>. There is no CRDT and no merge function; there is one room per document, and the room hands out sequence numbers.</p>",
  vs([("1", m("apps/web/src/Canvas.tsx"), "a click builds an <strong>op</strong> (one of four) and calls <code>peer.submit(op)</code>"),
      ("2", m("packages/peer-client/src/replica.ts"), "<code>local()</code>: checked against what the user SEES, applied at once (optimistic), queued as pending"),
      ("3", m("packages/peer-client/src/peer.ts"), "<code>flush()</code>: written to the WebSocket, at most 50 unanswered at a time"),
      ("4", m("apps/sync/src/server.ts"), "frame size cap, JSON, contract check; presence goes one way, ops the other"),
      ("5", m("apps/sync/src/room.ts"), "budget, dedupe, stale?, validate, limits, persist, apply, take the seq, remember, broadcast"),
      ("6", m("packages/peer-client/src/replica.ts"), "<code>receive()</code>: the sender's copy is its acknowledgement; everyone else's is a remote edit"),
      ("7", m("apps/web/src/usePeer.ts"), "<code>revision</code> moved, so React renders")], head=("Step", "Where", "What happens")),
  "<p>Two ideas carry the whole epic. <strong>First: a pure core in a thin shell.</strong> " + m("room.ts") + " has no socket in it and " + m("replica.ts") + " has no socket in it; " + m("server.ts") + " and " + m("peer.ts") + " are only wires. That is why the rules can be tested in microseconds, and why a simulator can drive the real code. <strong>Second: every message is a value of a closed set of shapes</strong>, checked at both ends by the same schema.</p>",
  vs([("one room per document, in memory, single-threaded", "an actor (Akka), or a <code>synchronized</code> aggregate", "an asyncio task owning its state"),
      ("ops + sequence numbers; last writer wins per property", "event sourcing with a single writer", "the same"),
      ("optimistic client + rollback", "rare on the JVM server side; common in Android/iOS clients", "rare")], head=("This repo", "Java world", "Python world")))

section("unions", "1 · A closed set of messages: the discriminated union",
  "<p>An op is <em>one of four things</em>. In Java you would write a <code>sealed interface Op permits AddNode, MoveNode, ...</code> with four records. TypeScript has no classes here at all: an op is a plain object, and the field <code>type</code> tells the compiler which of the four shapes it is.</p>",
  cut("packages/contracts/src/index.ts", "export const Op = z.discriminatedUnion(", "export type Op = z.infer<typeof Op>;", True),
  "<p>Now watch what the compiler does with it. Inside <code>case \"move_node\":</code> the variable <code>op</code> <em>has</em> a <code>newParentId</code>; inside <code>case \"set_prop\":</code> it does not, and using it is a compile error. This is called <strong>narrowing</strong>: a runtime check on the discriminant changes the static type in that branch.</p>",
  cut("packages/doc-model/src/index.ts", "    case \"remove_node\": {", "    default: {"),
  cut("packages/doc-model/src/index.ts", "    default: {", "  }\n}", True),
  "<p><strong>The <code>never</code> trick.</strong> After four <code>case</code>s, nothing is left, so in <code>default</code> the type of <code>op</code> is <code>never</code> (the empty type). Assigning it to a <code>never</code> variable compiles <em>only while the switch is complete</em>. Add a fifth op to the contract and this line stops the build, in every switch that uses the trick. Java 21 gives you the same through pattern-matching <code>switch</code> over a sealed type; Python's <code>match</code> does not check exhaustiveness at all (mypy can, with <code>assert_never</code>).</p>",
  "<p>Three tools for working with unions that you will see all over this epic:</p><ul>"
  "<li><code>Extract&lt;ServerMessage, { type: \"op\" }&gt;</code>: \"the member of the union whose <code>type</code> is <code>\"op\"</code>\". A type-level filter. <code>Exclude</code> is its opposite (" + m("replica.ts") + " uses it to say \"every server message except the presence ones\").</li>"
  "<li><code>{ ... } satisfies ClientMessage</code>: checks a literal against a type <em>without widening it</em>. " + m("peer.ts") + " uses it on the frame it is about to send: a typo in a field name is a compile error, right where the frame is built.</li>"
  "<li><code>z.strictObject</code> versus <code>z.object</code>: a <em>client</em> message is strict (an unknown key is an error: a client must not be able to slip in a <code>name</code>); a <em>server</em> message is loose (unknown keys are dropped: an old tab must survive a newer server).</li></ul>",
  vs([("union of object types + a literal discriminant", "<code>sealed interface</code> + records", "<code>Union[...]</code> + <code>Literal</code> discriminator (pydantic)"),
      ("narrowing by <code>switch (op.type)</code>", "pattern-matching <code>switch</code>", "<code>match</code> / <code>isinstance</code>"),
      ("exhaustiveness: <code>never</code>", "compiler error on a missing case (sealed)", "<code>assert_never</code> + mypy only"),
      ("no classes, no <code>instanceof</code>: data crosses the wire as JSON and comes back as the same type", "needs Jackson polymorphic config", "pydantic discriminated unions")]),
  case("The forward-compatibility rule had a hole: new VALUES inside a known message type.",
       "<p>" + m("peer.ts") + " skips a message whose <code>type</code> it does not know, so an old tab survives a server that learned a new message. Then the rate limit added a new <em>reject reason</em>, <code>rate_limited</code>. An old tab knows the type <code>\"rejected\"</code>, parses it, fails on the unknown reason, and that was fatal: the session ended and every unsent edit was dropped. The fix: a refusal with an unknown reason means \"not applied\", which is all a client needs to know. <em>A closed union is a promise to the compiler, not to last year's client.</em></p>"))

section("model", "2 · One planner, two appliers",
  "<p>What does an op <em>do</em>? That decision is made in exactly one function, <code>plan()</code>, which reads the document and returns a patch (or <code>undefined</code> for \"changes nothing\"). Two tiny appliers turn the patch into a result:</p>",
  cut("packages/doc-model/src/index.ts", "export function applyOp(doc: Doc, op: Op): Doc {", "function insertAt("),
  "<p><strong>Why two?</strong> The browser needs a <em>pure</em> function: it must be able to throw a guess away. The server needs speed: replaying 10,000 ops through the copying version took 13 to 26 seconds (it copies the node map every time, so replay is O(n²)); the in-place version does it in a fraction of a second. Writing the rules twice would have been the classic bug farm, so both ask the same planner. A property test runs them side by side on random ops and demands identical documents.</p>",
  "<p><strong>Structural sharing.</strong> <code>applyOp</code> builds a new node map but reuses every node object it did not touch. \"Immutable\" in JavaScript never means deep copies; it means <em>new containers, shared contents, and a promise not to edit the contents</em>. The replica leans on that promise in section 8.</p>",
  vs([("<code>{ ...parent, children: [...] }</code> spread = shallow copy", "records + <code>withX()</code> / builders", "<code>dataclasses.replace</code>"),
      ("nothing stops mutation; the discipline is tested (frozen nodes in a property test)", "<code>final</code> fields, immutable collections", "<code>frozen=True</code>"),
      ("plain objects as maps: <code>doc.nodes[id]</code>", "<code>HashMap</code>", "<code>dict</code>")]),
  case("A node named <code>__proto__</code> crashed the server; one named <code>constructor</code> corrupted the document.",
       "<p>This one is pure JavaScript, and nothing in Java or Python prepares you for it. A plain object used as a map <em>inherits</em> from <code>Object.prototype</code>. So <code>doc.nodes[\"constructor\"]</code> is not <code>undefined</code>: it is the <code>Object</code> function. And assigning to <code>doc.nodes[\"__proto__\"]</code> does not store a key, it calls a setter. Two defences, both needed: the contract refuses such names (<code>notOnObjectPrototype</code>), and every lookup goes through <code>Object.hasOwn</code>:</p>"
       + cut("packages/doc-model/src/index.ts", "export const nodeOf = ", "\n") +
       "<p>A <code>Map</code> has none of these problems, but a <code>Map</code> does not survive <code>JSON.stringify</code>, and this document lives on the wire and in a jsonb column. That is the trade.</p>"))

section("loop", "3 · The event loop is your lock, until you write <code>await</code>",
  "<p>The room has no mutex, no <code>synchronized</code>, no atomic counter, and it is correct. Node runs your JavaScript on <strong>one thread</strong>, and a function, once started, runs to its end (or to its next <code>await</code>) before anything else runs. Two WebSocket frames cannot be \"in the room at the same time\".</p>"
  "<p>The catch is in the parentheses. An <code>await</code> <em>is</em> a point where other code runs. The room awaits only one thing, the journal (<code>journal.append</code> and its lookups, from epic 6). Without care, op B would be validated against a document that op A has not changed yet. So ops go through a queue made of one promise:</p>",
  cut("apps/sync/src/room.ts", "    /** Resolves when this op has been fully handled", "    /**\n     * Leaves read-only"),
  "<p><code>tail</code> is \"the promise of everything submitted so far\". Each new op chains onto it and becomes the new tail. That is a complete, fair, in-order work queue in three lines, with no library. The <code>.catch</code> matters: a rejected promise would otherwise poison every later <code>.then</code>.</p>",
  vs([("single thread; interleaving only at <code>await</code>", "real threads; interleaving anywhere", "asyncio: same as Node; threads: GIL, interleaving anywhere"),
      ("queue = a promise chain", "<code>ExecutorService</code> with one thread, or an actor mailbox", "<code>asyncio.Queue</code> + one worker task"),
      ("CPU-bound work blocks everyone", "use more threads", "same problem as Node")]),
  case("A test that failed one run in six was a real lost edit.",
       "<p>The server attached its <code>message</code> listener <em>after</em> <code>await</code>ing the document load. A frame that arrived during the load was emitted to nobody and lost. In Java the socket would have been read by your own loop, so nothing could arrive \"early\". In Node, events fire whenever the loop is free: <strong>attach listeners before the first await</strong>, and buffer. The fix queues early frames and replays them after the welcome. The lesson beyond Node: a flaky test is a bug report with a bad title.</p>"),
  note("<strong>Principal-level point:</strong> single-threaded does not mean free of races. It means races can only happen <em>across</em> awaits, which makes them fewer and findable. Read every <code>await</code> in shared-state code as \"anything can have changed when I come back\"."))

section("pipeline", "4 · The room: eight checks, in an order that matters",
  cut("apps/sync/src/room.ts", "  async function handle(peer: Peer, { opId, baseSeq, op }: ClientOp): Promise<void> {", "  return {"),
  "<p>Each step's position was earned by a bug:</p><ul>"
  "<li><strong>Dedupe before validate.</strong> A client that never saw its acknowledgement sends the op again. Validate first, and an honest retry of <code>add_node</code> is answered <code>duplicate_node</code>.</li>"
  "<li><strong>Stale before validate.</strong> If the op is older than anything the room remembers, the room cannot know whether it applied it. It says so (<code>stale</code>) instead of guessing.</li>"
  "<li><strong>The document's rules before the room's limits</strong>, because they give the precise reason (a move into your own subtree is a <em>cycle</em>, not a depth problem).</li>"
  "<li><strong>Durable, then applied, then announced.</strong> The sequence number is only <em>taken</em> once the op is durable, so a failed write leaves no gap, and nobody ever hears of an op that could be lost.</li>"
  "<li><strong>The actor is stamped here</strong>, from the verified session. A client cannot claim \"the AI did this\".</li></ul>",
  "<p>And the budget is not in this function at all: it is charged in <code>submit()</code>, as the op <em>arrives</em>. Section 9 says why.</p>",
  case("A graceful shutdown lost every unsaved edit.",
       "<p><code>close()</code> terminated the sockets and then awaited the pending saves. There were none: the <code>close</code> handlers that <em>start</em> the saves run on a later tick of the event loop. The function returned, the process exited. The fix is to save every room first, then close. In Node, \"I called it\" and \"it has happened\" are different moments; when order matters, <code>await</code> the thing itself.</p>"))

section("idempotency", "5 · Exactly once, over a connection that lies",
  "<p>A network gives you two honest choices: at most once, or at least once. \"Exactly once\" is built on top: <strong>send at least once, and make the receiver recognise repeats</strong>. Every op carries a random <code>opId</code>; the room remembers what each <code>(sender, opId)</code> became and answers a repeat with the original answer.</p>"
  "<p>The memory is bounded (20,000 ops), so there must be a rule for what falls outside it. That is <code>baseSeq</code>: the last sequence number the client had seen when it <em>wrote</em> the op. Older than anything remembered? <code>stale</code>.</p>",
  cut("packages/peer-client/src/replica.ts", "    if (reason === RejectReason.enum.stale) {", "    pending = pending.filter((each) => each !== mine);\n    rebuild();\n    effects.settled.push({ opId, outcome: { ok: false, reason } });"),
  case("\"Would this op change the document?\" is not \"was this op applied?\"",
       "<p>My first rule for <code>stale</code>: if the op would still change the document, send it again. A reviewer broke it in six steps: my <code>gap=1</code> lands at seq 11 (I never hear); someone sets <code>gap=2</code> at seq 12; the server restarts; I resend; <code>stale</code>; the document says 2, so my op \"would change it\"; I resend with a fresh <code>baseSeq</code>; it lands at seq 13. An old write is now on top of a newer one, and with <code>add_node</code> the same path resurrects a node someone deleted. The rule now: only an op that <em>no earlier connection ever carried</em> is sent again. The others are given up, and the user is told. A lost edit you know about beats a corrupted document you do not. (The journal in epic 6 remembers every opId for good, and the rule goes away.)</p>"),
  note("Two smaller lessons from the same code: the dedupe key includes the <em>sender</em> (a broadcast shows every opId to every peer), and an acknowledgement is matched by id <strong>and</strong> content: <em>an id is a claim, the content is the fact</em>."))

section("shell", "6 · A pure core in a thin shell, and dependencies as parameters",
  "<p>Look at what the room asks of the outside world:</p>",
  cut("apps/sync/src/room.ts", "export type Peer = {", "/**\n * A token bucket"),
  "<p>A peer is \"who it is\" plus \"a way to send to it\". No socket. The server builds one from a WebSocket; a unit test builds one from an array; the simulator builds one from a queue. The same goes for time and randomness:</p>",
  cut("apps/sync/src/room.ts", "  rate?: Partial<RateLimit>;", "};", True),
  "<p><code>now</code> and <code>mintPeerId</code> are <em>functions passed in</em>, with real defaults. That is the entire dependency-injection mechanism: a parameter with a default value. No container, no interface, no mock library. A test hands in <code>() =&gt; clock.now</code> and winds the clock by hand.</p>",
  vs([("<code>now = Date.now</code> as a default parameter", "<code>java.time.Clock</code> injected by Spring", "<code>freezegun</code> / a clock argument"),
      ("<code>type Peer = { send(m): void }</code>: any object with that shape fits", "<code>interface Peer</code>, and classes must declare <code>implements</code>", "<code>Protocol</code> (structural), or duck typing"),
      ("a fake = an object literal", "Mockito", "<code>unittest.mock</code>")]),
  note("<strong>Structural typing</strong> is what makes this cheap. TypeScript never asks \"is this an instance of Peer?\"; it asks \"does it have <code>actor</code>, <code>session</code> and <code>send</code> of the right types?\". In Java terms, every type is an interface and every object implements all the interfaces it happens to fit."))

section("ws", "7 · WebSockets: what HTTP did for you, and now you do",
  "<ul><li><strong>Authentication happens once</strong>, at the upgrade. A browser cannot set headers on a WebSocket, except one: <code>Sec-WebSocket-Protocol</code>. The token rides there (a query string would land in proxy logs). A bad token is an HTTP 401 before any socket exists.</li>"
  "<li><strong>There are no status codes</strong> after that, so the server defines close codes that mirror HTTP: 4400, 4404, 4429, 4500, 4503. The client sorts them into \"retry\" and \"never retry\".</li>"
  "<li><strong>A dead peer says nothing.</strong> The server pings; a peer that has not answered by the next tick is terminated. The browser cannot see pings, so the client has its own watchdog: \"I am waiting for something and have heard nothing for 10 s\".</li>"
  "<li><strong>Backpressure is your job.</strong> <code>ws.send()</code> never blocks and never fails: what cannot be written is queued <em>in your memory</em>. One stalled reader could grow that without end, so past 1 MB the peer is dropped.</li>"
  "<li><strong>Node 24 has the browser's <code>WebSocket</code> built in.</strong> That is why one client library serves the browser tab, the AI worker and the git peer.</li></ul>",
  cut("apps/sync/src/server.ts", "      send: (message) => {", "      kick:"),
  cut("packages/peer-client/src/peer.ts", "  function retryLater(): void {", "  /** Drop this connection"),
  case("Resetting the backoff on every welcome made a reconnect storm.",
       "<p>\"Connected again, so start the backoff over\" sounds right. But a server that welcomes and then drops you (a crash loop, a failing database) is then retried every 250 ms for ever, by every open tab, and each retry costs the API a session token and the room a copy of the document. The backoff now restarts only after a connection that <em>lasted</em>. Jitter is there for the same reason: after a restart, a thousand tabs must not come back in the same millisecond.</p>"))

section("optimistic", "8 · Optimistic editing: two documents and one invariant",
  cut("packages/peer-client/src/replica.ts", "/**\n * One peer's copy of a document.", "export function createReplica("),
  "<p>The user must see their edit <em>now</em>, not after a round trip. So the replica keeps the server's truth and its own guess apart, and the guess is always <em>recomputable</em>: confirmed, then every pending op, in order. When the server says something that changes history (someone else's op landed before mine), the guess is thrown away and made again:</p>",
  cut("packages/peer-client/src/replica.ts", "  /**\n   * Throw the guess away and make it again.", "  const wire ="),
  "<p>That shallow copy is 6x faster than <code>structuredClone</code> (about 1 ms against 6.5 ms on 5,000 nodes), and it is only safe because of section 2's promise: appliers replace nodes, they never edit one. The promise is enforced by a test that <em>freezes</em> every node the replica holds and then runs sixty random histories; an in-place edit would throw.</p>",
  "<p><strong>The property, stated as a test:</strong> after any mix of local edits, remote edits, acknowledgements, refusals and reconnects, <code>optimistic == confirmed + pending</code>, the document is well formed, and once nothing is pending the replica's document <em>is</em> the server's. Rollback is not a feature that was written; it is what \"recompute the guess without the refused op\" does.</p>",
  vs([("<code>structuredClone(x)</code>: deep copy, built in", "serialization or copy constructors", "<code>copy.deepcopy</code>"),
      ("<code>{ ...doc, nodes: { ...doc.nodes } }</code>: one level", "<code>new HashMap&lt;&gt;(map)</code>", "<code>dict(d)</code>"),
      ("getters on a returned object (<code>get doc()</code>) expose live state read-only", "getter methods", "<code>@property</code>")]))

section("rate", "9 · Rate limiting: where you charge matters more than how",
  cut("apps/sync/src/room.ts", "  /** Takes one token (unless `take` is false)", "  /** Refuses the op if this peer is over budget."),
  "<p>A token bucket is ten lines. The decisions around it are the design:</p><ul>"
  "<li><strong>Charge on arrival.</strong> The first version charged when the queue reached the op. Behind a slow journal the bucket refills while ops wait: a flood of 3,000 frames got <em>zero</em> refusals and sat in memory. <em>Limit where work arrives, not where it is processed.</em></li>"
  "<li><strong>Per actor, not per connection</strong>: otherwise reconnecting is a free refill. And an AI run has its own bucket, so it cannot starve the person who started it.</li>"
  "<li><strong>Keep the order.</strong> After op K is refused, the bucket refills, and op K+1 (K's child) would get in and be lost as <code>gone</code>. So the room refuses that peer's later ops until K comes back.</li>"
  "<li><strong>A strike is coming back too soon</strong>, not being refused. A second tab that waits as told and loses the race for the token is unlucky, not abusive, and must never be dropped.</li>"
  "<li><strong>Cheap requests must not share a pool with expensive ones.</strong> Ops that change nothing cost almost nothing; remembered in the same memory as real ops, 20,000 of them pushed out every real entry and turned honest resends into <code>stale</code>.</li></ul>",
  case("My own honest client cost 18,524 refusals for 600 ops.",
       "<p>Told \"come back in 10 ms\", it came back with its whole window of 50 ops. One token had refilled. One op in, 49 refused, repeat. The test was named \"an honest client is never dropped\" and it passed, because it never <em>counted</em> refusals. Now the window restarts at one op and grows by one per answer (the shape of TCP's congestion control), the server's hint means \"when a few tokens are back\", and the test counts. <em>Assert the thing you claim, in numbers.</em></p>"))

section("presence", "10 · Presence: the message that is not an op",
  "<p>Cursors and selections are not part of the document: never ordered, never stored, gone with the process. So presence takes none of the op pipeline: no queue, no seq, no persist, no budget. What it needs instead:</p><ul>"
  "<li><strong>Identity from the token</strong>, never from the message. The client message is a <code>strictObject</code>: an extra <code>name</code> field closes the connection.</li>"
  "<li><strong>Latest wins, nothing queues.</strong> The client sends at most every 50 ms and always the newest state; the room drops anything faster than 25 ms apart. 10,000 frames in one tick relay 2.</li>"
  "<li><strong>A dead connection says no goodbye</strong>, and the server may not notice for 15 s. So every client refreshes every 2 s, and <em>viewers</em> forget anyone silent for 5 s.</li>"
  "<li><strong>A cursor is a fraction of the canvas</strong>, not pixels: two windows are never the same size.</li>"
  "<li><strong>Serialise once.</strong> N peers at 20 messages a second is N²·20 <code>JSON.stringify</code> calls if you do it per recipient.</li></ul>",
  cut("apps/sync/src/room.ts", "  /** To everyone (but `except`).", "  // Presence lives HERE"))

section("react", "11 · React meets a store that is not React's",
  "<p>You know servers; here is the smallest honest account of the browser side. React re-renders a component when <em>its</em> state changes. The peer is not React state: it changes when a WebSocket frame arrives. <code>useSyncExternalStore</code> is the bridge: \"here is how to subscribe, here is how to read a snapshot\". React re-renders when the snapshot is a <em>different value</em> (<code>Object.is</code>).</p>",
  cut("apps/web/src/usePeer.ts", "function openStore(", "const NOTHING"),
  "<p>The document is edited in place, so its identity never changes and would make a useless snapshot. The snapshot is a string of the numbers that do move.</p>",
  cut("apps/web/src/usePeer.ts", "export function usePeer(", None),
  "<ul><li><strong>Side effects live in effects.</strong> A render must be pure: React may run it twice and discard one (StrictMode does so on purpose in development). An effect comes with a cleanup; a render does not.</li>"
  "<li><strong>Derived, not stored.</strong> The selection is <code>doc.nodes[wanted] ?? root</code>. When someone else deletes the selected node there is no state to repair.</li>"
  "<li><strong>A ref for what the screen does not depend on.</strong> The pointer position changes sixty times a second and nothing on <em>our</em> screen shows it: <code>useRef</code>, not <code>useState</code>.</li>"
  "<li><strong><code>key</code> resets a component.</strong> The inspector is keyed by node id: select another node and the old form unmounts (its field blurs, its draft is committed to the <em>right</em> node) and a fresh one mounts.</li></ul>",
  case("StrictMode left two live connections per page.",
       "<p>Mount, cleanup, mount again, all in one tick. My library <em>scheduled</em> its connection (<code>queueMicrotask</code>), so the cleanup's <code>close()</code> ran before the connection had started, and the start then undid the close. A library that defers its start must ask \"was I closed meanwhile?\" when it finally runs.</p>"),
  vs([("<code>useState</code>: state owned by the component", "a field + <code>repaint()</code>", "n/a"),
      ("<code>useEffect(() =&gt; { open(); return close; }, [id])</code>", "<code>@PostConstruct</code> / <code>@PreDestroy</code>", "a context manager"),
      ("the prop form is generated from the manifest at runtime", "reflection over a DTO", "pydantic model fields")], head=("React", "Closest Java idea", "Closest Python idea")))

section("manifest", "12 · Types as data: reading TypeScript with TypeScript",
  "<p>The canvas must know which components exist and which props they take. Nobody wrote that list: it is <em>extracted</em> from the sample app's own TypeScript types with the compiler API, and committed. Change a prop in the design system and <code>make check</code> fails until the manifest is regenerated.</p>",

  "<p>The compiler is a library: <code>ts.createProgram</code> gives you a type checker you can ask \"what are the properties of this type, and is this one optional?\". Java's equivalent is an annotation processor or reflection; the difference is that TypeScript's types do not exist at runtime, so the only way to get them into data is to run the compiler.</p>",
  case("Arrow-function components were silently skipped.",
       "<p>The extractor looked for <code>function Button(props: ...)</code> declarations. <code>export const Button = (props: ...) =&gt; ...</code> is a <em>variable</em> whose initialiser is a function: a different syntax node. Half of all React code is written that way. Code that walks a syntax tree needs a test per way of writing the same thing.</p>"))

section("testing", "13 · How you test concurrency without sleeping",
  "<ul><li><strong>Property tests</strong>: not \"this input gives that output\" but \"for every history, this stays true\". Seeded, so a failure replays.</li>"
  "<li><strong>A simulator</strong> (" + m("apps/sync/src/sim.ts") + ", <code>make sim</code>): the real room and real replicas, a network that delays, reorders and drops, a server that restarts, one seeded generator deciding everything. Same seed, same run, byte for byte, in separate processes.</li>"
  "<li><strong>Mutation</strong>: break a rule on purpose and demand a red test. The simulator's first version passed when a replica re-applied a late acknowledgement, because random ops almost never made two peers write the same property. It now generates <em>collisions</em> on purpose and checks every caught-up replica at every step, not only at the end (later edits hide a wrong value).</li>"
  "<li><strong>Held frames</strong>: in the browser tests, Playwright sits between the page and the server and holds one browser's outgoing frames. \"Two people did this at the same moment\" becomes a deterministic test.</li>"
  "<li><strong>Injected time</strong>: a hand-wound clock instead of <code>sleep</code>.</li></ul>",
  cut("apps/sync/src/sim.ts", "  function check(): void {", "  async function deliverToServer("),
  case("The simulator's best find was a bug in code that every committed seed passed.",
       "<p>Two features, each correct alone. The room remembers \"this op changed nothing\" and answers a resend with the same <code>ack</code> (re-judging it later could put an old value over a newer one). The replica, told never to trust blindly, refused to believe an <code>ack</code> for an op that <em>would</em> change the document it holds now. Put together: I set <code>gap=2</code> when it is already 2; the ack is lost; someone sets <code>gap=1</code>; I reconnect and resend; the room says <code>ack</code>; I do not believe it, reconnect, resend; for ever, silently. It happens in about one seed in 700, and seeds 1 to 40 never hit it. A verifier swept 3,000 seeds and seed 761 printed the loop. The fix is one deleted condition: the room's verdict is about <em>then</em>, not now, so the ack is believed and the newer value stands.</p>"
       "<p>Three habits came out of it: after building a simulator, <strong>sweep thousands of seeds once</strong> and commit the ones that fail; make the final drain <strong>bounded</strong>, so a livelock is a failure with a trace and not a hang; and when a client double-checks a server, it needs the server's real semantics, or the check itself becomes the bug.</p>"),
  note("The independent last-writer-wins check exists because the \"replay the log\" check uses doc-model's own applier: a wrong rule inside it would agree with itself. <strong>An oracle must not share code with what it judges.</strong>"))

section("limits", "14 · What the type system could not see, epic 2 edition",
  "<p>Everything below compiled under <code>strict</code>, passed the linter and the first tests.</p>",
  vs([("frame lost while the room was loading", "listener attached after an <code>await</code>", "attach first, buffer, replay"),
      ("shutdown lost unsaved edits", "close handlers run on a later tick", "save first, then close"),
      ("resend applied twice outside the dedupe window", "bounded memory with no rule for the outside", "<code>baseSeq</code> + <code>stale</code>"),
      ("old write over a newer one after a restart", "\"would change\" mistaken for \"was not applied\"", "only never-sent ops are rebased"),
      ("a co-editor could diverge your canvas for good", "ack matched by id alone", "id AND content"),
      ("a cyclic welcome froze the tab", "contract checks nodes, not the tree", "<code>checkDoc</code> on arrival; seen-set in the walk"),
      ("~6 reconnects a second, for ever", "backoff reset on every welcome", "reset after a connection that lasted"),
      ("an honest second tab was kicked", "a strike per refusal", "a strike per EARLY return"),
      ("floods never refused behind a slow journal", "budget charged inside the queue", "charge on arrival"),
      ("honest resends turned <code>stale</code>", "no-ops shared the dedupe memory", "their own small memory"),
      ("18,524 refusals for 600 ops", "whole window resent into one token", "restart at 1, +1 per answer"),
      ("two live connections per page in dev", "close() before a deferred start was undone", "check \"closed?\" at the start"),
      ("a stale link retried for ever", "404 mapped to \"retry later\"", "throw = retry, null = give up"),
      ("<code>1e999</code> silently deleted a prop", "a number input reports \"\" for unreadable text", "<code>validity.badInput</code>"),
      ("a third of presence colours unreadable", "a colour formula cannot promise contrast", "a checked list + a test that recomputes WCAG"),
      ("an endless, silent resync loop", "the replica disbelieved a REMEMBERED ack", "the ack is about then, not now: believe it"),
      ("<code>__proto__</code> as a node id", "plain objects inherit", "refuse in the contract; <code>Object.hasOwn</code> everywhere")], head=("What went wrong", "Why", "Fix")),
  note("<strong>The pattern:</strong> types prove shapes. They say nothing about <em>order</em>, <em>time</em>, <em>repetition</em>, <em>memory</em> or <em>who is speaking</em>, and a distributed system is made of exactly those. That is what the verifier pass, the property tests, the simulator and mutation-checking are for."))

toc = "".join(f'<li><a href="#{sid}">{title}</a></li>' for sid, title, _ in S)
sections = "".join(f'<section id="{sid}"><h2>{title}</h2>{body}</section>' for sid, title, body in S)
style = re.search(r"<style>.*?</style>", (root / "docs/handbook/lesson-0.template.html").read_text(), re.S).group(0)
page = (pathlib.Path(__file__).parent / "lesson-2.template.html").read_text()
page = page.replace("{{STYLE}}", style).replace("{{TOC}}", toc).replace("{{SECTIONS}}", sections).replace("{{COMMIT}}", commit)
(out / "lesson-2.html").write_text(page)
print("built", len(page), "bytes at", commit)
