import { dirname } from "node:path";
import ts from "typescript";
import { Manifest } from "@noon/contracts";

type ManifestProp = Manifest["components"][number]["props"][number];
type PropType = ManifestProp["type"];

/**
 * Reads a design system's entry file and describes every exported component: its props, their
 * types, which are required, their defaults, and whether it takes children.
 *
 * Two passes, because the information lives in two places (learning-tests/ts-manifest):
 *  - the TYPE CHECKER resolves prop types through aliases, Omit<> and imports;
 *  - the SYNTAX TREE has the defaults, which are values (`{ gap = 8 }`) and so not in any type.
 */
export function extractManifest(entryFile: string): Manifest {
  const program = ts.createProgram([entryFile], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const entry = program.getSourceFile(entryFile);
  const moduleSymbol = entry && checker.getSymbolAtLocation(entry);
  if (!entry || !moduleSymbol) throw new Error(`cannot read design system entry: ${entryFile}`);
  const ownDirectory = dirname(entryFile);

  const components = checker
    .getExportsOfModule(moduleSymbol)
    .map((exported) => (exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported))
    .flatMap((symbol) => {
      // Only values with a capitalised name can be components; exported types and helpers are skipped.
      if ((symbol.flags & ts.SymbolFlags.Value) === 0 || !/^[A-Z]/.test(symbol.name)) return [];
      const fn = componentFunction(symbol);
      // Anything else that LOOKS like a component must not vanish quietly: a manifest that silently
      // lacks a component is a wrong answer nobody notices until the canvas cannot place it.
      if (!fn) throw new Error(`${symbol.name}: exported with a capitalised name but not a function component this extractor understands (function declaration, arrow function or function expression). Rename it, or teach the extractor.`);
      return [describeComponent(symbol.name, fn)];
    });

  /** `function C(props)`, `const C = (props) => ...` and `const C = function (props) {...}`. */
  function componentFunction(symbol: ts.Symbol): ts.SignatureDeclaration | undefined {
    for (const declaration of symbol.declarations ?? []) {
      if (ts.isFunctionDeclaration(declaration)) return declaration;
      const init = ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined;
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) return init;
    }
    return undefined;
  }

  function describeComponent(name: string, declaration: ts.SignatureDeclaration): Manifest["components"][number] {
    const parameter = declaration.parameters[0];
    if (!parameter) return { name, acceptsChildren: false, props: [] };
    const defaults = readDefaults(parameter);
    let acceptsChildren = false;
    const props: ManifestProp[] = [];
    for (const prop of checker.getTypeAtLocation(parameter).getProperties()) {
      // Only props the design system declares itself. A component typed with
      // React.ComponentProps<'button'> would otherwise drag in ~290 DOM attributes.
      const declaredHere = prop.declarations?.some((d) => d.getSourceFile().fileName.startsWith(ownDirectory));
      if (!declaredHere) continue;
      if (prop.name === "children") {
        acceptsChildren = true;
        continue;
      }
      const type = classify(checker.getTypeOfSymbol(prop));
      if (!type) {
        throw new Error(`${name}.${prop.name}: unsupported prop type "${checker.typeToString(checker.getTypeOfSymbol(prop))}". The canvas can edit strings, numbers, booleans and string-literal unions.`);
      }
      const fallback = defaults.get(prop.name);
      props.push({
        name: prop.name,
        type,
        // "Optional" is a flag on the property. Do NOT ask whether the type includes undefined:
        // ReactNode includes undefined and a required `children: ReactNode` is still required.
        required: (prop.flags & ts.SymbolFlags.Optional) === 0,
        ...(fallback === undefined ? {} : { default: fallback }),
      });
    }
    return { name, acceptsChildren, props: props.sort(byName) };
  }

  /** string | number | boolean | a union of string literals; `undefined` (from `?`) is ignored. */
  function classify(type: ts.Type): PropType | undefined {
    const members = (type.isUnion() ? type.types : [type]).filter((t) => (t.flags & ts.TypeFlags.Undefined) === 0);
    if (members.length > 0 && members.every((t) => t.isStringLiteral())) {
      return { kind: "enum", options: members.flatMap((t) => (t.isStringLiteral() ? [t.value] : [])).sort() };
    }
    // `boolean` is itself the union `true | false`, so it arrives as two literal members.
    if (members.length > 0 && members.every((t) => (t.flags & ts.TypeFlags.BooleanLike) !== 0)) return { kind: "boolean" };
    if (members.length === 1 && members[0] && (members[0].flags & ts.TypeFlags.String) !== 0) return { kind: "string" };
    if (members.length === 1 && members[0] && (members[0].flags & ts.TypeFlags.Number) !== 0) return { kind: "number" };
    return undefined;
  }

  return Manifest.parse({ version: 1, components: components.sort(byName) });
}

/** Defaults from `function C({ variant = "primary", gap = 8, disabled = false })`. Literals only. */
function readDefaults(parameter: ts.ParameterDeclaration): Map<string, string | number | boolean> {
  const defaults = new Map<string, string | number | boolean>();
  if (!ts.isObjectBindingPattern(parameter.name)) return defaults;
  for (const element of parameter.name.elements) {
    const init = element.initializer;
    const key = (element.propertyName ?? element.name).getText();
    if (!init) continue;
    if (ts.isStringLiteral(init)) defaults.set(key, init.text);
    else if (ts.isNumericLiteral(init)) defaults.set(key, Number(init.text));
    else if (init.kind === ts.SyntaxKind.TrueKeyword) defaults.set(key, true);
    else if (init.kind === ts.SyntaxKind.FalseKeyword) defaults.set(key, false);
  }
  return defaults;
}

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name);

/** Stable text: sorted content, fixed indentation, trailing newline. Regenerate + compare = drift check. */
export const serializeManifest = (manifest: Manifest): string => `${JSON.stringify(manifest, null, 2)}\n`;
