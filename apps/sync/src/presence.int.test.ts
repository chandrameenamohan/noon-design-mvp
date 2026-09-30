import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import type { Doc } from "@noon/contracts";
import type { DocumentStore } from "@noon/db";
import { ROOT_ID } from "@noon/doc-model";
import { startSyncServer } from "./server.ts";
import { connect, NO_JOURNAL, TEST_SECRET } from "./testing.ts";

// F7 over real sockets: presence is relayed, a closed connection is announced, and NOTHING about it
// reaches a store or survives a restart.
test("presence is relayed and a leaver announced; after a restart nobody is here, and the store never saw any of it", async () => {
  const saved: string[] = [];
  let kept: { doc: Doc; seq: number } | undefined;
  const store: DocumentStore = {
    ...NO_JOURNAL,
    load: () => Promise.resolve({ doc: kept?.doc, seq: kept?.seq ?? 0 }),
    save: (_org, _id, doc, seq) => { saved.push(JSON.stringify([doc, seq])); kept = { doc: structuredClone(doc), seq }; return Promise.resolve(); },
  };
  const documentId = randomUUID();
  let server = await startSyncServer({ port: 0, secrets: [TEST_SECRET], store });

  const ada = await connect(server.url, documentId, randomUUID(), {}, undefined, "Ada");
  const bob = await connect(server.url, documentId);
  ada.send({ type: "add_node", nodeId: "n1", parentId: ROOT_ID, index: 0, component: "Stack", props: {} }); // so that there IS something to save
  ada.sendRaw({ type: "presence", cursor: { x: 0.123456, y: 0.5 }, selection: "n1" });
  const seen = await bob.next("presence");
  expect(seen).toMatchObject({ name: "Ada", actor: { kind: "user", id: ada.userId }, cursor: { x: 0.123456, y: 0.5 }, selection: "n1" });

  // A client cannot speak for someone else: extra fields are a contract violation, and the connection ends.
  const mallory = await connect(server.url, documentId);
  mallory.sendRaw({ type: "presence", cursor: null, selection: null, name: "Ada", peerId: seen.peerId });
  expect((await mallory.closed).code).toBe(4400);

  ada.close();
  expect(await bob.next("presence_left", (m) => m.peerId === seen.peerId)).toBeDefined();

  await server.close(); // saves the document
  expect(saved.length).toBeGreaterThan(0);
  expect(saved.join("")).not.toMatch(/0\.123456|presence|cursor|Ada/);

  server = await startSyncServer({ port: 0, secrets: [TEST_SECRET], store });
  const later = await connect(server.url, documentId);
  const welcome = await later.next("welcome");
  expect(welcome.peers).toEqual([]);
  expect(welcome.doc.nodes["n1"]).toBeDefined(); // the DOCUMENT survived; presence did not
  later.close();
  await server.close();
});
