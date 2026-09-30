import { describe, expect, it } from "vitest";
import { formatHolder, keepLease, parseHolder, parseSyncNodes, syncRouter, type Holder } from "./lease.ts";

describe("holder values", () => {
  it("round-trips, and anything that is not one of ours reads as nobody", () => {
    expect(parseHolder(formatHolder({ token: 7, nodeId: "sync-2" }))).toEqual({ token: 7, nodeId: "sync-2" });
    for (const bad of ["", "7", "7:", ":sync", "0:sync", "-1:sync", "x:sync", "7:Sync", "7:a b", "7:__proto__"]) expect(parseHolder(bad), bad).toBeUndefined();
  });
});

describe("keepLease", () => {
  const TTL = 1000;
  function setup(renew: () => Promise<boolean>) {
    let clock = 0;
    let lostCount = 0;
    const keeper = keepLease({ renew, ttlMs: TTL, now: () => clock, acquiredAt: 0, onLost: () => { lostCount += 1; } });
    return { keeper, advance: (ms: number) => { clock += ms; }, lost: () => lostCount };
  }

  it("a renewed lease stays held well past one ttl", async () => {
    const { keeper, advance, lost } = setup(() => Promise.resolve(true));
    for (let i = 0; i < 10; i += 1) {
      advance(TTL / 3);
      await keeper.tick();
    }
    expect(keeper.held).toBe(true);
    expect(lost()).toBe(0);
  });

  it("a renewal Redis refuses (someone else holds it) loses the lease at once, and only once", async () => {
    const { keeper, advance, lost } = setup(() => Promise.resolve(false));
    advance(1);
    await keeper.tick();
    expect(keeper.held).toBe(false);
    await keeper.tick();
    expect(lost()).toBe(1);
  });

  it("while Redis cannot be asked it is still held, until the deadline on OUR clock passes", async () => {
    const { keeper, advance, lost } = setup(() => Promise.reject(new Error("redis away")));
    advance(TTL / 3);
    await keeper.tick();
    expect(keeper.held).toBe(true);
    advance(TTL / 3);
    await keeper.tick();
    expect(keeper.held).toBe(true);
    advance(TTL / 3); // 1000 ms since the acquire was SENT: Redis may already have let it go
    await keeper.tick();
    expect(keeper.held).toBe(false);
    expect(lost()).toBe(1);
  });

  it("the deadline counts from when a renewal was SENT, not when its answer came back", async () => {
    let clock = 0;
    const keeper = keepLease({
      renew: () => { clock += 800; return Promise.resolve(true); }, // a slow answer: Redis started its countdown at the send
      ttlMs: TTL, now: () => clock, acquiredAt: 0, onLost: () => undefined,
    });
    clock = 300;
    await keeper.tick(); // sent at 300, answered at 1100: trusted until 300 + 900
    clock = 1150;
    expect(keeper.held).toBe(true);
    clock = 1200;
    expect(keeper.held).toBe(false);
  });

  it("a renewal that hangs does not keep the lease: the deadline is checked even while one is in flight", async () => {
    let clock = 0;
    let lostCount = 0;
    const keeper = keepLease({ renew: () => new Promise<boolean>(() => undefined), ttlMs: TTL, now: () => clock, acquiredAt: 0, onLost: () => { lostCount += 1; } });
    clock = 300;
    void keeper.tick();
    clock = 950;
    await keeper.tick();
    expect(lostCount).toBe(1);
    expect(keeper.held).toBe(false);
  });

  it("a renewal that fails never shortens what an earlier one earned", async () => {
    let answer: () => Promise<boolean> = () => Promise.resolve(true);
    let clock = 0;
    const keeper = keepLease({ renew: () => answer(), ttlMs: TTL, now: () => clock, acquiredAt: 0, onLost: () => undefined });
    clock = 500;
    await keeper.tick(); // trusted until 1400
    answer = () => Promise.reject(new Error("away"));
    clock = 800;
    await keeper.tick();
    clock = 1350;
    expect(keeper.held).toBe(true);
  });
});

describe("parseSyncNodes", () => {
  it("one URL is one node; a trailing slash is dropped so that joining a path never doubles it", () => {
    expect(parseSyncNodes("wss://noon.example.com/sync/")).toEqual({ kind: "one", url: "wss://noon.example.com/sync" });
  });

  it("id=url pairs are the routing table", () => {
    expect(parseSyncNodes("sync=ws://localhost:3001, sync-2=ws://localhost:3003/")).toEqual({ kind: "many", nodes: new Map([["sync", "ws://localhost:3001"], ["sync-2", "ws://localhost:3003"]]) });
  });

  it("refuses what would route a peer nowhere", () => {
    for (const bad of ["", "http://localhost:3001", "localhost:3001", "wss://a.example/?x=1", "wss://a.example#f", "sync=http://a", "Sync=ws://a", "=ws://a", "a=ws://x,a=ws://y", "a=ws://x?y=1", ","]) expect(parseSyncNodes(bad), bad).toBeUndefined();
  });
});

describe("syncRouter", () => {
  const nodes = parseSyncNodes("sync=ws://one:3001,sync-2=ws://two:3001");
  if (!nodes) throw new Error("fixture");
  const doc = "11111111-1111-4111-8111-111111111111";
  const owned = (holder: Holder | undefined) => () => Promise.resolve(holder);

  it("sends every peer to the room's owner", async () => {
    const route = syncRouter({ nodes, owner: owned({ token: 3, nodeId: "sync-2" }), pick: () => "sync" });
    expect(await route(doc)).toBe(`ws://two:3001/documents/${doc}`);
  });

  it("with no owner yet, any node: its first peer takes the lease", async () => {
    const seen: (readonly string[])[] = [];
    const route = syncRouter({ nodes, owner: owned(undefined), pick: (ids) => { seen.push(ids); return "sync"; } });
    expect(await route(doc)).toBe(`ws://one:3001/documents/${doc}`);
    expect(seen).toEqual([["sync", "sync-2"]]);
  });

  it("an owner the table does not name is an error, not a guess that would loop on 4409", async () => {
    await expect(syncRouter({ nodes, owner: owned({ token: 1, nodeId: "sync-9" }) })(doc)).rejects.toThrow(/sync-9/);
  });

  it("Redis unreachable is the caller's error to answer", async () => {
    await expect(syncRouter({ nodes, owner: () => Promise.reject(new Error("redis away")) })(doc)).rejects.toThrow("redis away");
  });

  it("a single node needs no lookup at all", async () => {
    const route = syncRouter({ nodes: { kind: "one", url: "ws://sync.test:3001" }, owner: () => Promise.reject(new Error("must not be asked")) });
    expect(await route(doc)).toBe(`ws://sync.test:3001/documents/${doc}`);
  });
});
