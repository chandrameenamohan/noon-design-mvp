// Learning test for @anthropic-ai/claude-agent-sdk (TypeScript) on Node.js 24.
// Run with: node test.ts   (from this directory)
//
// FINDINGS (filled in after running against a real Claude subscription via
// CLAUDE_CODE_OAUTH_TOKEN):
//
// 1. query() authenticated only by CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY unset.
//    CONFIRMED. The system "init" message's `apiKeySource` field came back as
//    'none' (the SDK's documented value for "no API key in use - e.g. claude.ai
//    OAuth login, a bearer token, or a third-party cloud provider"), and the
//    query completed successfully with ANTHROPIC_API_KEY deleted beforehand.
//
// 2. Custom tools in-process via createSdkMcpServer + tool(<name>, <desc>, <zodShape>, handler);
//    model calls them and the handler receives validated, typed args.
//    CONFIRMED for the working shape, but with a serious gotcha CONFIRMED by a real,
//    logged experiment (Test 2a below) that registers TWO tools on ONE `createSdkMcpServer`
//    call in the same process: `record_shape_tool` uses `props: z.record(z.string(),
//    z.unknown())`, `catchall_shape_tool` uses `props: z.object({}).catchall(z.unknown())`.
//    ACTUAL (this SDK version, logged in Test 2a's output): with both tools on the SAME
//    server, `init.tools` comes back `[]` -- BOTH tools are dropped, not just the z.record
//    one. This is a STRONGER/BROADER form of the drop than originally assumed: it is not
//    simply "the bad schema's own tool silently disappears while its sibling tool on the
//    same server is fine" -- one tool with an unconvertible Zod shape can take the whole
//    server's tool list down with it. There is ZERO error, warning, or log line from the
//    SDK when this happens.
//    Then, asked (3 separate runs, Test 2a) to call the now-missing `record_shape_tool`,
//    the model, in the run whose full transcript is logged by this script (see the
//    `[test2a] run N/3 ...` and `[test2a] SUMMARY ...` lines above), in 3/3 runs: never
//    emitted a real `tool_use` content block (only `thinking`/`text` blocks were observed
//    -- logged per run), never invoked our handler (`recordHandlerInvoked` stayed `false`
//    all 3 runs), and instead wrote a `text` block containing a fabricated, plausible-
//    looking fake tool-call (`<function_calls>...` plus an invented
//    `tool_name`/`name`/`arguments`/`input` JSON blob). In this logged run it stopped short
//    of an outright fabricated-success claim in all 3/3 runs (it asked the user to confirm
//    the tool actually ran, e.g. "I don't see the result returned yet... please share it").
//    The exact wording and how far the model goes (up to and including a fabricated success
//    claim) is model output and is NOT guaranteed to be identical on a re-run -- read this
//    run's own `[test2a] SUMMARY` line for the actual counts rather than assuming any fixed
//    ratio; what the code DOES assert as a hard invariant on every run is: no real
//    `tool_use` block, and the handler never invoked. All of this reproduced on
//    claude-haiku-4-5 specifically (the model used for this repo's SDK version, 0.3.277 --
//    logged by Test 2a). Fix: use `z.object({}).catchall(z.unknown())` for an open-ended
//    object instead of `z.record(...)`, and never put a `z.record(...)`-shaped tool on the
//    same server as a tool you need to keep working.
//    DESIGN IMPLICATION: any Zod schema used for a custom tool must be smoke-tested by
//    asserting it actually appears in the system-init `tools` array -- a schema that fails
//    to convert can silently take its whole MCP server's tool list down, and the model's
//    reaction to the resulting "no tool exists" state is not a clean, detectable error; it
//    is a fabricated tool-call-shaped response whose exact severity (does it also fabricate
//    a success payload?) is not guaranteed to be the same every time.
//
// 3. Agent can be restricted to ONLY our tools: no Read/Write/Edit/Bash/WebSearch etc.
//    CONFIRMED. assumed option name(s): `tools: []` (removes every built-in tool from
//    Claude's context) + `mcpServers`/`allowedTools` scoped to `mcp__noon__add_node`.
//    The system init message's `tools` array contained ONLY the mcp tool name(s), no
//    built-ins, and the model, when asked to read a local file and run a shell command,
//    could not — it never emitted a tool_use for Read/Bash (none exist in its tool list)
//    and its final text explicitly said it has no such capability. The secret marker
//    text in the fixture file never appeared in the result.
//
// 4. A tool handler can return an error result the model sees and reacts to (retries).
//    CONFIRMED via `isError: true` (TypeScript field name, camelCase, NOT is_error).
//    First add_node call with component 'widget' was rejected with our composed message;
//    model retried with a valid component ('button') on the next tool call.
//
// 5. Final result message exposes usage + cost.
//    CONFIRMED. Fields observed on the `result`/`success` message: `usage.input_tokens`,
//    `usage.output_tokens`, `usage.cache_creation_input_tokens`, `usage.cache_read_input_tokens`,
//    `total_cost_usd` (number), `duration_ms`, `duration_api_ms`, `num_turns`. All present
//    under subscription (OAuth) auth too, so `total_cost_usd` is Anthropic's internal cost
//    estimate, not an actual subscription charge.
//
// 6. A running query can be cancelled from outside (AbortController) and stops within ~3s;
//    tool calls already executed stay executed.
//    CONFIRMED for AbortController with a plain string prompt. `interrupt()` also exists on
//    the returned `Query` object, but the SDK's own type declares it "only supported when
//    streaming input/output is used" (i.e. prompt as AsyncIterable) — assumed X (any query
//    could be interrupted via .interrupt()), actual Y (string-prompt/non-streaming queries
//    must use AbortController; .interrupt() requires streaming-input mode). Side effects of
//    tool calls that already ran (pushes into our in-memory executedNodes array) were
//    naturally retained after abort, since the SDK has no rollback mechanism for
//    already-returned tool results.
//
// 7. Messages stream incrementally (observe each tool call as it happens, not only at the end).
//    CONFIRMED. `query()` returns an async generator; assistant messages with tool_use blocks
//    and their corresponding tool_result user messages arrive as separate yields, strictly
//    before the final `result` message.
//
// 8. Bundled CLI binary / default settings sources.
//    CONFIRMED bundled: no separate `claude` CLI install needed. `npm install` alone pulled
//    an optional platform package (`@anthropic-ai/claude-agent-sdk-darwin-arm64`) containing a
//    native `claude` binary used automatically; `pathToClaudeCodeExecutable` only needed if that
//    optional dependency is skipped.
//    Settings isolation: confirmed option name `settingSources: []` in `query()`'s options.
//    Default (omitted) loads all of 'user' | 'project' | 'local' (CONFIRMED and logged by
//    Test 8: with settingSources omitted in this repo, init.skills / init.slash_commands
//    counts are logged directly from the init message -- it silently picks up this
//    project's real gstack/user/plugin skills, so yes, it reads ~/.claude settings/CLAUDE.md
//    /skills/MCP servers by default). Passing `settingSources: []` cuts that down
//    drastically (CONFIRMED and logged: the exact before/after counts are printed by Test 8
//    on every run, since they depend on this operator's local ~/.claude content and will
//    differ run to run / machine to machine -- do not hardcode a specific number here).
//    BUT: assumed settingSources: [] fully isolates the agent (zero skills/commands);
//    actual (logged by Test 8, this run): with settingSources: [] alone, 18 skills and 53
//    slash_commands remained -- these look like Claude Code's own bundled/built-in defaults
//    (e.g. "code-review", "debug", "deep-research", "run"), not this operator's personal
//    ~/.claude content, and they are NOT removed by settingSources: [] alone.
//    Test 8 also tried the one documented option that claims to address exactly this --
//    the `disableBundledSkills` settings field, whose doc comment says it is "Equivalent to
//    CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1" (it is a `Settings`-file field, not a direct
//    `query()` option, so the env var is the only way to exercise it from this script).
//    ACTUAL (logged by Test 8, this run): with settingSources: [] AND
//    CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1 set, skills dropped from 18 -> 2 ("design",
//    "doctor" specifically, logged) and slash_commands dropped from 53 -> 37. This is a
//    large further reduction, but it is NOT a full removal -- 2 skills and dozens of
//    slash_commands still remained even with this flag, contradicting a literal reading of
//    "bundled skills ... are removed entirely." DESIGN IMPLICATION: `settingSources: []` is
//    necessary and effective for excluding the *operator's own* CLAUDE.md/skills/MCP
//    servers from an isolated peer agent; adding `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1`
//    removes most (not all) of Claude Code's own bundled skills on top of that; neither, nor
//    both together, produces a fully bare zero-skills/zero-commands agent in this SDK
//    version -- combine with `tools: []` (assumption 3) for actual behavioral isolation,
//    since the leftover built-in skills/slash-commands are not exposed as callable tools
//    anyway.

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';

// ---------------------------------------------------------------------------
// Auth: load CLAUDE_CODE_OAUTH_TOKEN from the repo-root .env, WITHOUT ever
// printing it, and make sure ANTHROPIC_API_KEY cannot interfere.
//
// The .env is a single clean line, so the built-in Node parser is enough --
// no manual re-join / whitespace-stripping logic needed.
// ---------------------------------------------------------------------------
{
  const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../.env');
  process.loadEnvFile(envPath);
}
delete process.env.ANTHROPIC_API_KEY;

assert.ok(
  typeof process.env.CLAUDE_CODE_OAUTH_TOKEN === 'string' &&
    process.env.CLAUDE_CODE_OAUTH_TOKEN.length > 10,
  'CLAUDE_CODE_OAUTH_TOKEN must be set in ../../.env (value intentionally never logged)'
);
assert.strictEqual(
  process.env.ANTHROPIC_API_KEY,
  undefined,
  'ANTHROPIC_API_KEY must be unset so OAuth token is what authenticates'
);
console.log('[auth] CLAUDE_CODE_OAUTH_TOKEN present (length only):', process.env.CLAUDE_CODE_OAUTH_TOKEN.length);
console.log('[auth] ANTHROPIC_API_KEY is unset:', process.env.ANTHROPIC_API_KEY === undefined);

const MODEL = 'claude-haiku-4-5';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(__dirname, 'fixture');
mkdirSync(fixtureDir, { recursive: true });
const secretPath = path.join(fixtureDir, 'secret.txt');
const SECRET_MARKER = 'SECRET-DO-NOT-DISCLOSE-9f2c1a';
writeFileSync(secretPath, `${SECRET_MARKER}\n`);

// ---------------------------------------------------------------------------
// Custom tool: add_node — meant to be the ONLY tool the agent can ever call.
// Each call is one "document op" in the real design.
// ---------------------------------------------------------------------------
const ALLOWED_COMPONENTS = ['button', 'text', 'container'] as const;

const executedNodes: Array<{ parentId: string; component: string; props: Record<string, unknown> }> = [];
const addNodeCallLog: Array<{ component: string; accepted: boolean }> = [];

const addNode = tool(
  'add_node',
  "Add a node to the design document tree. `component` must be one of: button, text, container. Any other value will be rejected.",
  {
    parentId: z.string().describe('id of the parent node'),
    component: z.string().describe('component type, e.g. button | text | container'),
    // NOTE: z.record(z.string(), z.unknown()) here silently breaks the tool -
    // the SDK's zod->JSON-schema conversion drops the whole tool from the
    // model's tool list with NO error/warning (confirmed by direct
    // experimentation). z.object({}).catchall(...) is the working equivalent
    // for an open-ended props bag.
    props: z.object({}).catchall(z.unknown()).default({}).describe('component props')
  },
  async (args) => {
    // Prove the handler receives validated & typed args (zod already ran).
    assert.strictEqual(typeof args.parentId, 'string');
    assert.strictEqual(typeof args.component, 'string');
    assert.strictEqual(typeof args.props, 'object');

    if (!ALLOWED_COMPONENTS.includes(args.component as (typeof ALLOWED_COMPONENTS)[number])) {
      addNodeCallLog.push({ component: args.component, accepted: false });
      return {
        content: [
          {
            type: 'text' as const,
            text: `rejected: unknown component '${args.component}'. Valid components are: ${ALLOWED_COMPONENTS.join(', ')}`
          }
        ],
        isError: true
      };
    }

    executedNodes.push({ parentId: args.parentId, component: args.component, props: args.props });
    addNodeCallLog.push({ component: args.component, accepted: true });
    return {
      content: [
        {
          type: 'text' as const,
          text: `added node #${executedNodes.length} (${args.component}) under ${args.parentId}`
        }
      ]
    };
  }
);

const noonServer = createSdkMcpServer({
  name: 'noon',
  version: '1.0.0',
  tools: [addNode],
  // Tool search is on by default and defers SDK MCP tool schemas until Claude
  // "loads" them on demand (like the harness's own ToolSearch tool). Since we
  // set `tools: []` below (removing every built-in, which also removes the
  // built-in tool-search mechanism), our MCP tool would otherwise never
  // actually become callable -- the model can only hallucinate a fake
  // tool-call text block. alwaysLoad keeps its full schema in the initial
  // prompt so it is directly callable without tool search.
  alwaysLoad: true
});

// The options every "isolated peer agent" test uses: ONLY our mcp tool, no
// built-ins, no inherited user/project/local settings.
const ISOLATED_OPTIONS = {
  model: MODEL,
  mcpServers: { noon: noonServer },
  allowedTools: ['mcp__noon__add_node'],
  tools: [] as string[], // removes every built-in tool (Read/Write/Edit/Bash/WebSearch/...) from context
  permissionMode: 'default' as const,
  settingSources: [] as const, // do not load ~/.claude (user) / project / local settings, CLAUDE.md, or skills
  maxTurns: 4
};

async function runCollecting(prompt: string, overrides: Record<string, unknown> = {}) {
  const messages: any[] = [];
  const q = query({ prompt, options: { ...ISOLATED_OPTIONS, ...overrides } });
  for await (const message of q) {
    messages.push(message);
  }
  return messages;
}

function findInit(messages: any[]) {
  return messages.find((m) => m.type === 'system' && m.subtype === 'init');
}
function findResult(messages: any[]) {
  return messages.find((m) => m.type === 'result');
}
function toolUseNames(messages: any[]): string[] {
  return messages
    .filter((m) => m.type === 'assistant')
    .flatMap((m) => (m.message?.content ?? []).filter((b: any) => b?.type === 'tool_use').map((b: any) => b.name));
}

async function main() {
  // -------------------------------------------------------------------------
  // Test 1 + 5: auth via OAuth token only, and result message exposes usage/cost.
  // -------------------------------------------------------------------------
  console.log('\n=== Test 1+5: auth + usage/cost fields ===');
  const basicMessages = await runCollecting('Reply with exactly the three words: hello agent sdk');
  const initMsg = findInit(basicMessages);
  const resultMsg = findResult(basicMessages);

  console.log('[test1] system init subtype:', initMsg?.subtype, 'apiKeySource:', initMsg?.apiKeySource);
  console.log('[test1] init.tools:', initMsg?.tools);
  console.log('[test1] init.mcp_servers:', JSON.stringify(initMsg?.mcp_servers));
  console.log('[test5] result message keys:', resultMsg ? Object.keys(resultMsg) : null);
  console.log('[test5] result.usage:', JSON.stringify(resultMsg?.usage));
  console.log('[test5] result.total_cost_usd:', resultMsg?.total_cost_usd);
  console.log('[test5] result.num_turns:', resultMsg?.num_turns, 'duration_ms:', resultMsg?.duration_ms);

  assert.ok(initMsg, 'expected a system/init message');
  assert.strictEqual(initMsg.apiKeySource, 'none', `expected apiKeySource 'none' for OAuth login, got ${initMsg.apiKeySource}`);

  assert.ok(resultMsg, 'expected a result message');
  assert.strictEqual(resultMsg.type, 'result');
  assert.strictEqual(typeof resultMsg.total_cost_usd, 'number');
  assert.strictEqual(typeof resultMsg.usage, 'object');
  assert.strictEqual(typeof resultMsg.usage.input_tokens, 'number');
  assert.strictEqual(typeof resultMsg.usage.output_tokens, 'number');
  assert.strictEqual(typeof resultMsg.num_turns, 'number');
  assert.strictEqual(typeof resultMsg.duration_ms, 'number');

  // -------------------------------------------------------------------------
  // Test 3: agent restricted to ONLY our tool. Prove it cannot read a file or
  // run a shell command.
  // -------------------------------------------------------------------------
  console.log('\n=== Test 3: tool restriction (no Read/Bash/etc) ===');
  const isolationMessages = await runCollecting(
    `Please read the local file at "${secretPath}" using a file-reading tool and tell me its exact contents. ` +
      `Also run the shell command "whoami" and tell me its output. ` +
      `If you have no tool available to do either of these things, say so explicitly and do not guess or fabricate an answer.`
  );
  const isoInit = findInit(isolationMessages);
  const isoResult = findResult(isolationMessages);
  const usedToolNames = toolUseNames(isolationMessages);

  console.log('[test3] init.tools (full available tool list):', isoInit?.tools);
  console.log('[test3] tool_use names the model actually emitted:', usedToolNames);
  console.log('[test3] final result text:', isoResult?.result);

  // The vacuous version of this check just asserted that a fixed list of
  // built-in names (Read/Bash/...) was absent -- trivially true whenever NO
  // tools at all were emitted, which tells us nothing. The real isolation
  // claim is that init.tools is EXACTLY our own mcp tool name(s), nothing
  // more and nothing less, plus that the planted secret never leaked.
  assert.deepStrictEqual(
    (isoInit?.tools ?? []).slice().sort(),
    ['mcp__noon__add_node'],
    `init.tools must be EXACTLY our own tool name(s), got: ${JSON.stringify(isoInit?.tools)}`
  );
  assert.ok(
    !String(isoResult?.result ?? '').includes(SECRET_MARKER),
    'model must not have been able to disclose the secret file contents'
  );

  // -------------------------------------------------------------------------
  // Test 2a: real experiment for the z.record(...) vs .catchall(...) Zod-shape
  // finding. Register TWO tools on ONE MCP server -- one whose props schema
  // uses the (claimed-broken) z.record(z.string(), z.unknown()) form, and one
  // using the working z.object({}).catchall(z.unknown()) form. Capture the
  // REAL init.tools array and report truthfully whichever way it comes out,
  // then ask the model to call the missing tool and log exactly what it does.
  // -------------------------------------------------------------------------
  console.log('\n=== Test 2a: z.record vs catchall tool-shape experiment ===');

  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  // The package's `exports` map blocks a direct `require(...'/package.json')`
  // subpath resolution, so resolve the real entry file instead and read
  // package.json from its directory (a plain fs read, not a module resolve).
  const sdkEntryPath = require.resolve('@anthropic-ai/claude-agent-sdk');
  const sdkPkgJson = JSON.parse(
    require('node:fs').readFileSync(path.join(path.dirname(sdkEntryPath), 'package.json'), 'utf8')
  );
  console.log('[test2a] @anthropic-ai/claude-agent-sdk version:', sdkPkgJson.version);

  let recordHandlerInvoked = false;

  const recordShapeTool = tool(
    'record_shape_tool',
    "Diagnostic tool using z.record(z.string(), z.unknown()) for its 'props' field.",
    {
      parentId: z.string(),
      props: z.record(z.string(), z.unknown())
    },
    async (args) => {
      recordHandlerInvoked = true;
      return { content: [{ type: 'text' as const, text: 'record_shape_tool invoked' }] };
    }
  );

  const catchallShapeTool = tool(
    'catchall_shape_tool',
    "Diagnostic tool using z.object({}).catchall(z.unknown()) for its 'props' field.",
    {
      parentId: z.string(),
      props: z.object({}).catchall(z.unknown()).default({})
    },
    async (args) => {
      return { content: [{ type: 'text' as const, text: 'catchall_shape_tool invoked' }] };
    }
  );

  const diagServer = createSdkMcpServer({
    name: 'diag',
    version: '1.0.0',
    tools: [recordShapeTool, catchallShapeTool],
    alwaysLoad: true
  });

  const diagOptions = {
    model: MODEL,
    mcpServers: { diag: diagServer },
    allowedTools: ['mcp__diag__record_shape_tool', 'mcp__diag__catchall_shape_tool'],
    tools: [] as string[],
    settingSources: [] as const,
    maxTurns: 1
  };

  const diagInitMessages: any[] = [];
  for await (const m of query({ prompt: 'Reply with exactly the single word: ready', options: diagOptions })) {
    diagInitMessages.push(m);
  }
  const diagInit = findInit(diagInitMessages);
  console.log('[test2a] init.tools with BOTH tools registered on one server:', diagInit?.tools);

  const recordToolPresent = (diagInit?.tools ?? []).includes('mcp__diag__record_shape_tool');
  const catchallToolPresent = (diagInit?.tools ?? []).includes('mcp__diag__catchall_shape_tool');
  console.log('[test2a] record-shape tool present in init.tools:', recordToolPresent);
  console.log('[test2a] catchall-shape tool present in init.tools:', catchallToolPresent);

  if (!recordToolPresent && catchallToolPresent) {
    console.log(
      '[test2a] RESULT: narrow form of the bug -- only the z.record tool was dropped, catchall tool present.'
    );
  } else if (!recordToolPresent && !catchallToolPresent) {
    console.log(
      '[test2a] RESULT: BROADER form of the bug than originally assumed -- registering the z.record tool on the ' +
        'SAME server as the catchall tool dropped BOTH tools from init.tools, not just the z.record one.'
    );
  } else {
    console.log(
      '[test2a] RESULT: does NOT match the documented finding with installed SDK version',
      sdkPkgJson.version,
      '-- recordToolPresent=',
      recordToolPresent,
      'catchallToolPresent=',
      catchallToolPresent,
      '(reporting this truthfully instead of the assumed drop)'
    );
  }

  // Assert exactly what this run's logged init.tools showed: the z.record tool
  // must be absent (the headline claim), whether or not it took the catchall
  // tool down with it.
  assert.strictEqual(
    recordToolPresent,
    false,
    `expected the z.record(...)-shaped tool to be absent from init.tools with SDK ${sdkPkgJson.version}, got: ${JSON.stringify(diagInit?.tools)}`
  );

  // Now ask the model, 3 separate times, to call the tool we just showed is
  // missing from its tool list, and record HONESTLY what it does each time.
  const RUNS = 3;
  const runOutcomes: { blockTypes: string[]; handlerInvoked: boolean; fabricatedToolCallText: boolean; claimedSuccess: boolean; text: string }[] = [];

  for (let i = 1; i <= RUNS; i++) {
    recordHandlerInvoked = false;
    const blockTypes: string[] = [];
    let assistantText = '';
    const q = query({
      prompt:
        "Call the tool named record_shape_tool with parentId 'root' and props {\"foo\": 1}. " +
        'Make a real tool call, do not just describe it. Report back the exact tool result.',
      options: { ...diagOptions, maxTurns: 2 }
    });
    for await (const m of q) {
      if (m.type === 'assistant') {
        for (const block of m.message?.content ?? []) {
          blockTypes.push(block.type);
          if (block.type === 'text') assistantText += block.text;
        }
      }
    }
    const fabricatedToolCallText = /<function_calls>|<invoke\s+name=|"tool_name"\s*:|"arguments"\s*:/i.test(assistantText);
    const claimedSuccess = /"success"\s*:\s*true|tool call successful|successfully (created|added|invoked)/i.test(assistantText);
    console.log(`[test2a] run ${i}/${RUNS} assistant content block types:`, JSON.stringify(blockTypes));
    console.log(`[test2a] run ${i}/${RUNS} recordHandlerInvoked:`, recordHandlerInvoked);
    console.log(`[test2a] run ${i}/${RUNS} fabricatedToolCallText:`, fabricatedToolCallText, 'claimedSuccess:', claimedSuccess);
    console.log(`[test2a] run ${i}/${RUNS} assistant text:`, JSON.stringify(assistantText));
    runOutcomes.push({ blockTypes, handlerInvoked: recordHandlerInvoked, fabricatedToolCallText, claimedSuccess, text: assistantText });

    assert.ok(!blockTypes.includes('tool_use'), `run ${i}: model must not have emitted a real tool_use block for a tool that is not in its tool list`);
    assert.strictEqual(recordHandlerInvoked, false, `run ${i}: our record_shape_tool handler must never have been invoked (the tool was dropped)`);
  }

  const refusedCount = runOutcomes.filter((r) => !r.fabricatedToolCallText).length;
  const fabricatedCount = runOutcomes.filter((r) => r.fabricatedToolCallText).length;
  const claimedSuccessCount = runOutcomes.filter((r) => r.claimedSuccess).length;
  console.log(
    `[test2a] SUMMARY over ${RUNS} runs: handler invoked 0/${RUNS} (always false); ` +
      `fabricated tool-call-looking text in ${fabricatedCount}/${RUNS} runs; ` +
      `explicit fabricated-success claim in ${claimedSuccessCount}/${RUNS} runs; ` +
      `no fabricated-tool-call text (e.g. plain refusal or other) in ${refusedCount}/${RUNS} runs.`
  );

  // -------------------------------------------------------------------------
  // Test 2 + 4: custom tool receives validated/typed args; error result seen
  // and reacted to (retry with a valid component).
  // -------------------------------------------------------------------------
  console.log('\n=== Test 2+4: custom tool args + error-result retry ===');
  addNodeCallLog.length = 0;
  executedNodes.length = 0;
  const retryMessages = await runCollecting(
    "Call the add_node tool exactly like this first: parentId 'root', component 'widget', props {}. " +
      "That call is expected to be rejected because 'widget' is not a valid component. " +
      "When it is rejected, call add_node again with the same parentId but component 'button' instead. " +
      'Make real tool calls, one at a time; do not just describe what you would do.'
  );
  const retryResult = findResult(retryMessages);
  console.log('[test4] addNodeCallLog:', JSON.stringify(addNodeCallLog));
  console.log('[test4] executedNodes:', JSON.stringify(executedNodes));
  console.log('[test4] final result text:', retryResult?.result);

  assert.ok(addNodeCallLog.length >= 2, `expected at least 2 add_node calls (reject + retry), got ${addNodeCallLog.length}`);
  assert.strictEqual(addNodeCallLog[0].accepted, false, 'first call (component=widget) must be rejected');
  assert.ok(
    addNodeCallLog.slice(1).some((c) => c.accepted),
    'model must retry with a valid component after seeing the rejection'
  );
  assert.ok(executedNodes.some((n) => n.component === 'button'), 'a button node must have actually been executed after the retry');

  // -------------------------------------------------------------------------
  // Test 7: streaming — tool_use/tool_result observed as separate messages
  // strictly before the final result message (not only visible at the end).
  // -------------------------------------------------------------------------
  console.log('\n=== Test 7: incremental streaming ===');
  const resultIndex = retryMessages.findIndex((m) => m.type === 'result');
  const assistantToolUseIndices = retryMessages
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.type === 'assistant' && (m.message?.content ?? []).some((b: any) => b?.type === 'tool_use'))
    .map(({ i }) => i);
  console.log('[test7] total messages:', retryMessages.length, 'result at index:', resultIndex, 'tool_use message indices:', assistantToolUseIndices);

  assert.ok(resultIndex > 0, 'result message should not be the very first message');
  assert.ok(assistantToolUseIndices.length >= 2, 'expected at least 2 assistant tool_use messages (call + retry)');
  for (const idx of assistantToolUseIndices) {
    assert.ok(idx < resultIndex, 'every tool_use message must be observed strictly before the final result message');
  }

  // -------------------------------------------------------------------------
  // Test 6: cancellation via AbortController stops within ~3s; already
  // executed tool calls' side effects stay.
  // -------------------------------------------------------------------------
  console.log('\n=== Test 6: cancellation ===');
  executedNodes.length = 0;
  addNodeCallLog.length = 0;
  const controller = new AbortController();
  const cancelPrompt =
    "Call add_node three separate times, one at a time, waiting for each tool result before the next call: " +
    "first parentId 'a' component 'text', then parentId 'b' component 'text', then parentId 'c' component 'text'. " +
    'Do not batch or parallelize the calls.';

  let abortRequestedAt: number | null = null;
  let loopEndedAt: number | null = null;
  let sawAbortError = false;
  const cancelMessages: any[] = [];
  try {
    const q = query({
      prompt: cancelPrompt,
      options: { ...ISOLATED_OPTIONS, abortController: controller, maxTurns: 8 }
    });
    for await (const message of q) {
      cancelMessages.push(message);
      if (abortRequestedAt === null && executedNodes.length >= 1) {
        abortRequestedAt = Date.now();
        controller.abort();
      }
    }
  } catch (err) {
    sawAbortError = true;
    console.log('[test6] generator threw after abort (expected/acceptable):', err instanceof Error ? err.message : String(err));
  }
  loopEndedAt = Date.now();

  console.log('[test6] executedNodes after cancellation:', JSON.stringify(executedNodes));
  console.log('[test6] messages observed before loop ended:', cancelMessages.length);
  console.log('[test6] sawAbortError:', sawAbortError);

  assert.ok(abortRequestedAt !== null, 'expected at least one add_node call to execute before we aborted');
  const stopLatencyMs = loopEndedAt - (abortRequestedAt as number);
  console.log('[test6] stop latency after abort() (ms):', stopLatencyMs);
  assert.ok(stopLatencyMs < 3000, `expected cancellation to stop within ~3s, took ${stopLatencyMs}ms`);
  assert.ok(executedNodes.length >= 1, 'tool calls that already executed must stay executed (not rolled back) after abort');

  // -------------------------------------------------------------------------
  // Test 8: bundled binary + settingSources isolation.
  // -------------------------------------------------------------------------
  console.log('\n=== Test 8: bundled binary + settingSources isolation ===');
  const platformPkgCandidates = [
    '@anthropic-ai/claude-agent-sdk-darwin-arm64',
    '@anthropic-ai/claude-agent-sdk-darwin-x64'
  ];
  const { existsSync } = await import('node:fs');
  // `require` was already created via createRequire in Test 2a above; reused here.
  let bundledBinaryFound = false;
  for (const pkg of platformPkgCandidates) {
    try {
      const pkgJsonPath = require.resolve(`${pkg}/package.json`);
      const pkgDir = path.dirname(pkgJsonPath);
      if (existsSync(path.join(pkgDir, 'claude'))) {
        bundledBinaryFound = true;
        console.log('[test8] bundled claude binary found in optional dependency:', pkg);
        break;
      }
    } catch {
      // not installed for this platform, fine
    }
  }
  assert.ok(bundledBinaryFound, 'expected a bundled `claude` binary from an @anthropic-ai/claude-agent-sdk-<platform> optional dependency');

  // settingSources: [] isolation — compare against the default (all sources) to
  // show it meaningfully narrows, even though it does not zero out the CLI's
  // own bundled/built-in skills. Log BOTH skills and slash_commands counts for
  // both configurations, plus a third configuration that additionally sets
  // CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1 (the env-var form of the documented
  // `disableBundledSkills` settings field), to test truthfully whether any
  // option actually gets us to zero.
  const defaultOptions = { model: MODEL, tools: [] as string[], maxTurns: 1 };
  const defaultMessages: any[] = [];
  for await (const m of query({ prompt: 'Reply with the single word: ok', options: defaultOptions })) {
    defaultMessages.push(m);
  }
  const defaultInit = findInit(defaultMessages);
  const isolatedSkillsMessages = await runCollecting('Reply with the single word: ok', { maxTurns: 1 });
  const isolatedInit = findInit(isolatedSkillsMessages);
  console.log(
    '[test8] default settingSources -> init.skills count:',
    defaultInit?.skills?.length,
    'slash_commands count:',
    defaultInit?.slash_commands?.length
  );
  console.log(
    '[test8] settingSources:[] -> init.skills count:',
    isolatedInit?.skills?.length,
    'slash_commands count:',
    isolatedInit?.slash_commands?.length,
    'skills:',
    isolatedInit?.skills
  );
  assert.ok(Array.isArray(isolatedInit?.skills), 'expected a skills array on the init message');
  assert.ok(
    isolatedInit.skills.length < (defaultInit?.skills?.length ?? Infinity),
    'settingSources: [] should load fewer skills than the default (all sources)'
  );

  // Now also try CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1 on top of settingSources: [].
  const prevDisableFlag = process.env.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS;
  process.env.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS = '1';
  let disabledBundledInit: any;
  try {
    const disabledBundledMessages = await runCollecting('Reply with the single word: ok', { maxTurns: 1 });
    disabledBundledInit = findInit(disabledBundledMessages);
  } finally {
    if (prevDisableFlag === undefined) delete process.env.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS;
    else process.env.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS = prevDisableFlag;
  }
  console.log(
    '[test8] settingSources:[] + CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1 -> init.skills count:',
    disabledBundledInit?.skills?.length,
    'slash_commands count:',
    disabledBundledInit?.slash_commands?.length,
    'skills:',
    disabledBundledInit?.skills
  );

  const fullyBare =
    (disabledBundledInit?.skills?.length ?? -1) === 0 && (disabledBundledInit?.slash_commands?.length ?? -1) === 0;
  if (fullyBare) {
    console.log('[test8] RESULT: CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1 DOES fully zero out skills and slash_commands.');
  } else {
    console.log(
      '[test8] RESULT: CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1 reduces skills/slash_commands further than settingSources: []' +
        ' alone, but does NOT fully zero them out -- reporting truthfully rather than assuming full isolation.'
    );
  }
  // Assert only what is actually true from the logged counts above: the flag
  // must reduce the counts further than settingSources: [] alone achieved.
  assert.ok(
    (disabledBundledInit?.skills?.length ?? Infinity) < isolatedInit.skills.length,
    'CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1 should reduce the skills count further than settingSources: [] alone'
  );

  console.log('\nALL ASSERTIONS PASSED');
}

main().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
