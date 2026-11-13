// Statement slice of the former frontend/type-mapper.ts (split for
// maintainability; the directory barrel ../type-mapper.ts re-exports the
// original public surface). Statements are verbatim from the original file.
import * as ts from "../ts7/adapter.js";
import { isDeclaredInAmbientModule, provenanceOf } from "./s04.js";
import type { SymbolProvenanceCtx } from "./s04.js";
import { MAP_TYPE_MAX_DEPTH } from "./s05.js";
import type { TypeMapperCtx } from "./s05.js";
import { activeWalk, walkStats } from "./s06.js";
import { PROGRESS_RECORD, PROGRESS_UNION, TypeWalk, WalkEntry, walkRefusals } from "./s07.js";



/** A recursive placeholder was minted or finished for `key`: the type maps
 * differently from now on, so no entry computed around an earlier mapping of
 * it serves again. */
export function walkRecursiveChanged(kind: number, key: ts.Type): void {
  const walk = activeWalk;
  if (walk === null) return;
  const earlier = walk.finished[kind]!.get(key);
  if (earlier === undefined) return;
  const last = earlier[earlier.length - 1]!;
  if (last > walk.staleBefore) walk.staleBefore = last;
}


/** The key of an entry that holds for one depth only. Entry keys are
 * non-negative; these are negative. */
export function depthEntryKey(key: number, depth: number): number {
  return -(key * MAP_TYPE_MAX_DEPTH + depth) - 1;
}


/** Whether `entry` is the answer mapping its type again would give now, at
 * `depth`, under `ctx`. */
export function walkEntryServes(
  walk: TypeWalk,
  entry: WalkEntry,
  depth: number,
  ctx: TypeMapperCtx,
): boolean {
  const refusal = walkEntryRefusal(walk, entry, depth, ctx);
  if (refusal < 0) return true;
  walk.refused++;
  if (walkStats) walkRefusals[refusal]!++;
  return false;
}


/** Why `entry` does not serve (an index into walkRefusals), or -1. */
export function walkEntryRefusal(
  walk: TypeWalk,
  entry: WalkEntry,
  depth: number,
  ctx: TypeMapperCtx,
): number {
  const spans = entry.spans;
  if (spans[0]! <= walk.staleBefore) return 0;
  if (
    depth !== entry.depth &&
    (entry.metDepthLimit || depth + entry.height + 1 >= MAP_TYPE_MAX_DEPTH)
  )
    return 1;
  if ((ctx.erasedMember?.outerConsulted ?? false) !== entry.outerConsulted) return 2;
  // By identity: a rank can be a reference whose value settles later.
  if (ctx.shapes.declaredOrderRank() !== entry.keyOrderRank) return 3;
  const deps = entry.deps;
  if (deps !== null) {
    for (const dep of deps) {
      const frame = dep.frame;
      if (walk.active[frame.kind]!.has(frame.key)) continue;
      if (dep.strict) return 4;
      if (frame.kind === PROGRESS_RECORD) {
        if (ctx.shapes.recursiveShapeFor(frame.key as ts.Type) === undefined) return 4;
      } else if (frame.kind === PROGRESS_UNION) {
        if (ctx.unions.recursiveUnionFor(frame.key as ts.Type) === undefined) return 4;
      } else {
        return 4;
      }
    }
  }
  for (const frame of walk.reentered) {
    // An earlier mapping of a type in progress now that started inside one
    // of the entry's spans: the entry holds that type mapped in full.
    // Both lists rise; a type mapped again and again has a long one, so each
    // span looks up the first earlier mapping that started at or after it.
    const earlier = frame.earlier!;
    for (let i = 0; i < spans.length; i += 2) {
      const from = spans[i]!;
      let low = 0;
      let high = earlier.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (earlier[middle]! < from) low = middle + 1;
        else high = middle;
      }
      if (low < earlier.length && earlier[low]! <= spans[i + 1]!) return 5;
    }
  }
  return -1;
}


/** node:url's legacy record interfaces: url.parse()'s Url instance (and
 * its two query-typed refinements), url.format()'s UrlObject input, the
 * URL form's URLFormatOptions, and urlToHttpOptions's result. The values
 * are checked-dynamic objects — Node's Url instance carries its class name
 * and null fields, format() reads any object's fields with JS truthiness,
 * and urlToHttpOptions answers a null-prototype object. */
export const LEGACY_URL_TYPES = new Set([
  "Url",
  "UrlObject",
  "UrlWithParsedQuery",
  "UrlWithStringQuery",
  "URLFormatOptions",
  "UrlHttpOptions",
]);


export function isLegacyUrlType(
  type: ts.Type,
  ctx: Pick<TypeMapperCtx, "checker" | "isStdlibFile" | "symbolProvenance">,
): boolean {
  const symbol = type.getAliasSymbol() ?? type.getSymbol();
  return isLegacyUrlSymbol(symbol, ctx);
}


/** A symbol declared as one of node:url's legacy record interfaces, or as
 * a member of one. */
export function isLegacyUrlSymbol(
  symbol: ts.Symbol | null | undefined,
  ctx: SymbolProvenanceCtx,
): boolean {
  if (!symbol) return false;
  const provenance = provenanceOf(symbol, ctx);
  provenance.legacyUrl ??= declaresLegacyUrl(symbol.declarations, ctx);
  return provenance.legacyUrl;
}


/** Whether any declaration of the symbol is one of node:url's legacy record
 * interfaces (or a member of one). A function of the declarations alone,
 * stored as SymbolProvenance.legacyUrl in provenanceOf's shared memo. */
export function declaresLegacyUrl(
  declarations: readonly ts.Node[],
  ctx: Pick<TypeMapperCtx, "isStdlibFile">,
): boolean {
  for (const d of declarations) {
    if (!ctx.isStdlibFile(ts.getSourceFileOfNode(d))) continue;
    let family = false;
    for (let n: ts.Node | undefined = d; n; n = n.parent) {
      if (ts.isInterfaceDeclaration(n) && LEGACY_URL_TYPES.has(n.name.text)) family = true;
      if (ts.isModuleDeclaration(n) && ts.isStringLiteral(n.name)) {
        if (family && (n.name.text === "url" || n.name.text === "node:url")) return true;
        break;
      }
    }
  }
  return false;
}


/** os.constants and its groups — @types/node's `namespace constants`
 * (errno, dlopen, priority) and SignalConstants, and the fallback's twins:
 * the runtime's checked-dynamic constants object, whose members vary by
 * platform. */
/** True for node:path's platform-specific namespaces ("path/posix",
 * "path/win32"). Their values are the path module object, so they map to
 * the checked-dynamic module value (see pathModuleValue in
 * lowering/lower-builtin-values.ts), not to a module declaration. */
export function isPathPlatformNamespaceId(moduleId: string): boolean {
  return moduleId === "builtin:path/posix" || moduleId === "builtin:path/win32";
}


/** @types/node's `PlatformPath` interface (module "path"): the declared type
 * of `path.posix`/`path.win32`. Its values are the path module object. */
export function isPlatformPathType(type: ts.Type, ctx: Pick<TypeMapperCtx, "isStdlibFile">): boolean {
  const sym = type.getSymbol();
  if (sym === undefined || ts.symbolName(sym) !== "PlatformPath") return false;
  return sym.declarations.some(
    (decl) =>
      ts.isInterfaceDeclaration(decl) &&
      ctx.isStdlibFile(ts.getSourceFileOfNode(decl)) &&
      isDeclaredInAmbientModule(decl, "path"),
  );
}


export function isOsConstantsType(
  type: ts.Type,
  ctx: Pick<TypeMapperCtx, "checker" | "isStdlibFile">,
): boolean {
  return (
    isOsConstantsSymbol(type.getAliasSymbol(), ctx, true) ||
    isOsConstantsSymbol(type.getSymbol(), ctx, true)
  );
}


/** A symbol declared as os.constants or one of its groups (a namespace, or
 * with `types`, the SignalConstants alias; without it, the `signals`
 * constant). The binding-symbol form needs no type query. */
export function isOsConstantsSymbol(
  symbol: ts.Symbol | null | undefined,
  ctx: Pick<TypeMapperCtx, "checker" | "isStdlibFile">,
  types = false,
): boolean {
  return isBuiltinConstantsSymbol(symbol, ctx, "os", types);
}


/** node:module's `constants` and its `compileCacheStatus` group, as
 * @types/node and the fallback declare them (namespaces): the runtime's
 * frozen checked-dynamic constants object. Its members are the same four
 * numbers on every platform. */
export function isModuleConstantsType(
  type: ts.Type,
  ctx: Pick<TypeMapperCtx, "checker" | "isStdlibFile">,
): boolean {
  return (
    isBuiltinConstantsSymbol(type.getAliasSymbol(), ctx, "module", false) ||
    isBuiltinConstantsSymbol(type.getSymbol(), ctx, "module", false)
  );
}


/** A symbol declared as `constants`, or a namespace inside it, of the
 * builtin module `module` (os or module). */
export function isBuiltinConstantsSymbol(
  symbol: ts.Symbol | null | undefined,
  ctx: Pick<TypeMapperCtx, "checker" | "isStdlibFile">,
  module: "os" | "module",
  types: boolean,
): boolean {
  if (!symbol) return false;
  for (const d of symbol.declarations) {
    const os = module === "os";
    const alias = os && types && ts.isTypeAliasDeclaration(d) && d.name.text === "SignalConstants";
    const signals =
      os &&
      !types &&
      ts.isVariableDeclaration(d) &&
      ts.isIdentifier(d.name) &&
      d.name.text === "signals";
    if (
      !(alias || signals || ts.isModuleDeclaration(d)) ||
      !ctx.isStdlibFile(ts.getSourceFileOfNode(d))
    )
      continue;
    let inConstants = ts.isModuleDeclaration(d) && d.name.text === "constants";
    for (let n: ts.Node | undefined = d.parent; n; n = n.parent) {
      if (!ts.isModuleDeclaration(n)) continue;
      if (ts.isStringLiteral(n.name)) {
        if ((n.name.text === module || n.name.text === `node:${module}`) && (alias || inConstants))
          return true;
        break;
      }
      if (n.name.text === "constants") inConstants = true;
    }
  }
  return false;
}


/** worker_threads' Worker and MessagePort: owned runtime handles that keep
 * their live object representation (DYN) wherever they are stored. */
export function isWorkerHandleSymbol(
  symbol: ts.Symbol | undefined,
  ctx: Pick<TypeMapperCtx, "checker" | "isStdlibFile">,
): boolean {
  return (
    ((symbol !== undefined && ts.symbolName(symbol) === "Worker") ||
      (symbol !== undefined && ts.symbolName(symbol) === "MessagePort") ||
      (symbol !== undefined && ts.symbolName(symbol) === "MessageChannel") ||
      (symbol !== undefined && ts.symbolName(symbol) === "BroadcastChannel")) &&
    symbol.declarations.some(
      (d) =>
        (ts.isClassDeclaration(d) || ts.isInterfaceDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientModule(d, "worker_threads"),
    )
  );
}


/** The `{ message: any }` object type (or its union with undefined) that
 * worker_threads declares as receiveMessageOnPort's result. */
/** A union of dns lookup option bags with numbers and nullish values that
 * includes LookupAllOptions (whose `all: true` arm has no record form). */
export function isLookupOptionsUnion(type: ts.Type, ctx: Pick<TypeMapperCtx, "isStdlibFile">): boolean {
  if (!type.isUnionType()) return false;
  let all = false;
  for (const member of ts.constituentTypes(type)) {
    if (member.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined))
      continue;
    const symbol = member.getSymbol();
    if (
      symbol === undefined ||
      !/^Lookup(One|All)?Options$/.test(ts.symbolName(symbol)) ||
      !symbol.declarations.some((d) => ctx.isStdlibFile(ts.getSourceFileOfNode(d)))
    )
      return false;
    if (ts.symbolName(symbol) === "LookupAllOptions") all = true;
  }
  return all;
}


/** The binary and stream members of fetch's BodyInit (undici-types):
 * NodeJS.ArrayBufferView expands to the typed arrays and DataView. */
export const FETCH_BODY_MEMBERS: ReadonlySet<string> = new Set([
  "ArrayBuffer",
  "SharedArrayBuffer",
  "AsyncIterable",
  "Iterable",
  "Blob",
  "FormData",
  "URLSearchParams",
  "ReadableStream",
  "DataView",
  "Buffer",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float16Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
]);


/** fetch's request body type, BodyInit, however TypeScript spells it
 * (`RequestInit["body"]`, `NonNullable<...>`, an optional member): a
 * union of strings, the stdlib binary and stream types and nullish
 * values that includes both FormData and URLSearchParams. Native fetch
 * reads such a body at run time, so it rides checked-dynamic storage. */
export function isFetchBodyUnion(type: ts.Type, ctx: Pick<TypeMapperCtx, "isStdlibFile">): boolean {
  if (!type.isUnionType()) return false;
  let formData = false;
  let searchParams = false;
  for (const member of ts.constituentTypes(type)) {
    if (member.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined))
      continue;
    const symbol = member.getSymbol();
    if (
      symbol === undefined ||
      !FETCH_BODY_MEMBERS.has(ts.symbolName(symbol)) ||
      !symbol.declarations.some((d) => ctx.isStdlibFile(ts.getSourceFileOfNode(d)))
    )
      return false;
    if (ts.symbolName(symbol) === "FormData") formData = true;
    if (ts.symbolName(symbol) === "URLSearchParams") searchParams = true;
  }
  return formData && searchParams;
}
