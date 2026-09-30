/**
 * A link to one of the app's pages. ponytail: the address bar is the router (App.tsx: ?doc=, ?org=, ?audit=, ?usage=).
 * The development identity `?user=` (api.ts) rides along when the current address has it, so two windows stay two
 * people from one page to the next; with a real sign-in there is none, and the link is just the page.
 */
export function hrefTo(page: Record<string, string>, search: string = location.search): string {
  const user = new URLSearchParams(search).get("user");
  const params = new URLSearchParams(page);
  if (user !== null) params.set("user", user);
  return `/?${params.toString()}`;
}
