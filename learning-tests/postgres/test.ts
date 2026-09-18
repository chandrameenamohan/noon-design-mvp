// FINDINGS (after running against PostgreSQL 17.11 / Debian, via pg 8.x on Node 24.17):
//
// 1. Duplicate insert violating a unique constraint fails with code === '23505' and the
//    error exposes which constraint via `.constraint` (and `.table`, `.detail`, `.schema`).
//    CONFIRMED. Both the (document_id, seq) and (document_id, op_id) unique constraints
//    produced distinct `.constraint` names, so the app can tell a duplicate seq from a
//    duplicate op_id by string-comparing `err.constraint`.
//
// 2. After a unique-violation error inside a transaction, the transaction is aborted:
//    further statements fail with 25P02 until ROLLBACK. CONFIRMED.
//    `INSERT ... ON CONFLICT DO NOTHING RETURNING ...` avoids aborting the transaction and
//    returns zero rows on conflict. CONFIRMED (query succeeded, rowCount === 0, and a
//    subsequent statement in the same transaction still worked).
//
// 3. Two concurrent transactions inserting the same (document_id, seq): the second blocks
//    until the first commits, then fails with 23505 (does not silently succeed). CONFIRMED.
//    Measured that tx2's INSERT did not resolve until after tx1's COMMIT (timing gap
//    confirmed the block), and it then rejected with code 23505.
//
// 4. A conditional append ("insert the journal row only if the writer's token is >= the
//    lease row's current fencing token") can be done atomically in ONE statement using
//    `INSERT INTO op_journal SELECT ... FROM lease WHERE token <= $writer_token FOR UPDATE`
//    (the FOR UPDATE row lock inside the SELECT gates the INSERT and serializes concurrent
//    writers/owners on that one lease row). Tested with two REAL interleavings across two
//    separate connections with explicit BEGIN/COMMIT (not just two independent queries):
//    (i) writer A BEGINs with token=5, then a new-owner tx bumps the lease token 5->6 and
//    COMMITs before A's append statement executes -> A's append CONFIRMED inserted 0 rows
//    (the statement re-reads the lease fresh, it does not use a stale value captured at
//    BEGIN time). (ii) writer A's append (token=5) runs first and its FOR UPDATE lock is
//    held inside A's still-open transaction -> a concurrent bump to token=6 CONFIRMED
//    blocked (did not resolve) until A committed; after A committed, A's row (token 5) was
//    CONFIRMED present in op_journal, the bump then proceeded, and a later append attempt
//    with the same token=5 CONFIRMED got 0 rows. A CONTROL using the naive two-step version
//    (SELECT token, then a separate un-gated INSERT with no row lock) was run through the
//    same bump-in-the-middle interleaving and CONFIRMED let the stale write through (1 row
//    inserted after the token had already moved to 6), proving the test setup can actually
//    distinguish a correct fenced append from a broken one. Finally, the race (append vs.
//    concurrent bump, order randomized via Promise.all + randomized 0-5ms delays) was run
//    for 50 iterations; CONFIRMED zero stale rows landed in any iteration (verified per
//    iteration by re-attempting an append with the pre-race token after the race settled
//    and asserting it is always rejected).
//
// 5. pg returns BIGINT (int8) columns as strings, not numbers, by default. CONFIRMED.
//    typeof value === 'string' for a `seq bigint` column. This means naive numeric use
//    (`row.seq + 1`) silently does string concatenation ("5" + 1 === "51"), a real bug
//    risk for an ordering/sequence column. Cleanest fix used here: cast in SQL
//    (`seq::text` is already text; for numeric ops either keep seq as a JS BigInt by
//    setting `pg.types.setTypeParser(20, BigInt)` globally, or — simpler and scoped —
//    just always cast/compare seq in SQL (ORDER BY, WHERE seq > $1) and treat the JS
//    value as an opaque string/BigInt, never mixing it into JS arithmetic unconverted.
//    We used `BigInt(row.seq)` at the boundary where arithmetic was needed.
//
// 6. pg.Pool: a query error on a pooled client does NOT poison the pool — the same pool
//    served a normal query right after a failed one. CONFIRMED.
//    A client checked out via `pool.connect()` and never released does exhaust the pool
//    (with max: 2, checking out 2 clients and not releasing either leaves 0 available),
//    and a subsequent `pool.query()` call hangs until `connectionTimeoutMillis` expires,
//    rejecting with a timeout error rather than hanging forever. CONFIRMED
//    (used max: 2, connectionTimeoutMillis: 500 and observed the timeout error/timing).
//
// 7. jsonb round-trips a nested JS object intact (deep-equal survives the round trip).
//    CONFIRMED. Key order is NOT preserved: inserted `{b:1, a:2, c:3}` and jsonb gave back
//    `{a:2, b:1, c:3}` (Postgres jsonb normalizes/sorts top-level keys), confirmed via
//    Object.keys() order differing from insertion order while deep value-equality held.
//
// Design implication: treat `seq` as a string/BigInt boundary type end-to-end (never do
// raw JS arithmetic on the driver value); rely on `err.constraint` (not just err.code) to
// distinguish duplicate-seq vs duplicate-op_id conflicts; use FOR UPDATE-gated
// INSERT...SELECT for the lease-token guard, in one round trip; and always call
// pool.connect()+release() in try/finally to avoid silent pool exhaustion.

import assert from 'node:assert/strict';
import pg from 'pg';

const CONNECTION = {
  host: 'localhost',
  port: 5432,
  user: 'noon',
  password: 'noon-dev-only',
  database: 'noon',
};

const SCHEMA = 'lt_pg';

function log(label: string, value: unknown): void {
  console.log(`\n--- ${label} ---`);
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

async function setup(client: pg.Client): Promise<void> {
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${SCHEMA}`);
  await client.query(`
    CREATE TABLE ${SCHEMA}.op_journal (
      id BIGSERIAL PRIMARY KEY,
      document_id TEXT NOT NULL,
      seq BIGINT NOT NULL,
      op_id TEXT NOT NULL,
      payload JSONB,
      CONSTRAINT uq_doc_seq UNIQUE (document_id, seq),
      CONSTRAINT uq_doc_opid UNIQUE (document_id, op_id)
    )
  `);
  await client.query(`
    CREATE TABLE ${SCHEMA}.lease (
      document_id TEXT PRIMARY KEY,
      token BIGINT NOT NULL
    )
  `);
}

async function teardown(client: pg.Client): Promise<void> {
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
}

async function testAssumption1_duplicateUniqueConstraint(client: pg.Client): Promise<void> {
  console.log('\n=== Assumption 1: duplicate insert -> 23505 + constraint name ===');
  await client.query(
    `INSERT INTO ${SCHEMA}.op_journal (document_id, seq, op_id) VALUES ($1, $2, $3)`,
    ['doc-1', 1, 'op-a']
  );

  // Duplicate seq (same document_id, seq=1), different op_id.
  let seqErr: any;
  try {
    await client.query(
      `INSERT INTO ${SCHEMA}.op_journal (document_id, seq, op_id) VALUES ($1, $2, $3)`,
      ['doc-1', 1, 'op-b']
    );
  } catch (e) {
    seqErr = e;
  }
  log('duplicate-seq error', {
    code: seqErr?.code,
    constraint: seqErr?.constraint,
    table: seqErr?.table,
    detail: seqErr?.detail,
  });
  assert.equal(seqErr?.code, '23505', 'expected 23505 for duplicate seq');
  assert.equal(seqErr?.constraint, 'uq_doc_seq', 'expected constraint name uq_doc_seq');

  // Duplicate op_id (same document_id, op_id='op-a'), different seq.
  let opIdErr: any;
  try {
    await client.query(
      `INSERT INTO ${SCHEMA}.op_journal (document_id, seq, op_id) VALUES ($1, $2, $3)`,
      ['doc-1', 2, 'op-a']
    );
  } catch (e) {
    opIdErr = e;
  }
  log('duplicate-op_id error', {
    code: opIdErr?.code,
    constraint: opIdErr?.constraint,
    table: opIdErr?.table,
    detail: opIdErr?.detail,
  });
  assert.equal(opIdErr?.code, '23505', 'expected 23505 for duplicate op_id');
  assert.equal(opIdErr?.constraint, 'uq_doc_opid', 'expected constraint name uq_doc_opid');
  assert.notEqual(
    seqErr?.constraint,
    opIdErr?.constraint,
    'constraint names must differ so app can distinguish the two cases'
  );

  await client.query(`DELETE FROM ${SCHEMA}.op_journal WHERE document_id = 'doc-1'`);
}

async function testAssumption2_abortedTransactionAndOnConflict(client: pg.Client): Promise<void> {
  console.log('\n=== Assumption 2: aborted tx (25P02) vs ON CONFLICT DO NOTHING RETURNING ===');

  await client.query(
    `INSERT INTO ${SCHEMA}.op_journal (document_id, seq, op_id) VALUES ($1, $2, $3)`,
    ['doc-2', 1, 'op-a']
  );

  // Part A: plain INSERT causing 23505 inside a transaction aborts the transaction.
  await client.query('BEGIN');
  let insideErr: any;
  try {
    await client.query(
      `INSERT INTO ${SCHEMA}.op_journal (document_id, seq, op_id) VALUES ($1, $2, $3)`,
      ['doc-2', 1, 'op-b']
    );
  } catch (e) {
    insideErr = e;
  }
  assert.equal(insideErr?.code, '23505');

  let afterErr: any;
  try {
    await client.query('SELECT 1');
  } catch (e) {
    afterErr = e;
  }
  log('post-conflict statement error (same tx)', { code: afterErr?.code, message: afterErr?.message });
  assert.equal(afterErr?.code, '25P02', 'expected 25P02 (in failed sql transaction) after unique violation');
  await client.query('ROLLBACK');

  // Confirm we can operate normally after ROLLBACK.
  const sane = await client.query('SELECT 1 AS ok');
  assert.equal(sane.rows[0].ok, 1);

  // Part B: ON CONFLICT DO NOTHING RETURNING avoids aborting the transaction.
  await client.query('BEGIN');
  const conflictResult = await client.query(
    `INSERT INTO ${SCHEMA}.op_journal (document_id, seq, op_id)
     VALUES ($1, $2, $3)
     ON CONFLICT ON CONSTRAINT uq_doc_seq DO NOTHING
     RETURNING id`,
    ['doc-2', 1, 'op-b']
  );
  log('ON CONFLICT DO NOTHING RETURNING result', {
    rowCount: conflictResult.rowCount,
    rows: conflictResult.rows,
  });
  assert.equal(conflictResult.rowCount, 0, 'expected zero rows returned on conflict');

  // Transaction must still be usable (not aborted).
  const stillGood = await client.query('SELECT 2 AS ok');
  assert.equal(stillGood.rows[0].ok, 2, 'transaction should still be usable after ON CONFLICT DO NOTHING');
  await client.query('COMMIT');

  await client.query(`DELETE FROM ${SCHEMA}.op_journal WHERE document_id = 'doc-2'`);
}

async function testAssumption3_concurrentInsertBlocksAndFails(pool: pg.Pool): Promise<void> {
  console.log('\n=== Assumption 3: concurrent inserts on same (document_id, seq) ===');

  const c1 = await pool.connect();
  const c2 = await pool.connect();
  try {
    await c1.query('BEGIN');
    await c2.query('BEGIN');

    await c1.query(
      `INSERT INTO ${SCHEMA}.op_journal (document_id, seq, op_id) VALUES ($1, $2, $3)`,
      ['doc-3', 1, 'op-a']
    );

    let tx2Resolved = false;
    const tx2Start = Date.now();
    // Note: resolve with the error instead of re-throwing inside .then's rejection
    // handler. Re-throwing there would produce a second, not-yet-awaited promise that
    // Node can flag as an unhandled rejection during the setTimeout window below, before
    // the later `await tx2Promise` gets a chance to attach a handler to it.
    const tx2Promise: Promise<unknown> = c2
      .query(`INSERT INTO ${SCHEMA}.op_journal (document_id, seq, op_id) VALUES ($1, $2, $3)`, [
        'doc-3',
        1,
        'op-b',
      ])
      .then(
        () => {
          tx2Resolved = true;
          return undefined;
        },
        (e) => {
          tx2Resolved = true;
          return e;
        }
      );

    // Give tx2 a chance to attempt and block.
    await new Promise((r) => setTimeout(r, 300));
    log('tx2 resolved before tx1 commit?', tx2Resolved);
    assert.equal(tx2Resolved, false, 'tx2 insert should still be blocked waiting on tx1 row lock');

    await c1.query('COMMIT');

    const tx2Err: any = await tx2Promise;
    const elapsedMs = Date.now() - tx2Start;
    log('tx2 outcome after tx1 commit', { code: tx2Err?.code, elapsedMs });
    assert.ok(tx2Err, 'tx2 insert should fail once tx1 commits the conflicting row');
    assert.equal(tx2Err.code, '23505');

    await c2.query('ROLLBACK');
  } finally {
    c1.release();
    c2.release();
  }

  await pool.query(`DELETE FROM ${SCHEMA}.op_journal WHERE document_id = 'doc-3'`);
}

// The one-statement fenced append: the INSERT's source rows come from a SELECT ... FOR
// UPDATE against the lease row, so (a) the lease row gets locked, (b) the read of the
// current token is fresh (not a value cached earlier by the caller), and (c) the row is
// only produced (and thus inserted) when the writer's token is still >= the lease's
// current token. This is the single statement under test throughout Assumption 4.
function conditionalAppendSql(schema: string): string {
  return `
    INSERT INTO ${schema}.op_journal (document_id, seq, op_id)
    SELECT $1, $2, $3
    FROM ${schema}.lease
    WHERE document_id = $1 AND token <= $4
    FOR UPDATE
    RETURNING id
  `;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testAssumption4_conditionalAppendWithLeaseToken(pool: pg.Pool): Promise<void> {
  console.log('\n=== Assumption 4: atomic lease-token-gated conditional append (real races) ===');
  const APPEND_SQL = conditionalAppendSql(SCHEMA);

  // --- Sequential sanity check: a stale token is rejected, a current token succeeds. ---
  await pool.query(`INSERT INTO ${SCHEMA}.lease (document_id, token) VALUES ($1, $2)`, ['doc-4-sanity', 5]);
  const staleAttempt = await pool.query(APPEND_SQL, ['doc-4-sanity', 100, 'op-stale', 3]);
  log('sanity: stale-token (3 < current 5) attempt rowCount', staleAttempt.rowCount);
  assert.equal(staleAttempt.rowCount, 0, 'stale writer (token 3 < current 5) must be rejected');

  const currentAttempt = await pool.query(APPEND_SQL, ['doc-4-sanity', 101, 'op-current', 5]);
  log('sanity: current-token (5 >= current 5) attempt rowCount', currentAttempt.rowCount);
  assert.equal(currentAttempt.rowCount, 1, 'writer with token equal to current must succeed');
  await pool.query(`DELETE FROM ${SCHEMA}.op_journal WHERE document_id = 'doc-4-sanity'`);
  await pool.query(`DELETE FROM ${SCHEMA}.lease WHERE document_id = 'doc-4-sanity'`);

  // --- Interleaving (i): bump-then-append. Writer A BEGINs first (token=5), but a new
  // owner bumps the lease to 6 and COMMITs before A's append statement actually runs.
  // A's append must then see the fresh token (6) and insert 0 rows -- proving the
  // statement re-reads the lease at execution time rather than trusting a value A might
  // have cached when it opened its transaction. ---
  {
    const doc = 'doc-4-bump-then-append';
    await pool.query(`INSERT INTO ${SCHEMA}.lease (document_id, token) VALUES ($1, $2)`, [doc, 5]);

    const connA = await pool.connect();
    const connB = await pool.connect();
    try {
      await connA.query('BEGIN');
      // A has opened its transaction but has NOT yet run its append statement.

      await connB.query('BEGIN');
      await connB.query(`UPDATE ${SCHEMA}.lease SET token = $2 WHERE document_id = $1`, [doc, 6]);
      await connB.query('COMMIT');
      log('interleaving (i): new-owner bump to 6 committed before A appended', true);

      // Only now does A run its append, still using its original token=5.
      const aResult = await connA.query(APPEND_SQL, [doc, 1, 'op-a-stale', 5]);
      log('interleaving (i): A append (token=5) rowCount after bump to 6', aResult.rowCount);
      assert.equal(
        aResult.rowCount,
        0,
        'A append with stale token=5 must insert 0 rows once the lease was bumped to 6'
      );
      await connA.query('COMMIT');

      const finalRows = await pool.query(`SELECT * FROM ${SCHEMA}.op_journal WHERE document_id = $1`, [doc]);
      log('interleaving (i): journal rows for doc after the race', finalRows.rows);
      assert.equal(finalRows.rowCount, 0, 'no journal row should exist: the only append attempt was rejected');
    } finally {
      connA.release();
      connB.release();
    }
    await pool.query(`DELETE FROM ${SCHEMA}.lease WHERE document_id = $1`, [doc]);
  }

  // --- Interleaving (ii): append-then-bump (reverse order). Writer A's append (token=5)
  // runs FIRST and, because it is a SELECT ... FOR UPDATE under the hood, holds the lease
  // row's lock inside A's still-open transaction. A concurrent bump to token=6 must then
  // BLOCK until A commits (proving the lock is real, not just a filter). After A commits,
  // A's row must be present with token 5, the bump must then proceed, and a later append
  // attempt reusing token=5 must now fail. ---
  {
    const doc = 'doc-4-append-then-bump';
    await pool.query(`INSERT INTO ${SCHEMA}.lease (document_id, token) VALUES ($1, $2)`, [doc, 5]);

    const connA = await pool.connect();
    const connB = await pool.connect();
    try {
      await connA.query('BEGIN');
      const aResult = await connA.query(APPEND_SQL, [doc, 1, 'op-a-first', 5]);
      log('interleaving (ii): A append (token=5) rowCount, tx still open', aResult.rowCount);
      assert.equal(aResult.rowCount, 1, 'A append with token=5 against current=5 must succeed');
      // A's transaction is still OPEN here: the FOR UPDATE lock on the lease row is held.

      let bumpResolved = false;
      const bumpStart = Date.now();
      await connB.query('BEGIN');
      const bumpPromise = connB
        .query(`UPDATE ${SCHEMA}.lease SET token = $2 WHERE document_id = $1`, [doc, 6])
        .then(
          () => {
            bumpResolved = true;
          },
          (e) => {
            bumpResolved = true;
            throw e;
          }
        );

      await sleep(300);
      log('interleaving (ii): bump resolved before A committed?', bumpResolved);
      assert.equal(bumpResolved, false, 'the bump must be blocked by A holding the lease row lock');

      await connA.query('COMMIT');
      await bumpPromise;
      const bumpElapsedMs = Date.now() - bumpStart;
      log('interleaving (ii): bump outcome after A committed', { bumpResolved, bumpElapsedMs });
      assert.ok(bumpElapsedMs >= 280, 'the bump should have waited close to the full block duration');
      await connB.query('COMMIT');

      const rowsAfterA = await pool.query(`SELECT * FROM ${SCHEMA}.op_journal WHERE document_id = $1`, [doc]);
      log('interleaving (ii): journal rows after A committed and bump proceeded', rowsAfterA.rows);
      assert.equal(rowsAfterA.rowCount, 1, "A's row must be present");
      assert.equal(rowsAfterA.rows[0].seq, '1');

      // A later append reusing the now-stale token=5 (lease is now 6) must be rejected.
      const laterAttempt = await pool.query(APPEND_SQL, [doc, 2, 'op-later-stale', 5]);
      log('interleaving (ii): later append with stale token=5 rowCount', laterAttempt.rowCount);
      assert.equal(laterAttempt.rowCount, 0, 'a later append with the now-stale token=5 must be rejected');
    } finally {
      connA.release();
      connB.release();
    }
    await pool.query(`DELETE FROM ${SCHEMA}.op_journal WHERE document_id = $1`, [doc]);
    await pool.query(`DELETE FROM ${SCHEMA}.lease WHERE document_id = $1`, [doc]);
  }
}

// CONTROL: the naive two-step version -- SELECT the token, then INSERT in a SEPARATE
// statement with no row lock -- run through the SAME "bump happens in the middle"
// interleaving as (i) above. If the test harness can tell right from wrong, this must
// let the stale write through (rowCount 1) precisely where the correct one-statement
// fenced append got 0 rows.
async function testAssumption4_controlNaiveTwoStepIsBroken(pool: pg.Pool): Promise<void> {
  console.log('\n=== Assumption 4 CONTROL: naive SELECT-then-INSERT (no lock) lets stale writes through ===');
  const doc = 'doc-4-naive-control';
  await pool.query(`INSERT INTO ${SCHEMA}.lease (document_id, token) VALUES ($1, $2)`, [doc, 5]);

  const connA = await pool.connect();
  const connB = await pool.connect();
  try {
    await connA.query('BEGIN');

    // Naive step 1: read the token with a plain SELECT, no FOR UPDATE, no lock held.
    const readBack = await connA.query(`SELECT token FROM ${SCHEMA}.lease WHERE document_id = $1`, [doc]);
    const observedToken = readBack.rows[0].token;
    log('naive control: step 1 SELECT token (no lock)', observedToken);
    assert.equal(observedToken, '5');

    // Meanwhile, a new owner bumps the lease and commits -- A's naive read is now stale.
    await connB.query('BEGIN');
    await connB.query(`UPDATE ${SCHEMA}.lease SET token = $2 WHERE document_id = $1`, [doc, 6]);
    await connB.query('COMMIT');
    log('naive control: new-owner bump to 6 committed between A\'s SELECT and INSERT', true);

    // Naive step 2: the writer's local JS check (`5 >= 5`, using the STALE value from
    // step 1) passes, so it goes ahead with a plain, unconditional INSERT.
    const localCheckPasses = Number(observedToken) <= 5;
    assert.equal(localCheckPasses, true, 'the naive in-process check uses the stale token and passes');
    const naiveInsert = await connA.query(
      `INSERT INTO ${SCHEMA}.op_journal (document_id, seq, op_id) VALUES ($1, $2, $3) RETURNING id`,
      [doc, 1, 'op-naive-stale']
    );
    log('naive control: step 2 INSERT rowCount (after lease already bumped to 6)', naiveInsert.rowCount);
    await connA.query('COMMIT');

    assert.equal(
      naiveInsert.rowCount,
      1,
      'CONTROL: the naive two-step version must let the stale write through (proves the test can distinguish right from wrong)'
    );

    const journalRows = await pool.query(`SELECT * FROM ${SCHEMA}.op_journal WHERE document_id = $1`, [doc]);
    log('naive control: journal rows (stale write landed despite lease already at 6)', journalRows.rows);
    assert.equal(journalRows.rowCount, 1, 'the stale row is actually present in the journal');
  } finally {
    connA.release();
    connB.release();
  }
  await pool.query(`DELETE FROM ${SCHEMA}.op_journal WHERE document_id = $1`, [doc]);
  await pool.query(`DELETE FROM ${SCHEMA}.lease WHERE document_id = $1`, [doc]);
}

// Loop the genuine race (append vs. a concurrent bump, order randomized via Promise.all
// plus randomized tiny delays) many times, and on every single iteration assert that no
// stale row can ever land: after the race settles, re-attempting an append with the
// PRE-race token must always be rejected, regardless of which side won the lock.
async function testAssumption4_raceLoopNeverLetsStaleRowsLand(pool: pg.Pool): Promise<void> {
  console.log('\n=== Assumption 4: 50-iteration randomized race, asserting zero stale rows ever land ===');
  const APPEND_SQL = conditionalAppendSql(SCHEMA);
  const ITERATIONS = 50;
  let staleRowsObserved = 0;
  let appendWonCount = 0;
  let bumpWonCount = 0;

  for (let i = 0; i < ITERATIONS; i++) {
    const doc = `doc-4-race-loop-${i}`;
    await pool.query(`INSERT INTO ${SCHEMA}.lease (document_id, token) VALUES ($1, $2)`, [doc, 0]);

    const connA = await pool.connect();
    const connB = await pool.connect();
    try {
      await connA.query('BEGIN');
      await connB.query('BEGIN');

      const appendDelay = Math.floor(Math.random() * 6); // 0-5ms
      const bumpDelay = Math.floor(Math.random() * 6); // 0-5ms

      const appendPromise = sleep(appendDelay)
        .then(() => connA.query(APPEND_SQL, [doc, 1, `op-race-${i}`, 0]))
        .then(async (res) => {
          await connA.query('COMMIT');
          return res;
        });

      const bumpPromise = sleep(bumpDelay)
        .then(() => connB.query(`UPDATE ${SCHEMA}.lease SET token = token + 1 WHERE document_id = $1`, [doc]))
        .then(async (res) => {
          await connB.query('COMMIT');
          return res;
        });

      const [appendRes] = await Promise.all([appendPromise, bumpPromise]);
      if (appendRes.rowCount === 1) {
        appendWonCount++;
      } else {
        bumpWonCount++;
      }

      // Whichever side won, the lease has now moved past token 0 (bump always eventually
      // succeeds -- it is unconditional). Re-attempting an append with the SAME pre-race
      // token (0) must now ALWAYS be rejected: this is the "zero stale rows ever land"
      // invariant, checked fresh on every single iteration.
      const followUp = await pool.query(APPEND_SQL, [doc, 2, `op-race-followup-${i}`, 0]);
      if (followUp.rowCount !== 0) {
        staleRowsObserved++;
      }
    } finally {
      connA.release();
      connB.release();
    }
    await pool.query(`DELETE FROM ${SCHEMA}.op_journal WHERE document_id = $1`, [doc]);
    await pool.query(`DELETE FROM ${SCHEMA}.lease WHERE document_id = $1`, [doc]);
  }

  log('race loop summary', { ITERATIONS, appendWonCount, bumpWonCount, staleRowsObserved });
  assert.equal(appendWonCount + bumpWonCount, ITERATIONS, 'every iteration must have a definite winner');
  assert.equal(staleRowsObserved, 0, 'zero stale rows must ever land across all randomized iterations');
}

async function testAssumption5_bigintAsString(client: pg.Client): Promise<void> {
  console.log('\n=== Assumption 5: BIGINT columns come back as strings ===');
  await client.query(
    `INSERT INTO ${SCHEMA}.op_journal (document_id, seq, op_id) VALUES ($1, $2, $3)`,
    ['doc-5', 9007199254740993n.toString(), 'op-a'] // beyond MAX_SAFE_INTEGER
  );
  const res = await client.query(
    `SELECT seq FROM ${SCHEMA}.op_journal WHERE document_id = 'doc-5'`
  );
  const seqValue = res.rows[0].seq;
  log('seq value + typeof', { seqValue, typeOf: typeof seqValue });
  assert.equal(typeof seqValue, 'string', 'bigint column should come back as a JS string by default');

  // Demonstrate the footgun: naive JS arithmetic on the string does concatenation, not addition.
  const naive = (seqValue as unknown as string) + 1;
  log('naive `seqValue + 1` (string concat footgun)', naive);
  assert.equal(naive, '90071992547409931', 'demonstrates string concatenation, not numeric addition');

  // Cleanest fix demonstrated: convert explicitly at the boundary with BigInt().
  const asBigInt = BigInt(seqValue as unknown as string) + 1n;
  log('BigInt(seqValue) + 1n (correct)', asBigInt.toString());
  assert.equal(asBigInt, 9007199254740994n);

  await client.query(`DELETE FROM ${SCHEMA}.op_journal WHERE document_id = 'doc-5'`);
}

async function testAssumption6_poolBehavior(): Promise<void> {
  console.log('\n=== Assumption 6: pool error isolation + exhaustion/timeout ===');

  const pool = new pg.Pool({ ...CONNECTION, max: 2, connectionTimeoutMillis: 500 });
  try {
    // A query error on a pooled client should not poison the pool.
    let queryErr: any;
    try {
      await pool.query('SELECT * FROM this_table_does_not_exist');
    } catch (e) {
      queryErr = e;
    }
    log('deliberate query error', { code: queryErr?.code });
    assert.equal(queryErr?.code, '42P01');

    const stillWorks = await pool.query('SELECT 1 AS ok');
    log('pool still works after error', stillWorks.rows[0]);
    assert.equal(stillWorks.rows[0].ok, 1, 'pool must not be poisoned by a prior query error');

    // Exhaust the pool by checking out both clients and never releasing them.
    const held1 = await pool.connect();
    const held2 = await pool.connect();
    log('pool stats after checking out max clients', {
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount,
    });

    let timeoutErr: any;
    const start = Date.now();
    try {
      await pool.query('SELECT 1');
    } catch (e) {
      timeoutErr = e;
    }
    const elapsedMs = Date.now() - start;
    log('query while pool exhausted', { message: timeoutErr?.message, elapsedMs });
    assert.ok(timeoutErr, 'query attempted while pool is exhausted should eventually reject');
    assert.ok(
      elapsedMs >= 450,
      `expected to wait close to connectionTimeoutMillis (500ms), got ${elapsedMs}ms`
    );

    held1.release();
    held2.release();
  } finally {
    await pool.end();
  }
}

async function testAssumption7_jsonbRoundtrip(client: pg.Client): Promise<void> {
  console.log('\n=== Assumption 7: jsonb round-trip + key order ===');
  const original = { b: 1, a: 2, c: 3, nested: { z: 'last', y: 'mid', x: 'first' }, arr: [3, 1, 2] };
  await client.query(
    `INSERT INTO ${SCHEMA}.op_journal (document_id, seq, op_id, payload) VALUES ($1, $2, $3, $4)`,
    ['doc-7', 1, 'op-a', original]
  );
  const res = await client.query(`SELECT payload FROM ${SCHEMA}.op_journal WHERE document_id = 'doc-7'`);
  const roundTripped = res.rows[0].payload;
  log('original', original);
  log('round-tripped', roundTripped);
  log('Object.keys(original) vs Object.keys(roundTripped)', {
    originalKeys: Object.keys(original),
    roundTrippedKeys: Object.keys(roundTripped),
  });

  assert.deepEqual(roundTripped, original, 'jsonb should round-trip the object intact (deep equal)');
  assert.notDeepEqual(
    Object.keys(roundTripped),
    Object.keys(original),
    'key order should NOT be preserved by jsonb (top-level keys get normalized)'
  );

  await client.query(`DELETE FROM ${SCHEMA}.op_journal WHERE document_id = 'doc-7'`);
}

async function main(): Promise<void> {
  const client = new pg.Client(CONNECTION);
  await client.connect();

  try {
    const versionResult = await client.query('select version()');
    log('select version()', versionResult.rows[0].version);

    await setup(client);

    await testAssumption1_duplicateUniqueConstraint(client);
    await testAssumption2_abortedTransactionAndOnConflict(client);

    const pool = new pg.Pool({ ...CONNECTION, max: 5 });
    try {
      await testAssumption3_concurrentInsertBlocksAndFails(pool);
      await testAssumption4_conditionalAppendWithLeaseToken(pool);
      await testAssumption4_controlNaiveTwoStepIsBroken(pool);
      await testAssumption4_raceLoopNeverLetsStaleRowsLand(pool);
    } finally {
      await pool.end();
    }

    await testAssumption5_bigintAsString(client);
    await testAssumption6_poolBehavior();
    await testAssumption7_jsonbRoundtrip(client);

    console.log('\nAll assumptions confirmed.');
  } finally {
    await teardown(client);
    await client.end();
  }
}

main().catch((err) => {
  console.error('\nFAILED:', err);
  process.exitCode = 1;
});
