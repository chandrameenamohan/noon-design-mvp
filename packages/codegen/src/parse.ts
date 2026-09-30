import ts from "typescript";
import { Doc, type DocNode, type Manifest, type PropValue } from "@noon/contracts";
import { generate, type CodegenReason } from "./index.ts";

/**
 * Keystone 8, the way back: a generated file that an engineer edited and pushed becomes a document
 * again, but ONLY while it still has the shape `generate()` writes. Everything else is a conflict
 * (F16b), and the conflict must say why, so every way out of the shape has its own reason.
 *
 * The file is untrusted input: anyone who can push to the repo wrote it. So it is PARSED, never run
 * (TypeScript's own parser, syntax only, no program and no type checker), sizes are capped before
 * parsing, the walk over the tree is iterative, and a value is accepted only as a literal, read by
 * its syntax, never by evaluating it.
 *
 * The final judge is `generate()` itself: whatever tree came out is handed back to it, so every rule
 * about components, props and tree shape is the SAME rule in both directions. A second copy of those
 * rules here would drift, and a document this accepts but generate refuses would be a push that
 * lands on the canvas and then cannot be generated or shipped.
 *
 * Not decided here: whether an id in the file was removed from the document earlier (id re-use
 * lands an edit meant for the dead node on the new one), and whether the root id matches the open
 * document. Both need the document's history; E5.3b, which turns this tree into ops, has it.
 */

type ParseReason =
  | CodegenReason
  | "too_large"
  | "too_deep"
  | "syntax_error"
  | "extra_statement"
  | "hook"
  | "second_export"
  | "not_page_component"
  | "bad_import"
  | "spread"
  | "conditional"
  | "map"
  | "non_literal_prop"
  | "text_child"
  | "expression_child"
  | "not_an_element"
  | "missing_node_id"
  | "bad_node_id"
  | "duplicate_node_id"
  | "duplicate_prop";
export type Parsed = { ok: true; doc: Doc } | { ok: false; reason: ParseReason; detail: string };

const DESIGN_SYSTEM = "../design-system/index.ts";
const ROOT_COMPONENT = "Page";
// ponytail: the room's own defaults (apps/sync/src/room.ts), copied, not imported: codegen must not
// depend on the sync app. A room with other limits still refuses the ops E5.3b makes from this tree.
const MAX_NODES = 5000;
const MAX_DEPTH = 64;
// ponytail: 2 MB is roomy for 5000 nodes of ordinary props and small enough to parse in milliseconds.
// Raise it with MAX_NODES if a room ever holds more.
const MAX_BYTES = 2 * 1024 * 1024;
const NODE_ID = "data-node-id";

/** A refusal that carries the line it is about. Thrown inside the walk, caught once in `parse`. */
class OutOfShape extends Error {
  readonly reason: ParseReason;
  constructor(reason: ParseReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** Never throws, like `generate`: the caller is the git webhook's job handler, and a reason is what the conflict banner shows. */
export function parse(tsx: string, manifest: Manifest): Parsed {
  try {
    if (typeof tsx !== "string") return { ok: false, reason: "malformed_doc", detail: "the file is not text" };
    if (tsx.length > MAX_BYTES) return { ok: false, reason: "too_large", detail: `larger than ${String(MAX_BYTES)} bytes` };
    const doc = read(tsx);
    // The contract is the trust boundary for everything a document may hold: node ids, prop values
    // (control characters, -0), sizes. What the room would refuse from an op is refused here too.
    const contract = Doc.safeParse(doc);
    if (!contract.success) return { ok: false, reason: "malformed_doc", detail: contract.error.issues.map((issue) => issue.message).slice(0, 3).join("; ") };
    const generated = generate(doc, manifest);
    return generated.ok ? { ok: true, doc } : generated;
  } catch (err) {
    if (err instanceof OutOfShape) return { ok: false, reason: err.reason, detail: err.message };
    // TypeScript's parser recurses: nesting far past MAX_DEPTH (still under MAX_BYTES) overflows its stack.
    if (err instanceof RangeError) return { ok: false, reason: "too_deep", detail: "nested too deeply to read" };
    return { ok: false, reason: "malformed_doc", detail: "the file could not be read" };
  }
}

function read(tsx: string): Doc {
  const file = ts.createSourceFile("page.tsx", tsx, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  const out = (node: ts.Node, reason: ParseReason, what: string): OutOfShape =>
    new OutOfShape(reason, `line ${String(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1)}: ${what}`);

  // ponytail: `parseDiagnostics` is internal to TypeScript (stable for a decade, used by most tools).
  // The public route is a whole Program just to ask for syntax errors. If it ever disappears the
  // guard below refuses every file loudly rather than accepting broken ones.
  const diagnostics = (file as unknown as { parseDiagnostics?: unknown }).parseDiagnostics;
  if (!Array.isArray(diagnostics)) throw new Error("typescript no longer reports parse diagnostics");
  const first = diagnostics[0] as ts.DiagnosticWithLocation | undefined;
  if (first) throw new OutOfShape("syntax_error", `line ${String(file.getLineAndCharacterOfPosition(first.start).line + 1)}: ${ts.flattenDiagnosticMessageText(first.messageText, " ")}`);

  const imported = new Set<string>();
  let pageFunction: ts.FunctionDeclaration | undefined;
  let seenImport = false;
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      readImport(statement, imported, seenImport, out);
      seenImport = true;
      continue;
    }
    const exported = ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true;
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === ROOT_COMPONENT && exported && !pageFunction) {
      pageFunction = statement;
      continue;
    }
    if (exported || ts.isExportAssignment(statement) || ts.isExportDeclaration(statement)) {
      // The page is the ONLY export: Fast Refresh keeps state only while a module exports components alone.
      throw out(statement, pageFunction ? "second_export" : "not_page_component", pageFunction ? "the file may export only the page component" : `the page must be \`export function ${ROOT_COMPONENT}() { return (...); }\``);
    }
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === ROOT_COMPONENT) throw out(statement, "not_page_component", `${ROOT_COMPONENT} must be exported`);
    throw out(statement, "extra_statement", "the file holds only the import and the page component");
  }
  if (!pageFunction) throw new OutOfShape("not_page_component", `line 1: no \`export function ${ROOT_COMPONENT}()\``);
  const jsx = returnedElement(pageFunction, out);

  const nodes: Record<string, DocNode> = {};
  let count = 0;
  let rootId = "";
  // Iterative, like generate: the depth cap is checked as we go, not after a recursion has run out of stack.
  const stack: { element: ts.JsxElement | ts.JsxSelfClosingElement; parent: DocNode | null; depth: number }[] = [{ element: jsx, parent: null, depth: 0 }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) break;
    const { element, parent, depth } = frame;
    if (depth > MAX_DEPTH) throw out(element, "too_deep", `deeper than ${String(MAX_DEPTH)} levels`);
    if (++count > MAX_NODES) throw out(element, "too_large", `more than ${String(MAX_NODES)} elements`);

    const opening = ts.isJsxElement(element) ? element.openingElement : element;
    if (!ts.isIdentifier(opening.tagName) || opening.typeArguments) throw out(element, "not_an_element", "a tag must be a plain component name");
    const tag = opening.tagName.text;
    if (parent === null && tag !== "div") throw out(element, "not_page_component", `the page must return <div ${NODE_ID}="...">, not <${tag}>`);
    if (parent !== null) {
      if (tag === ROOT_COMPONENT) throw out(element, "reserved_component", `${ROOT_COMPONENT} is the page component's own name`);
      if (!/^[A-Z]/u.test(tag)) throw out(element, "unknown_component", `<${tag}> is not a design-system component`);
      if (!imported.has(tag)) throw out(element, "bad_import", `<${tag}> is used but not imported from ${DESIGN_SYSTEM}`);
    }

    const { id, props } = readAttributes(opening, out);
    if (Object.hasOwn(nodes, id)) throw out(element, "duplicate_node_id", `${NODE_ID}="${id}" appears twice`);
    const node: DocNode = { id, component: parent === null ? ROOT_COMPONENT : tag, props, parentId: parent?.id ?? null, children: [] };
    nodes[id] = node;
    if (parent) parent.children.push(id);
    else rootId = id;

    const children = ts.isJsxElement(element) ? childElements(element, out) : [];
    // Reversed, because a stack hands back what went on last: children are visited, and listed, in order.
    for (const child of children.reverse()) stack.push({ element: child, parent: node, depth: depth + 1 });
  }
  return { rootId, nodes };
}

function readImport(statement: ts.ImportDeclaration, imported: Set<string>, seenImport: boolean, out: Out): void {
  const clause = statement.importClause;
  const from = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : "";
  if (seenImport) throw out(statement, "bad_import", `one import only, from ${DESIGN_SYSTEM}`);
  if (from !== DESIGN_SYSTEM) throw out(statement, "bad_import", `imports come only from ${DESIGN_SYSTEM}`);
  const named = clause?.namedBindings;
  if (!clause || clause.phaseModifier !== undefined || clause.name || !named || !ts.isNamedImports(named) || statement.attributes) throw out(statement, "bad_import", `the import must be \`import { A, B } from "${DESIGN_SYSTEM}"\``);
  for (const element of named.elements) {
    if (element.propertyName || element.isTypeOnly) throw out(element, "bad_import", `import ${element.name.text} by its own name`);
    if (element.name.text === ROOT_COMPONENT) throw out(element, "reserved_component", `${ROOT_COMPONENT} is the page component's own name`);
    imported.add(element.name.text);
  }
}

type Out = (node: ts.Node, reason: ParseReason, what: string) => OutOfShape;

/** `export function Page() { return (<div ...>...</div>); }`: no parameters, no return type, one statement. */
function returnedElement(page: ts.FunctionDeclaration, out: Out): ts.JsxElement | ts.JsxSelfClosingElement {
  const modifiers = ts.getModifiers(page) ?? [];
  if (page.parameters.length > 0 || page.typeParameters || page.type || page.asteriskToken || modifiers.length !== 1 || !page.body) {
    throw out(page, "not_page_component", `the page must be \`export function ${ROOT_COMPONENT}() { return (...); }\``);
  }
  const statements = page.body.statements;
  for (const statement of statements.slice(0, -1)) {
    const hook = ts.forEachChild(statement, function find(node): boolean | undefined {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && /^use[A-Z]/u.test(node.expression.text)) return true;
      return ts.forEachChild(node, find);
    });
    throw out(statement, hook ? "hook" : "extra_statement", hook ? "the page component calls no hooks" : "the page component holds only its return");
  }
  const last = statements[statements.length - 1];
  if (!last || !ts.isReturnStatement(last) || !last.expression) throw out(page, "not_an_element", "the page must return an element");
  let expression = last.expression;
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  if (!ts.isJsxElement(expression) && !ts.isJsxSelfClosingElement(expression)) throw out(expression, reasonFor(expression, "not_an_element"), "the page must return one element");
  return expression;
}

function readAttributes(opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement, out: Out): { id: string; props: Record<string, PropValue> } {
  let id: string | undefined;
  // A plain object is what the contract and generate expect; every key is refused below before it is
  // written if it is a name on Object.prototype, so `props[key] =` can never reach the prototype.
  const props: Record<string, PropValue> = {};
  for (const attribute of opening.attributes.properties) {
    if (ts.isJsxSpreadAttribute(attribute)) throw out(attribute, "spread", "spread attributes hide which props are set");
    if (!ts.isIdentifier(attribute.name)) throw out(attribute, "unknown_prop", "namespaced attributes are not props");
    const name = attribute.name.text;
    if (name === NODE_ID) {
      if (id !== undefined) throw out(attribute, "duplicate_prop", `${NODE_ID} appears twice`);
      const init = attribute.initializer;
      const value = init && ts.isStringLiteral(init) ? init.text : undefined;
      // The NodeId contract, checked here so the reason is precise; Doc.safeParse checks it again.
      if (value === undefined || !/^[A-Za-z0-9_-]{1,64}$/u.test(value) || value in Object.prototype) throw out(attribute, "bad_node_id", `${NODE_ID} must be a quoted id of 1-64 letters, digits, _ or -`);
      id = value;
      continue;
    }
    if (name in Object.prototype) throw out(attribute, "unknown_prop", `${name} is a reserved name`);
    if (Object.hasOwn(props, name)) throw out(attribute, "duplicate_prop", `${name} appears twice`);
    props[name] = literal(name, attribute, out);
  }
  if (id === undefined) throw out(opening, "missing_node_id", `every element carries ${NODE_ID}`);
  return { id, props };
}

/** A prop's value, read from its syntax only: a string, a finite number (optionally negated), true or false. */
function literal(name: string, attribute: ts.JsxAttribute, out: Out): PropValue {
  const init = attribute.initializer;
  if (!init) return true; // `<Button disabled />` is JSX for disabled={true}
  if (ts.isStringLiteral(init)) {
    // A quoted JSX attribute has no escapes but DOES decode HTML entities when compiled: the text
    // TypeScript hands back is the raw one, so a `&` would mean one thing here and another in the page.
    if (init.text.includes("&")) throw out(init, "non_literal_prop", "a quoted attribute with & is decoded as HTML; write it as {\"...\"}");
    return init.text;
  }
  const expression = ts.isJsxExpression(init) ? init.expression : undefined;
  if (expression) {
    if (ts.isStringLiteral(expression)) return expression.text;
    if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
    const negative = ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.MinusToken;
    const operand = negative ? expression.operand : expression;
    if (ts.isNumericLiteral(operand)) {
      // TypeScript normalises the literal's text (0x10 -> "16", separators dropped), so Number() reads a decimal.
      const value = Number(operand.text);
      if (Number.isFinite(value)) return negative ? -value : value;
    }
  }
  throw out(init, expression ? reasonFor(expression, "non_literal_prop") : "non_literal_prop", `${name} must be a literal string, number or boolean`);
}

/** The children that are elements; whitespace and `{/* comments *\/}` are allowed and dropped, anything else is out of shape. */
function childElements(element: ts.JsxElement, out: Out): (ts.JsxElement | ts.JsxSelfClosingElement)[] {
  const elements: (ts.JsxElement | ts.JsxSelfClosingElement)[] = [];
  for (const child of element.children) {
    if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) elements.push(child);
    else if (ts.isJsxText(child)) {
      if (!child.containsOnlyTriviaWhiteSpaces) throw out(child, "text_child", "text is not a node: put it in a prop");
    } else if (ts.isJsxExpression(child)) {
      if (child.dotDotDotToken) throw out(child, "spread", "spread children hide which nodes exist");
      if (child.expression) throw out(child, reasonFor(child.expression, "expression_child"), "a child must be an element");
    } else throw out(child, "not_an_element", "fragments are not nodes");
  }
  return elements;
}

/** Names the two shapes the conflict banner is most likely to meet; anything else keeps the caller's reason. */
function reasonFor(expression: ts.Expression, otherwise: ParseReason): ParseReason {
  let at = expression;
  while (ts.isParenthesizedExpression(at)) at = at.expression;
  if (ts.isConditionalExpression(at)) return "conditional";
  if (ts.isBinaryExpression(at) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(at.operatorToken.kind)) return "conditional";
  if (ts.isCallExpression(at) && ts.isPropertyAccessExpression(at.expression) && at.expression.name.text === "map") return "map";
  return otherwise;
}
