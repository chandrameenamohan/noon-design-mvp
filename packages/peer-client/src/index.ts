export { connectPeer, type PeerOptions, type PeerStatus, type Rejection } from "./peer.ts";
// The pure half, without a socket: what the reconcile simulator (apps/sync/src/sim.ts) drives.
export { createReplica, type DocMessage } from "./replica.ts";
