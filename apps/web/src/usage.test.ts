import { expect, test } from "vitest";
import { tokens, usd, waitWords } from "./usage.ts";

test("tokens are whole numbers with thousands separators", () => {
  expect(tokens(0)).toBe("0");
  expect(tokens(2400)).toBe("2,400");
  expect(tokens(1234567)).toBe("1,234,567");
});

test("an estimated cost keeps up to six decimals (the database's scale) and never fewer than two", () => {
  expect(usd(0)).toBe("$0.00");
  expect(usd(0.0246)).toBe("$0.0246");
  expect(usd(0.012345)).toBe("$0.012345");
  expect(usd(1234.5)).toBe("$1,234.50");
});

test("a wait in words, rounded up so coming back when told is never too early", () => {
  expect(waitWords(1)).toBe("1 second");
  expect(waitWords(59)).toBe("59 seconds");
  expect(waitWords(60)).toBe("1 minute");
  expect(waitWords(61)).toBe("2 minutes");
  expect(waitWords(3600)).toBe("60 minutes");
});
