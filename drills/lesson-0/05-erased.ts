// Lesson 0 · 5 — TYPES VANISH AT RUNTIME. The most important idea in this lesson.  Run: node 05-erased.ts
// Node runs this .ts file by deleting the type syntax. Nothing checks types while it runs.

type Health = { status: "ok"; service: string };

// 1. A cast (`as`) is a promise to the compiler, not a check. This "Health" is a lie, and it runs fine.
const fromTheWire = JSON.parse('{"status":"down","service":42}') as Health;
console.log("the compiler believes this is Health:", fromTheWire);

// Java's Jackson would throw here; Python + pydantic would raise. Plain TypeScript does nothing.
// So at every trust boundary (HTTP body, WebSocket message, DB row, env var) we must check at RUNTIME.

// 2. A hand-written runtime check. `x is Health` is a TYPE PREDICATE: it tells the compiler
//    "if this returns true, treat x as Health from here on".
function isHealth(x: unknown): x is Health {
  return (
    typeof x === "object" && x !== null &&
    "status" in x && x.status === "ok" &&
    "service" in x && typeof x.service === "string" && x.service.length > 0
  );
}

const candidate: unknown = JSON.parse('{"status":"ok","service":"api"}');
if (isHealth(candidate)) console.log("checked for real:", candidate.service); // narrowed to Health
console.log("the liar passes the check?", isHealth(fromTheWire)); // false

// 3. Writing these by hand does not scale, and the type and the check can drift apart.
//    Zod (packages/contracts) writes ONE schema and DERIVES the type from it:
//      const Health = z.object({ status: z.literal("ok"), service: z.string().min(1) });
//      type Health = z.infer<typeof Health>;   // the type comes from the runtime check, so they cannot drift
//      Health.parse(json)                      // throws with the failing field's name
