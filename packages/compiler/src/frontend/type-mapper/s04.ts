// Statement slice of the former frontend/type-mapper.ts (split for
// maintainability; the directory barrel ../type-mapper.ts re-exports the
// original public surface). Statements are verbatim from the original file.
import { F64, PERF_NODE_TIMING_JSON_FIELDS, PERF_NODE_TIMING_MARKER, STRING } from "../../ir/ir.js";
import type { IrType } from "../../ir/ir.js";
import { isNodeTypesPath } from "../program.js";
import * as ts from "../ts7/adapter.js";
import { ShapeRegistry } from "./s01.js";
import { UnionRegistry } from "./s02.js";
import { PERF_NODE_TIMING_FIELDS, uvMetricsShape } from "./s03.js";
import type { TypeMapperCtx } from "./s05.js";
import { withUndefinedArm } from "./s23.js";



/** The record behind performance.nodeTiming (mapType): the timing
 * milestones as f64 fields in Node's key order, plus the uvMetricsInfo
 * record. The marker keeps the shape distinct from a structurally equal
 * user record and gives a dyn conversion the PerformanceNodeTiming
 * prototype. */
export function perfNodeTimingShape(shapes: ShapeRegistry, unions: UnionRegistry): string {
  return shapes.intern(
    [
      { name: PERF_NODE_TIMING_MARKER, type: withUndefinedArm(F64, unions)! },
      { name: "bootstrapComplete", type: F64 },
      { name: "duration", type: F64 },
      { name: "entryType", type: STRING },
      { name: "environment", type: F64 },
      { name: "idleTime", type: F64 },
      { name: "loopExit", type: F64 },
      { name: "loopStart", type: F64 },
      { name: "name", type: STRING },
      { name: "nodeStart", type: F64 },
      { name: "startTime", type: F64 },
      { name: "uvMetricsInfo", type: { kind: "record", shapeId: uvMetricsShape(shapes) } },
      { name: "v8Start", type: F64 },
    ],
    false,
    undefined,
    PERF_NODE_TIMING_FIELDS,
  );
}


/** toJSON()'s plain object over performance.nodeTiming: its fields without
 * uvMetricsInfo. */
export function perfNodeTimingJsonShape(shapes: ShapeRegistry): string {
  return shapes.intern(
    [
      { name: "bootstrapComplete", type: F64 },
      { name: "duration", type: F64 },
      { name: "entryType", type: STRING },
      { name: "environment", type: F64 },
      { name: "idleTime", type: F64 },
      { name: "loopExit", type: F64 },
      { name: "loopStart", type: F64 },
      { name: "name", type: STRING },
      { name: "nodeStart", type: F64 },
      { name: "startTime", type: F64 },
      { name: "v8Start", type: F64 },
    ],
    false,
    undefined,
    PERF_NODE_TIMING_JSON_FIELDS,
  );
}


/** performance.eventLoopUtilization()'s record, in Node's key order. */
export function eventLoopUtilizationShape(shapes: ShapeRegistry): string {
  return shapes.intern(
    [
      { name: "active", type: F64 },
      { name: "idle", type: F64 },
      { name: "utilization", type: F64 },
    ],
    false,
    undefined,
    ["idle", "active", "utilization"],
  );
}


export function isDeclaredInAmbientModule(d: ts.Declaration, name: string): boolean {
  let node: ts.Node | undefined = d.parent;
  while (node) {
    if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      const spec = node.name.text;
      return spec === name || spec === `node:${name}`;
    }
    node = node.parent;
  }
  return false;
}


/** True when the declaration's nearest enclosing namespace is `name`
 * (`declare global { namespace NodeJS { ... } }` — the NodeJS-global
 * interfaces @types/node declares outside any ambient module). */
export function isDeclaredInAmbientNamespace(d: ts.Declaration, name: string): boolean {
  let node: ts.Node | undefined = d.parent;
  while (node) {
    if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) {
      return node.name.text === name;
    }
    node = node.parent;
  }
  return false;
}


/** What a symbol's declarations prove about its provenance: which declaration
 * kinds it contributes to the standard library, and whether it belongs to the
 * shipped WebAssembly namespace or to node:url's legacy records. The mapper
 * asks these on every object type it maps, and each answer walks the
 * declarations and their ancestor chains. Every declaration of a symbol
 * carries that symbol's one name, so a declaration kind is a yes/no answer
 * and callers match the name themselves. */
export interface SymbolProvenance {
  /** Declares an interface in a standard-library file. */
  stdlibInterface: boolean;
  /** Declares an interface or a class in a standard-library file. */
  stdlibClass: boolean;
  /** Declares a standard-library interface outside @types/node. */
  libInterface: boolean;
  webAssembly?: boolean;
  legacyUrl?: boolean;
}


/** The answers provenanceOf has given, keyed by symbol. The lowering owns
 * one map through TypeMapperCtx.symbolProvenance; a symbol belongs to one
 * loaded program, so one island round shares the map across its passes
 * (lowering-facts.ts). */
export function newSymbolProvenanceMemo(): Map<ts.Symbol, SymbolProvenance> {
  return new Map();
}


/** A symbol's provenance, computed from its declarations alone: the answer
 * depends on which files declare it and nothing else, so it is the same for
 * every lowering pass of one loaded program (lowering-facts.ts shares the
 * memo). */
export function computeSymbolProvenance(
  psym: ts.Symbol,
  isStdlibFile: (sf: ts.SourceFile) => boolean,
): SymbolProvenance {
  let stdlibInterface = false;
  let stdlibClass = false;
  let libInterface = false;
  for (const decl of psym.declarations) {
    const file = ts.getSourceFileOfNode(decl);
    if (!isStdlibFile(file)) continue;
    if (ts.isInterfaceDeclaration(decl)) {
      stdlibInterface = true;
      stdlibClass = true;
      if (!isNodeTypesPath(file.fileName)) libInterface = true;
    } else if (ts.isClassDeclaration(decl)) {
      stdlibClass = true;
    }
  }
  return { stdlibInterface, stdlibClass, libInterface };
}


/** What provenanceOf needs: the shared memo, the stdlib classifier and the
 * verify-mode hit check (absent when the mode is off). Contexts built from a
 * Lowerer carry the hook too, so a hand-made ctx may omit it. */
export type SymbolProvenanceCtx = Pick<TypeMapperCtx, "isStdlibFile" | "symbolProvenance"> & {
  verifySymbolProvenance?: ((sym: ts.Symbol, answer: SymbolProvenance) => void) | undefined;
};


export function provenanceOf(psym: ts.Symbol, ctx: SymbolProvenanceCtx): SymbolProvenance {
  let bySymbol = ctx.symbolProvenance;
  if (bySymbol === undefined) {
    bySymbol = new Map();
    ctx.symbolProvenance = bySymbol;
  }
  let provenance = bySymbol.get(psym);
  if (provenance === undefined) {
    provenance = computeSymbolProvenance(psym, ctx.isStdlibFile);
    bySymbol.set(psym, provenance);
  } else ctx.verifySymbolProvenance?.(psym, provenance);
  return provenance;
}


/** Whether `type` is one of the stream spellings the general stream
 * representation (TypeMapperCtx.generalNodeStreams) maps differently:
 * NodeJS.ReadableStream / NodeJS.WritableStream, @types/node's
 * stream.Readable / stream.Writable, or the fallback declarations'
 * ChildStdin / ChildStdout. */
export function isGeneralNodeStreamInterface(
  type: ts.Type,
  ctx: Pick<TypeMapperCtx, "isStdlibFile">,
): boolean {
  const psym = type.getSymbol() ?? type.getAliasSymbol();
  if (psym === undefined) return false;
  return psym.declarations.some((d) => {
    if (!(ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d))) return false;
    if (!ctx.isStdlibFile(ts.getSourceFileOfNode(d))) return false;
    if (ts.symbolName(psym) === "ReadableStream" || ts.symbolName(psym) === "WritableStream")
      return ts.isInterfaceDeclaration(d) && isDeclaredInAmbientNamespace(d, "NodeJS");
    if (ts.symbolName(psym) === "ChildStdin" || ts.symbolName(psym) === "ChildStdout")
      return isDeclaredInAmbientModule(d, "child_process");
    return (
      (ts.symbolName(psym) === "Readable" || ts.symbolName(psym) === "Writable") &&
      isNodeTypesPath(ts.getSourceFileOfNode(d).fileName) &&
      isDeclaredInAmbientModule(d, "stream")
    );
  });
}


/** Whether any declaration of the symbol sits in the shipped WebAssembly
 * namespace (scriptc.d.ts). Like the declaration-kind walk, the answer is a
 * function of the declarations alone, so provenanceOf's shared memo can keep
 * it (SymbolProvenance.webAssembly). */
export function declaresWebAssemblyNamespace(
  declarations: readonly ts.Node[],
  isStdlibFile: (sf: ts.SourceFile) => boolean,
): boolean {
  return declarations.some(
    (d) =>
      isStdlibFile(ts.getSourceFileOfNode(d)) &&
      isDeclaredInAmbientNamespace(d as ts.Declaration, "WebAssembly"),
  );
}


/** A type declared in the shipped WebAssembly namespace (scriptc.d.ts):
 * its modules, instances, memories, tables, globals, error classes and the
 * Exports/Imports records. */
export function isWebAssemblyType(type: ts.Type, ctx: SymbolProvenanceCtx): boolean {
  const symbol = type.getAliasSymbol() ?? type.getSymbol();
  if (!symbol) return false;
  const provenance = provenanceOf(symbol, ctx);
  provenance.webAssembly ??= declaresWebAssemblyNamespace(symbol.declarations, ctx.isStdlibFile);
  return provenance.webAssembly;
}


/** True when a type contains a record anywhere (the trigger for the
 * shape-mismatch diagnostic SC2002 — non-record mismatches are tsc's or
 * the validator's business). */
export function containsRecord(t: IrType): boolean {
  switch (t.kind) {
    case "record":
      return true;
    case "array":
      return containsRecord(t.elem);
    case "func":
      return t.params.some(containsRecord) || containsRecord(t.ret);
    default:
      // Unions deliberately return false: a union-involving mismatch has its
      // own diagnostic (SC2003 via containsUnion), not the record one.
      return false;
  }
}


/** True when a type contains a union anywhere reachable without a registry
 * (the trigger for the union-mismatch diagnostic SC2003 — e.g. a value
 * narrowed to a SUB-union flowing into the full union's slot, which would
 * need a runtime re-tag). */
export function containsUnion(t: IrType): boolean {
  switch (t.kind) {
    case "union":
      return true;
    case "array":
      return containsUnion(t.elem);
    case "func":
      return t.params.some(containsUnion) || containsUnion(t.ret);
    default:
      return false;
  }
}


/** ts.Type → IrType. Returns null for anything outside the supported
 * surface; the caller (badType) classifies the shape and reports the
 * matching type fence — SC2005 generic signatures, SC2006 index
 * signatures, SC2007 overloads, SC2008 intersections, SC2009 component
 * fences, SC2020 library types, SC2001 for the remainder — with
 * checker.typeToString.
 *
 * Literal types are widened FIRST (`const x = 1` has type `1`, `true` has
 * type `true`; internally `boolean` is the union `true | false`) — mapping
 * without widening is the classic bug this function exists to centralize.
 *
 * `ctx.shapes` is the Lowerer's shape registry: object types over data
 * properties intern their canonical shape there and map to
 * `{ kind: "record", shapeId }`.
 */
/** Computes the program-wide IR name for a class declaration. Injected by
 * the Lowerer so type mapping and lowering agree on qualified names in
 * multi-file programs (two files may each declare `class Point`). */
export type ClassNamer = (decl: ts.ClassLikeDeclaration) => string;


/** Resolves a type-parameter ts.Type to a concrete IR type, or null when it
 * isn't one / isn't bound. Injected by the Lowerer while it instantiates a
 * generic function body (monomorphization): inside the body the checker
 * reports the UNSUBSTITUTED types (`T`, `T[]`, `{ v: T }`), so the
 * substitution has to happen inside mapType's recursion — carried by the
 * TypeMapperCtx exactly like ClassNamer. */
export type TypeParamResolver = (t: ts.Type) => IrType | null;


/** Resolves a type-parameter ts.Type to the CHECKER type it is bound to in
 * the current instantiation, or null. The ts-level twin of
 * TypeParamResolver, needed where the IR type has already lost information
 * mapType's widening discipline drops: `T[K]` inside a generic body resolves
 * through the BOUND checker types (K's literal names the property), which no
 * IrType binding can carry. */
export type TypeParamTsResolver = (t: ts.Type) => ts.Type | null;
