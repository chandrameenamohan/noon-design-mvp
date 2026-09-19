import { randomUUID } from "node:crypto";
import { afterAll, beforeAll } from "vitest";
import WebSocket from "ws";
import { ServerMessage, type ClientMessage, type Op } from "@noon/contracts";
import { signSessionToken } from "@noon/session-token";
import { frameText } from "./raw.ts";
import { startSyncServer, type RunningSyncServer } from "./server.ts";

const TEST_SECRET = "test-only-session-secret-0123456789abcdef";
const ORG = "22222222-2222-4222-8222-222222222222";

/** A real sync server on a free port for one test file. */
export function useSyncServer(limits?: { maxNodes?: number; maxDepth?: number }): { readonly server: RunningSyncServer } {
  let server: RunningSyncServer | undefined;
  beforeAll(async () => {
    server = await startSyncServer({ port: 0, secrets: [TEST_SECRET], ...(limits ? { limits } : {}) });
  });
  afterAll(() => server?.close());
  return {
    get server() {
      if (!server) throw new Error("useSyncServer: used before beforeAll ran");
      return server;
    },
  };
}

const tokenFor = (documentId: string, userId: string, secret = TEST_SECRET, ttlSeconds = 60): string =>
  signSessionToken({ userId, orgId: ORG, documentId, secret, ttlSeconds });

/** A test peer: a real WebSocket plus an inbox you can await on. */
export type TestPeer = {
  userId: string;
  inbox: ServerMessage[];
  /** Resolves with the next message that matches, including ones that already arrived. */
  next<T extends ServerMessage["type"]>(type: T, where?: (m: Extract<ServerMessage, { type: T }>) => boolean): Promise<Extract<ServerMessage, { type: T }>>;
  send(op: Op, opId?: string): string;
  sendRaw(message: unknown): void;
  closed: Promise<{ code: number; reason: string }>;
  close(): void;
};

export async function connect(url: string, documentId: string, userId: string = randomUUID()): Promise<TestPeer> {
  // The token rides in the Sec-WebSocket-Protocol header: a browser cannot set any other header on
  // a WebSocket, and a query string would end up in proxy logs and Referer headers.
  const socket = new WebSocket(`${url}/documents/${documentId}`, ["noon.v1", tokenFor(documentId, userId)]);
  const inbox: ServerMessage[] = [];
  const waiters: { test: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
  const consumed = new Set<ServerMessage>();
  socket.on("message", (data: WebSocket.RawData) => {
    const message = ServerMessage.parse(JSON.parse(frameText(data))); // every frame must satisfy the contract
    inbox.push(message);
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
  let sentSeq = 0;
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
      socket.send(JSON.stringify({ type: "op", opId, baseSeq: sentSeq++, op } satisfies ClientMessage));
      return opId;
    },
    sendRaw: (message) => { socket.send(typeof message === "string" ? message : JSON.stringify(message)); },
    closed,
    close: () => { socket.close(); },
  };
}
