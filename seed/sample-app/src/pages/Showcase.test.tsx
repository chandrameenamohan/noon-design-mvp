import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { Showcase } from "./Showcase.tsx";

test("the showcase renders every design-system component", () => {
  const html = renderToStaticMarkup(<Showcase />);
  for (const name of ["Stack", "Card", "Button", "Text", "Image", "Input"]) {
    expect(html, name).toContain(`data-component="${name}"`);
  }
  expect(html).toContain("Pay $42");
  expect(html).toMatch(/<label for="[^"]+">Card number<\/label>/); // the input has an accessible name
});
