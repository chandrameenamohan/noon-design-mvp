import { expect, test } from "vitest";
import { previewDocument, previewToken } from "./sandbox-proxy.ts";

// noon-9gz: behind one public URL a document id is no longer enough to see a preview.
const key = "k".repeat(32);
const doc = "0b7e6a52-3c1d-4f8e-9a2b-5d6c7e8f9a0b";
const other = "1c8f7b63-4d2e-4a9f-8b3c-6e7d8f9a0b1c";
const nonce = "0123456789abcdef";
const token = previewToken(key, doc, nonce);

test("a token minted for the document opens it, the HMR socket's path and the preview's query included", () => {
  expect(token).toMatch(/^[0-9a-f]{16}\.[0-9a-f]{32}$/u);
  expect(previewDocument(key, `/preview/${doc}/${token}/noon-preview/?doc=${doc}&started=1`)).toBe(doc);
  expect(previewDocument(key, `/preview/${doc}/${token}/?token=x`)).toBe(doc);
  expect(previewDocument(key, `/preview/${doc}/${previewToken(key, doc, "fedcba9876543210")}/`)).toBe(doc); // another container's nonce: the SANDBOX refuses that one
});

// One broken rule per case: the proxy is public, and every one of these is somebody without the token.
const [, mac] = token.split(".") as [string, string];
test.each([
  ["the document id alone (the noon-l96 ceiling)", `/preview/${doc}/`],
  ["the document id and a port, as before noon-9gz", `/preview/${doc}/20001/`],
  ["another document's token", `/preview/${doc}/${previewToken(key, other, nonce)}/`],
  ["a token under another key", `/preview/${doc}/${previewToken("x".repeat(32), doc, nonce)}/`],
  ["a mac for another nonce", `/preview/${doc}/fedcba9876543210.${mac}/`],
  ["one wrong hex digit", `/preview/${doc}/${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}/`],
  ["a short mac", `/preview/${doc}/${token.slice(0, -1)}/`],
  ["an upper-case token", `/preview/${doc}/${token.toUpperCase()}/`],
  ["an upper-case document id", `/preview/${doc.toUpperCase()}/${token}/`],
  ["no slash after the token", `/preview/${doc}/${token}`],
  ["the path somewhere else", `/x/preview/${doc}/${token}/`],
])("refuses %s", (_name, url) => {
  expect(previewDocument(key, url)).toBeUndefined();
});
