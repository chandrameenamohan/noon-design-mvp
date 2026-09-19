// Lesson 0 · 8 — promises, async/await, and the single thread.  Run: node 08-async.ts
// Java: threads + blocking calls. Python: asyncio. Node: ONE thread running your code, an event loop,
// and non-blocking I/O. Nothing runs in parallel with your JavaScript, so there are no data races on
// in-memory state, and one slow synchronous function freezes EVERYTHING (every request, every socket).

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// A Promise<T> = Java's CompletableFuture<T> = Python's awaitable. `async` makes a function return one.
async function fetchOrg(id: string): Promise<{ id: string }> {
  await sleep(50); // gives the thread back to the event loop while "waiting"
  return { id };
}

// Sequential vs concurrent: the most common performance mistake.
let t = Date.now();
await fetchOrg("a");
await fetchOrg("b");
console.log("one after another:", Date.now() - t, "ms"); // ~100

t = Date.now();
await Promise.all([fetchOrg("a"), fetchOrg("b")]); // both waits overlap
console.log("concurrently:     ", Date.now() - t, "ms"); // ~50

// Errors: a rejected promise is an exception at the `await`.
async function mayFail(): Promise<never> {
  throw new Error("db is down");
}
try {
  await mayFail();
} catch (e) {
  console.log("caught:", e instanceof Error ? e.message : e); // `e` is unknown: narrow before use
}

// Ordering: sync code first, then microtasks (promise callbacks), then timers.
setTimeout(() => console.log("3 timer"), 0);
void Promise.resolve().then(() => console.log("2 microtask"));
console.log("1 sync");

// The classic bug: forgetting `await`. The call starts, nobody waits, errors vanish.
// Our ESLint rule `no-floating-promises` turns that into a lint error; `void` above says "on purpose".
await sleep(10);
