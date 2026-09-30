import type { Doc } from "@noon/contracts";

/** The page the layer and library unit tests share: a card (with a button and a text), a stack (empty) and a second text. */
export const doc: Doc = {
  rootId: "root",
  nodes: {
    root: { id: "root", component: "Page", props: {}, parentId: null, children: ["card", "stack", "text2"] },
    card: { id: "card", component: "Card", props: {}, parentId: "root", children: ["button", "text"] },
    button: { id: "button", component: "Button", props: { label: "Go" }, parentId: "card", children: [] },
    text: { id: "text", component: "Text", props: { value: "Hi" }, parentId: "card", children: [] },
    stack: { id: "stack", component: "Stack", props: {}, parentId: "root", children: [] },
    text2: { id: "text2", component: "Text", props: { value: "Bye" }, parentId: "root", children: [] },
  },
};
