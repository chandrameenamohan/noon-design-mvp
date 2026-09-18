// FINDINGS (after running against typescript@6.0.3 on Node 24.17, fixture in ./fixture/):
//
// 1. ts.createProgram + getTypeChecker() DOES resolve exported components' props to a flat
//    {name, optional, type} list through aliases, Omit<>, intersections and imported types.
//    CONFIRMED. checker.getTypeAtLocation(propsParam) followed by
//    checker.getPropertiesOfType(propsType) works uniformly whether the props type is a
//    plain interface (Stack, Image), an interface with a prop typed via an imported alias
//    (Card.size: Size from ./types.ts -> resolved to its literal members ['sm','md','lg']),
//    or `Omit<TextStyleProps,'muted'> & TextOwnProps` (Text -> resolved to exactly
//    ['bold','value','variant'], with 'muted' correctly gone and 'variant' correctly
//    still required). The AST alone (no checker) could not have done any of this — Omit<>
//    and imported aliases are only resolvable through the type system.
//
// 2. String-literal unions read as a member list: CONFIRMED — checking `type.isUnion()`
//    and `t.isStringLiteral()` per member gives the literal `.value` for each
//    (Stack.direction -> ['row','column'], Button.variant -> ['primary','ghost']).
//    boolean must be special-cased: CONFIRMED, and the exact shape matters — a `boolean`
//    prop's raw type (via getTypeOfSymbolAtLocation) is a union whose non-undefined
//    constituents are TWO `TypeFlags.BooleanLiteral` members (verified by reading raw
//    `type.flags` on each constituent, for BOTH a REQUIRED boolean prop, Card.bordered --
//    added specifically to exercise this case -- and an OPTIONAL one, Button.disabled):
//    Card.bordered (required) -> `type.isUnion()` true, constituents exactly
//    `[BooleanLiteral, BooleanLiteral]`; Button.disabled (optional) -> `type.isUnion()`
//    true, constituents exactly `[Undefined, BooleanLiteral, BooleanLiteral]`. So TS does
//    NOT hand back a single opaque "boolean" type at the raw-type level even for a REQUIRED
//    boolean prop — it is a union of the two literal members `true`/`false` either way; only
//    an OPTIONAL boolean additionally has `undefined` mixed into that same union.
//    A previous version of this finding claimed "checker.typeToString() happens to collapse
//    the two BooleanLiteral members back to the word boolean for display" -- but the
//    describePropType() code below does NOT reach checker.typeToString() on this path at
//    all: `isBooleanUnion` is detected and a hardcoded `'boolean'` string is returned via an
//    early `return`, before typeToString is ever called. That specific claim was therefore
//    untested by the code that made it. We now call `checker.typeToString()` directly (not
//    through describePropType) on the raw types above and it IS real and CONFIRMED, just
//    previously unverified: `checker.typeToString(cardBorderedType)` (required) ->
//    `'boolean'`; `checker.typeToString(buttonDisabledType)` (optional) ->
//    `'boolean | undefined'` (typeToString collapses the two BooleanLiteral constituents to
//    the word "boolean" but still shows the surviving `| undefined` from the outer union).
//    The special-casing in describePropType is kept (it is simpler and cheaper than parsing
//    typeToString's string output), but is now described accurately: it is an independent
//    hardcoded shortcut for a pattern that happens to produce the same display string
//    typeToString would produce anyway, not a workaround for something typeToString gets
//    wrong. The rule that worked: if a union (after removing an `undefined` constituent)
//    has exactly 2 members and both are `TypeFlags.BooleanLiteral`, treat it as `boolean`.
//    Optional props DO include `undefined` in the type returned by
//    `getTypeOfSymbolAtLocation`: CONFIRMED for Button.variant?/disabled?/Stack.gap? (all
//    optional -> includesUndefined true) vs Stack.direction/Text.variant/Card.bordered
//    (required -> includesUndefined false). Caveat found beyond the assumption:
//    `includesUndefined` is NOT a reliable proxy for "is this prop optional" in general —
//    `children: React.ReactNode` is a REQUIRED prop on Stack/Button, yet its type is a big
//    union that itself contains `undefined` as one of ReactNode's own members, so
//    includesUndefined=true even though optional=false. Use the `optional` flag
//    (SymbolFlags.Optional) for optionality, not "does the type mention undefined".
//
// 3. Destructuring defaults are NOT visible in the checker's type: CONFIRMED. The type for
//    Button's `variant` is just `'primary' | 'ghost' | undefined` — nothing marks 'primary'
//    as the default. Defaults were extracted with a plain AST walk over the function's
//    first parameter (`ts.isObjectBindingPattern(param.name)`, then each `BindingElement`'s
//    `.initializer.getText()`), giving Button -> {variant:"'primary'", disabled:'false'},
//    Card -> {size:"'md'", elevated:'false'}, Image -> {alt:"''"}, Stack -> {gap:'8'},
//    Text -> {bold:'false'}. Confirms the design needs BOTH passes: checker for the type
//    shape, AST walk for defaults — they are genuinely disjoint pieces of information.
//
// 4. React.ComponentProps<'button'> explodes as assumed: CONFIRMED, 291 properties on
//    Input's raw props type (checker.getPropertiesOfType before filtering). Filtering by
//    declaration source file (`symbol.declarations[0].getSourceFile().fileName` must be
//    under the design-system's own fixture directory, not under node_modules/@types/react
//    or a TS lib file) brought it down to exactly 1 prop: `label` (the DS's own addition).
//    This is a viable, simple rule for keeping the manifest small; it is a per-PROPERTY
//    filter (not per-component), since a component like Input mixes its own declared props
//    with hundreds of inherited ones on the very same synthesized type.
//
// 5. The manifest serializes to stable JSON via a recursive sort-keys-then-JSON.stringify:
//    CONFIRMED byte-identical (3537 chars, identical string) across two fully independent
//    `ts.createProgram` runs. This is a valid basis for a `git diff --exit-code` drift
//    check, PROVIDED property order inside arrays (e.g. the `props` list) is itself sorted
//    deterministically before serializing (plain key-sort of an object does not sort
//    array elements) — this script sorts `props` by name explicitly for that reason.
//
// 6. Timing for this 8-file fixture (Stack/Card/Button/Text/Image/Input/types/index.ts +
//    @types/react pulled in transitively): RE-MEASURED (the earlier band was stated as an
//    assumption/guess, not from actually timing this exact script) across 3 separate fresh
//    `node test.ts` process runs, reading the `First/Second/Third extraction` lines this
//    script itself prints for Assumption 6, below: first (cold-process) `ts.createProgram`
//    ranged ~339-363ms across the 3 runs; the second and third (independent, but same-
//    process, so with node module cache / OS file cache warm) `createProgram` calls ranged
//    ~165-199ms each. These are the actual measured numbers this run of the script printed
//    (see the `First/Second/Third extraction` log lines below) — every run still builds a
//    fresh Program+Checker, no incremental reuse attempted. For a real design system with
//    many more files this cost matters; a real implementation should look at
//    `ts.createIncrementalProgram` or a long-lived language service if extraction runs
//    on every keystroke/save rather than as a one-shot CLI/CI step.
//
// 7. PARSE BACK via `ts.createSourceFile(..., ScriptKind.TSX)` with NO checker: CONFIRMED
//    works cleanly for the exact fixed shape in the spec — walking JsxElement /
//    JsxSelfClosingElement gives tag names and JsxAttribute values (string literals
//    directly, numeric/boolean via `JsxExpression.expression`). "No longer fits the shape"
//    detectors, each independently isolated and confirmed to fire with exactly one reason
//    (except the last, which legitimately produces two related reasons from one root
//    cause): non-literal prop expression (`gap={8*2}`) -> flagged by checking the
//    JsxExpression's inner expression against a literal whitelist (string/number/boolean/
//    negative-number) and reporting anything else; a spread attribute
//    (`{...{title:'Order'}}`) -> `ts.isJsxSpreadAttribute`; a `&&` conditional child ->
//    `ts.isBinaryExpression` with `&&` operator; a `.map()` child -> `ts.isCallExpression`
//    whose callee is a PropertyAccessExpression named `map`; an extra statement/hook in the
//    function body -> `body.statements.length !== 1`; a second top-level export -> more than
//    one exported FunctionDeclaration at the source-file's top level. All six flagged
//    correctly with human-readable reasons; the "happy path" from the spec parsed to the
//    exact expected {Stack{Card{Text}}} tree with correct prop values and types.
//
// 8. Stable node identity, `data-node-id="..."` attribute vs. a `{/* node:id */}` JSX
//    comment: CONFIRMED the attribute wins. Both markers survive Prettier formatting
//    verbatim (Prettier drops neither attributes nor comments). The difference shows up
//    under a realistic manual edit (an engineer inserting a new sibling element without
//    knowing about the id convention): the `data-node-id` attribute is bound to its own
//    JSX tag, so it keeps identifying the correct element with zero extra work. The
//    `{/* node:id */}` comment is just another child in the same children array as the
//    elements it's meant to label — its meaning depends entirely on an unenforced
//    "immediately precedes its target" convention, and inserting a sibling before the
//    intended target silently re-associates the comment with the WRONG element (confirmed:
//    after the edit, "node:n2" now precedes the newly-inserted `<Text value="inserted!">`,
//    not the original `<Text value="2 items">` it used to label). Design implication:
//    embed node ids as attributes on the element itself, not as sibling comments.
//
// Design implications for our manifest/parse-back design: (a) always run BOTH a checker
// pass (types, unions, Omit/intersection/imported-alias resolution) and a raw AST pass
// (destructuring defaults) — one cannot substitute for the other; (b) filter manifest
// props by declaration source file to avoid hundreds of inherited DOM props leaking in
// from React.ComponentProps<'button'>-style props; (c) treat SymbolFlags.Optional, not
// "type includes undefined", as the source of truth for optionality; (d) the parse-back
// "fixed shape" detector is a real, cheap, checker-free AST walk and can reliably flag
// drift/non-conformance with specific reasons; (e) use `data-node-id` attributes, not JSX
// comments, for stable node identity that survives manual edits.

import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import * as prettier from 'prettier';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(__dirname, 'fixture');

function log(...args: unknown[]) {
  console.log(...args);
}

// ---------------------------------------------------------------------------
// EXTRACTION: fixture design system -> manifest via ts.createProgram + checker
// ---------------------------------------------------------------------------

const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  jsx: ts.JsxEmit.ReactJSX,
  strict: true,
  esModuleInterop: true,
  skipLibCheck: true,
  types: ['react'],
};

function fixtureRootNames(): string[] {
  return fs
    .readdirSync(fixtureDir)
    .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
    .map((f) => path.join(fixtureDir, f));
}

type PropDescriptor = {
  name: string;
  optional: boolean;
  type: string;
  literalValues?: (string | number | boolean)[];
  isBooleanLike: boolean;
  includesUndefined: boolean;
  declaredIn: string; // relative path of the declaring source file
};

type ComponentDescriptor = {
  name: string;
  file: string;
  propsCount: number;
  propsCountFilteredToDesignSystem: number;
  props: PropDescriptor[];
  defaults: { prop: string; defaultText: string }[];
};

function relFixture(p: string): string {
  return path.relative(fixtureDir, p) || p;
}

function describePropType(type: ts.Type, checker: ts.TypeChecker) {
  let includesUndefined = false;
  let working = type;

  if (working.isUnion()) {
    const nonUndef = working.types.filter((t) => (t.flags & ts.TypeFlags.Undefined) === 0);
    if (nonUndef.length !== working.types.length) includesUndefined = true;

    if (nonUndef.length === 1) {
      working = nonUndef[0];
    } else if (nonUndef.length > 1) {
      const isBooleanUnion =
        nonUndef.length === 2 && nonUndef.every((t) => (t.flags & ts.TypeFlags.BooleanLiteral) !== 0);
      if (isBooleanUnion) {
        return { display: 'boolean', literalValues: undefined, isBooleanLike: true, includesUndefined };
      }
      const allStringLiteral = nonUndef.every((t) => t.isStringLiteral());
      if (allStringLiteral) {
        const values = nonUndef.map((t) => (t as ts.StringLiteralType).value);
        return { display: values.map((v) => `'${v}'`).join(' | '), literalValues: values, isBooleanLike: false, includesUndefined };
      }
      return { display: checker.typeToString(type), literalValues: undefined, isBooleanLike: false, includesUndefined };
    }
  }

  if ((working.flags & ts.TypeFlags.Boolean) !== 0) {
    return { display: 'boolean', literalValues: undefined, isBooleanLike: true, includesUndefined };
  }
  if (working.isStringLiteral()) {
    return { display: `'${working.value}'`, literalValues: [working.value], isBooleanLike: false, includesUndefined };
  }
  if (working.isNumberLiteral()) {
    return { display: `${working.value}`, literalValues: [working.value], isBooleanLike: false, includesUndefined };
  }
  return { display: checker.typeToString(working), literalValues: undefined, isBooleanLike: false, includesUndefined };
}

function extractDefaultsFromDestructuring(param: ts.ParameterDeclaration): { prop: string; defaultText: string }[] {
  const out: { prop: string; defaultText: string }[] = [];
  if (ts.isObjectBindingPattern(param.name)) {
    for (const el of param.name.elements) {
      if (ts.isBindingElement(el) && el.initializer && ts.isIdentifier(el.name)) {
        out.push({ prop: el.name.text, defaultText: el.initializer.getText() });
      }
    }
  }
  return out;
}

function extractManifest(program: ts.Program, checker: ts.TypeChecker): Record<string, ComponentDescriptor> {
  const manifest: Record<string, ComponentDescriptor> = {};
  const fixtureFiles = new Set(fixtureRootNames());

  for (const sourceFile of program.getSourceFiles()) {
    if (!fixtureFiles.has(sourceFile.fileName)) continue;

    ts.forEachChild(sourceFile, (node) => {
      if (!ts.isFunctionDeclaration(node) || !node.name) return;
      const isExported = !!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (!isExported) return;

      const param = node.parameters[0];
      if (!param) return; // no-props component, not part of this fixture

      const propsType = checker.getTypeAtLocation(param);
      const propSymbols = checker.getPropertiesOfType(propsType);

      const props: PropDescriptor[] = propSymbols.map((sym) => {
        const optional = (sym.flags & ts.SymbolFlags.Optional) !== 0;
        const t = checker.getTypeOfSymbolAtLocation(sym, param);
        const described = describePropType(t, checker);
        const declFile = sym.declarations?.[0]?.getSourceFile().fileName ?? '<unknown>';
        return {
          name: sym.name,
          optional,
          type: described.display,
          literalValues: described.literalValues,
          isBooleanLike: described.isBooleanLike,
          includesUndefined: described.includesUndefined,
          declaredIn: relFixture(declFile),
        };
      });

      const filtered = props.filter((p) => !p.declaredIn.startsWith('..') && !p.declaredIn.includes('node_modules'));

      manifest[node.name.text] = {
        name: node.name.text,
        file: relFixture(sourceFile.fileName),
        propsCount: props.length,
        propsCountFilteredToDesignSystem: filtered.length,
        props: filtered.sort((a, b) => a.name.localeCompare(b.name)),
        defaults: extractDefaultsFromDestructuring(param),
      };
    });
  }

  return manifest;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function runExtractionOnce(): { manifest: Record<string, ComponentDescriptor>; ms: number } {
  const start = performance.now();
  const program = ts.createProgram(fixtureRootNames(), compilerOptions);
  const checker = program.getTypeChecker();
  const manifest = extractManifest(program, checker);
  const ms = performance.now() - start;
  return { manifest, ms };
}

// ===========================================================================
// RUN: assumptions 1-6 (extraction)
// ===========================================================================

log('\n=== Assumption 1/2/3/4: extraction ===');
const { manifest, ms: firstMs } = runExtractionOnce();
log(JSON.stringify(manifest, null, 2));

// --- Assumption 1: components found, props resolved through aliases/Omit/intersection/imports
const componentNames = Object.keys(manifest).sort();
log('\nComponents found:', componentNames);
assert.deepStrictEqual(componentNames, ['Button', 'Card', 'Image', 'Input', 'Stack', 'Text']);

// Card.size is typed via an IMPORTED type alias (Size, from ./types.ts) -> resolves to its literal union
const cardSize = manifest.Card.props.find((p) => p.name === 'size');
assert.ok(cardSize, 'Card should have a size prop');
assert.deepStrictEqual(cardSize!.literalValues?.slice().sort(), ['lg', 'md', 'sm']);

// Text props built with Omit<> & intersection: 'muted' must be gone, 'value'/'bold'/'variant' present
const textPropNames = manifest.Text.props.map((p) => p.name).sort();
assert.deepStrictEqual(textPropNames, ['bold', 'value', 'variant']);
const textVariant = manifest.Text.props.find((p) => p.name === 'variant')!;
assert.strictEqual(textVariant.optional, false, 'variant is required (not part of the Omit<...,"muted">)');

// --- Assumption 2: string literal unions -> member list; boolean special-cased; optional includes undefined
const stackDirection = manifest.Stack.props.find((p) => p.name === 'direction')!;
log('\nStack.direction descriptor:', stackDirection);
assert.deepStrictEqual(stackDirection.literalValues?.slice().sort(), ['column', 'row']);
assert.strictEqual(stackDirection.optional, false);
assert.strictEqual(stackDirection.includesUndefined, false);

const buttonVariant = manifest.Button.props.find((p) => p.name === 'variant')!;
log('Button.variant descriptor:', buttonVariant);
assert.strictEqual(buttonVariant.optional, true);
assert.deepStrictEqual(buttonVariant.literalValues?.slice().sort(), ['ghost', 'primary']);
assert.strictEqual(buttonVariant.includesUndefined, true, 'optional prop type should include undefined');

const buttonDisabled = manifest.Button.props.find((p) => p.name === 'disabled')!;
log('Button.disabled descriptor:', buttonDisabled);
assert.strictEqual(buttonDisabled.isBooleanLike, true, 'boolean must be special-cased, not shown as true|false');
assert.strictEqual(buttonDisabled.type, 'boolean');
assert.strictEqual(buttonDisabled.includesUndefined, true);

const cardBordered = manifest.Card.props.find((p) => p.name === 'bordered')!;
log('Card.bordered descriptor (REQUIRED boolean prop):', cardBordered);
assert.ok(cardBordered, 'Card should have a bordered prop (required boolean, added to exercise this exact case)');
assert.strictEqual(cardBordered.optional, false, 'bordered has no `?` and no default -- it is required');
assert.strictEqual(cardBordered.isBooleanLike, true, 'boolean must be special-cased for the required case too');
assert.strictEqual(cardBordered.type, 'boolean');
assert.strictEqual(cardBordered.includesUndefined, false, 'a required prop type must not include undefined');

// --- Real checker.typeToString() + raw union-member-flags measurement, independent of
// describePropType's own special-casing. Finding #2 (as originally written) claimed
// "checker.typeToString() happens to collapse the two BooleanLiteral members back to the
// word boolean for display" -- but describePropType (above) returns its OWN hardcoded
// 'boolean' string via an early `return` the moment it detects a 2-member
// [BooleanLiteral, BooleanLiteral] union; it never actually calls checker.typeToString on
// that branch. So that claim was untested by the code that made it. Here we call
// checker.typeToString() directly, for real, on both a REQUIRED and an OPTIONAL boolean
// prop's raw type, and log the real per-constituent TypeFlags, to describe the special
// casing accurately instead of assuming what typeToString would say.
function findPropRawType(componentName: string, propName: string): { type: ts.Type; checker: ts.TypeChecker } {
  const probeProgram = ts.createProgram(fixtureRootNames(), compilerOptions);
  const probeChecker = probeProgram.getTypeChecker();
  for (const sourceFile of probeProgram.getSourceFiles()) {
    if (!fixtureRootNames().includes(sourceFile.fileName)) continue;
    let found: ts.Type | undefined;
    ts.forEachChild(sourceFile, (node) => {
      if (found || !ts.isFunctionDeclaration(node) || node.name?.text !== componentName) return;
      const param = node.parameters[0];
      if (!param) return;
      const propsType = probeChecker.getTypeAtLocation(param);
      const sym = probeChecker.getPropertyOfType(propsType, propName);
      if (!sym) return;
      found = probeChecker.getTypeOfSymbolAtLocation(sym, param);
    });
    if (found) return { type: found, checker: probeChecker };
  }
  throw new Error(`prop ${componentName}.${propName} not found for raw-type probe`);
}

function flagNames(t: ts.Type): string {
  const names: string[] = [];
  if ((t.flags & ts.TypeFlags.Undefined) !== 0) names.push('Undefined');
  if ((t.flags & ts.TypeFlags.BooleanLiteral) !== 0) names.push('BooleanLiteral');
  if ((t.flags & ts.TypeFlags.Boolean) !== 0) names.push('Boolean');
  if ((t.flags & ts.TypeFlags.Union) !== 0) names.push('Union');
  return names.length ? names.join('|') : `(flags=${t.flags})`;
}

log('\n=== Assumption 2 (re-checked): REAL checker.typeToString() for boolean props ===');

const { type: requiredBoolType, checker: requiredBoolChecker } = findPropRawType('Card', 'bordered');
const requiredBoolTypeString = requiredBoolChecker.typeToString(requiredBoolType);
const requiredBoolIsUnion = requiredBoolType.isUnion();
log('Card.bordered (REQUIRED) raw type.isUnion():', requiredBoolIsUnion);
log('Card.bordered (REQUIRED) real checker.typeToString(type):', requiredBoolTypeString);
log(
  'Card.bordered (REQUIRED) constituent flags:',
  requiredBoolIsUnion ? requiredBoolType.types.map(flagNames) : [flagNames(requiredBoolType)]
);

const { type: optionalBoolType, checker: optionalBoolChecker } = findPropRawType('Button', 'disabled');
const optionalBoolTypeString = optionalBoolChecker.typeToString(optionalBoolType);
const optionalBoolIsUnion = optionalBoolType.isUnion();
log('Button.disabled (OPTIONAL) raw type.isUnion():', optionalBoolIsUnion);
log('Button.disabled (OPTIONAL) real checker.typeToString(type):', optionalBoolTypeString);
log(
  'Button.disabled (OPTIONAL) constituent flags:',
  optionalBoolIsUnion ? optionalBoolType.types.map(flagNames) : [flagNames(optionalBoolType)]
);

// Assert on what was actually measured above, not on an assumed/hardcoded value.
assert.strictEqual(
  requiredBoolTypeString,
  'boolean',
  `expected checker.typeToString() for the REQUIRED boolean prop to display as 'boolean', got '${requiredBoolTypeString}'`
);
assert.strictEqual(
  optionalBoolTypeString,
  'boolean | undefined',
  `expected checker.typeToString() for the OPTIONAL boolean prop to display as 'boolean | undefined', got '${optionalBoolTypeString}'`
);
assert.strictEqual(requiredBoolIsUnion, true, 'the REQUIRED boolean prop raw type is ALSO a union at the checker level (true | false), even though typeToString displays it as boolean');
assert.strictEqual(optionalBoolIsUnion, true, 'the OPTIONAL boolean prop raw type is a union (true | false | undefined)');
assert.deepStrictEqual(
  requiredBoolType.isUnion() ? requiredBoolType.types.map(flagNames).sort() : [],
  ['BooleanLiteral', 'BooleanLiteral'].sort(),
  'REQUIRED boolean: the real union constituents are exactly two BooleanLiteral members (true, false) -- confirmed on the raw type, not assumed'
);
assert.deepStrictEqual(
  optionalBoolType.isUnion() ? optionalBoolType.types.map(flagNames).sort() : [],
  ['BooleanLiteral', 'BooleanLiteral', 'Undefined'].sort(),
  'OPTIONAL boolean: the real union constituents are exactly two BooleanLiteral members plus Undefined -- confirmed on the raw type, not assumed'
);

// --- Assumption 3: destructuring defaults are NOT in the type; must come from an AST walk
// The checker's type for `variant` is the plain union 'primary' | 'ghost' — nothing in the
// TYPE marks which member is the default; that information only exists in the parameter's
// AST (the `= 'primary'` initializer on the destructuring pattern).
assert.deepStrictEqual(buttonVariant.literalValues?.slice().sort(), ['ghost', 'primary']);
const buttonDefaults = manifest.Button.defaults;
log('\nButton destructuring defaults (from AST, not from checker):', buttonDefaults);
assert.deepStrictEqual(
  buttonDefaults.sort((a, b) => a.prop.localeCompare(b.prop)),
  [
    { prop: 'disabled', defaultText: 'false' },
    { prop: 'variant', defaultText: "'primary'" },
  ],
);
const cardDefaults = manifest.Card.defaults.sort((a, b) => a.prop.localeCompare(b.prop));
log('Card destructuring defaults:', cardDefaults);
assert.deepStrictEqual(cardDefaults, [
  { prop: 'elevated', defaultText: 'false' },
  { prop: 'size', defaultText: "'md'" },
]);

// --- Assumption 4: React.ComponentProps<'button'> explodes; filter by declaration source file
log('\nInput props BEFORE filtering to design-system files:', manifest.Input.propsCount);
log('Input props AFTER filtering to design-system files:', manifest.Input.propsCountFilteredToDesignSystem);
assert.ok(manifest.Input.propsCount > 100, `expected hundreds of inherited DOM props, got ${manifest.Input.propsCount}`);
assert.strictEqual(
  manifest.Input.propsCountFilteredToDesignSystem,
  1,
  'after filtering by declaration source file, only the own prop (label) should remain',
);
assert.deepStrictEqual(
  manifest.Input.props.map((p) => p.name),
  ['label'],
);

// ===========================================================================
// Assumption 5: manifest serializes to stable JSON (sorted keys) -> drift check
// ===========================================================================

log('\n=== Assumption 5: stable serialization across two independent runs ===');
const run1 = runExtractionOnce();
const run2 = runExtractionOnce();
const json1 = stableStringify(run1.manifest);
const json2 = stableStringify(run2.manifest);
log('run1 length:', json1.length, 'run2 length:', json2.length);
assert.strictEqual(json1, json2, 'two independent extraction runs must produce byte-identical stable JSON');
log('Stable JSON identical across runs: CONFIRMED (this is what a git-diff drift check relies on).');

// ===========================================================================
// Assumption 6: timing
// ===========================================================================
log('\n=== Assumption 6: timing ===');
log(`First extraction (cold createProgram): ${firstMs.toFixed(1)}ms`);
log(`Second extraction (cold createProgram, new instance): ${run1.ms.toFixed(1)}ms`);
log(`Third extraction (cold createProgram, new instance): ${run2.ms.toFixed(1)}ms`);

// ===========================================================================
// Assumption 7: PARSE BACK a fixed-shape generated TSX file
// ===========================================================================

type ParsedNode = {
  component: string;
  props: Record<string, string | number | boolean>;
  children: ParsedNode[];
};

type ParseResult = {
  ok: boolean;
  reasons: string[];
  tree?: ParsedNode;
};

function literalFromExpression(expr: ts.Expression): { ok: true; value: string | number | boolean } | { ok: false } {
  if (ts.isStringLiteral(expr)) return { ok: true, value: expr.text };
  if (ts.isNumericLiteral(expr)) return { ok: true, value: Number(expr.text) };
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return { ok: true, value: true };
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return { ok: true, value: false };
  if (
    ts.isPrefixUnaryExpression(expr) &&
    expr.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(expr.operand)
  ) {
    return { ok: true, value: -Number(expr.operand.text) };
  }
  return { ok: false };
}

function parseJsxTag(
  tag: ts.JsxOpeningLikeElement,
  reasons: string[],
): { component: string; props: Record<string, string | number | boolean> } {
  const component = tag.tagName.getText();
  const props: Record<string, string | number | boolean> = {};
  for (const attr of tag.attributes.properties) {
    if (ts.isJsxSpreadAttribute(attr)) {
      reasons.push(`spread attributes used on <${component}>`);
      continue;
    }
    if (!ts.isJsxAttribute(attr)) continue;
    const name = attr.name.getText();
    if (!attr.initializer) {
      props[name] = true;
      continue;
    }
    if (ts.isStringLiteral(attr.initializer)) {
      props[name] = attr.initializer.text;
      continue;
    }
    if (ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
      const lit = literalFromExpression(attr.initializer.expression);
      if (lit.ok) {
        props[name] = lit.value;
      } else {
        reasons.push(`non-literal prop expression: ${name}={${attr.initializer.expression.getText()}} on <${component}>`);
      }
    }
  }
  return { component, props };
}

function parseChildren(children: ts.NodeArray<ts.JsxChild>, reasons: string[]): ParsedNode[] {
  const out: ParsedNode[] = [];
  for (const child of children) {
    if (ts.isJsxText(child)) {
      if (child.text.trim().length > 0) {
        reasons.push(`unexpected literal text child: ${JSON.stringify(child.text.trim())}`);
      }
      continue;
    }
    if (ts.isJsxElement(child)) {
      const { component, props } = parseJsxTag(child.openingElement, reasons);
      out.push({ component, props, children: parseChildren(child.children, reasons) });
      continue;
    }
    if (ts.isJsxSelfClosingElement(child)) {
      const { component, props } = parseJsxTag(child, reasons);
      out.push({ component, props, children: [] });
      continue;
    }
    if (ts.isJsxFragment(child)) {
      reasons.push('fragment used in children');
      continue;
    }
    if (ts.isJsxExpression(child)) {
      const expr = child.expression;
      if (!expr) continue; // {} empty expression / comment-only, ignore
      if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        reasons.push('conditional expression in children (&&)');
      } else if (ts.isConditionalExpression(expr)) {
        reasons.push('conditional expression in children (ternary)');
      } else if (
        ts.isCallExpression(expr) &&
        ts.isPropertyAccessExpression(expr.expression) &&
        expr.expression.name.text === 'map'
      ) {
        reasons.push('.map() call in children');
      } else {
        reasons.push(`non-literal expression in children: {${expr.getText()}}`);
      }
      continue;
    }
  }
  return out;
}

function parseFixedShapeGenerated(source: string): ParseResult {
  const sf = ts.createSourceFile('generated.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const reasons: string[] = [];

  const topLevelExportedFns = sf.statements.filter(
    (s): s is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(s) && !!s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
  );

  if (sf.statements.length > 1) {
    reasons.push(`multiple top-level statements/exports in file (found ${sf.statements.length})`);
  }
  if (topLevelExportedFns.length !== 1) {
    reasons.push(`expected exactly one exported function, found ${topLevelExportedFns.length}`);
    return { ok: false, reasons };
  }

  const fn = topLevelExportedFns[0];
  const body = fn.body;
  if (!body) {
    reasons.push('exported function has no body');
    return { ok: false, reasons };
  }
  if (body.statements.length !== 1 || !ts.isReturnStatement(body.statements[0])) {
    reasons.push(`extra statement or hook in function body (found ${body.statements.length} statements)`);
  }
  const returnStatement = body.statements.find((s): s is ts.ReturnStatement => ts.isReturnStatement(s));
  if (!returnStatement || !returnStatement.expression) {
    reasons.push('no return statement with a JSX expression found');
    return { ok: false, reasons };
  }

  let expr: ts.Expression = returnStatement.expression;
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;

  let tree: ParsedNode | undefined;
  if (ts.isJsxElement(expr)) {
    const { component, props } = parseJsxTag(expr.openingElement, reasons);
    tree = { component, props, children: parseChildren(expr.children, reasons) };
  } else if (ts.isJsxSelfClosingElement(expr)) {
    const { component, props } = parseJsxTag(expr, reasons);
    tree = { component, props, children: [] };
  } else {
    reasons.push(`returned expression is not a JSX element (kind=${ts.SyntaxKind[expr.kind]})`);
  }

  return { ok: reasons.length === 0, reasons, tree };
}

log('\n=== Assumption 7: parse-back a fixed-shape generated file ===');

const GOOD_SOURCE = `export function CheckoutPage() { return (<Stack direction="row" gap={16}><Card title="Order"><Text value="2 items" /></Card></Stack>); }`;

const goodResult = parseFixedShapeGenerated(GOOD_SOURCE);
log('Good source parse result:', JSON.stringify(goodResult, null, 2));
assert.strictEqual(goodResult.ok, true);
assert.deepStrictEqual(goodResult.tree, {
  component: 'Stack',
  props: { direction: 'row', gap: 16 },
  children: [
    {
      component: 'Card',
      props: { title: 'Order' },
      children: [{ component: 'Text', props: { value: '2 items' }, children: [] }],
    },
  ],
});

const BROKEN_VARIANTS: {
  label: string;
  source: string;
  expectReasonIncludes: string;
  expectedReasonCount?: number;
}[] = [
  {
    label: 'non-literal prop expression (gap={8*2})',
    source: `export function CheckoutPage() { return (<Stack direction="row" gap={8*2}><Card title="Order"><Text value="2 items" /></Card></Stack>); }`,
    expectReasonIncludes: 'non-literal prop expression',
  },
  {
    label: 'spread attributes',
    source: `export function CheckoutPage() { return (<Stack direction="row" gap={16}><Card {...{ title: 'Order' }}><Text value="2 items" /></Card></Stack>); }`,
    expectReasonIncludes: 'spread attributes',
  },
  {
    label: 'conditional in children (&&)',
    source: `export function CheckoutPage() { return (<Stack direction="row" gap={16}><Card title="Order">{true && <Text value="big" />}</Card></Stack>); }`,
    expectReasonIncludes: 'conditional expression in children',
  },
  {
    label: '.map() in children',
    source: `export function CheckoutPage() { return (<Stack direction="row" gap={16}><Card title="Order">{['a','b'].map(i => <Text value={i} />)}</Card></Stack>); }`,
    expectReasonIncludes: '.map() call in children',
  },
  {
    label: 'extra statement/hook in function body',
    source: `export function CheckoutPage() { const [count] = useState(0); return (<Stack direction="row" gap={16}><Card title="Order"><Text value="2 items" /></Card></Stack>); }`,
    expectReasonIncludes: 'extra statement or hook',
  },
  {
    label: 'second export in file',
    source: `export function CheckoutPage() { return (<Stack direction="row" gap={16}><Card title="Order"><Text value="2 items" /></Card></Stack>); }\nexport function Other() { return (<Text value="x" />); }`,
    expectReasonIncludes: 'multiple top-level statements',
    expectedReasonCount: 2, // "multiple statements" + "expected exactly one exported function" both fire — same root cause
  },
];

for (const variant of BROKEN_VARIANTS) {
  const result = parseFixedShapeGenerated(variant.source);
  log(`\n[${variant.label}] ok=${result.ok} reasons=${JSON.stringify(result.reasons)}`);
  assert.strictEqual(result.ok, false, `variant "${variant.label}" should NOT be reported as fitting the shape`);
  assert.ok(
    result.reasons.some((r) => r.includes(variant.expectReasonIncludes)),
    `variant "${variant.label}" should include a reason containing "${variant.expectReasonIncludes}", got ${JSON.stringify(result.reasons)}`,
  );
  assert.strictEqual(
    result.reasons.length,
    variant.expectedReasonCount ?? 1,
    `variant "${variant.label}" should be isolated to its expected violation(s), got ${JSON.stringify(result.reasons)}`,
  );
}

// ===========================================================================
// Assumption 8: stable node identity — data-node-id attribute vs JSX comment
// ===========================================================================

log('\n=== Assumption 8: node identity survival (attribute vs comment) ===');

const ATTR_BEFORE = `export function CheckoutPage() {
  return (
    <Stack direction="row" gap={16} data-node-id="n1">
      <Card title="Order" data-node-id="n2">
        <Text value="2 items" data-node-id="n3" />
      </Card>
    </Stack>
  );
}
`;

const COMMENT_BEFORE = `export function CheckoutPage() {
  return (
    <Stack direction="row" gap={16}>
      {/* node:n1 */}
      <Card title="Order">
        {/* node:n2 */}
        <Text value="2 items" />
      </Card>
    </Stack>
  );
}
`;

// Simulate an engineer manually inserting a new sibling element, unaware of the
// node-id convention (a very ordinary manual edit: "add another line item").
const ATTR_AFTER_EDIT = `export function CheckoutPage() {
  return (
    <Stack direction="row" gap={16} data-node-id="n1">
      <Card title="Order" data-node-id="n2">
        <Text value="inserted!" />
        <Text value="2 items" data-node-id="n3" />
      </Card>
    </Stack>
  );
}
`;

const COMMENT_AFTER_EDIT = `export function CheckoutPage() {
  return (
    <Stack direction="row" gap={16}>
      {/* node:n1 */}
      <Card title="Order">
        {/* node:n2 */}
        <Text value="inserted!" />
        <Text value="2 items" />
      </Card>
    </Stack>
  );
}
`;

function findAttrNodeId(source: string, expectedValue: string): string | undefined {
  const sf = ts.createSourceFile('id.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found: string | undefined;
  function visit(node: ts.Node) {
    if (ts.isJsxOpeningLikeElement(node)) {
      for (const attr of node.attributes.properties) {
        if (ts.isJsxAttribute(attr) && attr.name.getText() === 'value' && attr.initializer && ts.isStringLiteral(attr.initializer)) {
          if (attr.initializer.text === expectedValue) {
            const idAttr = node.attributes.properties.find(
              (a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText() === 'data-node-id',
            );
            if (idAttr?.initializer && ts.isStringLiteral(idAttr.initializer)) {
              found = idAttr.initializer.text;
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return found;
}

// Attribute-based: the node-id travels WITH the tag it's declared on, so after the
// edit, the Text with value "2 items" is still correctly identified as n3.
const idBefore = findAttrNodeId(ATTR_BEFORE, '2 items');
const idAfterEdit = findAttrNodeId(ATTR_AFTER_EDIT, '2 items');
log('Attribute-based id for value="2 items" BEFORE edit:', idBefore);
log('Attribute-based id for value="2 items" AFTER manual edit:', idAfterEdit);
assert.strictEqual(idBefore, 'n3');
assert.strictEqual(idAfterEdit, 'n3', 'data-node-id stays attached to its own tag regardless of sibling edits');

// Comment-based: identity is positional ("the comment immediately precedes the
// element it names"). After the edit, the element following "node:n2" is now the
// WRONG element (the newly inserted sibling), demonstrating the convention breaks.
function findElementFollowingComment(source: string, commentText: string): string | undefined {
  const sf = ts.createSourceFile('id.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let result: string | undefined;
  function visit(node: ts.Node) {
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      const children = node.children;
      for (let i = 0; i < children.length; i++) {
        const c = children[i];
        if (ts.isJsxExpression(c) && !c.expression) {
          // empty {} — comment lives in the leading trivia of this JsxExpression node
          const fullText = sf.getFullText();
          const leading = fullText.slice(c.getFullStart(), c.getEnd());
          if (leading.includes(commentText)) {
            // find next sibling that is an element
            for (let j = i + 1; j < children.length; j++) {
              const next = children[j];
              if (ts.isJsxElement(next)) {
                const valueAttr = next.openingElement.attributes.properties.find(
                  (a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText() === 'value',
                );
                if (valueAttr?.initializer && ts.isStringLiteral(valueAttr.initializer)) {
                  result = valueAttr.initializer.text;
                }
              } else if (ts.isJsxSelfClosingElement(next)) {
                const valueAttr = next.attributes.properties.find(
                  (a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText() === 'value',
                );
                if (valueAttr?.initializer && ts.isStringLiteral(valueAttr.initializer)) {
                  result = valueAttr.initializer.text;
                }
                break;
              }
              if (result !== undefined) break;
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return result;
}

const commentTargetBefore = findElementFollowingComment(COMMENT_BEFORE, 'node:n2');
const commentTargetAfterEdit = findElementFollowingComment(COMMENT_AFTER_EDIT, 'node:n2');
log('Comment "node:n2" identifies value BEFORE edit:', commentTargetBefore);
log('Comment "node:n2" identifies value AFTER manual edit:', commentTargetAfterEdit);
assert.strictEqual(commentTargetBefore, '2 items');
assert.notStrictEqual(
  commentTargetAfterEdit,
  '2 items',
  'comment-based identity is positional and breaks when a sibling is inserted without moving the comment',
);
assert.strictEqual(commentTargetAfterEdit, 'inserted!', 'the comment now (wrongly) points at the new sibling');

// Now run all four variants through Prettier and confirm both markers survive
// formatting byte-for-byte in their meaningful parts (attribute value / comment text).
const prettierOptions: prettier.Options = { filepath: 'generated.tsx', semi: true, singleQuote: true };

const attrBeforeFormatted = await prettier.format(ATTR_BEFORE, prettierOptions);
const attrAfterFormatted = await prettier.format(ATTR_AFTER_EDIT, prettierOptions);
const commentBeforeFormatted = await prettier.format(COMMENT_BEFORE, prettierOptions);
const commentAfterFormatted = await prettier.format(COMMENT_AFTER_EDIT, prettierOptions);

log('\n--- attribute-based, after edit, formatted by Prettier ---');
log(attrAfterFormatted);
log('--- comment-based, after edit, formatted by Prettier ---');
log(commentAfterFormatted);

assert.ok(attrBeforeFormatted.includes('data-node-id="n1"'));
assert.ok(attrBeforeFormatted.includes('data-node-id="n2"'));
assert.ok(attrBeforeFormatted.includes('data-node-id="n3"'));
assert.ok(attrAfterFormatted.includes('data-node-id="n3"'), 'Prettier preserves the attribute through formatting');
assert.strictEqual(
  findAttrNodeId(attrAfterFormatted, '2 items'),
  'n3',
  'attribute-based id survives edit + Prettier formatting',
);

assert.ok(commentBeforeFormatted.includes('{/* node:n1 */}'));
assert.ok(commentAfterFormatted.includes('{/* node:n2 */}'), 'Prettier preserves the comment TEXT through formatting');
assert.strictEqual(
  findElementFollowingComment(commentAfterFormatted, 'node:n2'),
  'inserted!',
  'Prettier preserves the comment but NOT its intended semantic association — it still (wrongly) precedes the inserted node',
);

log(
  '\nConclusion for assumption 8: Prettier preserves both markers verbatim (it does not drop attributes or comments),' +
    ' but only the data-node-id ATTRIBUTE survives a realistic manual edit with its identity mapping intact, because it' +
    " is bound to the element's own tag. The comment is a sibling in the children list and its meaning depends on a" +
    ' position-relative convention that an unaware engineer can silently break by inserting/reordering elements.',
);

log('\nAll assertions passed.');
