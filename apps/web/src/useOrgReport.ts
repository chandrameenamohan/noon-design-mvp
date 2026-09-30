import { useEffect, useState } from "react";
import type { Org } from "@noon/contracts";
import { readOrg } from "./api.ts";

/**
 * A paged report on one org (the audit trail, F26; AI usage, F31; the members, E10.8): the org's name, the pages read so
 * far, and why the api said no ("forbidden": not an owner; "gone": not found or not a member; "error": no answer).
 * `reload` reads the first page again (after a change the page itself made), so what is shown is always the api's answer.
 */
export function useOrgReport<P extends { nextCursor: string | null }>(orgId: string, read: (orgId: string, cursor?: string) => Promise<P | "forbidden" | "gone">) {
  const [org, setOrg] = useState<Org>();
  const [pages, setPages] = useState<P[]>([]);
  const [refused, setRefused] = useState<"forbidden" | "gone" | "error">();
  const [loading, setLoading] = useState(true);

  const load = async (cursor?: string): Promise<void> => {
    setLoading(true);
    try {
      const page = await read(orgId, cursor);
      if (typeof page === "string") setRefused(page);
      else setPages((before) => (cursor === undefined ? [page] : [...before, page]));
    } catch {
      setRefused("error");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    readOrg(orgId).then((found) => { if (found !== "gone") setOrg(found); }, () => undefined);
    void load();
    // Once per org (`load` is recreated every render, and only reads orgId).
  }, [orgId]);

  const next = pages.at(-1)?.nextCursor ?? null;
  return { org, pages, refused, loading, next, more: () => { if (next !== null) void load(next); }, reload: () => { setRefused(undefined); void load(); } };
}
