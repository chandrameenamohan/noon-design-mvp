// `run.sh report`: PASS/FAIL per property, from the SDK's local output (one file per process, under <state>/sdk).
//   node report.ts [dir] [--require pass|guards|round]
// --require pass    harness:baseline-all-pass: every property PASS (an always never evaluated is not a PASS).
// --require guards  harness:vacuity-guards-hit: every vacuity guard fired.
// --require round   one chaos round: nothing FAILED. A single fault cannot reach every window or guard, so those are not asked.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { guardsMissed, judge, notPassing, parseSdkOutput, table } from "./properties.ts";

const args = process.argv.slice(2);
const at = args.indexOf("--require");
const require = at < 0 ? undefined : args[at + 1];
const dir = args.find((arg, i) => !arg.startsWith("--") && (at < 0 || i !== at + 1)) ?? join(process.env["HARNESS_STATE"] ?? new URL("../.run", import.meta.url).pathname, "sdk");

const files = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".jsonl")) : [];
if (files.length === 0) {
  process.stdout.write(`no SDK output under ${dir}: nothing has run since the last reset\n`);
  process.exit(require === undefined ? 0 : 1);
}
const rows = judge(files.flatMap((name) => parseSdkOutput(readFileSync(join(dir, name), "utf8"))));
process.stdout.write(`${table(rows)}\n`);
const failed = require === "pass" ? notPassing(rows) : require === "guards" ? guardsMissed(rows) : require === "round" ? rows.filter((row) => row.verdict === "FAIL" && row.kind !== "reachability" && row.kind !== "sometimes").map((row) => `${row.slug}: FAIL`) : [];
if (require !== undefined) process.stdout.write(failed.length === 0 ? `harness check "${require}": PASS\n` : `harness check "${require}": FAIL\n${failed.map((line) => `  ${line}`).join("\n")}\n`);
process.exit(failed.length === 0 ? 0 : 1);
