import { createServer, type AddressInfo, type Socket } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, expect, test, vi } from "vitest";
import { applyOp, emptyDoc, ROOT_ID } from "@noon/doc-model";
import { decodeSnapshot, encodeSnapshot, s3Snapshots, snapshotKey, snapshotter } from "./snapshots.ts";

// E6.2: the key and cadence rules, without MinIO. snapshot.int.test.ts runs them against the real thing.
afterEach(() => { vi.useRealTimers(); });

const ORG = "11111111-1111-4111-8111-111111111111";
const DOC = "22222222-2222-4222-8222-222222222222";

test("keys zero-pad the seq so that string order is numeric order, up to the largest safe integer", () => {
  expect(snapshotKey(ORG, DOC, 7)).toBe(`${ORG}/${DOC}/0000000000000007.json.gz`);
  const seqs = [9, 10, 2, 100_000, Number.MAX_SAFE_INTEGER];
  const keys = seqs.map((seq) => snapshotKey(ORG, DOC, seq));
  expect([...keys].sort()).toEqual([...seqs].sort((a, b) => a - b).map((seq) => snapshotKey(ORG, DOC, seq)));
  expect(new Set(keys.map((k) => k.length)).size).toBe(1);
  for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(() => snapshotKey(ORG, DOC, bad)).toThrow(/not a seq/);
});

test("a snapshot round-trips, and anything that is not a well-formed tree decodes to nothing", () => {
  const doc = applyOp(emptyDoc(), { type: "add_node", nodeId: "n1", parentId: ROOT_ID, index: 0, component: "Stack", props: { gap: 8 } });
  expect(decodeSnapshot(encodeSnapshot(doc))).toEqual(doc);
  expect(decodeSnapshot(new TextEncoder().encode(JSON.stringify(doc)))).toBeUndefined(); // not gzipped
  expect(decodeSnapshot(gzipSync("{not json"))).toBeUndefined();
  expect(decodeSnapshot(gzipSync(JSON.stringify({ hello: "world" })))).toBeUndefined();
  const ghost = { rootId: "root", nodes: { root: { id: "root", component: "Page", props: {}, parentId: null, children: ["ghost"] } } };
  expect(decodeSnapshot(gzipSync(JSON.stringify(ghost)))).toBeUndefined(); // parses as a Doc, but checkDoc refuses it
});

/** A room stand-in whose seq a test moves by hand, and a write that records or fails on demand. */
function rig({ from = 0, everyOps = 3, everyMs = 1000 } = {}) {
  const room = { seq: from, doc: emptyDoc(), peerCount: 1 };
  const written: number[] = [];
  const control = { fail: false, hold: undefined as Promise<void> | undefined };
  const snap = snapshotter({
    room,
    from,
    cadence: { everyOps, everyMs },
    write: async (seq, body) => {
      await control.hold;
      if (control.fail) throw new Error("minio down");
      expect(decodeSnapshot(body)).toBeDefined();
      written.push(seq);
    },
  });
  const accept = (): void => { room.seq++; snap.accepted(room.seq); };
  return { room, written, control, snap, accept };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("every N accepted ops, counted from the last snapshot: not from zero, not from the room's start", async () => {
  const { written, snap, accept } = rig({ from: 10, everyOps: 3 });
  accept(); accept(); await flush();
  expect(written).toEqual([]);
  accept(); await flush();
  expect(written).toEqual([13]);
  accept(); accept(); await flush();
  expect(written).toEqual([13]);
  accept(); await flush();
  expect(written).toEqual([13, 16]);
  expect(snap.saved).toBe(16);
  snap.stop();
});

test("every T while peers are connected, only if the room moved; never with nobody here", async () => {
  vi.useFakeTimers();
  const { room, written, snap } = rig({ everyOps: 1000, everyMs: 1000 });
  await vi.advanceTimersByTimeAsync(1000);
  expect(written).toEqual([]); // nothing new: no write
  room.seq = 2;
  await vi.advanceTimersByTimeAsync(1000);
  expect(written).toEqual([2]);
  room.seq = 5;
  room.peerCount = 0;
  await vi.advanceTimersByTimeAsync(3000);
  expect(written).toEqual([2]); // the last-leave snapshot is the server's to take, not the timer's
  room.peerCount = 1;
  await vi.advanceTimersByTimeAsync(1000);
  expect(written).toEqual([2, 5]);
  snap.stop();
  room.seq = 9;
  await vi.advanceTimersByTimeAsync(5000);
  expect(written).toEqual([2, 5]);
});

test("a failed write loses nothing: take says so, nothing counts as saved, and the next trigger tries again", async () => {
  const { written, control, snap, accept } = rig({ everyOps: 2 });
  control.fail = true;
  accept(); accept(); await flush();
  expect(await snap.take()).toBe(false);
  expect(snap.saved).toBe(0);
  control.fail = false;
  expect(await snap.take()).toBe(true);
  expect(written).toEqual([2]);
  expect(await snap.take()).toBe(true); // nothing new
  expect(written).toEqual([2]);
  snap.stop();
});

test("one write at a time: triggers during a write are dropped, and take waits for it, then writes what is newer", async () => {
  const { room, written, control, snap, accept } = rig({ everyOps: 1 });
  let release = (): void => undefined;
  control.hold = new Promise((resolve) => { release = resolve; });
  accept(); // starts a write of 1, held
  accept(); accept(); // dropped: a write is running
  const last = snap.take(); // what the last peer leaving does
  await flush();
  expect(written).toEqual([]);
  control.hold = undefined;
  release();
  expect(await last).toBe(true);
  expect(written).toEqual([1, 3]);
  expect(room.seq).toBe(3);
  snap.stop();
});

// noon-cs6.3 (minio-stalled, noon-mo3.3.1): the SDK sets no timeout of its own, so a MinIO that accepts the
// connection and never answers held `load()` for ever, and with it every later peer of that document on the node.
test("a MinIO that accepts the connection and never answers is a rejection within the bound, never a wait for ever", async () => {
  const sockets = new Set<Socket>();
  const silent = createServer((socket) => { sockets.add(socket); socket.on("error", () => undefined); });
  await new Promise<void>((resolve) => { silent.listen(0, "127.0.0.1", resolve); });
  const store = s3Snapshots({ endpoint: `http://127.0.0.1:${String((silent.address() as AddressInfo).port)}`, accessKeyId: "key", secretAccessKey: "secret", bucket: "snapshots", timeoutMs: 150 });
  try {
    const started = Date.now();
    await expect(store.get(ORG, DOC, 1)).rejects.toThrow("MinIO did not answer within 150 ms");
    await expect(store.put(ORG, DOC, 1, encodeSnapshot(emptyDoc()))).rejects.toThrow("MinIO did not answer");
    await expect(store.ensureBucket()).rejects.toThrow("MinIO did not answer");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(sockets.size).toBeGreaterThan(0); // the calls really reached the silent server
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => silent.close(resolve));
  }
}, 4000);
