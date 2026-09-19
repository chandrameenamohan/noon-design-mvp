import { Manifest } from "@noon/contracts";
import committed from "../manifest.json" with { type: "json" };

/** The design system the canvas designs with: the sample app's, until a real customer repo exists. */
export const DESIGN_SYSTEM_ENTRY = new URL("../../../seed/sample-app/src/design-system/index.ts", import.meta.url).pathname;

/** The committed manifest, validated on load. Regenerate with `make manifest`. */
export const manifest: Manifest = Manifest.parse(committed);

/** Human-readable differences between the committed manifest and a fresh extraction. Empty = in sync. */
export function describeDrift(committedManifest: Manifest, fresh: Manifest): string[] {
  const before = new Map(committedManifest.components.map((c) => [c.name, c]));
  const after = new Map(fresh.components.map((c) => [c.name, c]));
  const drift: string[] = [];
  for (const name of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const was = before.get(name);
    const now = after.get(name);
    if (!was) drift.push(`${name}: new in the design system`);
    else if (!now) drift.push(`${name}: removed from the design system`);
    else if (JSON.stringify(was) !== JSON.stringify(now)) {
      const props = new Set([...was.props, ...now.props].map((p) => p.name));
      const changed = [...props].filter((p) => JSON.stringify(was.props.find((x) => x.name === p)) !== JSON.stringify(now.props.find((x) => x.name === p)));
      drift.push(`${name}: ${changed.length > 0 ? `props changed (${changed.sort().join(", ")})` : "children support changed"}`);
    }
  }
  return drift;
}
