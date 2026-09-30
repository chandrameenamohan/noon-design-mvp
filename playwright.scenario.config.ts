import { e2eConfig } from "./playwright.config.ts";

// The SPEC §8 scenario (e2e/spec-scenario.spec.ts, `make e2e-scenario`): the e2e servers with TWO sync nodes.
export default e2eConfig({ twoSyncNodes: true });
