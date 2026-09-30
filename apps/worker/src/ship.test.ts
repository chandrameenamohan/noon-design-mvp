import { expect, test } from "vitest";
import { ensurePull, openPullOf, pushRejected, remoteHeads, repoApi } from "./ship.ts";
import { JobFailure } from "./worker.ts";

// E5.5 (F17), the pure half: where Gitea's API is, which pull request is the branch's, and how the pull request
// is opened or found. The real Gitea, git and room are ship.int.test.ts.
const DOC = "0f9c7a0e-1b2c-4d3e-8f00-00000000e550";
const BRANCH = `noon/${DOC}`;
const seed = { url: "http://gitea:3000/noon/sample-app.git", auth: { user: "noon", token: "the-token" } };
const pull = (number: number, ref: string, state = "open") => ({ number, state, html_url: `http://localhost:3002/noon/sample-app/pulls/${String(number)}`, head: { ref } });

test("the API of the repo the clone URL names; anything that is not <host>/<owner>/<repo>.git is refused", () => {
  expect(repoApi("http://gitea:3000/noon/sample-app.git")).toBe("http://gitea:3000/api/v1/repos/noon/sample-app");
  expect(repoApi("https://git.example.com/sub/path/acme/web")).toBe("https://git.example.com/sub/path/api/v1/repos/acme/web");
  for (const bad of ["/tmp/seed.git", "file:///tmp/a/b.git", "http://gitea:3000/only-one", "not a url"]) expect(() => repoApi(bad), bad).toThrow(/Gitea clone URL/u);
});

test("the branch's pull request is the OPEN one whose head is the branch, never another branch's or a closed one", () => {
  expect(openPullOf([pull(1, "noon/other"), pull(2, BRANCH, "closed"), pull(3, BRANCH)], BRANCH)).toEqual({ number: 3, url: "http://localhost:3002/noon/sample-app/pulls/3" });
  expect(openPullOf([pull(1, "noon/other")], BRANCH)).toBeUndefined();
  // Gitea's answer is another program's: a link that is not http(s) never reaches the canvas's href.
  expect(() => openPullOf([{ ...pull(3, BRANCH), html_url: "javascript:alert(1)" }], BRANCH)).toThrow();
});

test("only git's own 'not a fast-forward' is a race to build again on; any other failure is one", () => {
  expect(pushRejected(new Error("git push:  ! [rejected]        abc -> noon/x (non-fast-forward)"))).toBe(true);
  expect(pushRejected(new Error("git push:  ! [rejected]        abc -> noon/x (fetch first)"))).toBe(true);
  expect(pushRejected(new Error("git push: fatal: unable to access 'http://gitea:3000/': Could not resolve host"))).toBe(false);
  expect(pushRejected(new Error("git push: remote: Unauthorized"))).toBe(false);
});

test("ls-remote's answer as ref -> commit, odd lines skipped", () => {
  const main = "a".repeat(40);
  const ours = "b".repeat(40);
  expect(remoteHeads(`${main}\trefs/heads/main\n${ours}\trefs/heads/${BRANCH}\nwarning: nonsense\n`)).toEqual(new Map([["refs/heads/main", main], [`refs/heads/${BRANCH}`, ours]]));
});

/** A Gitea that answers from a script, and remembers what it was asked. */
function fakeGitea(answers: ((url: string, init: RequestInit) => Response)[]) {
  const asked: { url: string; init: RequestInit }[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    asked.push({ url, init });
    const answer = answers.shift();
    if (!answer) throw new Error(`unexpected request ${url}`);
    return Promise.resolve(answer(url, init));
  }) as typeof fetch;
  return { asked, fetchImpl };
}
const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const signal = new AbortController().signal;

test("the first ship opens the pull request from the branch into main, with the token as a header and no redirect followed", async () => {
  const gitea = fakeGitea([json(201, pull(7, BRANCH))]);
  expect(await ensurePull({ seed, documentId: DOC, signal, fetchImpl: gitea.fetchImpl })).toEqual({ number: 7, url: "http://localhost:3002/noon/sample-app/pulls/7" });
  const [only] = gitea.asked;
  expect(only?.url).toBe("http://gitea:3000/api/v1/repos/noon/sample-app/pulls");
  expect(only?.init).toMatchObject({ method: "POST", redirect: "error", headers: { authorization: "token the-token" } });
  expect(JSON.parse(only?.init.body as string)).toMatchObject({ head: BRANCH, base: "main" });
  expect(only?.url).not.toContain("the-token");
});

test("shipping again: Gitea's 409 means the branch has its pull request, which is found by head.ref across pages", async () => {
  const fullPage = Array.from({ length: 50 }, (_, i) => pull(100 + i, `noon/someone-${String(i)}`));
  const gitea = fakeGitea([json(409, { message: "pull request already exists for these targets" }), json(200, fullPage), json(200, [pull(3, BRANCH)])]);
  expect(await ensurePull({ seed, documentId: DOC, signal, fetchImpl: gitea.fetchImpl })).toMatchObject({ number: 3 });
  expect(gitea.asked.map((each) => each.url.replace(/^.*\/pulls/u, "/pulls"))).toEqual(["/pulls", "/pulls?state=open&limit=50&page=1", "/pulls?state=open&limit=50&page=2"]);
});

test("Gitea refusing or away fails the ship by a name the user can read", async () => {
  const refusing = fakeGitea([json(401, { message: "unauthorized" })]);
  await expect(ensurePull({ seed, documentId: DOC, signal, fetchImpl: refusing.fetchImpl })).rejects.toMatchObject({ reason: "gitea_unavailable" });
  const away = (() => Promise.reject(new TypeError("fetch failed"))) as typeof fetch;
  const failure = await ensurePull({ seed, documentId: DOC, signal, fetchImpl: away }).catch((err: unknown) => err);
  expect(failure).toBeInstanceOf(JobFailure);
  expect(failure).toMatchObject({ reason: "gitea_unavailable" });
  // A 409 whose pull request is nowhere among the open ones (closed in between) is not a pull request.
  const vanished = fakeGitea([json(409, {}), json(200, [pull(1, "noon/other")])]);
  await expect(ensurePull({ seed, documentId: DOC, signal, fetchImpl: vanished.fetchImpl })).rejects.toMatchObject({ reason: "gitea_unavailable" });
});
