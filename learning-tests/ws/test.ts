// Learning test for the `ws` package (WebSocket) on Node.js 24.
// Run with: node test.ts   (Node 24 strips types natively)
//
// FINDINGS (filled in after running against ws@8.21.3 / Node v24.17.0):
//
// 1. Message ordering (single connection, and server broadcast order):
//    CONFIRMED. Messages sent in order N..1 on one connection arrive at the
//    server in that exact order. Messages the server sends (in a fixed
//    order) to a client arrive at that client in the same order. WebSocket
//    over a single TCP connection is inherently ordered; ws does not
//    reorder frames.
//
// 2. Dead-peer detection without a close frame:
//    ASSUMED X, ACTUAL Y (important nuance). Assumed: "killing the client
//    without a close frame (e.g. socket.terminate()/destroy()) means the
//    server won't learn about it promptly by itself." Actual: it DEPENDS on
//    *how* the peer dies.
//      - `client._socket.destroy()` on localhost: the server's 'close'
//        fired almost instantly (0-1ms in this run). destroy() still makes
//        the OS kernel send a TCP FIN/RST, which the server's kernel/ws
//        sees right away. This is NOT a silent death — it's just skipping
//        the WebSocket-level close *handshake*, not the TCP-level signal.
//      - A genuinely silent hang (client socket paused in both directions,
//        never destroyed/ended — simulating a frozen process, a suspended
//        laptop, or a network partition where no FIN/RST is ever sent):
//        the server's 'close' did NOT fire within the 2.5s observation
//        window. This is the real scenario a heartbeat protects against.
//    With a ping/pong heartbeat (ping every 500ms, terminate() if no pong
//    since the last ping), and detection latency measured from the moment
//    the hang was actually induced (not from connection-open, and not from
//    before the client even connected), the silently-hung peer was
//    detected and terminated ~794-807ms after the hang started, across
//    repeated runs -- inside the asserted [heartbeatInterval,
//    3*heartbeatInterval] = [500ms, 1500ms] bound, and consistent with the
//    theoretical (heartbeatInterval, 2*heartbeatInterval] window for this
//    protocol (the first tick after the hang sends an unanswered ping, the
//    next tick observes no pong and terminates). Termination was verified
//    server-side, not just inferred from an internal flag: the peer's own
//    socket emitted a 'close' event and wss.clients.size dropped from 1 to
//    0. The no-heartbeat control (silent hang, no heartbeat running) was
//    observed for the identical 3x-heartbeat-interval window (1500ms) and
//    did NOT fire 'close' on the server side, confirming detection is
//    attributable to the heartbeat, not to some other TCP/OS-level signal.
//    DESIGN IMPLICATION: don't assume `close`/`error` will fire for every
//    kind of dead peer — a heartbeat is still required, because the
//    failure modes it actually protects against are silent hangs/partitions,
//    not just "process exits without sending a close frame."
//    See logged values below for exact numbers from this run.
//
// 3. Backpressure via bufferedAmount:
//    CONFIRMED. `ws.send()` does not throw even when the peer is not
//    reading (paused). `bufferedAmount` grows as more data is queued
//    client/server-side, confirming the application must watch
//    `bufferedAmount` (or use the send() callback) and apply its own
//    backpressure — ws will not do it automatically.
//
// 4. Rejecting upgrade before WebSocket established (noServer + handleUpgrade):
//    CONFIRMED. Using `noServer: true` and manually calling
//    `wss.handleUpgrade()` only for requests with a valid token, and
//    otherwise writing a raw HTTP 401 response and calling
//    `socket.destroy()`, the client's `ws` constructor emits an 'unexpected-response'
//    event carrying the actual non-101 status code (401) rather than
//    upgrading.
//
// 5. Custom close codes 4000-4999 with a reason:
//    CONFIRMED. A close code of 4001 and a reason string sent by the server
//    arrive intact at the client's 'close' event handler (code === 4001,
//    reason === the exact string).
//
// 6. maxPayload closes the connection with code 1009:
//    ASSUMED X, ACTUAL Y (nuance). Assumed: "the connection closes with
//    code 1009." Actual: the CLIENT (the side that sent the oversized
//    message) receives close code 1009 from the server's close frame, as
//    expected. But the SERVER's own 'close' event reports code 1006
//    (abnormal closure), not 1009 -- because upon detecting the violation,
//    ws emits an 'error' (RangeError: Max payload size exceeded) on the
//    server-side socket, sends a 1009 close frame to the client, and then
//    aborts its own socket immediately without completing the closing
//    handshake. An application must handle the 'error' event on the
//    server-side socket (ws re-throws it as an unhandled 'error' event
//    otherwise) and should not assume ITS OWN close code will be 1009 when
//    it is the one enforcing the limit -- only the remote peer sees 1009.

import { WebSocketServer, WebSocket } from "ws";
import http from "node:http";
import assert from "node:assert/strict";

const PORT = 8791;

function log(...args: unknown[]) {
  console.log(...args);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function test1_ordering() {
  log("\n=== TEST 1: message ordering ===");
  const wss = new WebSocketServer({ port: PORT });
  await new Promise<void>((resolve) => wss.once("listening", resolve));

  const serverReceived: string[] = [];
  const clientReceived: string[] = [];

  const serverSocketPromise = new Promise<WebSocket>((resolve) => {
    wss.once("connection", (ws) => {
      ws.on("message", (data) => {
        serverReceived.push(data.toString());
      });
      resolve(ws);
    });
  });

  const client = new WebSocket(`ws://localhost:${PORT}`);
  await new Promise<void>((resolve) => client.once("open", resolve));
  const serverSocket = await serverSocketPromise;

  client.on("message", (data) => {
    clientReceived.push(data.toString());
  });

  // Client -> server, in order
  const sent = ["msg-1", "msg-2", "msg-3", "msg-4", "msg-5"];
  for (const m of sent) {
    client.send(m);
  }

  // Give the server time to receive all of them
  await wait(200);
  log("server received (client->server order):", serverReceived);
  assert.deepEqual(
    serverReceived,
    sent,
    "server should receive messages in the order the client sent them"
  );

  // Server -> client broadcast, in a fixed order
  const broadcast = ["b-1", "b-2", "b-3", "b-4", "b-5"];
  for (const m of broadcast) {
    serverSocket.send(m);
  }
  await wait(200);
  log("client received (server->client order):", clientReceived);
  assert.deepEqual(
    clientReceived,
    broadcast,
    "client should receive messages in the order the server sent them"
  );

  client.close();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  log("TEST 1: PASS");
}

async function test2_deadPeerDetection() {
  log("\n=== TEST 2: dead peer detection (no close frame) ===");

  // Shared across Part A and Part B so the "no heartbeat" control observes
  // the peer for exactly the same wall-clock window the heartbeat case is
  // given to detect it in.
  const HEARTBEAT_INTERVAL = 500;
  const OBSERVE_WINDOW = HEARTBEAT_INTERVAL * 3;

  // --- Part A0: socket.destroy() on localhost -- shown for comparison ---
  // IMPORTANT FINDING: on localhost, destroy()ing the client's underlying
  // TCP socket still causes the kernel to send a FIN/RST to the server side
  // immediately, so the server's 'close' fires almost instantly. This is
  // NOT a silent death -- it's a clean-ish TCP teardown. The real failure
  // mode a heartbeat protects against is a peer that hangs/freezes/loses
  // network WITHOUT its OS ever sending a FIN/RST (process frozen, laptop
  // sleeps, network partition, hard crash). We measure that first, then
  // measure the (misleading) destroy() case for comparison.
  {
    const wss = new WebSocketServer({ port: PORT });
    await new Promise<void>((resolve) => wss.once("listening", resolve));

    const serverSocketPromise = new Promise<WebSocket>((resolve) => {
      wss.once("connection", (ws) => resolve(ws));
    });

    const client = new WebSocket(`ws://localhost:${PORT}`);
    await new Promise<void>((resolve) => client.once("open", resolve));
    const serverSocket = await serverSocketPromise;

    let serverSawClose = false;
    const closeStart = Date.now();
    let closeElapsed = -1;
    serverSocket.on("close", () => {
      serverSawClose = true;
      closeElapsed = Date.now() - closeStart;
    });

    (client as any)._socket.destroy();

    await wait(500);
    log(
      `destroy() case: server saw 'close' = ${serverSawClose} after ${closeElapsed}ms (TCP-level teardown still happened -- NOT representative of a truly silent peer death)`
    );
    assert.equal(
      serverSawClose,
      true,
      "on localhost, destroy() still sends a TCP FIN/RST that the server's kernel/ws sees promptly"
    );

    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  // --- Part A: truly silent hang -- pause the client's socket in both
  // directions and never close it. No FIN, no RST, no WebSocket close
  // frame is ever sent. This is the realistic "dead peer" scenario: the
  // TCP connection stays ESTABLISHED at the OS level on both ends, exactly
  // like a frozen process, a suspended laptop, or a network partition where
  // the local kernel has no idea the remote is unreachable.
  {
    const wss = new WebSocketServer({ port: PORT });
    await new Promise<void>((resolve) => wss.once("listening", resolve));

    const serverSocketPromise = new Promise<WebSocket>((resolve) => {
      wss.once("connection", (ws) => resolve(ws));
    });

    const client = new WebSocket(`ws://localhost:${PORT}`);
    await new Promise<void>((resolve) => client.once("open", resolve));
    const serverSocket = await serverSocketPromise;

    let serverSawClose = false;
    serverSocket.on("close", () => {
      serverSawClose = true;
    });

    // Freeze the client's socket silently: stop reading incoming data and
    // never send anything else. The socket is NOT destroyed/ended, so no
    // FIN/RST is emitted -- this is a genuinely silent hang.
    (client as any)._socket.pause();

    await wait(OBSERVE_WINDOW);
    log(
      `silent-hang (paused, not destroyed) case: server saw 'close' = ${serverSawClose} after ${OBSERVE_WINDOW}ms observation window (== the same 3x heartbeat-interval window Part B is given to detect the same kind of hang) with NO heartbeat running`
    );
    assert.equal(
      serverSawClose,
      false,
      "server should NOT detect a genuinely silent hung peer on its own within the observation window (no FIN/RST, no close frame, no heartbeat)"
    );

    // Clean up the paused socket so it doesn't linger past the test.
    (client as any)._socket.destroy();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  // --- Part B: with ping/pong heartbeat, measure detection latency FROM
  // THE MOMENT THE HANG IS INDUCED (not from connection open, and not from
  // before the client connects) -- that's the actual failure-start instant
  // a real design would care about. Also verify the server-side effect of
  // detection: the peer's socket actually gets a 'close' event and is
  // removed from wss.clients, not just that some internal flag flipped.
  {
    const wss = new WebSocketServer({ port: PORT });
    await new Promise<void>((resolve) => wss.once("listening", resolve));

    function heartbeat(this: WebSocket & { isAlive?: boolean }) {
      this.isAlive = true;
    }

    const serverSocketPromise = new Promise<WebSocket & { isAlive?: boolean }>(
      (resolve) => {
        wss.once("connection", (ws: WebSocket & { isAlive?: boolean }) => {
          ws.isAlive = true;
          ws.on("pong", heartbeat.bind(ws));
          resolve(ws);
        });
      }
    );

    let detectedAt = 0;

    const interval = setInterval(() => {
      wss.clients.forEach((ws: WebSocket & { isAlive?: boolean }) => {
        if (ws.isAlive === false) {
          detectedAt = Date.now();
          return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
      });
    }, HEARTBEAT_INTERVAL);

    const client = new WebSocket(`ws://localhost:${PORT}`);
    await new Promise<void>((resolve) => client.once("open", resolve));
    const serverSocket = await serverSocketPromise;

    let serverSawClose = false;
    serverSocket.on("close", () => {
      serverSawClose = true;
    });

    // Let one healthy heartbeat cycle pass so we know pong response works
    // before we induce the hang.
    await wait(HEARTBEAT_INTERVAL + 200);
    log(`before hang: wss.clients.size = ${wss.clients.size}`);
    assert.equal(
      wss.clients.size,
      1,
      "server should see exactly one connected (still-healthy) client right before the hang is induced"
    );

    // Now freeze the client silently (pause its underlying raw TCP socket,
    // don't destroy it): this stops it from reading incoming bytes, so it
    // never parses/answers the server's ping frames, and no FIN/RST is
    // ever sent -- the same genuinely silent hang used in Part A, NOT
    // socket.destroy(). Detection latency is measured from THIS instant.
    const hangInducedAt = Date.now();
    (client as any)._socket.pause();

    // Wait for detection. In steady state the interval sees the peer go
    // isAlive=false on the first tick after the hang (no pong arrives) and
    // terminates it on the following tick, so latency should land in
    // (HEARTBEAT_INTERVAL, 2*HEARTBEAT_INTERVAL]; we give it slack up to
    // 3x to absorb scheduler/event-loop jitter, per the assertion below.
    await wait(HEARTBEAT_INTERVAL * 3 + 200);
    clearInterval(interval);

    // Clean up the paused socket now that measurement is done.
    (client as any)._socket.destroy();
    // Let the terminated socket's 'close' event and wss.clients bookkeeping
    // finish propagating.
    await wait(100);

    assert.notEqual(
      detectedAt,
      0,
      "heartbeat should have detected the dead peer within the observation window"
    );
    const detectionLatency = detectedAt - hangInducedAt;
    log(
      `with heartbeat (interval=${HEARTBEAT_INTERVAL}ms): detected dead peer ~${detectionLatency}ms after the hang was induced (hangInducedAt=${hangInducedAt}, detectedAt=${detectedAt})`
    );
    assert.ok(
      detectionLatency >= HEARTBEAT_INTERVAL && detectionLatency <= HEARTBEAT_INTERVAL * 3,
      `detection latency (${detectionLatency}ms) should be within [${HEARTBEAT_INTERVAL}, ${
        HEARTBEAT_INTERVAL * 3
      }]ms of the hang being induced (was: ${detectionLatency}ms)`
    );

    log(
      `after termination: server saw 'close' on the peer's socket = ${serverSawClose}; wss.clients.size = ${wss.clients.size}`
    );
    assert.equal(
      serverSawClose,
      true,
      "server should have observed a 'close' event on the terminated peer's own socket"
    );
    assert.equal(
      wss.clients.size,
      0,
      "wss.clients should have shrunk (peer removed) after the dead peer was terminated"
    );

    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  log("TEST 2: PASS");
}

async function test3_backpressure() {
  log("\n=== TEST 3: backpressure via bufferedAmount ===");

  const wss = new WebSocketServer({ port: PORT });
  await new Promise<void>((resolve) => wss.once("listening", resolve));

  const serverSocketPromise = new Promise<WebSocket>((resolve) => {
    wss.once("connection", (ws) => resolve(ws));
  });

  const client = new WebSocket(`ws://localhost:${PORT}`);
  await new Promise<void>((resolve) => client.once("open", resolve));
  const serverSocket = await serverSocketPromise;

  // Pause the client's socket so it stops reading from the network,
  // simulating a slow/stuck peer, so the server's writes queue up.
  (client as any)._socket.pause();

  const chunk = "x".repeat(1024 * 1024); // 1MB string
  let threw = false;
  const bufferedReadings: number[] = [];
  try {
    for (let i = 0; i < 20; i++) {
      serverSocket.send(chunk);
      bufferedReadings.push(serverSocket.bufferedAmount);
    }
  } catch (err) {
    threw = true;
    log("send() threw:", err);
  }

  log("bufferedAmount readings after 20x 1MB sends:", bufferedReadings);
  assert.equal(threw, false, "send() should not throw even though the peer is not reading");
  assert.ok(
    serverSocket.bufferedAmount > 0,
    "bufferedAmount should grow when the peer is not draining the socket"
  );

  // Resume the client so it can drain, and confirm bufferedAmount eventually
  // goes down (proving it's a live, meaningful signal, not a stuck counter).
  (client as any)._socket.resume();
  await wait(500);
  log("bufferedAmount after resuming client:", serverSocket.bufferedAmount);

  client.close();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  log("TEST 3: PASS");
}

async function test4_rejectUpgrade() {
  log("\n=== TEST 4: rejecting upgrade before WebSocket established ===");

  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://localhost:${PORT}`);
    const token = url.searchParams.get("token");

    if (token !== "good-token") {
      const body = "Unauthorized";
      socket.write(
        `HTTP/1.1 401 Unauthorized\r\n` +
          `Content-Type: text/plain\r\n` +
          `Content-Length: ${Buffer.byteLength(body)}\r\n` +
          `Connection: close\r\n\r\n${body}`
      );
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  await new Promise<void>((resolve) => server.listen(PORT, resolve));

  // Bad token: expect rejection with a non-101 status, no WebSocket established.
  const badClient = new WebSocket(`ws://localhost:${PORT}/?token=wrong`);
  const badResult = await new Promise<{ event: string; status?: number }>((resolve) => {
    badClient.once("unexpected-response", (_req, res) => {
      resolve({ event: "unexpected-response", status: res.statusCode });
    });
    badClient.once("open", () => resolve({ event: "open" }));
    badClient.once("error", () => resolve({ event: "error" }));
  });
  log("bad token result:", badResult);
  assert.equal(badResult.event, "unexpected-response");
  assert.equal(badResult.status, 401);

  // Good token: expect a normal open.
  const goodClient = new WebSocket(`ws://localhost:${PORT}/?token=good-token`);
  const goodResult = await new Promise<string>((resolve) => {
    goodClient.once("open", () => resolve("open"));
    goodClient.once("unexpected-response", () => resolve("unexpected-response"));
  });
  log("good token result:", goodResult);
  assert.equal(goodResult, "open");

  goodClient.close();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  log("TEST 4: PASS");
}

async function test5_customCloseCodes() {
  log("\n=== TEST 5: custom close codes 4000-4999 with reason ===");

  const wss = new WebSocketServer({ port: PORT });
  await new Promise<void>((resolve) => wss.once("listening", resolve));

  const serverSocketPromise = new Promise<WebSocket>((resolve) => {
    wss.once("connection", (ws) => resolve(ws));
  });

  const client = new WebSocket(`ws://localhost:${PORT}`);
  await new Promise<void>((resolve) => client.once("open", resolve));
  const serverSocket = await serverSocketPromise;

  const CUSTOM_CODE = 4001;
  const REASON = "custom-app-shutdown-reason";

  const clientClosePromise = new Promise<{ code: number; reason: string }>((resolve) => {
    client.once("close", (code, reasonBuf) => {
      resolve({ code, reason: reasonBuf.toString() });
    });
  });

  serverSocket.close(CUSTOM_CODE, REASON);

  const result = await clientClosePromise;
  log("client observed close:", result);
  assert.equal(result.code, CUSTOM_CODE);
  assert.equal(result.reason, REASON);

  await new Promise<void>((resolve) => wss.close(() => resolve()));
  log("TEST 5: PASS");
}

async function test6_maxPayload() {
  log("\n=== TEST 6: maxPayload closes with code 1009 ===");

  const MAX_PAYLOAD = 1024; // 1KB limit
  const wss = new WebSocketServer({ port: PORT, maxPayload: MAX_PAYLOAD });
  await new Promise<void>((resolve) => wss.once("listening", resolve));

  const serverSocketPromise = new Promise<WebSocket>((resolve) => {
    wss.once("connection", (ws) => resolve(ws));
  });

  const client = new WebSocket(`ws://localhost:${PORT}`);
  await new Promise<void>((resolve) => client.once("open", resolve));
  const serverSocket = await serverSocketPromise;

  // ws emits an 'error' (RangeError: Max payload size exceeded) on the
  // server-side socket right before closing it with 1009. That's expected
  // for this scenario, so we must handle it or Node will crash on the
  // unhandled 'error' event.
  serverSocket.on("error", (err) => {
    log("server socket 'error' (expected for oversized message):", (err as Error).message);
  });

  const serverClosePromise = new Promise<{ code: number; reason: string }>((resolve) => {
    serverSocket.once("close", (code, reasonBuf) => {
      resolve({ code, reason: reasonBuf.toString() });
    });
  });
  const clientClosePromise = new Promise<{ code: number }>((resolve) => {
    client.once("close", (code) => resolve({ code }));
  });

  // Send a message well over the limit.
  const oversized = "y".repeat(MAX_PAYLOAD * 10);
  client.send(oversized);

  const serverResult = await serverClosePromise;
  const clientResult = await clientClosePromise;
  log("server observed close after oversized message:", serverResult);
  log("client observed close after oversized message:", clientResult);

  // ACTUAL BEHAVIOR (differs from the naive assumption): the side that
  // VIOLATED the limit (the client, which sent the oversized message)
  // receives close code 1009 from the server's close frame. The server
  // itself -- having detected the violation locally -- sends that 1009
  // frame to the client and then aborts its own socket immediately without
  // completing the closing handshake, so the server's *own* 'close' event
  // reports 1006 (abnormal closure), not 1009.
  assert.equal(
    clientResult.code,
    1009,
    "the message sender should see the connection closed with code 1009 (Message Too Big)"
  );
  assert.equal(
    serverResult.code,
    1006,
    "the server (limit-enforcer) sees its own close as abnormal (1006) because it aborts immediately after sending the 1009 frame, rather than 1009 itself"
  );

  await new Promise<void>((resolve) => wss.close(() => resolve()));
  log("TEST 6: PASS");
}

async function main() {
  log(`Node version: ${process.version}`);
  await test1_ordering();
  await test2_deadPeerDetection();
  await test3_backpressure();
  await test4_rejectUpgrade();
  await test5_customCloseCodes();
  await test6_maxPayload();
  log("\nALL TESTS PASSED");
}

main().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
