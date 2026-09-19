// EXPECT-RUNTIME: ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX
// Node can only DELETE type syntax. `enum` generates real code, so Node refuses to run it.
// (That is why this repo uses literal unions and sets `erasableSyntaxOnly`.)
enum RunStatus { Queued, Running }
console.log(RunStatus.Queued);
