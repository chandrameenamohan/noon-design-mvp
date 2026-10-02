import { gunzipSync, gzipSync } from "node:zlib";
import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Doc } from "@noon/contracts";
import { checkDoc } from "@noon/doc-model";

// E6.2 (F19): a room writes its whole document to MinIO now and then, so that opening it replays only the
// journal rows after that. The journal stays the truth: a snapshot that fails to write loses nothing, the
// next open just replays more rows.

/** Where the snapshot of a document at `seq` lives. Zero-padded to 16 digits (every safe integer): S3 lists keys as strings, so unpadded "10" sorts before "9". */
export function snapshotKey(orgId: string, documentId: string, seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error(`snapshot: not a seq: ${String(seq)}`);
  return `${orgId}/${documentId}/${String(seq).padStart(16, "0")}.json.gz`;
}

/** Gzipped by hand: the SDK neither compresses nor decompresses (learning-tests/minio). */
export const encodeSnapshot = (doc: Doc): Uint8Array => gzipSync(JSON.stringify(doc));

/** The document, or undefined when the bytes are not a well-formed tree: a room must never open on top of that. */
export function decodeSnapshot(bytes: Uint8Array): Doc | undefined {
  let parsed;
  try {
    parsed = Doc.safeParse(JSON.parse(gunzipSync(bytes).toString("utf8")));
  } catch {
    return undefined;
  }
  return parsed.success && checkDoc(parsed.data).length === 0 ? parsed.data : undefined;
}

export type SnapshotStore = {
  /** Stores the bytes, once: a key that exists already is left as it is (IfNoneMatch). Rejects when not stored. */
  put(orgId: string, documentId: string, seq: number, body: Uint8Array): Promise<void>;
  /** The bytes, or undefined when there is no such object. Rejects when MinIO does not answer. */
  get(orgId: string, documentId: string, seq: number): Promise<Uint8Array | undefined>;
};

type S3Options = {
  endpoint: string; accessKeyId: string; secretAccessKey: string; bucket: string;
  /**
   * How long MinIO may take over ONE call, body included (noon-mo3.3.1). The SDK sets no timeout of its own, so a
   * MinIO that accepts the connection and never answers held a room's load for ever, and with it the document.
   * ponytail: one bound for every size; ceiling: a snapshot MinIO cannot take or give in 10 s is never stored or
   * read (the journal replay still opens the document, and a failed read is "try again"); upgrade: scale it with the body.
   */
  timeoutMs?: number;
};

/** MinIO through the AWS SDK, configured as learning-tests/minio found enough. */
export function s3Snapshots({ endpoint, accessKeyId, secretAccessKey, bucket, timeoutMs = 10_000 }: S3Options): SnapshotStore & { ensureBucket(): Promise<void> } {
  // ponytail: the MinIO root credentials. Ceiling: whoever reads sync's environment owns every bucket.
  // Upgrade: a MinIO user whose policy allows get/put on this one bucket, made by init.sh.
  const s3 = new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });
  const named = (err: unknown, ...names: string[]): boolean => err instanceof Error && names.includes(err.name);
  /** One call, answered within `timeoutMs` or rejected. The signal frees the socket; the race is what ends the wait (a body that stalls after its headers, too). */
  const answered = <T>(call: (abortSignal: AbortSignal) => Promise<T>): Promise<T> => {
    const abortSignal = AbortSignal.timeout(timeoutMs);
    const late = new Promise<never>((_, reject) => { abortSignal.addEventListener("abort", () => { reject(new Error(`MinIO did not answer within ${String(timeoutMs)} ms`)); }, { once: true }); });
    return Promise.race([call(abortSignal), late]);
  };
  return {
    async ensureBucket() {
      try {
        await answered((abortSignal) => s3.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal }));
      } catch (err) {
        if (!named(err, "NotFound", "NoSuchBucket")) throw err;
        try {
          await answered((abortSignal) => s3.send(new CreateBucketCommand({ Bucket: bucket }), { abortSignal }));
        } catch (raced) {
          if (!named(raced, "BucketAlreadyOwnedByYou", "BucketAlreadyExists")) throw raced;
        }
      }
    },
    async put(orgId, documentId, seq, body) {
      try {
        await answered((abortSignal) => s3.send(new PutObjectCommand({ Bucket: bucket, Key: snapshotKey(orgId, documentId, seq), Body: body, ContentType: "application/json", ContentEncoding: "gzip", IfNoneMatch: "*" }), { abortSignal }));
      } catch (err) {
        // 412: this seq of this document is stored already. The same journal prefix gives the same document,
        // so the object there is this one; overwriting it would only open a window where it is half-written.
        if (!named(err, "PreconditionFailed")) throw err;
      }
    },
    async get(orgId, documentId, seq) {
      try {
        return await answered(async (abortSignal) => {
          const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: snapshotKey(orgId, documentId, seq) }), { abortSignal });
          return res.Body ? await res.Body.transformToByteArray() : undefined;
        });
      } catch (err) {
        if (named(err, "NoSuchKey")) return undefined;
        throw err;
      }
    },
  };
}

export type SnapshotCadence = { everyOps: number; everyMs: number };

type Source = { readonly seq: number; readonly doc: Doc; readonly peerCount: number };

/**
 * When a room snapshots (SPEC §2.9): every `everyOps` accepted ops, every `everyMs` while peers are connected
 * (a session that is never idle still snapshots), and when asked (the last peer left, the server stops).
 * One write at a time; a trigger during a write is dropped, and the next op or tick catches up.
 */
export function snapshotter({ room, from, cadence, write }: { room: Source; from: number; cadence: SnapshotCadence; write: (seq: number, body: Uint8Array) => Promise<void> }) {
  let saved = from;
  // The newest seq a write was ATTEMPTED at (never behind `saved`). While MinIO is away `saved` stays put, and an op-triggered retry on every
  // op past the threshold was a gzip, a failing PUT and a log line per op (noon-mo3.3.3); the timer still retries.
  let attempted = from;
  let writing: Promise<unknown> | undefined;

  /** Snapshots the room as it is now, if it moved since the last one. True: stored (or nothing to store). Never rejects. */
  async function take(): Promise<boolean> {
    while (writing) await writing;
    const seq = room.seq;
    if (seq <= saved) return true;
    // Read in the same tick as `seq`: the room edits `doc` in place, and only here is it exactly the document at `seq`.
    attempted = Math.max(attempted, seq);
    const work = write(seq, encodeSnapshot(room.doc)).then(() => { saved = Math.max(saved, seq); return true; }, () => false);
    writing = work.finally(() => { writing = undefined; });
    return work;
  }

  const timer = setInterval(() => { if (room.peerCount > 0 && !writing) void take(); }, cadence.everyMs);
  timer.unref();
  return {
    get saved() { return saved; },
    /** The room accepted an op numbered `seq`. */
    accepted(seq: number): void {
      if (!writing && seq - attempted >= cadence.everyOps) void take();
    },
    take,
    stop(): void { clearInterval(timer); },
  };
}
