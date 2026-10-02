import { BlockList, isIP } from "node:net";

/**
 * E9.6 (F31): who is asking, for the per-address rate limit on routes that name no user. The address is the TCP peer,
 * unless the peer is a proxy we trust, in which case it is the rightmost X-Forwarded-For entry that is not itself a
 * trusted proxy. Rightmost, not leftmost: every hop APPENDS what it saw (ngrok the visitor, http-proxy the ngrok
 * agent), so everything left of the last trusted hop's entry was written by the client and may say anything. A
 * header from a peer we do not trust is ignored entirely: anyone can send one.
 *
 * Who is trusted is TRUST_PROXY (config.ts): "loopback" by default, which is the Vite dev server (and the ngrok agent
 * behind it) when the api runs on the host. In compose the api sees the host's Vite through Docker's gateway, a
 * private address, so docker-compose.yml says "loopback,private": its port is published on 127.0.0.1 only, and the
 * sandboxes live on their own network, so a private peer is the host or one of our own containers.
 */
export type Trusted = (address: string) => boolean;

const NAMED: Record<string, readonly (readonly [string, number])[]> = {
  loopback: [["127.0.0.0", 8], ["::1", 128]],
  // RFC 1918 and IPv6 unique local: Docker's bridge networks and Docker Desktop's host gateway.
  private: [["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["fc00::", 7]],
};
const family = (address: string) => (isIP(address) === 6 ? "ipv6" : "ipv4");
/** "::ffff:127.0.0.1" (an IPv4 client on a dual-stack socket) is 127.0.0.1: one client, one key. */
const unmap = (address: string): string => {
  const tail = address.slice(7);
  return address.toLowerCase().startsWith("::ffff:") && isIP(tail) === 4 ? tail : address;
};

/** `spec`: comma-separated "loopback", "private", addresses and CIDRs. Anything else throws: a typo must not trust the world, or no one. */
export function trustedProxies(spec: string): Trusted {
  const list = new BlockList();
  for (const entry of spec.split(",").map((each) => each.trim()).filter((each) => each !== "")) {
    const named = NAMED[entry];
    if (named) {
      for (const [net, prefix] of named) list.addSubnet(net, prefix, family(net));
      continue;
    }
    const [net = "", prefix, extra] = entry.split("/");
    const bits = isIP(net) === 6 ? 128 : 32;
    if (isIP(net) === 0 || extra !== undefined || (prefix !== undefined && !(/^\d{1,3}$/.test(prefix) && Number(prefix) <= bits))) {
      throw new Error(`not an address, a CIDR, "loopback" or "private": ${entry}`);
    }
    if (prefix === undefined) list.addAddress(net, family(net));
    else list.addSubnet(net, Number(prefix), family(net));
  }
  return (address) => {
    const plain = unmap(address);
    return isIP(plain) !== 0 && list.check(plain, family(plain));
  };
}

/** The client's address (see above), or undefined when there is no socket to ask (a request made in-process, in tests). */
export function clientAddress(peer: string | undefined, forwardedFor: string | undefined, trusted: Trusted): string | undefined {
  if (peer === undefined) return undefined;
  let client = unmap(peer);
  if (!trusted(client) || forwardedFor === undefined) return client;
  const hops = forwardedFor.split(",");
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = unmap((hops[i] ?? "").trim());
    // Not an address: stop at the last one a trusted hop vouched for (a garbled header costs its sender, not others).
    if (isIP(hop) === 0) return client;
    client = hop;
    if (!trusted(hop)) return hop;
  }
  return client; // every hop a trusted proxy: the furthest one
}

/** "1:2::" is ["1", "2"]; an IPv4 tail ("::1.2.3.4") is two groups, past the /64 and so never read. */
const groups = (part: string): string[] => (part === "" ? [] : part.split(":").flatMap((group) => (group.includes(".") ? ["0", "0"] : [group])));

/**
 * What a client is counted as: an IPv4 address is itself, an IPv6 one its /64, the smallest block a host is given
 * (SLAAC, RFC 6177), so a host rotating through its 2^64 addresses is still one count. ponytail: a /64 per key;
 * ceiling: a client given a /48 still has 2^16 keys; upgrade: a looser second count per /48.
 */
export function rateKey(address: string): string {
  const plain = unmap(address);
  if (isIP(plain) !== 6) return plain;
  const [head = "", tail] = plain.toLowerCase().replace(/%.*$/, "").split("::");
  const left = groups(head);
  const right = tail === undefined ? [] : groups(tail);
  const full = [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  return `${full.slice(0, 4).map((group) => Number.parseInt(group, 16).toString(16)).join(":")}::/64`;
}
