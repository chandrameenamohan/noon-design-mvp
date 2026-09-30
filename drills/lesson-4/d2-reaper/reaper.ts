// DRILL 2 · one bug from Lesson 4 is planted in this file. Find it and fix it HERE.
//
// The reaper, cut down to its order of operations. The real one is `reapSandboxes` in
// apps/worker/src/sandbox.ts; the ideas are the same: a container is only a cache, Postgres is the
// truth about which documents are in use, and a reaper sweeps its own pool and nothing else. Docker
// here is a fake in memory; "in use" is whatever the caller answers, as slowly as it likes.

export type FakeDocker = {
  /** `docker ps --all --filter label=noon.sandbox=<pool>`: the documents whose sandbox exists in this pool. */
  list(pool: string): Promise<string[]>;
  /** `docker rm --force`: those documents' sandboxes are gone. */
  remove(documents: string[]): Promise<void>;
  /** `docker run`: what a sandbox job does when it starts a document's sandbox. */
  start(document: string, pool: string): Promise<void>;
  running(document: string): boolean;
};

/** Only names this code made: a label that is not a uuid is left alone. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * Removes every sandbox of `pool` whose document is not in use, and returns those documents.
 * `inUse` asks Postgres (a sandbox job queued or running, or finished a moment ago).
 */
export async function reap(inUse: () => Promise<ReadonlySet<string>>, docker: FakeDocker, pool: string): Promise<string[]> {
  const used = await inUse();
  const listed = await docker.list(pool);
  const idle = listed.filter((id) => UUID.test(id) && !used.has(id));
  if (idle.length > 0) await docker.remove(idle);
  return idle;
}

/** A Docker daemon in a Map: every call takes a turn of the event loop, as a real one takes a round trip. */
export function fakeDocker(): FakeDocker {
  const containers = new Map<string, string>(); // document -> pool
  const later = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));
  return {
    async list(pool) {
      await later();
      return [...containers].filter(([, p]) => p === pool).map(([document]) => document);
    },
    async remove(documents) {
      await later();
      for (const document of documents) containers.delete(document);
    },
    async start(document, pool) {
      await later();
      containers.set(document, pool);
    },
    running: (document) => containers.has(document),
  };
}
