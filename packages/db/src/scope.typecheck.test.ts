/* eslint-disable @typescript-eslint/no-meaningless-void-operator, @typescript-eslint/no-unsafe-call --
   every line below is wrong on purpose; the compiler, not the linter, is the judge here. */
import { expect, test } from "vitest";
import type { Db } from "./index.ts";

// Compile-time checks. `@ts-expect-error` FAILS the typecheck layer if the line below it compiles,
// so these lines prove that an unscoped door does not exist on the public type.
function unscopedAccessIsImpossible(db: Db): void {
  // @ts-expect-error the connection pool is not reachable from outside the package
  void db.pool;
  // @ts-expect-error there is no raw query method
  void db.query("select * from workspaces");
  // @ts-expect-error tenant data cannot be listed without naming an org
  void db.listWorkspaces();
  // @ts-expect-error a scope needs an org id
  void db.forOrg();
}

test("the unscoped-access checks above are compile-time only", () => {
  expect(unscopedAccessIsImpossible).toBeTypeOf("function");
});
