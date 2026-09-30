import { randomUUID } from "node:crypto";
import { afterAll, beforeAll } from "vitest";
import WebSocket from "ws";
import { ServerMessage, type ClientMessage, type Op } from "@noon/contracts";
import type { DocumentStore } from "@noon/db";
import { signSessionToken } from "@noon/session-token";
import { frameText } from "./raw.ts";
import { startSyncServer, type RunningSyncServer } from "./server.ts";

export const TEST_SECRET = "test-only-session-secret-0123456789abcdef";
export const TEST_ORG = "22222222-2222-4222-8222-222222222222";

/** The journal half of a fake DocumentStore, for tests that are not about the journal: it keeps nothing. */
export const NO_JOURNAL: Pick<DocumentStore, "append" | "find" | "everAdded" | "since"> = {
  append: () => Promise.resolve(undefined),
  find: () => Promise.resolve(undefined),
  everAdded: () => Promise.resolve(false),
  since: () => Promise.resolve([]),
};

/** A real sync server on a free port for one test file. */
export function useSyncServer(options: Omit<Parameters<typeof startSyncServer>[0], "port" | "secrets"> = {}): { readonly server: RunningSyncServer } {
  let server: RunningSyncServer | undefined;
  beforeAll(async () => {
    server = await startSyncServer({ port: 0, secrets: [TEST_SECRET], ...options });
  });
  afterAll(() => server?.close());
  return {
    get server() {
      if (!server) throw new Error("useSyncServer: used before beforeAll ran");
      return server;
    },
  };
}

const tokenFor = (documentId: string, userId: string, orgId: string, name?: string): string =>
  signSessionToken({ userId, orgId, documentId, secret: TEST_SECRET, ttlSeconds: 60, ...(name === undefined ? {} : { name }) });

/** A test peer: a real WebSocket plus an inbox you can await on. */
export type TestPeer = {
  userId: string;
  inbox: ServerMessage[];
  /** Resolves with the next message that matches, including ones that already arrived. */
  next<T extends ServerMessage["type"]>(type: T, where?: (m: Extract<ServerMessage, { type: T }>) => boolean): Promise<Extract<ServerMessage, { type: T }>>;
  send(op: Op, opId?: string): string;
  sendRaw(message: unknown): void;
  /** Keeps the socket open but stops reading from it: what a stalled client looks like to the server. */
  pauseReading(): void;
  closed: Promise<{ code: number; reason: string }>;
  close(): void;
};

export async function connect(url: string, documentId: string, userId: string = randomUUID(), wsOptions: WebSocket.ClientOptions = {}, orgId: string = TEST_ORG, name?: string): Promise<TestPeer> {
  // The token rides in the Sec-WebSocket-Protocol header: a browser cannot set any other header on
  // a WebSocket, and a query string would end up in proxy logs and Referer headers.
  const socket = new WebSocket(`${url}/documents/${documentId}`, ["noon.v1", tokenFor(documentId, userId, orgId, name)], wsOptions);
  const inbox: ServerMessage[] = [];
  let lastSeq = 0;
  const waiters: { test: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
  const consumed = new Set<ServerMessage>();
  socket.on("message", (data: WebSocket.RawData) => {
    const message = ServerMessage.parse(JSON.parse(frameText(data))); // every frame must satisfy the contract
    inbox.push(message);
    // A real client reports the last seq it has SEEN as baseSeq: that is how the room can tell a fresh
    // op from one that may be older than anything it still remembers.
    if (message.type === "welcome" || message.type === "op") lastSeq = Math.max(lastSeq, message.seq);
    const waiter = waiters.find((w) => w.test(message));
    if (waiter) {
      waiters.splice(waiters.indexOf(waiter), 1);
      consumed.add(message);
      waiter.resolve(message);
    }
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.on("close", (code, reason) => { resolve({ code, reason: reason.toString("utf8") }); });
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => { resolve(); });
    socket.once("error", reject);
  });
  return {
    userId,
    inbox,
    next: (type, where) =>
      new Promise((resolve, reject) => {
        const test = (m: ServerMessage): boolean => m.type === type && !consumed.has(m) && (where ? where(m as never) : true);
        const already = inbox.find(test);
        if (already) {
          consumed.add(already);
          resolve(already as never);
          return;
        }
        const timer = setTimeout(() => { reject(new Error(`no "${type}" message within 3 s; inbox: ${JSON.stringify(inbox.map((m) => m.type))}`)); }, 3000);
        waiters.push({ test, resolve: (m) => { clearTimeout(timer); resolve(m as never); } });
      }),
    send(op, opId = randomUUID()) {
      socket.send(JSON.stringify({ type: "op", opId, baseSeq: lastSeq, op } satisfies ClientMessage));
      return opId;
    },
    pauseReading: () => {
      // There is no public way to stall a ws client. It keeps its net.Socket in `_socket`, and its
      // receiver RESUMES that socket by itself whenever it has caught up, so pausing alone does nothing:
      // resume() must become a no-op as well.
      const net = (socket as unknown as { _socket: { pause(): void; resume(): unknown } })._socket;
      net.pause();
      net.resume = () => net;
    },
    sendRaw: (message) => { socket.send(typeof message === "string" ? message : JSON.stringify(message)); },
    closed,
    close: () => { socket.close(); },
  };
}

/** Waits for something that becomes true a moment after an event on ANOTHER process or socket. */
export async function until(condition: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
