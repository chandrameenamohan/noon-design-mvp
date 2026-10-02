import { describe, expect, it } from "vitest";
import { formatHolder, keepLease, parseHolder, parseSyncNodes, syncRouter, takeLease, type Holder } from "./lease.ts";

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
  const beating = (...ids: string[]) => () => Promise.resolve<ReadonlySet<string>>(new Set(ids));
  const all = beating("sync", "sync-2");

  it("sends every peer to the room's owner", async () => {
    const route = syncRouter({ nodes, owner: owned({ token: 3, nodeId: "sync-2" }), alive: all, pick: () => "sync" });
    expect(await route(doc)).toBe(`ws://two:3001/documents/${doc}`);
  });

  it("with no owner yet, any node: its first peer takes the lease", async () => {
    const seen: (readonly string[])[] = [];
    const route = syncRouter({ nodes, owner: owned(undefined), alive: all, pick: (ids) => { seen.push(ids); return "sync"; } });
    expect(await route(doc)).toBe(`ws://one:3001/documents/${doc}`);
    expect(seen).toEqual([["sync", "sync-2"]]);
  });

  it("an owner that stopped beating (killed) still holds its lease, but its peers go to a live node, which waits it out", async () => {
    const seen: (readonly string[])[] = [];
    const route = syncRouter({ nodes, owner: owned({ token: 3, nodeId: "sync-2" }), alive: beating("sync"), pick: (ids) => { seen.push(ids); return ids[0] ?? ""; } });
    expect(await route(doc)).toBe(`ws://one:3001/documents/${doc}`);
    expect(seen).toEqual([["sync"]]);
  });

  it("a dead node is never picked for a free room while a live one exists", async () => {
    const route = syncRouter({ nodes, owner: owned(undefined), alive: beating("sync-2"), pick: (ids) => { expect(ids).toEqual(["sync-2"]); return "sync-2"; } });
    expect(await route(doc)).toBe(`ws://two:3001/documents/${doc}`);
  });

  it("nobody beating at all (Redis restarted, beats not yet written) routes as before heartbeats: the owner, else any node", async () => {
    expect(await syncRouter({ nodes, owner: owned({ token: 3, nodeId: "sync-2" }), alive: beating(), pick: () => "sync" })(doc)).toBe(`ws://two:3001/documents/${doc}`);
    expect(await syncRouter({ nodes, owner: owned(undefined), alive: beating(), pick: (ids) => { expect(ids).toEqual(["sync", "sync-2"]); return "sync"; } })(doc)).toBe(`ws://one:3001/documents/${doc}`);
  });

  it("an owner the table does not name is an error, not a guess that would loop on 4409", async () => {
    await expect(syncRouter({ nodes, owner: owned({ token: 1, nodeId: "sync-9" }), alive: all })(doc)).rejects.toThrow(/sync-9/);
  });

  it("Redis unreachable is the caller's error to answer", async () => {
    await expect(syncRouter({ nodes, owner: () => Promise.reject(new Error("redis away")), alive: all })(doc)).rejects.toThrow("redis away");
  });

  it("a single node needs no lookup at all", async () => {
    const route = syncRouter({ nodes: { kind: "one", url: "ws://sync.test:3001" }, owner: () => Promise.reject(new Error("must not be asked")), alive: () => Promise.reject(new Error("must not be asked")) });
    expect(await route(doc)).toBe(`ws://sync.test:3001/documents/${doc}`);
  });
});

describe("takeLease", () => {
  const TTL = 1000;
  /** A lease held by `holder` until `expiresAt` on the fake clock; sleeping advances the clock. */
  function setup({ holder, expiresAt, beating, stop }: { holder: Holder; expiresAt: number; beating: Set<string>; stop?: () => boolean }) {
    let clock = 0;
    let acquires = 0;
    const slept: number[] = [];
    const take = () => takeLease({
      nodeId: "sync", ttlMs: TTL, now: () => clock, ...(stop ? { stop } : {}),
      acquire: () => {
        acquires += 1;
        clock += 1; // the round trip
        return Promise.resolve(clock >= expiresAt ? { acquired: true, holder: { token: holder.token + 1, nodeId: "sync" } } : { acquired: false, holder });
      },
      alive: (id) => Promise.resolve(beating.has(id)),
      sleep: (ms) => { slept.push(ms); clock += ms; return Promise.resolve(); },
    });
    return { take, acquires: () => acquires, slept, clock: () => clock };
  }

  it("a free room is taken at once, with the time read BEFORE the acquire was sent", async () => {
    const { take, acquires } = setup({ holder: { token: 1, nodeId: "sync-2" }, expiresAt: 0, beating: new Set() });
    expect(await take()).toEqual({ holder: { token: 2, nodeId: "sync" }, acquiredAt: 0 });
    expect(acquires()).toBe(1);
  });

  it("held by a LIVE node: refused at once, never waited for (its peers belong with the owner)", async () => {
    const { take, acquires, slept } = setup({ holder: { token: 1, nodeId: "sync-2" }, expiresAt: Infinity, beating: new Set(["sync", "sync-2"]) });
    expect(await take()).toBeUndefined();
    expect(acquires()).toBe(1);
    expect(slept).toEqual([]);
  });

  it("held by a node that stopped beating (killed): waited out, and taken no later than a poll after it expires", async () => {
    const { take, clock } = setup({ holder: { token: 4, nodeId: "sync-2" }, expiresAt: 700, beating: new Set(["sync"]) });
    const taken = await take();
    expect(taken?.holder).toEqual({ token: 5, nodeId: "sync" });
    expect(clock()).toBeLessThanOrEqual(700 + TTL / 10 + 1);
    expect(taken?.acquiredAt).toBeGreaterThanOrEqual(700 - TTL / 10);
  });

  it("our OWN id on it (this node was killed and restarted) is waited out too, though our id is beating", async () => {
    const { take } = setup({ holder: { token: 4, nodeId: "sync" }, expiresAt: 300, beating: new Set(["sync"]) });
    expect((await take())?.holder.token).toBe(5);
  });

  it("never waits more than about one ttl: a lease that does not expire was renewed after all, so it is refused", async () => {
    const { take, clock } = setup({ holder: { token: 4, nodeId: "sync-2" }, expiresAt: Infinity, beating: new Set() });
    expect(await take()).toBeUndefined();
    expect(clock()).toBeLessThanOrEqual(TTL + 2 * (TTL / 10) + 20);
  });

  it("the dead holder coming back to life while we wait: refused at the next look", async () => {
    const beating = new Set<string>();
    const { take, acquires } = setup({ holder: { token: 4, nodeId: "sync-2" }, expiresAt: Infinity, beating });
    const pending = take();
    beating.add("sync-2");
    expect(await pending).toBeUndefined();
    expect(acquires()).toBeLessThanOrEqual(2);
  });

  it("given up at once when the node is shutting down: its close must not wait out a dead holder's lease (noon-98h.1.1)", async () => {
    let closing = false;
    const { take, acquires, slept } = setup({ holder: { token: 4, nodeId: "sync-2" }, expiresAt: Infinity, beating: new Set(), stop: () => closing });
    const pending = take();
    closing = true; // SIGTERM while the first poll is in flight
    expect(await pending).toBeUndefined();
    expect(acquires()).toBe(1);
    expect(slept).toEqual([]);
  });

  it("a shutdown that begins during a sleep stops the wait before the next acquire", async () => {
    let closing = false;
    let acquires = 0;
    let clock = 0;
    const taken = await takeLease({
      nodeId: "sync", ttlMs: TTL, now: () => clock, stop: () => closing,
      acquire: () => { acquires += 1; return Promise.resolve({ acquired: false, holder: { token: 4, nodeId: "sync-2" } }); },
      alive: () => Promise.resolve(false),
      sleep: (ms) => { closing = true; clock += ms; return Promise.resolve(); },
    });
    expect(taken).toBeUndefined();
    expect(acquires).toBe(1);
  });
});
