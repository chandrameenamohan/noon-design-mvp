// check:catalog-complete (Z.2a, SPEC §4a A0). The property catalog under antithesis/scratchbook/ is one file per
// property, properties/<id>.md, whose front matter is flat `key: value` lines. Every property needs an observable, a
// type, a priority, the site its assertion lives at and an evidence file; every always (and unreachable, and eventually)
// also needs the sometimes that proves its path ran, and where that is observed. The seven A0 invariants must all
// have a property. Prints one line per problem and exits non-zero: `make catalog-check`, and a unit test.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const TYPES = ["always", "sometimes", "unreachable", "reachability", "eventually"];
const GUARDED = new Set(["always", "unreachable", "eventually"]);
const PRIORITIES = ["P0", "P1", "P2"];
// Antithesis's test-template command prefixes: a site Z.2b asserts from the driver, not from the app.
const COMMANDS = ["first_", "parallel_driver_", "singleton_driver_", "serial_driver_", "anytime_", "eventually_", "finally_"];
const A0 = [1, 2, 3, 4, 5, 6, 7];

type Book = { files: ReadonlyMap<string, string>; catalog: string; lineCount: (path: string) => number | undefined; a0?: readonly number[] };

function frontMatter(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  const block = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  for (const line of block.split("\n")) {
    const at = line.indexOf(": ");
    if (at > 0) fields.set(line.slice(0, at).trim(), line.slice(at + 2).trim());
  }
  return fields;
}

export function catalogProblems({ files, catalog, lineCount, a0 = A0 }: Book): string[] {
  const problems: string[] = [];
  const covered = new Set<number>();
  const site = (who: string, key: string, value: string | undefined): void => {
    if (!value) return void problems.push(`${who}: ${key} is missing (path:line in the repo, or harness:<test command>)`);
    if (value.startsWith("harness:")) {
      if (!COMMANDS.some((prefix) => value.slice("harness:".length).startsWith(prefix))) problems.push(`${who}: ${key} ${value} is not a test-template command (${COMMANDS.join(", ")})`);
      return;
    }
    const [path = "", line] = value.split(":");
    const lines = lineCount(path);
    if (lines === undefined) problems.push(`${who}: ${key} ${value}: ${path} does not exist`);
    else if (!/^\d+$/.test(line ?? "")) problems.push(`${who}: ${key} ${value} has no line number`);
    else if (Number(line) > lines) problems.push(`${who}: ${key} ${value} is past the end of the file (${String(lines)} lines)`);
  };
  for (const [name, text] of files) {
    const fields = frontMatter(text);
    const id = fields.get("id");
    if (id !== name.replace(/\.md$/, "")) {
      problems.push(`${name}: id ${id ?? "(none)"} does not match its file name`);
      continue;
    }
    const type = fields.get("type");
    const priority = fields.get("priority");
    if (!fields.get("observable")) problems.push(`${id}: observable is missing (the business outcome it is phrased on)`);
    if (!type) problems.push(`${id}: type is missing (always, sometimes, unreachable, reachability or eventually)`);
    else if (!TYPES.includes(type)) problems.push(`${id}: type ${type} is not always, sometimes, unreachable, reachability or eventually`);
    if (!priority) problems.push(`${id}: priority is missing (P0, P1 or P2)`);
    else if (!PRIORITIES.includes(priority)) problems.push(`${id}: priority ${priority} is not P0, P1 or P2`);
    site(id, "site", fields.get("site"));
    if (type && GUARDED.has(type)) {
      if (!fields.get("guard")) problems.push(`${id}: an ${type} needs a guard (the sometimes that proves its path ran)`);
      site(id, "guard_site", fields.get("guard_site"));
    }
    const evidence = (fields.get("evidence") ?? "").split(",").map((each) => each.trim()).filter(Boolean);
    if (evidence.length === 0) problems.push(`${id}: evidence is missing (the test or chaos script that exercises it today)`);
    for (const path of evidence) if (lineCount(path.split(":")[0] ?? "") === undefined) problems.push(`${id}: evidence ${path} does not exist`);
    // The antithesis-research skill's catalog format: one `### <slug> — <Property Name>` section per property.
    if (!catalog.split("\n").some((line) => line.startsWith(`### ${id} — `))) problems.push(`${id}: property-catalog.md has no section ### ${id} — <name>`);
    const invariant = fields.get("a0");
    if (invariant) covered.add(Number(invariant));
  }
  for (const n of a0) if (!covered.has(n)) problems.push(`A0 invariant ${String(n)} has no property`);
  return problems;
}

const ROOT = join(import.meta.dirname, "..");
const BOOK = join(ROOT, "antithesis", "scratchbook");

export function readScratchbook(): Book {
  const dir = join(BOOK, "properties");
  const files = new Map(readdirSync(dir).filter((name) => name.endsWith(".md")).map((name) => [name, readFileSync(join(dir, name), "utf8")]));
  const lineCount = (path: string): number | undefined => {
    const at = join(ROOT, path);
    return path !== "" && statSync(at, { throwIfNoEntry: false })?.isFile() ? readFileSync(at, "utf8").split("\n").length : undefined;
  };
  return { files, catalog: readFileSync(join(BOOK, "property-catalog.md"), "utf8"), lineCount };
}

if (import.meta.main) {
  const problems = catalogProblems(readScratchbook());
  for (const problem of problems) process.stdout.write(`${problem}\n`);
  process.exit(problems.length === 0 ? 0 : 1);
}
