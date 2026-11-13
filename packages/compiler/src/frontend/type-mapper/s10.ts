// Statement slice of the former frontend/type-mapper.ts (split for
// maintainability; the directory barrel ../type-mapper.ts re-exports the
// original public surface). Statements are verbatim from the original file.
import { DYN } from "../../ir/ir.js";
import type { IrType } from "../../ir/ir.js";
import { isJsSourceFile } from "../program.js";
import * as ts from "../ts7/adapter.js";
import type { TypeMapperCtx } from "./s05.js";
import { mapTypeDepth, mapTypeEntry } from "./s06.js";
import { FETCH_HANDLE_NAMES } from "./s09.js";



/** The native fetch handles (Headers, Request, Response, AbortController,
 * AbortSignal), optionally in arrays or with null/undefined: checked-dynamic
 * handles wherever they are stored, like the worker handles above. */
export function isFetchHandleType(
  type: ts.Type,
  ctx: Pick<TypeMapperCtx, "checker" | "isStdlibFile">,
): boolean {
  const members = type.isUnionType() ? ts.constituentTypes(type) : [type];
  let handle = false;
  for (const member of members) {
    if (member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) continue;
    if (ctx.checker.isArrayType(member)) {
      const element = ctx.checker.getTypeArguments(member as ts.TypeReference)[0];
      if (element === undefined || !isFetchHandleType(element, ctx)) return false;
    } else {
      const symbol = member.getSymbol();
      if (
        !symbol ||
        !FETCH_HANDLE_NAMES.has(ts.symbolName(symbol)) ||
        !symbol.declarations.some(
          (d) =>
            (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
            ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
        )
      )
        return false;
    }
    handle = true;
  }
  return handle;
}


/** The array type a class declared `extends Array` maps to (its base type,
 * `T[]`), or null for every other class. */
export function arrayClassBaseType(
  classDecl: ts.ClassLikeDeclaration,
  instance: ts.Type,
  ctx: TypeMapperCtx,
): IrType | null {
  const heritage = classDecl.heritageClauses?.nodes.find(
    (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
  )?.types?.nodes[0];
  if (heritage === undefined || !ts.isIdentifier(heritage.expression)) return null;
  if (heritage.expression.text !== "Array") return null;
  // The polymorphic `this` type of the class names the class's own type.
  const symbol = instance.getSymbol();
  const declared =
    (instance.flags & ts.TypeFlags.TypeParameter) !== 0 && symbol !== undefined
      ? ctx.checker.getDeclaredTypeOfSymbol(symbol)
      : instance;
  if ((declared.flags & ts.TypeFlags.Object) === 0) return null;
  const target = declared.isTypeReference() ? (declared.getTarget() ?? declared) : declared;
  const bases = ctx.checker.getBaseTypes(target as ts.InterfaceType);
  const base = bases[0];
  if (base === undefined || !ctx.checker.isArrayType(base)) return null;
  const mapped = mapType(base, ctx);
  if (mapped?.kind === "array") return mapped;
  // `extends Array` in JavaScript reads `any[]`: dyn elements (the class's
  // arrayClassBase).
  return isJsSourceFile(ts.getSourceFileOfNode(classDecl)) ? { kind: "array", elem: DYN } : null;
}


export function mapType(type: ts.Type, ctx: TypeMapperCtx): IrType | null {
  const shadow = ctx.canonShadow;
  if (shadow === undefined || mapTypeDepth !== 0) return mapTypeEntry(type, ctx);
  // Shadow mode observes every successful top-level mapping, including the
  // intrinsic primitives, local class values and memo hits that return
  // before the mapping proper.
  const mapped = mapTypeEntry(type, ctx);
  if (mapped !== null) shadow(type, mapped, ctx);
  return mapped;
}


/** How many mappings reached a primitive constructor's own function type
 * (noteConstructorFunctionType): a frame that moved it holds such a type. */
export let constructorFunctionMappings = 0;


/** A primitive constructor type mapped to the constructor's own function
 * type (TypeMapperCtx.onConstructorFunctionType). */
export function noteConstructorFunctionType(ctx: TypeMapperCtx): void {
  constructorFunctionMappings++;
  ctx.onConstructorFunctionType?.();
}


/** An answer taken from the memo reports the constructor function type its
 * mapping reached (TypeMapperCtx.constructorFunctionMemo). */
export function noteConstructorFunctionMemo(ctx: TypeMapperCtx, memoKey: number): void {
  const reached = ctx.constructorFunctionMemo;
  if (reached !== undefined && reached.size > 0 && reached.has(memoKey))
    noteConstructorFunctionType(ctx);
}


/** Local class types need the enclosing specialization's registered layout.
 * Static-block classes are sent through the same hook for an explicit fence. */
export function classExprNeedsContext(decl: ts.ClassLikeDeclaration): boolean {
  for (
    let p: ts.Node | undefined = decl.parent;
    p !== undefined && !ts.isSourceFile(p);
    p = p.parent
  ) {
    if (ts.isFunctionLike(p) || ts.isClassStaticBlockDeclaration(p)) return true;
  }
  return false;
}


/** True for the type of a TypeScript object literal with no contextual
 * type (`const options = { ...location, path }`) that spreads a value
 * mapping to the checked dynamic (a stdlib options type such as
 * http.RequestOptions). A literal with a contextual type is built in that
 * type's representation instead, and JavaScript literals keep their own
 * rules. */
export function spreadsCheckedDynamic(symbol: ts.Symbol | undefined, ctx: TypeMapperCtx): boolean {
  if (symbol === undefined || (symbol.flags & ts.SymbolFlags.ObjectLiteral) === 0) return false;
  const decl = symbol.declarations[0];
  if (decl === undefined || !ts.isObjectLiteralExpression(decl)) return false;
  if (isJsSourceFile(ts.getSourceFileOfNode(decl))) return false;
  if (ctx.checker.getContextualType(decl)) return false;
  return decl.properties.nodes.some(
    (prop) =>
      ts.isSpreadAssignment(prop) &&
      mapType(ctx.checker.getTypeAtLocation(prop.expression), ctx)?.kind === "dyn",
  );
}


/** The members a hand-written writable-pipe interface may name: the child
 * stdin surface a `Pipe { write(chunk: string): boolean; end(): void }`
 * declares (see the childWriter mapping in mapTypeInner). */
export const CHILD_WRITER_MEMBERS: ReadonlySet<string> = new Set([
  "write",
  "end",
  "destroy",
  "writable",
  "on",
  "once",
  "off",
  "removeListener",
]);
