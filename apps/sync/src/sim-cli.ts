// `make sim`: every committed seed, or one: `node apps/sync/src/sim-cli.ts --seed 7 [--trace]`.
import { parseArgs } from "node:util";
import { SEEDS } from "./sim-seeds.ts";
import { runSim, shrink } from "./sim.ts";

const { values } = parseArgs({ options: { seed: { type: "string" }, trace: { type: "boolean", default: false }, steps: { type: "string", default: "300" } } });
const steps = Number(values.steps);
let failed = 0;
for (const seed of values.seed === undefined ? SEEDS : [Number(values.seed)]) {
  const result = await runSim({ seed, steps });
  if (values.trace) process.stdout.write(`${result.trace.join("\n")}\n`);
  if (result.ok) continue;
  failed++;
  const smallest = await shrink({ seed, steps });
  process.stdout.write(`seed ${String(seed)} FAILED at ${smallest.failure ?? "?"}\n  replay: node apps/sync/src/sim-cli.ts --seed ${String(seed)} --steps ${String(smallest.steps)} --trace\n${smallest.trace.map((line) => `  ${line}`).join("\n")}\n`);
}
process.stdout.write(`sim: ${String(values.seed === undefined ? SEEDS.length : 1)} seed(s), ${String(failed)} failed\n`);
process.exit(failed === 0 ? 0 : 1);
