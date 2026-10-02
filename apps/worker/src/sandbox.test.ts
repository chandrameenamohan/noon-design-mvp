import { expect, test } from "vitest";
import { containerGone } from "./sandbox.ts";

// Docker's ways of saying "that container is gone, or no longer running", as `cli()` words them (the CLI's stderr after
// the command's name). A sandbox removed while it starts must fail by name, whichever of these its last call met.
test.each([
  ["inspect after a removal", "docker container: Error response from daemon: No such container: noon-sandbox-x"],
  ["the CLI's own wording", "docker exec: Error: No such container: noon-sandbox-x"],
  ["an exec whose upgrade met a removal (gate 10)", "docker exec: unable to upgrade to tcp, received 409"],
  ["an exec on a stopped container", "docker exec: Error response from daemon: container 4f1e2d is not running"],
  ["an exec on a stopped container, capitalised", "docker exec: Error response from daemon: Container 4f1e2d is not running"],
  ["a removal under way", "docker exec: Error response from daemon: removal of container noon-sandbox-x is already in progress"],
  ["a container marked for removal", "docker start: Error response from daemon: container is marked for removal and cannot be started"],
  ["runc, the container stopped under the exec", "docker exec: OCI runtime exec failed: exec failed: cannot exec in a stopped container: unknown"],
])("%s is a gone container", (_, message) => {
  expect(containerGone(new Error(message))).toBe(true);
});

test.each([
  ["the probe's own 'not yet'", "docker exec: Command failed: docker exec noon-sandbox-x node -e …"],
  ["a daemon that is away", "docker exec: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?"],
  ["a missing image", "docker run: Unable to find image 'noon-sandbox:dev' locally"],
  ["the deadline", "docker exec: abandoned at the deadline"],
])("%s is not", (_, message) => {
  expect(containerGone(new Error(message))).toBe(false);
});
