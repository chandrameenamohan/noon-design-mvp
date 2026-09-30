import { expect, test } from "vitest";
import { hrefTo } from "./links.ts";

test("a link names its page, keeps the development identity of the current address, and nothing else of it", () => {
  expect(hrefTo({ org: "o1" }, "")).toBe("/?org=o1");
  expect(hrefTo({ org: "o1" }, "?doc=d1&user=ann%40example.com")).toBe("/?org=o1&user=ann%40example.com");
  expect(hrefTo({ doc: "d1" }, "?audit=o1")).toBe("/?doc=d1");
  expect(hrefTo({ usage: "a b" }, "?user=x")).toBe("/?usage=a+b&user=x");
});
