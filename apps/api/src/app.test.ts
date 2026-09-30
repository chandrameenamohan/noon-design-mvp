import { expect, test } from "vitest";
import { publicPreview } from "./app.ts";

const doc = "0b7e6a52-3c1d-4f8e-9a2b-5d6c7e8f9a0b";
const stored = `http://127.0.0.1:20000/preview/${doc}/0123456789abcdef.0123456789abcdef0123456789abcdef/noon-preview/?doc=${doc}&started=17`;

test("behind one public URL the preview is the same path and query on the public origin", () => {
  expect(publicPreview({ status: "running", url: stored }, "https://noon.example.com")).toEqual({
    status: "running",
    url: `https://noon.example.com/preview/${doc}/0123456789abcdef.0123456789abcdef0123456789abcdef/noon-preview/?doc=${doc}&started=17`,
  });
});

test("without one, or without a URL, the preview is what was stored", () => {
  expect(publicPreview({ status: "running", url: stored }, undefined)).toEqual({ status: "running", url: stored });
  expect(publicPreview({ status: "running", url: null }, "https://noon.example.com")).toEqual({ status: "running", url: null });
});
