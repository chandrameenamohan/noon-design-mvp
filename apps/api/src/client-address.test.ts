import { expect, test } from "vitest";
import { clientAddress, trustedProxies } from "./client-address.ts";

const loopback = trustedProxies("loopback");

test("a peer we do not trust is the client, whatever X-Forwarded-For it sends", () => {
  expect(clientAddress("203.0.113.9", "198.51.100.1", loopback)).toBe("203.0.113.9");
  expect(clientAddress("172.18.0.1", "198.51.100.1", loopback)).toBe("172.18.0.1"); // private is not trusted unless asked for
  expect(clientAddress("203.0.113.9", undefined, loopback)).toBe("203.0.113.9");
});

test("behind a trusted proxy the client is the rightmost entry that is not a trusted proxy", () => {
  expect(clientAddress("127.0.0.1", "198.51.100.1", loopback)).toBe("198.51.100.1");
  // A visitor who writes their own header is to the LEFT of what ngrok appended: ignored.
  expect(clientAddress("127.0.0.1", "10.0.0.1, 1.2.3.4, 198.51.100.1", loopback)).toBe("198.51.100.1");
  // ngrok, then http-proxy (xfwd) appending the ngrok agent's loopback address.
  expect(clientAddress("::1", "198.51.100.1, 127.0.0.1", loopback)).toBe("198.51.100.1");
  expect(clientAddress("::ffff:127.0.0.1", "2001:db8::7", loopback)).toBe("2001:db8::7");
});

test("no header, a garbled one, or only proxies in it: the last address a trusted hop vouched for", () => {
  expect(clientAddress("127.0.0.1", undefined, loopback)).toBe("127.0.0.1");
  expect(clientAddress("127.0.0.1", "not-an-ip", loopback)).toBe("127.0.0.1");
  expect(clientAddress("127.0.0.1", "198.51.100.1, 1.2.3.4:80", loopback)).toBe("127.0.0.1");
  expect(clientAddress("127.0.0.1", "127.0.0.2, ::1", loopback)).toBe("127.0.0.2");
  expect(clientAddress(undefined, "198.51.100.1", loopback)).toBeUndefined();
});

test("an IPv4 client on a dual-stack socket is one client, not two", () => {
  expect(clientAddress("::ffff:203.0.113.9", undefined, loopback)).toBe("203.0.113.9");
});

test("TRUST_PROXY names loopback, private networks, addresses and CIDRs; anything else is refused", () => {
  const compose = trustedProxies("loopback, private");
  for (const yes of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "10.1.2.3", "172.18.0.1", "192.168.65.1", "fd00::1"]) expect(compose(yes), yes).toBe(true);
  for (const no of ["203.0.113.9", "172.32.0.1", "2001:db8::1", "", "nonsense"]) expect(compose(no), no).toBe(false);
  const exact = trustedProxies("198.51.100.7,2001:db8::/32");
  expect(exact("198.51.100.7")).toBe(true);
  expect(exact("198.51.100.8")).toBe(false);
  expect(exact("2001:db8:1::1")).toBe(true);
  expect(trustedProxies("")("127.0.0.1")).toBe(false);
  for (const bad of ["everyone", "*", "10.0.0.0/33", "10.0.0.0/8/1", "10.0.0.0/x", "::/129", "localhost"]) expect(() => trustedProxies(bad), bad).toThrow(/not an address/);
});
