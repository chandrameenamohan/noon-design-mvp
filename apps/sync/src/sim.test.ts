import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { createReplica } from "@noon/peer-client";
import { createRoom } from "./room.ts";
import { NAMED, SEEDS } from "./sim-seeds.ts";
import { runSim, shrink } from "./sim.ts";

const run = promisify(execFile);
const cli = new URL("./sim-cli.ts", import.meta.url).pathname;

test.each(SEEDS)("seed %i: every peer converges, no op is applied twice, the document is what its ops in seq order produce", async (seed) => {
  const result = await runSim({ seed });
  expect(result.failure, result.trace.join("\n")).toBeUndefined();
});

test("the seeds exercise what they are for: refusals, lost connections, reloads, 'stale', and real edits", async () => {
  const lines = (await Promise.all(SEEDS.map((seed) => runSim({ seed })))).flatMap((result) => result.trace);
  for (const needle of [" op seq ", "rejected", "stale", "gone", "loses its connection", "the room is reloaded", "gives up"]) expect(lines.some((line) => line.includes(needle)), needle).toBe(true);
});

test("same seed, same run: two separate PROCESSES print byte-identical traces", async () => {
  const [first, second] = await Promise.all([1, 2].map(() => run(process.execPath, [cli, "--seed", "7", "--trace"])));
  expect(first?.stdout.length).toBeGreaterThan(2000);
  expect(second?.stdout).toBe(first?.stdout);
  expect((await run(process.execPath, [cli, "--seed", "8", "--trace"])).stdout).not.toBe(first?.stdout);
}, 20_000);

// --- The simulator must be able to FAIL. Two real rules, each broken from outside, each caught by a named seed. ---

/** The room forgets who sent an op: every connection looks like a new actor, so its dedupe (keyed by sender + opId) never matches a resend. */
function roomIgnoringSender(): typeof createRoom {
  let connections = 0;
  return (options) => {
    const room = createRoom(options);
    return Object.assign(Object.create(room) as typeof room, { join: (peer: Parameters<typeof room.join>[0]) => { room.join(Object.assign(peer, { actor: { ...peer.actor, id: `${peer.actor.id}#${String(++connections)}` } })); } });
  };
}
/** A replica that claims, on every resend, to have written the op against what it sees NOW: it switches the room's "stale" guard off. */
const lyingReplica: typeof createReplica = (options) => {
  const replica = createReplica(options);
  return Object.assign(Object.create(replica) as typeof replica, { takeSendable: () => replica.takeSendable().map((op) => ({ ...op, baseSeq: replica.seq })) });
};

/** A replica that applies a late acknowledgement AGAIN (it arrives with a seq the welcome already covered) instead of only ending the wait. */
const reapplyingReplica: typeof createReplica = (options) => {
  const replica = createReplica(options);
  return Object.assign(Object.create(replica) as typeof replica, { receive: (message: Parameters<typeof replica.receive>[0]) => replica.receive(message.type === "op" && message.seq <= replica.seq ? { ...message, seq: replica.seq + 1 } : message) });
};

test("a replica that applies a late acknowledgement again fails the named seed: it no longer converges", async () => {
  const result = await runSim({ seed: NAMED.replicaAppliesLateAckAgain, factories: { createReplica: reapplyingReplica } });
  expect(result.failure).toMatch(/did not converge|still holds a different document/);
});

test("breaking the room's dedupe fails the named seed, with 'applied TWICE'", async () => {
  const result = await runSim({ seed: NAMED.roomDedupeIgnoresSender, factories: { createRoom: roomIgnoringSender() } });
  expect(result.failure).toMatch(/applied TWICE/);
});

test("a replica that lies about baseSeq fails the named seed, with 'applied TWICE'", async () => {
  const result = await runSim({ seed: NAMED.replicaLiesAboutBaseSeq, factories: { createReplica: lyingReplica } });
  expect(result.failure).toMatch(/applied TWICE/);
});

test("a failure is shrunk to the shortest run that still fails, and its trace names the ops", async () => {
  const options = { seed: NAMED.roomDedupeIgnoresSender, steps: 300, factories: { createRoom: roomIgnoringSender() } };
  const full = await runSim(options);
  const smallest = await shrink({ ...options, factories: { createRoom: roomIgnoringSender() } });
  expect(smallest.ok).toBe(false);
  expect(smallest.steps).toBeLessThan(full.steps);
  expect(smallest.trace.join("\n")).toMatch(/-> room {2}\w{4} base \d+: (add|move|remove|set) /);
});
