// One process per command: `node main.ts <command>`. The test template's files (test/v1/noon/) each exec this with
// their own name; run.sh also starts the scenes (scenes.ts), which only a local run has. Exit 0 = the command RAN
// (a property that failed is in the SDK's output, and in the report); exit 1 = it could not do its work.
import * as checks from "./checks.ts";
import * as scenes from "./scenes.ts";
import { closeStores } from "./world.ts";
import * as workload from "./workload.ts";

const COMMANDS: Record<string, () => Promise<void> | void> = {
  first_setup: workload.setup,
  parallel_driver_edit: workload.edit,
  parallel_driver_viewer_edit: workload.viewerEdit,
  parallel_driver_start_twice: workload.startTwice,
  parallel_driver_ai_and_person: workload.aiAndPerson,
  parallel_driver_end_run_early: workload.endRunEarly,
  parallel_driver_stale_message: workload.staleMessage,
  parallel_driver_ship: workload.ship,
  parallel_driver_share_revoke: workload.shareRevoke,
  parallel_driver_engineer_push: workload.engineerPush,
  anytime_stranger_probe: checks.strangerProbe,
  anytime_journal_contiguous: checks.journalContiguous,
  anytime_lease_matches_fence: checks.leaseMatchesFence,
  eventually_room_writable: checks.roomWritable,
  eventually_jobs_settle: checks.jobsSettle,
  eventually_revoked_share_closed: checks.revokedShareClosed,
  eventually_push_on_canvas: checks.pushOnCanvas,
  finally_ledger: checks.finallyLedger,
  finally_peers_converge: checks.finallyPeersConverge,
  finally_jobs: checks.finallyJobs,
  finally_ship: checks.finallyShip,
  finally_sut_logs: checks.finallySutLogs,
  finally_windows_reached: checks.finallyWindowsReached,
  "scene:sync-killed": scenes.syncKilled,
  "scene:sync-paused": scenes.syncPaused,
  "scene:store-unavailable": scenes.storeUnavailable,
  "scene:worker-killed": scenes.workerKilled,
  "scene:worker-paused": scenes.workerPaused,
  "scene:redis-wiped": scenes.redisWiped,
  "scene:webhook-dropped": scenes.webhookDropped,
  "scene:upgrade-reset": scenes.upgradeReset,
  "scene:worker-store-unavailable": scenes.workerStoreUnavailable,
  "scene:minio-reopen": scenes.minioClosed,
  "scene:minio-open": scenes.minioOpen,
};

const name = process.argv[2] ?? "";
const command = COMMANDS[name];
if (!command) {
  process.stderr.write(`usage: node main.ts <command>\n${Object.keys(COMMANDS).join("\n")}\n`);
  process.exit(2);
}
let code = 0;
try {
  await command();
} catch (err) {
  code = 1;
  process.stdout.write(`[${name}] COULD NOT RUN: ${err instanceof Error ? err.message : String(err)}\n`);
} finally {
  await closeStores().catch(() => undefined);
}
process.exit(code); // a peer's socket or a Redis connection must not keep a finished command alive
