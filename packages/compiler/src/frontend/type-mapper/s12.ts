// Statement slice of the former frontend/type-mapper.ts (split for
// maintainability; the directory barrel ../type-mapper.ts re-exports the
// original public surface). Statements are verbatim from the original file.
import { arrayOf, BYTES_ELEMENT_NAME, bytesOf, DATE_T, DYN, F64, isSupportedMapKey, isSupportedMapValue, isSupportedSetElem, mapOf, setOf, STRING, VOID } from "../../ir/ir.js";
import type { IrType } from "../../ir/ir.js";
import * as ts from "../ts7/adapter.js";
import { CIPHER_TYPE_NAMES, CRYPTO_KEY_OPTION_DYN_TYPES, FETCH_AMBIENT_TYPES, HTTP_REQUEST_OPTION_MODULES, WEBCRYPTO_DYN_TYPES } from "./s00.js";
import { isDeclaredInAmbientModule, isDeclaredInAmbientNamespace } from "./s04.js";
import { isWorkerHandleSymbol } from "./s08.js";
import { mapType } from "./s10.js";
import { mapTypeInnerPart4 } from "./s13.js";
import { isFallbackConsoleType } from "./s17.js";
import { mapCollectionView } from "./s19.js";
import { genResultRecord } from "./s23.js";

export function mapTypeInnerPart3(ctx, type, checker, unions, widened, flags, psym, psymName, provenance, isStdlibInterface, isLibInterface, isAsyncIterationProtocol, isStdlibTimerHandle): IrType | null {

  // Promise.withResolvers's return type — `{ promise, resolve, reject }`
  // from the overrides declaration (or es2024's PromiseWithResolvers,
  // the same shape): a real data record, but its anonymous literal lives
  // in a declaration file, which recordProvenanceOk rightly refuses for
  // lib type worlds. Map it manually with the executor's own scriptc
  // field shapes (plain-value resolve — () => void for Promise<void> —
  // and the reject the promise's own reason representation picks: Error
  // for a typed payload, the checked-dynamic value for a promise whose
  // settled value is unknown), so both the destructured and the
  // record-holding binding forms compile. User-declared literals with
  // these member names keep the ordinary record path (their declarations
  // are not in declaration files).
  const promiseDeclarations = psym ? psym.declarations : [];
  if (
    flags & ts.TypeFlags.Object &&
    promiseDeclarations.length > 0 &&
    promiseDeclarations.every((d) => ts.getSourceFileOfNode(d).isDeclarationFile)
  ) {
    const props = checker.getPropertiesOfType(widened);
    if (
      props.length === 3 &&
      ["promise", "resolve", "reject"].every((n) => props.some((p) => ts.symbolName(p) === n))
    ) {
      const promProp = props.find((p) => ts.symbolName(p) === "promise")!;
      const promT = mapType(checker.getTypeOfSymbol(promProp), ctx);
      if (promT?.kind === "promise") {
        const inner = promT.inner;
        return {
          kind: "record",
          shapeId: ctx.shapes.intern(
            [
              { name: "promise", type: promT },
              {
                name: "reject",
                type: {
                  kind: "func",
                  params: [inner.kind === "dyn" ? DYN : { kind: "object", className: "%Error" }],
                  ret: VOID,
                },
              },
              {
                name: "resolve",
                type: { kind: "func", params: inner.kind === "void" ? [] : [inner], ret: VOID },
              },
            ],
            false,
            undefined,
            ["promise", "resolve", "reject"],
          ),
        };
      }
    }
  }
  // NodeJS.ErrnoException (@types/node): an Error with optional
  // code/errno/syscall/path members. The VALUE is a plain runtime error
  // (fs/exec throw sites stamp `code`), so the type maps to the %Error
  // root — `err as NodeJS.ErrnoException` from an Error-typed value is a
  // no-op cast, error-typed listener params accept it, and the `.code`
  // reads have dedicated lowerings that preserve absent metadata.
  if (isStdlibInterface("ErrnoException")) return { kind: "object", className: "%Error" };
  // spawn consumes a presence-sensitive option bag, including optional
  // stdio and env values. Keep it checked-dynamic for native normalization.
  if (isStdlibInterface("SpawnOptions")) return DYN;
  // util.inspect as a value (a custom inspect method's third parameter is
  // `typeof inspect`): the runtime's inspect function, called through the
  // checked-dynamic boundary.
  if (
    psym !== undefined &&
    psymName === "inspect" &&
    psym.declarations.some(
      (d) =>
        ts.isFunctionDeclaration(d) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientModule(d, "util"),
    )
  )
    return DYN;
  // util.inspect's options bag, which inspect and formatWithOptions read
  // at run time (its sorted option can be a comparator function), and the
  // options custom inspect functions receive.
  if (
    (isStdlibInterface("InspectOptions") || isStdlibInterface("InspectOptionsStylized")) &&
    psym!.declarations.some(
      (d) => ts.isInterfaceDeclaration(d) && isDeclaredInAmbientModule(d, "util"),
    )
  )
    return DYN;
  // dns.LookupAllOptions (`all: true`, the overload whose callback takes
  // an address list): a lookup option bag dns.lookup reads at run time.
  // It rides checked-dynamic storage, so the lookup function type that
  // takes `LookupOneOptions | LookupAllOptions | number` compiles.
  if (isStdlibInterface("LookupAllOptions")) return DYN;
  // http.RequestOptions / https.RequestOptions as a declared type: an
  // option record whose members include functions, agents and signals.
  // Values ride checked-dynamic storage, like SpawnOptions.
  if (
    psym !== undefined &&
    psymName === "RequestOptions" &&
    psym.declarations.some((d) => {
      if (!ts.isInterfaceDeclaration(d) || !ctx.isStdlibFile(ts.getSourceFileOfNode(d)))
        return false;
      for (let p: ts.Node | undefined = d.parent; p !== undefined; p = p.parent) {
        if (ts.isModuleDeclaration(p) && ts.isStringLiteral(p.name))
          return HTTP_REQUEST_OPTION_MODULES.has(p.name.text);
      }
      return false;
    })
  )
    return DYN;

  // exactly like npm-declared types. Static fetch has one deliberately
  // narrower native representation: Response is an opaque checked-
  // dynamic capsule consumed only by the Response method lowerings, and
  // RequestInit is a checked-dynamic options object consumed by native
  // fetch. AbortSignal, response Headers, and the readable Web Streams
  // slice are native handles carried by that same checked-dynamic
  // representation. Provenance, not names: a user's own `interface
  // Response` maps as a record like any other.
  // Interface OR class declarations (the shipped fallback declares
  // interfaces; @types/node's undici-types declares Response as a class).
  {
    const alias = widened.getAliasSymbol();
    if (
      alias !== undefined &&
      ts.symbolName(alias) === "ReadableStreamReadResult" &&
      alias.declarations.some(
        (d) => ts.isTypeAliasDeclaration(d) && ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
      )
    ) {
      const elemTs = widened.getAliasTypeArguments()?.[0];
      const elem =
        elemTs && elemTs.flags & ts.TypeFlags.Any ? DYN : elemTs ? mapType(elemTs, ctx) : null;
      if (!elem) return null;
      return genResultRecord(elem, VOID, ctx.shapes, ctx.unions);
    }
  }
  if (
    psym &&
    (psymName === "ReadableStreamReadValueResult" || psymName === "ReadableStreamReadDoneResult") &&
    psym.declarations.some(
      (d) => ts.isInterfaceDeclaration(d) && ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  ) {
    const elemTs = checker.getTypeArguments(widened as ts.TypeReference)[0];
    const elem =
      elemTs && elemTs.flags & ts.TypeFlags.Any ? DYN : elemTs ? mapType(elemTs, ctx) : null;
    if (!elem) return null;
    return genResultRecord(elem, VOID, ctx.shapes, ctx.unions);
  }
  // node:net's SocketAddress and BlockList (scr_net.c) and node:util's
  // MIMEType and MIMEParams (scr_mime.c): native handles whose getters and
  // methods dispatch through the handle.
  if (
    ((psym !== undefined && psymName === "SocketAddress") ||
      (psym !== undefined && psymName === "BlockList") ||
      (psym !== undefined && psymName === "MIMEType") ||
      (psym !== undefined && psymName === "MIMEParams")) &&
    psym.declarations.some(
      (d) =>
        (ts.isClassDeclaration(d) || ts.isInterfaceDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  ) {
    return DYN;
  }
  // The functions node:util's debounce and throttle return
  // (scr_util_timing.c): native functions with their own members and
  // getters.
  if (
    psym !== undefined &&
    (psymName === "DebouncedFunction" || psymName === "ThrottledFunction") &&
    psym.declarations.some(
      (d) => ts.isInterfaceDeclaration(d) && ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  ) {
    return DYN;
  }
  // WebCrypto: the crypto global and its subtle object are dynamic
  // objects, CryptoKey values are native handles (scr_webcrypto.c), and
  // the algorithm dictionaries the methods take and keys report are plain
  // checked-dynamic objects.
  if (
    psym &&
    WEBCRYPTO_DYN_TYPES.has(psymName) &&
    psym.declarations.some(
      (d) =>
        (ts.isClassDeclaration(d) || ts.isInterfaceDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  ) {
    return DYN;
  }
  // node:crypto's KeyObject: secret keys (scr_lib.c) and private and
  // public keys (scr_pki.c) are native handles whose getters and methods
  // dispatch through the handle. The JsonWebKey that export() returns is a
  // plain checked-dynamic object.
  if (
    ((psym !== undefined && psymName === "KeyObject") ||
      (psym !== undefined && psymName === "JsonWebKey")) &&
    psym.declarations.some(
      (d) =>
        (ts.isClassDeclaration(d) || ts.isInterfaceDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  ) {
    return DYN;
  }
  // node:crypto's key and signature options are plain checked-dynamic
  // objects, so a value asserted to one (`opts as
  // crypto.AsymmetricKeyExportOptions<"pem">`) reaches the call unchanged.
  if (
    psym !== undefined &&
    CRYPTO_KEY_OPTION_DYN_TYPES.has(psymName) &&
    psym.declarations.some(
      (d) =>
        ts.isInterfaceDeclaration(d) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientModule(d, "crypto"),
    )
  ) {
    return DYN;
  }
  // node:crypto's Sign and Verify (createSign/createVerify): native
  // handles over the digest state (scr_pki.c).
  if (
    psym !== undefined &&
    (psymName === "Sign" || psymName === "Verify") &&
    psym.declarations.some(
      (d) =>
        ts.isClassDeclaration(d) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientModule(d, "crypto"),
    )
  ) {
    return DYN;
  }
  if (
    psym &&
    (FETCH_AMBIENT_TYPES as readonly string[]).includes(psymName) &&
    !(
      (psymName === "ReadableStream" || psymName === "WritableStream") &&
      psym.declarations.some(
        (d) => ts.isInterfaceDeclaration(d) && isDeclaredInAmbientNamespace(d, "NodeJS"),
      )
    ) &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  ) {
    return DYN;
  }
  // The stdlib Console interface (the global console and node:console
  // Console instances) is a native handle carried by the checked-dynamic
  // representation and consumed by the console method lowerings. The
  // stdlib Disposable (events.addAbortListener's result) and
  // AsyncDisposable are checked objects carrying their Symbol.dispose or
  // Symbol.asyncDispose method. A DisposableStack is a native handle whose
  // methods are function values of its checked-dynamic view.
  if (
    ((psym !== undefined && psymName === "Console") ||
      (psym !== undefined && psymName === "Disposable") ||
      (psym !== undefined && psymName === "AsyncDisposable") ||
      (psym !== undefined && psymName === "DisposableStack")) &&
    psym.declarations.some(
      (d) => ts.isInterfaceDeclaration(d) && ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  ) {
    return DYN;
  }
  // The fallback declarations give the global `console` an object type of
  // its own (not the Console interface): the same native handle, so a slot
  // of that type (`{ target: console }`, `[console]`, a parameter typed
  // `typeof console`) holds the console value in both type worlds.
  if (psym !== undefined && psym.declarations.some((d) => isFallbackConsoleType(d, ctx))) {
    return DYN;
  }
  // node:crypto Cipheriv/Decipheriv values (and @types/node's per-mode
  // interfaces over them) are native handles carried by the checked-dynamic
  // representation; lowerCipherMethodCall dispatches their methods.
  if (
    psym !== undefined &&
    CIPHER_TYPE_NAMES.has(psymName) &&
    psym.declarations.some((d) => ctx.isStdlibFile(ts.getSourceFileOfNode(d)))
  ) {
    return DYN;
  }
  // node:crypto ECDH values are native handles carried by the
  // checked-dynamic representation; lowerEcdhCall dispatches their methods.
  if (
    psym !== undefined &&
    psymName === "ECDH" &&
    psym.declarations.some(
      (d) => ts.isClassDeclaration(d) && ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  ) {
    return DYN;
  }
  // node:crypto DiffieHellman values, and @types/node's DiffieHellmanGroup
  // alias over them, are native handles carried by the checked-dynamic
  // representation; lowerDiffieHellmanCall dispatches their methods.
  {
    const dhSym = widened.getAliasSymbol() ?? psym;
    if (
      dhSym !== undefined &&
      (ts.symbolName(dhSym) === "DiffieHellman" || ts.symbolName(dhSym) === "DiffieHellmanGroup") &&
      dhSym.declarations.some(
        (d) =>
          (ts.isClassDeclaration(d) || ts.isTypeAliasDeclaration(d)) &&
          ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
      )
    ) {
      return DYN;
    }
  }
  // ReadonlyMap/ReadonlySet are the SAME runtime values as Map/Set — the
  // readonly-ness is a checker-only view (no mutating members on the
  // interface), so both map to the identical IR kinds and the read-side
  // method lowerings (.has/.get/.size/iteration) dispatch unchanged.
  if (isStdlibInterface("Map") || isStdlibInterface("ReadonlyMap")) {
    const args = checker.getTypeArguments(widened as ts.TypeReference);
    if (args.length !== 2) return null;
    const key = (args[0]!.flags & ts.TypeFlags.Any) !== 0 ? DYN : mapType(args[0]!, ctx);
    if (
      !key ||
      !isSupportedMapKey(key, key.kind === "union" ? ctx.unions.get(key.unionId)?.arms : undefined)
    )
      return null;
    const value = (args[1]!.flags & ts.TypeFlags.Any) !== 0 ? DYN : mapType(args[1]!, ctx);
    if (!value || !isSupportedMapValue(value)) return null;
    return mapOf(key, value);
  }
  // Native WeakMap keeps reference identities in checked-dynamic storage.
  // The runtime rejects reference kinds without a weak lifetime contract.
  if (isStdlibInterface("WeakMap") || isStdlibInterface("WeakSet")) return DYN;
  // FinalizationRegistry is a native handle with register and unregister.
  if (isStdlibInterface("FinalizationRegistry")) return DYN;
  // WeakRef is a native handle with deref.
  if (isStdlibInterface("WeakRef")) return DYN;
  // Set<T>: Map's sibling — same provenance rule and key domain.
  // Anything else stays unmapped;
  // the `new Set` lowering names the offending element type specifically.
  if (isStdlibInterface("Set") || isStdlibInterface("ReadonlySet")) {
    const args = checker.getTypeArguments(widened as ts.TypeReference);
    if (args.length !== 1) return null;
    const elem = (args[0]!.flags & ts.TypeFlags.Any) !== 0 ? DYN : mapType(args[0]!, ctx);
    if (
      !elem ||
      !isSupportedSetElem(
        elem,
        elem.kind === "union" ? ctx.unions.get(elem.unionId)?.arms : undefined,
      )
    )
      return null;
    return setOf(elem);
  }
  const collectionView = mapCollectionView(widened, ctx);
  if (collectionView) return collectionView;
  // Date: a refcounted object holding its TimeClip'd time value (ScrDate),
  // shared with the checked-dynamic Date handle, so it keeps its identity
  // through every slot and through `unknown`. Setters stay fenced.
  if (isStdlibInterface("Date")) return DATE_T;
  // RegExp: a reference to the lib RegExp interface — provenance, not the
  // name (a user's own `interface RegExp` maps as a record). Regex values
  // are literals interned as immortal statics; the kind is fenced out of
  // array elements, union arms, and Map keys/values above/below.
  if (isStdlibInterface("RegExp")) {
    return { kind: "regex" };
  }
  if (
    isStdlibInterface("Segmenter") ||
    isStdlibInterface("Segments") ||
    isStdlibInterface("SegmentData")
  )
    return DYN;
  // Intl.NumberFormat and Intl.DateTimeFormat objects are handles the
  // runtime builds over ICU (scr_intl.c), and their options objects are
  // read at run time by ECMA-402's steps, as checked-dynamic values.
  if (
    isStdlibInterface("NumberFormat") ||
    isStdlibInterface("DateTimeFormat") ||
    isStdlibInterface("NumberFormatOptions") ||
    isStdlibInterface("DateTimeFormatOptions")
  )
    return DYN;
  // Typed arrays: references to the lib's Uint8Array/Uint32Array/
  // Float32Array/Float64Array interfaces (provenance, not names). The es2022+ lib
  // declares them generic over the backing buffer (`Uint8Array<ArrayBuffer>`
  // in error text) — the type argument is irrelevant here: no free-standing
  // ArrayBuffer value exists. The other TypedArray flavors stay
  // unmapped (the record path's index-signature check rejects them).
  // RegExpMatchArray (s.match's result) IS a string[] here — the honest
  // slice: [whole match, ...captures]. Nonparticipating captures use the
  // array's undefined element state; numeric access preserves that state.
  if (isStdlibInterface("RegExpMatchArray")) return arrayOf(STRING);
  // TemplateStringsArray (a tag function's first parameter): a string[] —
  // the cooked spans the templateStrings site value carries. The `.raw`
  // extra fences per member like RegExpMatchArray's `.index`/`.input`.
  if (isStdlibInterface("TemplateStringsArray")) return arrayOf(STRING);
  // RegExpExecArray (matchAll's row type): the same honest slice.
  if (isStdlibInterface("RegExpExecArray")) return arrayOf(STRING);
  // RegExpStringIterator<RegExpExecArray> (matchAll's checker result): the
  // VALUE-position spelling of the eager drain — the intrinsic already
  // materializes string[][] (lazy vs eager is unobservable: strings are
  // immutable and the spec clones the regex at the call), so a stored
  // `const urlMatches = output.matchAll(re)` types as exactly that array.
  if (isStdlibInterface("RegExpStringIterator")) return arrayOf(arrayOf(STRING));
  // NodeJS.Timeout / the fallback `Timeout` interface (setTimeout's return)
  // maps to F64 — the numeric timer handle. The `.ref`/`.unref`/`.hasRef`
  // methods lower over that handle (loop-liveness bookkeeping); `Timeout |
  // null` becomes `number | null`, and clearTimeout/clearInterval take the
  // handle. Provenance-checked like the other named interfaces.
  if (isStdlibTimerHandle("Timeout")) return F64;
  // NodeJS.Immediate / the fallback `Immediate` (setImmediate's return):
  // the same numeric-handle story over the check-phase queue — its own id
  // space, so clearTimeout of an Immediate no-ops like Node.
  if (isStdlibTimerHandle("Immediate")) return F64;
  if (
    isStdlibInterface("ArrayBuffer") ||
    isStdlibInterface("SharedArrayBuffer") ||
    isStdlibInterface("PropertyDescriptor") ||
    isStdlibInterface("PropertyDescriptorMap") ||
    isStdlibInterface("ProcessVersions") ||
    isStdlibInterface("ProcessRelease") ||
    isStdlibInterface("ProcessFeatures") ||
    isStdlibInterface("ProcessReport")
  )
    return DYN;
  if (Object.values(BYTES_ELEMENT_NAME).some((name) => isStdlibInterface(`${name}Constructor`)))
    return DYN;
  // The ES lib's `ArrayBufferView` is the common supertype of every typed
  // array and DataView, so no single byte-view representation is honest:
  // `ArrayBuffer.isView` narrowing admits a Float64Array. The value stays
  // the checked dynamic one; its `buffer`, `byteOffset` and `byteLength`
  // reads come from the native view the dynamic value holds (a buffer by
  // identity) or from the dynamic tier, and every other member reads
  // dynamically (narrowing.ts). @types/node's `NodeJS.ArrayBufferView` is its
  // own interface with its own mapping and keeps it.
  //
  // The mapping belongs to the type, so it applies wherever a value of the
  // type flows, whether or not the program spells the name. The builtin
  // declarations (packages/compiler/ambient) type their view parameters with
  // their own `ScriptcBufferView`, so the Node signatures a program never
  // wrote do not change shape with it.
  if (isLibInterface("ArrayBufferView")) return DYN;
  if (isStdlibInterface("Uint8Array")) return bytesOf("u8");
  if (isStdlibInterface("Uint32Array")) return bytesOf("u32");
  if (isStdlibInterface("Uint8ClampedArray")) return bytesOf("u8c");
  if (isStdlibInterface("Int8Array")) return bytesOf("i8");
  if (isStdlibInterface("Uint16Array")) return bytesOf("u16");
  if (isStdlibInterface("Int16Array")) return bytesOf("i16");
  // Int32Array: the signed 32-bit kind (element reads sign-extend, writes
  // ToInt32-wrap) — the Atomics.wait sleep idiom constructs one over a
  // SharedArrayBuffer, and the i32 semantics hold for every other use.
  if (isStdlibInterface("Int32Array")) return bytesOf("i32");
  if (isStdlibInterface("Float16Array")) return bytesOf("f16");
  if (isStdlibInterface("Float32Array")) return bytesOf("f32");
  if (isStdlibInterface("Float64Array")) return bytesOf("f64");
  // DataView: the ONE view kind — a u8 bytes value whose runtime
  // representation borrows (aliases) its owner's storage, so reads through
  // it see writes to the source exactly like JS. The checker keeps the
  // DataView and typed-array member surfaces apart; at the IR level both
  // are bytes<u8>.
  if (isStdlibInterface("DataView")) return bytesOf("u8");
  // Node's Buffer IS a Uint8Array subclass — ONE runtime representation
  // (the u8 bytes kind). Declared `interface Buffer` by the shipped
  // fallback and by @types/node (whose NonSharedBuffer alias resolves to
  // the same symbol); provenance-checked like URL.
  if (
    psym !== undefined &&
    psymName === "Buffer" &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  ) {
    return bytesOf("u8");
  }
  // URL: the WHATWG URL instance type — declared as a global `interface
  // URL` (the shipped fallback, and @types/node's globals) AND as `class
  // URL` in @types/node's "url" module (`new URL(x)` types as the class's
  // instance type). Provenance, not the name: a user's own URL maps as a
  // record/class like any other.
  if (
    psym !== undefined &&
    psymName === "URL" &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  ) {
    return { kind: "url" };
  }
  // URLSearchParams: the WHATWG live query view — declared as a global
  // interface by the shipped fallback and by @types/node (plus `class
  // URLSearchParams` in the "url" module). Provenance-checked like URL.
  if (
    psym !== undefined &&
    psymName === "URLSearchParams" &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  ) {
    return { kind: "searchParams" };
  }
  // fs.Stats: @types/node's `class Stats` (module "fs") or the fallback
  // declarations' interface. Provenance-checked like URL.
  if (
    psym !== undefined &&
    psymName === "Stats" &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  ) {
    return { kind: "stats" };
  }
  // fs.BigIntStats: the SAME snapshot handle under Node's bigint member
  // table (`statSync(p, { bigint: true })`). Declared by @types/node as
  // `class BigIntStats` in "fs"; the fallback declarations keep the class
  // shape too. Provenance-checked like Stats.
  if (
    psym !== undefined &&
    psymName === "BigIntStats" &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  ) {
    return { kind: "bigintStats" };
  }
  // module.enableCompileCache()'s result and its options argument
  // (@types/node's EnableCompileCacheResult and EnableCompileCacheOptions,
  // and the fallback's twins) are the plain objects Node passes: a result
  // lacks the members Node did not set, and an options object is read by the
  // runtime the way Node reads it.
  if (
    psym !== undefined &&
    (psymName === "EnableCompileCacheResult" || psymName === "EnableCompileCacheOptions") &&
    psym.declarations.some(
      (d) =>
        ts.isInterfaceDeclaration(d) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientModule(d, "module"),
    )
  )
    return DYN;
  // Capacity snapshots and options keep their live object representation
  // across numeric/BigInt overloads, runtime options, and callbacks.
  if (
    ((psym !== undefined && psymName === "StatsFs") ||
      (psym !== undefined && psymName === "BigIntStatsFs") ||
      (psym !== undefined && psymName === "StatFsOptions")) &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientModule(d, "fs"),
    )
  )
    return DYN;
  if (isWorkerHandleSymbol(psym, ctx)) return DYN;
  // fs/promises.FileHandle: an owned descriptor object. Module provenance
  // distinguishes it from user interfaces with the same name; both the
  // fallback and @types/node declare it in "fs/promises".
  if (
    psym !== undefined &&
    psymName === "FileHandle" &&
    psym.declarations.some(
      (d) =>
        ts.isInterfaceDeclaration(d) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientModule(d, "fs/promises"),
    )
  ) {
    return { kind: "fileHandle" };
  }
  // fs.Dir: an open directory stream, declared in "fs" by both the
  // fallback and @types/node.
  if (
    psym !== undefined &&
    psymName === "Dir" &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientModule(d, "fs"),
    )
  ) {
    return { kind: "dir" };
  }
  // child_process.SpawnSyncReturns: @types/node's generic interface (the
  // Buffer/string split is re-checked at the stdout/stderr READ — status
  // reads work either way) or the fallback declarations' plain interface.
  // Provenance-checked like Stats.
  if (
    psym !== undefined &&
    psymName === "SpawnSyncReturns" &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
  ) {
    return { kind: "spawnRes" };
  }
  // child_process.ChildProcess and @types/node's stdio-refined return
  // interfaces: all carry the same runtime child handle; the generic
  // refinements only tell the checker which stdio properties are null.
  if (
    psym !== undefined &&
    (psymName === "ChildProcess" ||
      psymName === "ChildProcessWithoutNullStreams" ||
      psymName === "ChildProcessByStdio") &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientModule(d, "child_process"),
    )
  ) {
    return { kind: "child" };
  }
  // net.Server / net.Socket: @types/node's classes or the fallback
  // declarations' interfaces. The NAME is ambiguous across builtin
  // modules (http.Server, tls.Socket share it), so the provenance check
  // adds the ENCLOSING AMBIENT MODULE: both @types/node and the fallback
  // declare these inside `declare module "net"` — a declaration outside
  // that module (http's Server) stays unmapped and fences at its use
  // site.
  if (
    ((psym !== undefined && psymName === "Server") ||
      (psym !== undefined && psymName === "Socket") ||
      (psym !== undefined && psymName === "TLSSocket")) &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        (isDeclaredInAmbientModule(d, "net") ||
          // http.Server extends net.Server in @types/node — and tls.Server
          // / https.Server extend it transitively: same lowered surface
          // (listen/close/address/'error'), same handle kind. tls.TLSSocket
          // extends net.Socket the same way: post-handshake it IS a net
          // socket to every lowered member.
          (psymName === "Server" &&
            (isDeclaredInAmbientModule(d, "http") ||
              isDeclaredInAmbientModule(d, "tls") ||
              isDeclaredInAmbientModule(d, "https"))) ||
          (psymName === "TLSSocket" && isDeclaredInAmbientModule(d, "tls"))),
    )
  ) {
    return psymName === "Server" ? { kind: "netServer" } : { kind: "netSocket" };
  }
  // tls.SecureContext: the opaque parsed-cert/key handle SNI callbacks
  // answer with (tls.createSecureContext({ cert, key }) mints it; the TLS
  // server's handshake consumes it). Module-checked like net.Server —
  // @types/node declares `interface SecureContext` inside `declare module
  // "tls"`, and the shipped fallback mirrors it.
  if (
    psym !== undefined &&
    psymName === "SecureContext" &&
    psym.declarations.some(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientModule(d, "tls"),
    )
  ) {
    return { kind: "secureCtx" };
  }
  // Scrypt's runtime options retain property accessors and aliases. Use
  // checked values so presence probes and repeated getter reads match Node.
  if (
    psym !== undefined &&
    psymName === "ScryptOptions" &&
    psym.declarations.some(
      (d) =>
        ts.isInterfaceDeclaration(d) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientModule(d, "crypto"),
    )
  )
    return DYN;
  return mapTypeInnerPart4(ctx, type, checker, unions, widened, flags, psym, psymName, provenance, isStdlibInterface, isAsyncIterationProtocol);
}
