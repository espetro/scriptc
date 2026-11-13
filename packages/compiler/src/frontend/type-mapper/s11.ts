// Statement slice of the former frontend/type-mapper.ts (split for
// maintainability; the directory barrel ../type-mapper.ts re-exports the
// original public surface). Statements are verbatim from the original file.
import { BOOL, DYN, F64, RUNTIME_EMITTER_CLASS, RUNTIME_ERROR_CLASSES, STRING } from "../../ir/ir.js";
import type { IrType } from "../../ir/ir.js";
import * as ts from "../ts7/adapter.js";
import { isDeclaredInAmbientModule, isDeclaredInAmbientNamespace } from "./s04.js";
import { mapType } from "./s10.js";
import { mapTypeInnerPart3 } from "./s12.js";

export function mapTypeInnerPart2(ctx, type, checker, unions, widened, flags, psym, psymName, provenance, isStdlibInterface, isLibInterface, isAsyncIterationProtocol, isStdlibTimerHandle): IrType | null {

  // The builtin Error classes: references to the lib's Error interfaces map to the runtime-provided class
  // hierarchy (provenance, not the name — a user's own `class Error`
  // resolved through the class-instance branch above, and a user
  // `interface Error` maps as a record). The '%'-prefixed IR names are the
  // RUNTIME_ERROR_CLASSES table's; the Lowerer registers the matching
  // ClassInfos eagerly, so every consumer of the class name finds them.
  for (const [irName, rec] of RUNTIME_ERROR_CLASSES) {
    if (isStdlibInterface(rec.lib)) return { kind: "object", className: irName };
  }
  // node:assert's AssertionError is declared as a class (in the shipped
  // fallback and in @types/node), not as a lib interface.
  if (
    psym !== undefined &&
    psymName === "AssertionError" &&
    psym.declarations.some(
      (d) => ts.isClassDeclaration(d) && ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  )
    return { kind: "object", className: "%AssertionError" };
  // The lib's `Object` interface is a TOP type: tsc admits every
  // non-nullish value into an `Object` slot (`const x: Object = "s"`), so
  // it lowers like `unknown` (the dyn) — the same rule as `object` and
  // the empty object type, provenance-checked so a user's own `interface
  // Object` still maps as a record. Its Object.prototype member surface
  // (`x.toString()`) fences at each use site with an explicit error.
  if (isStdlibInterface("Object")) return DYN;
  // NodeJS.Module / the shipped fallback's ScriptcModule: a process-lifetime
  // scalar handle into the compiled CommonJS module registry. Module
  // identity is numeric identity; its fields are served by the dedicated
  // module lowering before generic number operations can observe the
  // representation. The node:module class's merged instance interface is
  // included, while unrelated user interfaces named Module stay structural.
  if (
    ((psym !== undefined && psymName === "ScriptcModule") ||
      (psym !== undefined && psymName === "Module")) &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        (psymName === "ScriptcModule" ||
          isDeclaredInAmbientNamespace(d, "NodeJS") ||
          isDeclaredInAmbientModule(d, "module")),
    )
  ) {
    return F64;
  }
  // events.EventEmitter: the runtime-provided emitter base class (the
  // Error-hierarchy precedent — user subclasses resolved through the
  // class-instance branch above). Both type layers declare it in the
  // "events" ambient module — the fallback as a class, @types/node as a
  // (generic) class plus a same-named interface — and @types/node's
  // NodeJS.EventEmitter interface (the structural surface net.Socket
  // et al. extend) is the same runtime value. Provenance-checked.
  if (
    psym !== undefined &&
    psymName === "EventEmitter" &&
    psym.declarations.some(
      (d) =>
        (ts.isClassDeclaration(d) || ts.isInterfaceDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        (isDeclaredInAmbientModule(d, "events") || isDeclaredInAmbientNamespace(d, "NodeJS")),
    )
  ) {
    return { kind: "object", className: RUNTIME_EMITTER_CLASS };
  }
  // events.on's iterator: a checked-dynamic object the runtime builds
  // with native next/return/throw methods and its own
  // [Symbol.asyncIterator], so `for await` over it takes the generic
  // dynamic path and property reads see the real object (its
  // `Symbol(nodejs.watermarkData)` included). Both type layers are
  // covered: @types/node returns `NodeJS.AsyncIterator<any[], undefined,
  // any>`, whose one class of values this is, and the shipped fallback
  // declares its own class. Only the `any[]` instantiation maps: the
  // lib's AsyncIterator protocol and the other NodeJS.AsyncIterator
  // instantiations (readline's string, fs's Dirent, a stream's any) keep
  // their own lowerings and fences.
  if (
    psym !== undefined &&
    ((psymName === "EventEmitterAsyncIterator" &&
      psym.declarations.some(
        (d) =>
          ts.isClassDeclaration(d) &&
          ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
          isDeclaredInAmbientModule(d, "events"),
      )) ||
      (psymName === "AsyncIterator" &&
        psym.declarations.some(
          (d) =>
            ts.isInterfaceDeclaration(d) &&
            ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
            isDeclaredInAmbientNamespace(d, "NodeJS"),
        ) &&
        (() => {
          const arg = checker.getTypeArguments(widened as ts.TypeReference)[0];
          if (arg === undefined) return false;
          const mapped = mapType(arg, ctx);
          return mapped?.kind === "array" && mapped.elem.kind === "dyn";
        })()))
  ) {
    return DYN;
  }
  // readline.Interface and readline/promises.Interface: the interface
  // value is an f64 handle into the runtime's registry (the Timeout-id
  // precedent). The NAME is generic, so the provenance check adds the
  // enclosing ambient module, like net.Server.
  if (
    psym !== undefined &&
    psymName === "Interface" &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        (isDeclaredInAmbientModule(d, "readline") ||
          isDeclaredInAmbientModule(d, "readline/promises")),
    )
  ) {
    return F64;
  }
  // readline.Key: emitKeys' key object stays a checked-dynamic value, so
  // it keeps Node's own shape (an undefined name, the escape sequences'
  // code member).
  if (
    psym !== undefined &&
    psymName === "Key" &&
    psym.declarations.some(
      (d) =>
        ts.isInterfaceDeclaration(d) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        (isDeclaredInAmbientModule(d, "readline") ||
          isDeclaredInAmbientModule(d, "readline/promises")),
    )
  ) {
    return DYN;
  }
  // readline/promises.Readline: an f64 handle the same way.
  if (
    psym !== undefined &&
    psymName === "Readline" &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientModule(d, "readline/promises"),
    )
  ) {
    return F64;
  }
  // diagnostics_channel.Channel: the channel value is an f64 handle into
  // the runtime's channel registry (the readline.Interface precedent —
  // Node's channels are process-lived too, its WeakRef machinery aside).
  // Provenance: the name is specific enough that stdlib-file provenance
  // plus the ambient module suffices for both the fallback declarations
  // and @types/node's class Channel<StoreType, ContextType>.
  if (
    psym !== undefined &&
    psymName === "Channel" &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientModule(d, "diagnostics_channel"),
    )
  ) {
    return F64;
  }
  // async_hooks.AsyncLocalStorage: the store value is an f64 handle into
  // the runtime's store id space (the Channel story — stores are
  // process-lived; contexts ride the fiber machinery).
  if (
    psym !== undefined &&
    psymName === "AsyncLocalStorage" &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientModule(d, "async_hooks"),
    )
  ) {
    return F64;
  }
  // diagnostics_channel.TracingChannel: the same f64-handle story over the
  // runtime's tracing registry (five event channels per entry).
  if (
    psym !== undefined &&
    psymName === "TracingChannel" &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientModule(d, "diagnostics_channel"),
    )
  ) {
    return F64;
  }
  // Node names this result; the ambient WHATWG declaration uses a type literal.
  const encodeResult =
    psym &&
    psym.declarations.some((decl) => {
      if (!ctx.isStdlibFile(ts.getSourceFileOfNode(decl))) return false;
      if (ts.isInterfaceDeclaration(decl) && decl.name.text === "EncodeIntoResult") return true;
      const parent = decl.parent;
      return (
        ts.isTypeLiteralNode(decl) &&
        parent?.kind === ts.SyntaxKind.MethodSignature &&
        parent.name &&
        ts.isIdentifier(parent.name) &&
        parent.name.text === "encodeInto" &&
        parent.parent &&
        ts.isInterfaceDeclaration(parent.parent) &&
        parent.parent.name.text === "TextEncoder"
      );
    });
  if (encodeResult)
    return {
      kind: "record",
      shapeId: ctx.shapes.intern([
        { name: "read", type: F64 },
        { name: "written", type: F64 },
      ]),
    };
  // WHATWG codec instances have ordinary reference identity and ownership.
  // Their private encoding slot is omitted from enumeration and JSON.
  if (
    ((psym !== undefined && psymName === "TextEncoder") ||
      (psym !== undefined && psymName === "TextDecoder")) &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  ) {
    return {
      kind: "record",
      shapeId: ctx.shapes.intern(
        [
          { name: `%${psymName}`, type: F64 },
          ...(psymName === "TextDecoder"
            ? [
                { name: "%fatal", type: BOOL },
                { name: "%ignoreBOM", type: BOOL },
                { name: "%state", type: DYN },
              ]
            : []),
        ],
        false,
        undefined,
        [],
      ),
    };
  }
  // string_decoder.StringDecoder: the decoder value is a two-field record
  // — the CANONICAL encoding name (construction normalizes aliases; the
  // `.encoding` property reads it) and the f64 packing the pending
  // partial sequence (the %strdec helpers' state cell). Provenance-
  // checked like Stats; construction and the write/end methods are
  // special-cased in lowerNew / lowerStringDecoderMethodCall, so the
  // record shape never surfaces.
  if (
    psym !== undefined &&
    psymName === "StringDecoder" &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  ) {
    return {
      kind: "record",
      shapeId: ctx.shapes.intern([
        { name: "%enc", type: STRING },
        { name: "%pending", type: F64 },
      ]),
    };
  }
  return mapTypeInnerPart3(ctx, type, checker, unions, widened, flags, psym, psymName, provenance, isStdlibInterface, isLibInterface, isAsyncIterationProtocol, isStdlibTimerHandle);
}
