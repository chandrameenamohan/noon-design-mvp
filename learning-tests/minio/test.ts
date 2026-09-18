// Learning test for `@aws-sdk/client-s3` against MinIO (S3-compatible object store).
// Run with: node test.ts   (Node 24 strips types natively; only erasable TS syntax used)
// Self-contained: at startup this removes any stale `lt-minio` container, starts a
// fresh `quay.io/minio/minio` container on 127.0.0.1:9100 via node:child_process,
// waits until it answers a health check, runs all tests, and ALWAYS removes the
// container afterward (finally block, even on failure). Requires `docker` on PATH,
// or at /Applications/Docker.app/Contents/Resources/bin/docker.
//
// FINDINGS (after running against quay.io/minio/minio:latest,
// RELEASE.2025-09-07T16-13-09Z, on port 9100, Node v24.17.0):
//
// 1. Minimal client config: confirmed. `endpoint`, `forcePathStyle: true`, a
//    dummy `region`, and static `credentials` are enough. No extra options
//    needed. (Docker Hub's `minio/minio` image is gone behind a paywall as of
//    2025 -- pulls return "pull access denied". Use `quay.io/minio/minio`
//    instead; same server, same behavior.)
// 2. Confirmed. PutObject -> GetObject is read-after-write consistent (single
//    node, no replication lag to worry about here). Body is a
//    `Readable`/web stream, not a string/Buffer; you must call
//    `res.Body.transformToString()` (SDK v3 provides this helper on the
//    Node.js Body mixin) or otherwise drain the stream yourself.
// 3. Confirmed. ListObjectsV2 returns keys in plain UTF-8 byte lexicographic
//    order. Unpadded numeric suffixes sort as strings ("10.json" before
//    "9.json"). Zero-padding the sequence number (e.g. 17 digits or however
//    many you need, here 12: "000000000010") makes lexicographic order equal
//    numeric order.
// 4. CONFIRMED AND EXERCISED. Putting 1,005 tiny objects under one prefix (in
//    parallel batches of 50) and listing with default MaxKeys shows the server
//    caps a single ListObjectsV2 page at 1000 keys: KeyCount=1000,
//    IsTruncated=true, and a NextContinuationToken is present. The newest
//    (highest zero-padded seq) key is absent from page 1 and only appears once
//    you page forward with that token (page 2: KeyCount=5, IsTruncated=false,
//    1000+5=1005 total). Explicitly requesting MaxKeys:5000 does not change
//    this -- the server still returns KeyCount=1000 and IsTruncated=true. So
//    there is no "list in reverse" / "last key" S3 API: ListObjectsV2 always
//    returns ascending key order, pages forward via ContinuationToken, and is
//    hard-capped at 1000 keys per page server-side regardless of the MaxKeys
//    requested. To find the "newest" snapshot cheaply you must either (a) page
//    through all keys under the prefix and take the last one, which is O(n)
//    in the number of snapshots and gets worse over time, or (b) keep a
//    separate pointer to the latest known seq. Cleanest approach for this
//    design: record the latest written seq per (org, doc) in Postgres (the
//    doc's row, updated in the same transaction/logic that decides the next
//    seq) and use that to build the exact key directly -- no S3 listing
//    needed on the hot path. Reserve ListObjectsV2 for a recovery/repair tool
//    only. (Dropped from this finding: an earlier draft additionally claimed
//    "no Delimiter/Reverse/OrderBy param exists, confirmed by TypeScript's
//    own input type" -- that is not something a runtime test can verify,
//    since Node strips TypeScript types without checking them, so no type
//    error would ever be caught at `node test.ts` time either way. The only
//    verified claim is the behavioral one above: MaxKeys:5000 was actually
//    sent and the server still returned 1000 keys.)
// 5. Assumed IfNoneMatch: '*' -> 412 on existing key. ACTUAL: MinIO
//    RELEASE.2025-09-07 supports it and it works correctly: first PutObject
//    with IfNoneMatch:'*' on a fresh key succeeds (200), a second
//    PutObject with IfNoneMatch:'*' on the SAME existing key fails with HTTP
//    412 and an error whose SDK-parsed `name` is "PreconditionFailed". So the
//    "two rooms can't both write the same snapshot key" guarantee holds on
//    this MinIO version. (Older MinIO releases, pre ~2024-06, did NOT support
//    conditional writes -- pin MinIO to a recent release if this matters.)
// 6. Confirmed. GetObject on a missing key throws an error with
//    `err.name === "NoSuchKey"` and `err.$metadata?.httpStatusCode === 404`.
//    Cleanest TS detection: `if (err instanceof S3ServiceException && err.name
//    === "NoSuchKey")` (or just check `.name`, since NoSuchKey is a stable
//    modeled exception name in @aws-sdk/client-s3) rather than string-matching
//    the message.
// 7. CORRECTED AND RE-EXERCISED. An earlier draft of this finding described
//    the abort body as "~50MB, small highWaterMark, immediate abort" -- that
//    prose did not match the code, which actually streams a 200MB generator
//    (1MB chunks, 15ms apart) and fires `controller.abort()` from a 120ms
//    timer partway through the upload, not immediately. That mismatch is
//    fixed here to describe what the code does. Separately, the original
//    catch block was a blanket catch that set `putAborted = true` for ANY
//    thrown error, which would also pass if the SDK failed for an unrelated
//    reason. Now the caught error's `name` is asserted and logged: MinIO/SDK
//    v3 report it as `"AbortError"` (the @smithy/abort-controller convention
//    used by the SDK's request pipeline), confirming the SDK call rejected
//    specifically because of the abort signal, not some other failure.
//    CONFIRMED (now on firmer footing): after the abort, HeadObject on that
//    key throws `"NotFound"` (404; HeadObject has no body so S3/MinIO can't
//    return the more specific NoSuchKey code), GetObject throws `"NoSuchKey"`
//    (404), and ListObjectsV2 scoped to that exact key returns zero entries
//    in Contents -- no partial object is visible or listed anywhere. (S3's
//    semantics: an object is only visible after Put completes; MinIO matches
//    this.)
// 8. Assumed the SDK auto-decompresses ContentEncoding:gzip on Get. ACTUAL: it
//    does NOT. GetObject returns the raw gzip bytes verbatim (Content-Encoding
//    header is echoed back), same as real S3 -- the SDK has no HTTP layer that
//    strips Content-Encoding, unlike a browser `fetch`. You must gzip
//    yourself before Put and gunzip yourself after Get (e.g. Node's `zlib`
//    gzipSync/gunzipSync or the stream equivalents).
//
// wrongAssumptions:
//  - assumed IfNoneMatch precondition support was uncertain on MinIO -> actual: supported on this (recent) MinIO version.
//  - assumed SDK might auto-decompress gzip on Get -> actual: it does not; caller must gzip/gunzip manually.
//  - assumed (earlier draft) Finding #4 was exercised -> actual: it was only asserted from a 5-key demo; now actually exercised with 1,005 objects and real pagination.
//  - assumed (earlier draft) Finding #7's prose (50MB/small highWaterMark/immediate abort) matched the code -> actual: the code uses a 200MB generator and a 120ms abort timer; prose corrected to match, and the catch is now abort-specific rather than a blanket catch.

import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { gzipSync, gunzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  CreateBucketCommand,
  S3ServiceException,
} from "@aws-sdk/client-s3";

const BUCKET = "snapshots";
const MINIO_PORT = 9100;
const ENDPOINT = `http://localhost:${MINIO_PORT}`;
const CONTAINER_NAME = "lt-minio";
const MINIO_IMAGE = "quay.io/minio/minio";
const MINIO_USER = "noon";
const MINIO_PASSWORD = "noon-dev-only";

function log(...args: unknown[]) {
  console.log(...args);
}

// ---------------------------------------------------------------------------
// Self-contained lifecycle: resolve a docker binary, remove any stale
// container from a previous run, start a fresh one, wait until it actually
// answers a health check, and (from main()) always remove it in a finally
// block.
// ---------------------------------------------------------------------------
function resolveDockerBin(): string {
  const candidates = ["docker", "/Applications/Docker.app/Contents/Resources/bin/docker"];
  for (const bin of candidates) {
    const res = spawnSync(bin, ["--version"], { stdio: "ignore" });
    if (!res.error && res.status === 0) return bin;
  }
  throw new Error(
    "docker binary not found on PATH or at /Applications/Docker.app/Contents/Resources/bin/docker",
  );
}

const DOCKER_BIN = resolveDockerBin();

function dockerRun(args: string[]) {
  return spawnSync(DOCKER_BIN, args, { encoding: "utf8" });
}

function removeStaleContainer() {
  const res = dockerRun(["rm", "-f", CONTAINER_NAME]);
  log(`removed any stale "${CONTAINER_NAME}" container (docker rm -f exit code ${res.status}, stdout: ${res.stdout?.trim() || "(none)"})`);
}

async function waitForMinioReady(timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${ENDPOINT}/minio/health/live`);
      if (res.ok) return;
      lastErr = new Error(`health check returned HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for minio to answer on ${ENDPOINT}: ${String(lastErr)}`);
}

async function startMinioContainer() {
  removeStaleContainer();
  log(`starting fresh ${MINIO_IMAGE} container "${CONTAINER_NAME}" on port ${MINIO_PORT} via ${DOCKER_BIN}...`);
  const run = dockerRun([
    "run",
    "-d",
    "--rm",
    "--name",
    CONTAINER_NAME,
    "-p",
    `${MINIO_PORT}:9000`,
    "-e",
    `MINIO_ROOT_USER=${MINIO_USER}`,
    "-e",
    `MINIO_ROOT_PASSWORD=${MINIO_PASSWORD}`,
    MINIO_IMAGE,
    "server",
    "/data",
  ]);
  if (run.status !== 0) {
    throw new Error(`docker run failed (status ${run.status}): ${run.stderr}`);
  }
  log("container id:", run.stdout.trim());
  await waitForMinioReady(120_000);
  log("minio container is answering its health check");
}

function stopMinioContainer() {
  log(`removing container "${CONTAINER_NAME}"...`);
  const res = dockerRun(["rm", "-f", CONTAINER_NAME]);
  log(`docker rm -f "${CONTAINER_NAME}" exit code:`, res.status);
}

// ---------------------------------------------------------------------------
async function main() {
  await startMinioContainer();
  try {
    // --- 1. Minimal client config -------------------------------------------
    const s3 = new S3Client({
      endpoint: ENDPOINT,
      region: "us-east-1", // dummy region; MinIO ignores it but the SDK requires one
      forcePathStyle: true, // required: MinIO doesn't do virtual-hosted-style buckets by default
      credentials: {
        accessKeyId: MINIO_USER,
        secretAccessKey: MINIO_PASSWORD,
      },
    });
    log("[1] client constructed with endpoint/forcePathStyle/region/credentials");

    // Bucket doesn't exist yet on a fresh MinIO -- create it.
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
    log(`[1] bucket "${BUCKET}" created`);

    // --- 2. Put then Get, read-after-write, stream Body ---------------------
    const org = "org1";
    const doc = "doc1";
    const key1 = `snapshots/${org}/${doc}/000000000001.json`;
    const payload1 = JSON.stringify({ seq: 1, content: "hello world" });

    const putRes1 = await s3.send(
      new PutObjectCommand({ Bucket: BUCKET, Key: key1, Body: payload1, ContentType: "application/json" }),
    );
    log("[2] PutObject response ETag:", putRes1.ETag);

    const getRes1 = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key1 }));
    log("[2] GetObject Body constructor:", getRes1.Body?.constructor?.name);
    assert.ok(getRes1.Body, "GetObject should return a Body");
    // Idiom: SDK v3 Node Body has .transformToString() (also .transformToByteArray(), .transformToWebStream())
    const text1 = await getRes1.Body!.transformToString();
    log("[2] GetObject Body via transformToString():", text1);
    assert.equal(text1, payload1, "read-after-write: Get should return exactly what was Put");

    // --- 3. ListObjectsV2 lexicographic ordering -----------------------------
    const prefix = `snapshots/${org}/${doc}/`;

    // unpadded seq numbers demonstrate the "10 before 9" trap
    const unpaddedKeys = ["9.json", "10.json", "2.json"];
    for (const k of unpaddedKeys) {
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: `unpadded-demo/${k}`, Body: "x" }));
    }
    const unpaddedList = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: "unpadded-demo/" }));
    const unpaddedOrder = (unpaddedList.Contents ?? []).map((o) => o.Key!.replace("unpadded-demo/", ""));
    log("[3] unpadded lexicographic order:", unpaddedOrder);
    assert.deepEqual(
      unpaddedOrder,
      ["10.json", "2.json", "9.json"],
      "unpadded numeric keys sort lexicographically, NOT numerically (10 before 2 before 9)",
    );

    // zero-padded seq numbers: lexicographic order == numeric order
    const paddedKeys = [9, 10, 2].map((n) => `${String(n).padStart(12, "0")}.json`);
    for (const k of paddedKeys) {
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: `padded-demo/${k}`, Body: "x" }));
    }
    const paddedList = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: "padded-demo/" }));
    const paddedOrder = (paddedList.Contents ?? []).map((o) => o.Key!.replace("padded-demo/", ""));
    log("[3] zero-padded lexicographic order:", paddedOrder);
    assert.deepEqual(
      paddedOrder,
      ["000000000002.json", "000000000009.json", "000000000010.json"],
      "zero-padded keys: lexicographic order matches numeric order",
    );

    // --- 4a. No "list in reverse" API; must page forward or keep a pointer --
    // Put several real snapshot keys under snapshots/org1/doc1/ and confirm
    // the "newest" one only comes out by listing (all pages) and taking the
    // last entry -- there is no StartAfter-from-the-end or reverse flag.
    for (const n of [2, 3, 4, 5]) {
      const k = `${prefix}${String(n).padStart(12, "0")}.json`;
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: k, Body: JSON.stringify({ seq: n }) }));
    }
    const fullList = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, MaxKeys: 1000 }));
    const allKeysAscending = (fullList.Contents ?? []).map((o) => o.Key!);
    log("[4a] all keys under prefix (ascending):", allKeysAscending);
    assert.equal(fullList.IsTruncated, false, "small demo fits in one page (MaxKeys 1000)");
    const newestKeyByListing = allKeysAscending[allKeysAscending.length - 1];
    log("[4a] newest snapshot found by listing + taking last element:", newestKeyByListing);
    assert.equal(
      newestKeyByListing,
      `${prefix}000000000005.json`,
      "newest snapshot must be derived by listing ascending and taking the tail (no reverse-list API exists)",
    );
    log(
      "[4a] cleanest approach for this design: keep the latest snapshot seq in Postgres " +
        "(alongside org/doc), so recovery/writes never need to List S3 on the hot path; " +
        "reserve ListObjectsV2 for an offline repair/reconciliation job.",
    );

    // --- 4b. Actually exercise pagination: 1,005 objects, IsTruncated,
    // NextContinuationToken, and the MaxKeys:5000 server-side cap. ----------
    const pagePrefix = "pagination-demo/";
    const totalKeys = 1005;
    const batchSize = 50;
    log(`[4b] putting ${totalKeys} tiny objects under "${pagePrefix}" in batches of ${batchSize}...`);
    for (let start = 0; start < totalKeys; start += batchSize) {
      const end = Math.min(start + batchSize, totalKeys);
      const batch: Promise<unknown>[] = [];
      for (let i = start; i < end; i++) {
        const k = `${pagePrefix}${String(i).padStart(12, "0")}.json`;
        batch.push(s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: k, Body: "x" })));
      }
      await Promise.all(batch);
    }
    log(`[4b] finished putting ${totalKeys} objects`);

    const page1 = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: pagePrefix }));
    log(
      "[4b] page1 KeyCount:",
      page1.KeyCount,
      "IsTruncated:",
      page1.IsTruncated,
      "NextContinuationToken present:",
      !!page1.NextContinuationToken,
    );
    assert.equal(page1.KeyCount, 1000, "first page (default MaxKeys) must be capped at 1000 keys");
    assert.equal(page1.IsTruncated, true, "first page must report IsTruncated:true since 1005 > 1000");
    assert.ok(page1.NextContinuationToken, "a truncated response must include NextContinuationToken");

    const newestKey = `${pagePrefix}${String(totalKeys - 1).padStart(12, "0")}.json`;
    const page1Keys = (page1.Contents ?? []).map((o) => o.Key);
    log("[4b] newest key expected only on page 2:", newestKey);
    assert.ok(!page1Keys.includes(newestKey), "the newest (highest-seq) key must NOT be reachable on page 1");

    const page2 = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: pagePrefix, ContinuationToken: page1.NextContinuationToken }),
    );
    log("[4b] page2 KeyCount:", page2.KeyCount, "IsTruncated:", page2.IsTruncated);
    const page2Keys = (page2.Contents ?? []).map((o) => o.Key);
    assert.ok(page2Keys.includes(newestKey), "the newest key must be reachable on page 2 via NextContinuationToken");
    assert.equal(page2.IsTruncated, false, "1005 - 1000 = 5 remaining keys must fit fully on page 2");
    assert.equal((page1.KeyCount ?? 0) + (page2.KeyCount ?? 0), totalKeys, "page1 + page2 key counts must total all objects put");

    // try MaxKeys: 5000 -- server still caps at 1000
    const bigMaxKeys = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: pagePrefix, MaxKeys: 5000 }));
    log(
      "[4b] requested MaxKeys:5000, server returned KeyCount:",
      bigMaxKeys.KeyCount,
      "IsTruncated:",
      bigMaxKeys.IsTruncated,
      "MaxKeys echoed:",
      bigMaxKeys.MaxKeys,
    );
    assert.equal(bigMaxKeys.KeyCount, 1000, "server must cap at 1000 keys per page even when MaxKeys:5000 is requested");
    assert.equal(bigMaxKeys.IsTruncated, true, "MaxKeys:5000 request must still be truncated given the server's 1000-key cap");

    // --- 5. Conditional write: IfNoneMatch '*' -------------------------------
    const condKey = `${prefix}condwrite-test.json`;
    const firstPut = await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: condKey, Body: "first", IfNoneMatch: "*" }));
    log("[5] first conditional PutObject (key did not exist) succeeded, ETag:", firstPut.ETag);

    let sawPreconditionFailed = false;
    let preconditionStatus: number | undefined;
    try {
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: condKey, Body: "second", IfNoneMatch: "*" }));
    } catch (err) {
      sawPreconditionFailed = err instanceof S3ServiceException && err.name === "PreconditionFailed";
      preconditionStatus = (err as S3ServiceException).$metadata?.httpStatusCode;
      log("[5] second conditional PutObject (key exists) rejected with:", (err as Error).name, preconditionStatus);
    }
    assert.ok(sawPreconditionFailed, "second PutObject with IfNoneMatch:'*' on an existing key must fail as PreconditionFailed");
    assert.equal(preconditionStatus, 412, "PreconditionFailed must carry HTTP 412");

    // --- 6. GetObject on missing key -> NoSuchKey / 404 ----------------------
    let sawNoSuchKey = false;
    let noSuchKeyStatus: number | undefined;
    try {
      await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `${prefix}does-not-exist.json` }));
    } catch (err) {
      sawNoSuchKey = err instanceof S3ServiceException && err.name === "NoSuchKey";
      noSuchKeyStatus = (err as S3ServiceException).$metadata?.httpStatusCode;
      log("[6] GetObject on missing key threw:", (err as Error).name, noSuchKeyStatus);
    }
    assert.ok(sawNoSuchKey, "GetObject on a missing key must throw an error named NoSuchKey");
    assert.equal(noSuchKeyStatus, 404, "NoSuchKey must carry HTTP 404");

    // --- 7. Aborted PutObject leaves no partial object visible ---------------
    // 200MB generator (1MB chunks, 15ms apart), abort fired from a 120ms timer
    // partway through -- this matches what the code actually does.
    const abortKey = `${prefix}aborted-upload.json`;
    const controller = new AbortController();

    async function* slowChunks() {
      const chunkSize = 1024 * 1024; // 1MB
      const chunk = Buffer.alloc(chunkSize, "a");
      for (let i = 0; i < 200; i++) {
        // 200MB total if uninterrupted
        yield chunk;
        await new Promise((r) => setTimeout(r, 15));
      }
    }
    const slowBody = Readable.from(slowChunks());

    const abortTimer = setTimeout(() => controller.abort(), 120);

    let putAborted = false;
    let abortErrorName: string | undefined;
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: abortKey,
          Body: slowBody,
          ContentLength: 200 * 1024 * 1024,
        }),
        { abortSignal: controller.signal },
      );
    } catch (err) {
      putAborted = true;
      abortErrorName = (err as Error).name;
      log("[7] aborted PutObject rejected with name:", abortErrorName, "message:", (err as Error).message);
    } finally {
      clearTimeout(abortTimer);
    }
    assert.ok(putAborted, "aborting the PutObject mid-upload should cause the SDK call to reject");
    assert.ok(
      abortErrorName === "AbortError" || abortErrorName === "RequestAbortedError",
      `expected an abort-specific error name (AbortError or the SDK's RequestAbortedError), got: ${abortErrorName}`,
    );

    let headErrorName: string | undefined;
    try {
      await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: abortKey }));
    } catch (err) {
      headErrorName = (err as Error).name;
    }
    log("[7] HeadObject on aborted-upload key threw:", headErrorName);
    assert.equal(headErrorName, "NotFound", "HeadObject on the aborted key must be NotFound (no partial object visible)");

    let getErrorName: string | undefined;
    try {
      await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: abortKey }));
    } catch (err) {
      getErrorName = (err as Error).name;
    }
    log("[7] GetObject on aborted-upload key threw:", getErrorName);
    assert.equal(getErrorName, "NoSuchKey", "GetObject on the aborted key must be NoSuchKey (no partial object visible)");

    const abortedList = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: abortKey }));
    log("[7] ListObjectsV2 scoped to the aborted key's exact prefix, Contents:", abortedList.Contents ?? []);
    assert.equal((abortedList.Contents ?? []).length, 0, "ListObjectsV2 must not show the aborted-upload key anywhere");

    // --- 8. Gzip: no auto-decompression on Get -------------------------------
    const gzipKey = `${prefix}gzip-test.json.gz`;
    const original = JSON.stringify({ seq: 999, content: "x".repeat(500) });
    const compressed = gzipSync(Buffer.from(original));
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: gzipKey,
        Body: compressed,
        ContentType: "application/json",
        ContentEncoding: "gzip",
      }),
    );
    const gzipGetRes = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: gzipKey }));
    log("[8] GetObject ContentEncoding header echoed back:", gzipGetRes.ContentEncoding);
    const rawBytes = await gzipGetRes.Body!.transformToByteArray();
    log("[8] raw bytes length (still compressed):", rawBytes.length, "vs original plaintext length:", original.length);
    // The SDK does NOT auto-decompress: raw bytes returned must equal what we compressed,
    // not the original plaintext, and must NOT already equal the plaintext bytes.
    assert.deepEqual(Buffer.from(rawBytes), compressed, "SDK must return the raw gzip bytes unchanged, no auto-decompression");
    const manuallyDecompressed = gunzipSync(Buffer.from(rawBytes)).toString("utf8");
    log("[8] after manual gunzipSync:", manuallyDecompressed);
    assert.equal(manuallyDecompressed, original, "manual gunzip of the raw bytes must recover the original content");

    log("\nALL ASSERTIONS PASSED");
  } finally {
    stopMinioContainer();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nTEST FAILURE:", err);
    process.exit(1);
  });
