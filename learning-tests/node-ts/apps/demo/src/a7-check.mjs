// Plain-JS checker (not itself type-stripped) for assumption 7.
// Runs a7-stack-trace.ts, parses the reported file:line:col out of the
// stack trace, and compares it against an expected line:col computed
// INDEPENDENTLY from the raw .ts source -- by scanning the source for a
// unique marker token ("new Error(") -- rather than trusting the very
// line number reported by the stack trace being validated. If the
// stack trace ever reported the WRONG line, the old version of this
// check (which used the reported line to index into the source before
// computing "expected" column) could never catch that; this version can.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(__dirname, "a7-stack-trace.ts");

const result = spawnSync(process.execPath, [target], { encoding: "utf8" });
const stack = result.stderr;

const m = stack.match(/a7-stack-trace\.ts:(\d+):(\d+)/);
if (!m) {
  console.log("a7-FAIL could not find file:line:col in stack trace:");
  console.log(stack);
  process.exit(1);
}
const [, lineStr, colStr] = m;
const reportedLine = Number(lineStr);
const reportedCol = Number(colStr);

// Marker token must appear exactly once in the source file, or this check
// can't uniquely locate the expected position.
const MARKER = "new Error(";
const sourceText = readFileSync(target, "utf8");
const sourceLines = sourceText.split("\n");

const matchingLineNumbers = sourceLines
  .map((text, idx) => ({ idx, text }))
  .filter(({ text }) => text.includes(MARKER))
  .map(({ idx }) => idx + 1);

if (matchingLineNumbers.length !== 1) {
  console.log(
    `a7-FAIL expected exactly one occurrence of ${JSON.stringify(MARKER)} in ${target}, found ${matchingLineNumbers.length}`
  );
  process.exit(1);
}

// V8 reports the throw site as the start of the `new Error(...)` expression,
// not the `throw` keyword itself -- that's normal V8 behavior, unrelated to
// type stripping. So the expected column points at "new Error(", computed
// purely from the source text, independent of anything the program under
// test printed.
const expectedLine = matchingLineNumbers[0];
const expectedCol = sourceLines[expectedLine - 1].indexOf(MARKER) + 1; // 1-based

console.log(
  `a7-info reported=${reportedLine}:${reportedCol} expected(from source, independent of stack trace)=${expectedLine}:${expectedCol}`
);
console.log(`a7-info sourceLine="${sourceLines[expectedLine - 1]}"`);

if (reportedLine === expectedLine && reportedCol === expectedCol) {
  console.log("a7-PASS line:col matches raw source exactly (types-as-whitespace preserves position)");
  process.exit(0);
} else {
  console.log(
    `a7-FAIL reported ${reportedLine}:${reportedCol} vs expected ${expectedLine}:${expectedCol} (computed independently from source)`
  );
  process.exit(1);
}
