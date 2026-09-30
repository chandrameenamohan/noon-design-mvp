import { useEffect, useState } from "react";
import type { Conflict } from "@noon/contracts";
import { readConflict } from "./api.ts";
import { conflictWords } from "./conflict.ts";

/**
 * F16b: a push to the document's branch that broke the fixed shape changed nothing on the canvas, and this
 * says so, naming the commit and the file. Editing goes on as before: the banner blocks nothing.
 *
 * Commit and file come from an engineer's push: React renders them as text nodes, never as markup.
 * ponytail: polled every 2 s, like the preview; a pushed message on the room is the upgrade if the lag matters.
 */
export function ConflictBanner({ documentId }: { documentId: string }) {
  const [conflict, setConflict] = useState<Conflict | null>(null);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async (): Promise<void> => {
      const next = await readConflict(documentId).catch(() => undefined); // a failed look is tried again
      if (stopped || next === "gone") return; // the canvas says so itself when the document goes
      if (next !== undefined) setConflict(next);
      timer = setTimeout(() => void tick(), 2000);
    };
    void tick();
    return () => { stopped = true; clearTimeout(timer); };
  }, [documentId]);

  if (!conflict) return null;
  const words = conflictWords(conflict);
  return (
    <div role="alert" className="conflict">
      <p><strong>A push to this page was not applied.</strong> The canvas is unchanged, and you can keep editing.</p>
      <p>Commit <code>{words.commit}</code> changed <code>{words.file}</code>: {words.why}</p>
    </div>
  );
}
