import { expect, test } from "vitest";
import { previewTarget } from "./preview-proxy.ts";

const doc = "0b7e6a52-3c1d-4f8e-9a2b-5d6c7e8f9a0b";

test("a preview path goes to the sandbox port it names, on this machine's loopback", () => {
  expect(previewTarget(`/preview/${doc}/20001/noon-preview/?doc=${doc}`)).toBe("http://127.0.0.1:20001");
  expect(previewTarget(`/preview/${doc}/20000/@vite/client`)).toBe("http://127.0.0.1:20000");
  expect(previewTarget(`/preview/${doc}/20999/?token=x`)).toBe("http://127.0.0.1:20999"); // the HMR socket
});

// One broken rule per case: the proxy is public, and anything but a sandbox port is the laptop's own services.
test.each([
  ["a port below the sandbox range (the api)", `/preview/${doc}/03000/`],
  ["a port below the sandbox range", `/preview/${doc}/19999/`],
  ["a port above the sandbox range", `/preview/${doc}/21000/`],
  ["a port that is not five digits", `/preview/${doc}/5432/`],
  ["no document id", "/preview/20001/"],
  ["a document id that is not a uuid", "/preview/not-a-document-id-at-all-just-36-chars/20001/"],
  ["an upper-case uuid (never what the worker writes)", `/preview/${doc.toUpperCase()}/20001/`],
  ["no trailing slash after the port", `/preview/${doc}/20001`],
  ["a path that only contains the prefix", `/x/preview/${doc}/20001/`],
])("refuses %s", (_name, url) => {
  expect(previewTarget(url)).toBeUndefined();
});
