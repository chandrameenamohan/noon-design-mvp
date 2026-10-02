import { useEffect, useState } from "react";
import type { OrgAsMember } from "@noon/contracts";
import { readOrg } from "./api.ts";

/**
 * A paged report on one org (the audit trail, F26; AI usage, F31; the members, E10.8): the org's name and the caller's
 * role in it, the pages read so far, and why the api said no ("forbidden": not an owner; "gone": not found or not a
 * member; "error": no answer). `reload` reads the org and the first page again (after a change the page itself made, or
 * a refusal that says the world moved), so what is shown is always the api's answer.
 */
export function useOrgReport<P extends { nextCursor: string | null }>(orgId: string, read: (orgId: string, cursor?: string) => Promise<P | "forbidden" | "gone">) {
  const [org, setOrg] = useState<OrgAsMember>();
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
  // The org's own read failing is a refusal too: without it the page cannot tell an owner, and would quietly show none.
  const readTheOrg = (): void => { readOrg(orgId).then((found) => { if (found !== "gone") setOrg(found); }, () => { setRefused("error"); }); };
  useEffect(() => {
    readTheOrg();
    void load();
    // Once per org (`load` and `readTheOrg` are recreated every render, and only read orgId).
  }, [orgId]);

  const next = pages.at(-1)?.nextCursor ?? null;
  return { org, pages, refused, loading, next, more: () => { if (next !== null) void load(next); }, reload: () => { setRefused(undefined); readTheOrg(); void load(); } };
}
