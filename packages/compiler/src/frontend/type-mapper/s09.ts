// Statement slice of the former frontend/type-mapper.ts (split for
// maintainability; the directory barrel ../type-mapper.ts re-exports the
// original public surface). Statements are verbatim from the original file.
import type { IrType } from "../../ir/ir.js";
import * as ts from "../ts7/adapter.js";
import { isDeclaredInAmbientModule, provenanceOf } from "./s04.js";
import { genChannels } from "./s05.js";
import type { TypeMapperCtx } from "./s05.js";
import { isWorkerHandleSymbol } from "./s08.js";
import { mapType } from "./s10.js";
import { genResultRecord } from "./s23.js";



/** A mapped object type (Omit, Pick, Partial) whose members all come from
 * one stdlib interface that maps to the checked dynamic. */
export function isDynInterfaceSubset(type: ts.Type, ctx: TypeMapperCtx): boolean {
  if (!(type.flags & ts.TypeFlags.Object) || type.isClassOrInterface()) return false;
  const alias = type.getAliasSymbol();
  if (alias === undefined) return false;
  const props = ctx.checker.getPropertiesOfType(type);
  if (props.length === 0) return false;
  let owner: ts.InterfaceDeclaration | undefined;
  for (const prop of props) {
    const decl = prop.declarations[0];
    const parent = decl?.parent;
    if (
      parent === undefined ||
      !ts.isInterfaceDeclaration(parent) ||
      !ctx.isStdlibFile(ts.getSourceFileOfNode(parent)) ||
      (owner !== undefined && owner !== parent)
    )
      return false;
    owner = parent;
  }
  return (
    owner !== undefined && mapType(ctx.checker.getTypeAtLocation(owner.name), ctx)?.kind === "dyn"
  );
}


/** The lib's homomorphic utility aliases that keep a subset or a
 * re-attributed copy of their first argument's members. */
export const MEMBER_SUBSET_ALIASES: ReadonlySet<string> = new Set([
  "Omit",
  "Pick",
  "Partial",
  "Required",
  "Readonly",
]);


export function isMemberSubsetAlias(symbol: ts.Symbol, ctx: TypeMapperCtx): boolean {
  return (
    MEMBER_SUBSET_ALIASES.has(ts.symbolName(symbol)) &&
    symbol.declarations.some((d) => ctx.isStdlibFile(ts.getSourceFileOfNode(d)))
  );
}


/** The type whose members a member-subset alias keeps (`Omit<T, K>`'s `T`).
 * A program alias of one (`type Brief = Pick<T, K>`) is the alias the
 * checker reports for the type, so it is followed through its declaration.
 * Null for every other type. */
export function memberSubsetSource(type: ts.Type, alias: ts.Symbol, ctx: TypeMapperCtx): ts.Type | null {
  if (isMemberSubsetAlias(alias, ctx)) return type.getAliasTypeArguments()?.[0] ?? null;
  const declaration = programTypeAliasOf(alias, ctx);
  return declaration === null ? null : memberSubsetSourceNode(declaration.type, ctx, 0);
}


export function memberSubsetSourceNode(
  node: ts.TypeNode,
  ctx: TypeMapperCtx,
  depth: number,
): ts.Type | null {
  if (depth > 8) return null;
  while (ts.isParenthesizedTypeNode(node)) node = node.type;
  if (!ts.isTypeReferenceNode(node)) return null;
  const symbol = ctx.checker.getSymbolAtLocation(node.typeName);
  if (symbol === undefined) return null;
  if (isMemberSubsetAlias(symbol, ctx)) {
    const sourceNode = node.typeArguments?.nodes[0];
    return sourceNode === undefined ? null : ctx.checker.getTypeFromTypeNode(sourceNode);
  }
  const declaration = programTypeAliasOf(symbol, ctx);
  return declaration === null ? null : memberSubsetSourceNode(declaration.type, ctx, depth + 1);
}


/** The type alias declaration a symbol has outside the standard library. */
export function programTypeAliasOf(symbol: ts.Symbol, ctx: TypeMapperCtx): ts.TypeAliasDeclaration | null {
  for (const declaration of symbol.declarations) {
    if (
      ts.isTypeAliasDeclaration(declaration) &&
      !ctx.isStdlibFile(ts.getSourceFileOfNode(declaration))
    )
      return declaration;
  }
  return null;
}


/** Whether `type` is the instance type of a class the standard library
 * provides: its symbol is declared there as a class, or as an interface
 * beside a value of the same name (`interface Response` with `declare var
 * Response`). A pure library interface (an options dictionary such as
 * `RequestInit`) has no value side and is not one. */
export function isBuiltinClassInstanceType(type: ts.Type, ctx: TypeMapperCtx): boolean {
  if ((type.flags & ts.TypeFlags.Object) === 0) return false;
  const symbol = type.getSymbol();
  if (symbol === undefined) return false;
  if (
    (symbol.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Variable | ts.SymbolFlags.Function)) ===
    0
  )
    return false;
  if (!provenanceOf(symbol, ctx).stdlibClass) return false;
  // `typeof C`, the class value, shares the class symbol.
  return ctx.checker.getConstructSignatures(type).length === 0;
}


/** The built-in class instance type a program type is derived from, or
 * null: an interface that extends the class or a member subset of it
 * (`Omit`, `Pick`, `Partial`, `Required`, `Readonly`), such a subset
 * itself, an intersection of one of these with plain object refinements,
 * and any of these over another derived type. Exactly one class may stand
 * behind the type; other heritage must be program interfaces with no class
 * behind them. */
export function builtinClassViewBase(type: ts.Type, ctx: TypeMapperCtx, depth = 0): ts.Type | null {
  if (depth > 8) return null;
  const { checker } = ctx;
  const through = (part: ts.Type): ts.Type | null =>
    isBuiltinClassInstanceType(part, ctx) ? part : builtinClassViewBase(part, ctx, depth + 1);
  if (type.isIntersectionType()) {
    let base: ts.Type | null = null;
    for (const part of ts.constituentTypes(type)) {
      const found = through(part);
      if (found !== null) {
        if (base !== null && base !== found) return null;
        base = found;
        continue;
      }
      const partSymbol = part.getSymbol();
      if (
        (part.flags & ts.TypeFlags.Object) === 0 ||
        checker.getCallSignatures(part).length > 0 ||
        checker.getConstructSignatures(part).length > 0 ||
        (partSymbol !== undefined && (partSymbol.flags & ts.SymbolFlags.Class) !== 0)
      )
        return null;
    }
    return base;
  }
  if ((type.flags & ts.TypeFlags.Object) === 0) return null;
  const alias = type.getAliasSymbol();
  if (alias !== undefined) {
    const source = memberSubsetSource(type, alias, ctx);
    if (source !== null) return through(source);
  }
  const symbol = type.getSymbol();
  if (
    symbol === undefined ||
    (symbol.flags & ts.SymbolFlags.Interface) === 0 ||
    (symbol.flags & ts.SymbolFlags.Class) !== 0 ||
    !type.isClassOrInterface() ||
    symbol.declarations.some((d) => ctx.isStdlibFile(ts.getSourceFileOfNode(d)))
  )
    return null;
  let base: ts.Type | null = null;
  for (const parent of checker.getBaseTypes(type)) {
    const found = through(parent);
    if (found === null) continue;
    if (base !== null && base !== found) return null;
    base = found;
  }
  return base;
}


/** The representation of a type derived from a built-in class whose values
 * are opaque handles: the class's own (the checked-dynamic value for the
 * fetch handles, a handle kind for sockets, servers and process streams).
 * Classes with a native layout of their own (errors, emitters, dates,
 * collections) keep the mapping they have. */
export function mapBuiltinClassView(type: ts.Type, ctx: TypeMapperCtx): IrType | null {
  const base = builtinClassViewBase(type, ctx);
  if (base === null) return null;
  const mapped = mapType(base, ctx);
  if (mapped === null) return null;
  return mapped.kind === "dyn" || BUILTIN_HANDLE_KINDS.has(mapped.kind) ? mapped : null;
}


/** The IR kinds of the opaque runtime handles. process.stdout's own type is
 * the refined intersection `WriteStream & { fd: 1 }`, so the scalar stream
 * kind is one of them. */
export const BUILTIN_HANDLE_KINDS: ReadonlySet<string> = new Set([
  "netServer",
  "netSocket",
  "httpReq",
  "httpRes",
  "httpClientReq",
  "dgramSocket",
  "childWriter",
  "procStream",
]);


/** fetch's HeadersInit (undici-types): a union of the stdlib Headers
 * class with header-pair arrays and/or a header record, plus nullish
 * values. Native fetch reads it at run time like the init around it. */
export function isFetchHeadersUnion(type: ts.Type, ctx: Pick<TypeMapperCtx, "isStdlibFile">): boolean {
  if (!type.isUnionType()) return false;
  let headers = false;
  let other = false;
  for (const member of ts.constituentTypes(type)) {
    if (member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) continue;
    const symbol = member.getSymbol();
    if (
      symbol !== undefined &&
      ts.symbolName(symbol) === "Headers" &&
      symbol.declarations.some((d) => ctx.isStdlibFile(ts.getSourceFileOfNode(d)))
    ) {
      headers = true;
      continue;
    }
    const alias = ts.symbolNameOf(member.getAliasSymbol());
    if (
      (symbol !== undefined && ts.symbolName(symbol) === "Array") ||
      (symbol !== undefined && ts.symbolName(symbol) === "ReadonlyArray") ||
      alias === "Record" ||
      alias === "HeaderRecord"
    ) {
      other = true;
      continue;
    }
    return false;
  }
  return headers && other;
}


export function isReceiveMessageResult(
  type: ts.Type,
  ctx: Pick<TypeMapperCtx, "checker" | "isStdlibFile">,
): boolean {
  const members = type.isUnionType() ? ts.constituentTypes(type) : [type];
  let found = false;
  for (const member of members) {
    if (member.flags & ts.TypeFlags.Undefined) continue;
    const decl = member.getSymbol() ? member.getSymbol()!.declarations[0] : undefined;
    let fn: ts.Node | undefined = decl?.parent;
    while (fn && ts.isUnionTypeNode(fn)) fn = fn.parent;
    if (
      !decl ||
      !ts.isTypeLiteralNode(decl) ||
      !fn ||
      !ts.isFunctionDeclaration(fn) ||
      fn.name?.text !== "receiveMessageOnPort" ||
      !ctx.isStdlibFile(ts.getSourceFileOfNode(decl)) ||
      !isDeclaredInAmbientModule(fn, "worker_threads")
    ) {
      return false;
    }
    found = true;
  }
  return found;
}


/** events.on's iterator result (`{ value, done }`): the fallback
 * declaration spells next/return/throw's answer as a type literal inside
 * `Promise<...>` on EventEmitterAsyncIterator, and the runtime builds that
 * object, so the result is a checked-dynamic value like the iterator
 * itself (its `value` holds the event's argument array). */
export function isEventsIteratorResult(
  type: ts.Type,
  ctx: Pick<TypeMapperCtx, "checker" | "isStdlibFile">,
): boolean {
  const sym = type.getSymbol();
  if (sym === undefined) return false;
  return sym.declarations.some((decl) => {
    if (!ts.isTypeLiteralNode(decl)) return false;
    const promise = decl.parent;
    if (!ts.isTypeReferenceNode(promise)) return false;
    const method = promise.parent;
    const cls = method?.parent;
    return (
      method !== undefined &&
      (method.kind === ts.SyntaxKind.MethodDeclaration ||
        method.kind === ts.SyntaxKind.MethodSignature) &&
      cls !== undefined &&
      ts.isClassDeclaration(cls) &&
      cls.name?.text === "EventEmitterAsyncIterator" &&
      ctx.isStdlibFile(ts.getSourceFileOfNode(decl)) &&
      isDeclaredInAmbientModule(cls, "events")
    );
  });
}


/** True for a type built only from worker handles, null/undefined, and
 * arrays of those: values that keep the live DYN representation. */
export function isWorkerHandleType(
  type: ts.Type,
  ctx: Pick<TypeMapperCtx, "checker" | "isStdlibFile">,
): boolean {
  const members = type.isUnionType() ? ts.constituentTypes(type) : [type];
  let handle = false;
  for (const member of members) {
    if (member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) continue;
    if (ctx.checker.isArrayType(member)) {
      const element = ctx.checker.getTypeArguments(member as ts.TypeReference)[0];
      if (element === undefined || !isWorkerHandleType(element, ctx)) return false;
    } else if (!isWorkerHandleSymbol(member.getSymbol(), ctx)) {
      return false;
    }
    handle = true;
  }
  return handle;
}


/** The return annotation of an `async *` declaration spelled with the
 * protocol interfaces the generator object implements —
 * `AsyncIterator<T>`, `AsyncIterableIterator<T>` or `AsyncIterable<T>` (pi's
 * `async *[Symbol.asyncIterator](): AsyncIterator<T>`): the body always
 * produces an async generator, so the declaration maps exactly like an
 * `AsyncGenerator<T, TReturn, TNext>` annotation. Values of these types
 * elsewhere stay unmapped (they can hold any object implementing the
 * protocol). Null when the annotation is not one of them. */
export function mapAsyncGeneratorAnnotation(type: ts.Type, ctx: TypeMapperCtx): IrType | null {
  const { checker } = ctx;
  const symbol = type.getSymbol();
  if (
    !symbol ||
    !["AsyncIterator", "AsyncIterableIterator", "AsyncIterable"].includes(ts.symbolName(symbol)) ||
    !symbol.declarations.some(
      (d) => ts.isInterfaceDeclaration(d) && ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  )
    return null;
  const args = checker.getTypeArguments(type as ts.TypeReference);
  const channels = genChannels(args[0], args[1], args[2], ctx);
  if (!channels) return null;
  if (!genResultRecord(channels.yieldT, channels.retT, ctx.shapes, ctx.unions)) return null;
  return { kind: "generator", async: true, ...channels };
}


export const FETCH_HANDLE_NAMES: ReadonlySet<string> = new Set([
  "Headers",
  "Request",
  "Response",
  "AbortController",
  "AbortSignal",
  "PerformanceObserver",
  "PerformanceObserverEntryList",
]);
