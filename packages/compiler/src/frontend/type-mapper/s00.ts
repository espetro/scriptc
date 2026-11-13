// Statement slice of the former frontend/type-mapper.ts (split for
// maintainability; the directory barrel ../type-mapper.ts re-exports the
// original public surface). Statements are verbatim from the original file.
import { canConvertToDyn, DYN, isUnitType, PERF_NODE_TIMING_JSON_FIELDS, PERF_NODE_TIMING_MARKER, typeKey } from "../../ir/ir.js";
import type { IrType } from "../../ir/ir.js";
import { isJsSourceFile } from "../program.js";
import * as ts from "../ts7/adapter.js";
import { ShapeRegistry } from "./s01.js";
import { UnionRegistry } from "./s02.js";



/** Both lists live in ir/ir.ts (the backend's JSON writer and dyn
 * conversion read them): the nodeTiming marker and the fields
 * PerformanceNodeTiming.prototype.toJSON answers, in its order. */
export { PERF_NODE_TIMING_JSON_FIELDS, PERF_NODE_TIMING_MARKER };

// typeKey moved to ir/ir.ts (the backend needs it too, for per-type
// helper interning); re-exported here so frontend call sites keep their
// import path.
export { typeKey };


/** The checker omits the erased receiver parameter from callable arity. */
export function runtimeParameterCount(parameters: readonly ts.ParameterDeclaration[]): number {
  const first = parameters[0];
  return (
    parameters.length - (first && ts.isIdentifier(first.name) && first.name.text === "this" ? 1 : 0)
  );
}


/** Empty JS object inference describes no fixed layout. Keep these values
 * in checked storage across fields, parameters and function signatures. */
export function jsOpenObjectType(
  decl: ts.Node | undefined,
  type: IrType,
  shapes: ShapeRegistry,
  unions: UnionRegistry,
): IrType {
  if (!decl || !isJsSourceFile(ts.getSourceFileOfNode(decl))) return type;
  const arms = type.kind === "union" ? unions.get(type.unionId)?.arms : [type];
  const present = arms?.filter((arm) => arm.kind !== "undefinedT");
  const parameter = ts.isParameter(decl)
    ? decl
    : decl.parent && ts.isParameter(decl.parent)
      ? decl.parent
      : null;
  // Array parameters in JavaScript also accept typed arrays. Keep
  // their runtime storage at the boundary, including default [] parameters.
  if (
    parameter &&
    !parameter.dotDotDotToken &&
    present?.length === 1 &&
    present[0]!.kind === "array"
  )
    return DYN;
  if (
    parameter &&
    !parameter.dotDotDotToken &&
    present?.length === 1 &&
    present[0]!.kind === "bytes"
  )
    return DYN;
  // An unannotated JavaScript parameter's object default is a fallback,
  // not a closed class contract. Published code routinely passes another
  // implementation of the same protocol through a boxed callable.
  if (
    parameter?.initializer &&
    !parameter.type &&
    present?.some((arm) => arm.kind === "object") &&
    arms?.every((arm) =>
      canConvertToDyn(
        arm,
        (id) => shapes.get(id),
        (id) => unions.get(id),
      ),
    )
  )
    return DYN;
  if (present?.length !== 1 || present[0]!.kind !== "record") return type;
  const shape = shapes.get(present[0]!.shapeId);
  // JavaScript dictionaries allow missing keys and inherited properties.
  // A typed index slot cannot represent either of those reads faithfully.
  if (shape?.indexValue && !shape.tuple) return DYN;
  const unitOnly = (field: IrType): boolean =>
    isUnitType(field) ||
    field.kind === "void" ||
    (field.kind === "union" && unions.get(field.unionId)?.arms.every(isUnitType) === true);
  return shape &&
    !shape.tuple &&
    !shape.indexValue &&
    (shape.fields.length === 0 || shape.fields.some((field) => unitOnly(field.type)))
    ? DYN
    : type;
}


/** The modules whose RequestOptions interface maps to the checked dynamic. */
export const HTTP_REQUEST_OPTION_MODULES: ReadonlySet<string> = new Set([
  "http",
  "node:http",
  "https",
  "node:https",
]);


/** The WebCrypto interfaces whose values are checked-dynamic: the crypto
 * global, SubtleCrypto, CryptoKey handles and the algorithm dictionaries
 * (scr_webcrypto.c). */
export const WEBCRYPTO_DYN_TYPES: ReadonlySet<string> = new Set([
  "Crypto",
  "SubtleCrypto",
  "CryptoKey",
  "Algorithm",
  "KeyAlgorithm",
  "HmacImportParams",
  "HmacKeyAlgorithm",
  "CryptoKeyPair",
  "EcKeyAlgorithm",
  "RsaHashedKeyAlgorithm",
  "EcKeyGenParams",
  "EcKeyImportParams",
  "EcdsaParams",
  "RsaHashedKeyGenParams",
  "RsaHashedImportParams",
  "RsaPssParams",
  "HmacKeyGenParams",
  "AesKeyGenParams",
  "AesKeyAlgorithm",
  "JsonWebKey",
  "AesGcmParams",
  "AesCbcParams",
  "AesCtrParams",
  "Pbkdf2Params",
  "HkdfParams",
  "AesDerivedKeyParams",
  "Argon2Params",
  "CShakeParams",
  "ContextParams",
  "EcdhKeyDeriveParams",
  "KangarooTwelveParams",
  "KmacImportParams",
  "KmacKeyAlgorithm",
  "KmacKeyGenParams",
  "KmacParams",
  "RsaOaepParams",
  "TurboShakeParams",
]);


/** node:crypto's key, signature and X509Certificate check option
 * interfaces: the key functions, KeyObject.export, sign/verify and the
 * X509Certificate checks take them as checked-dynamic arguments
 * (scr_lib.c, scr_pki.c, scr_x509.c). */
export const CRYPTO_KEY_OPTION_DYN_TYPES: ReadonlySet<string> = new Set([
  "AsymmetricKeyExportOptions",
  "ECKeyPairKeyObjectOptions",
  "ECKeyPairOptions",
  "ED25519KeyPairOptions",
  "JsonWebKeyInput",
  "JwkKeyExportOptions",
  "KeyExportOptions",
  "PrivateKeyInput",
  "PublicKeyInput",
  "RSAKeyPairKeyObjectOptions",
  "X25519KeyPairOptions",
  "RSAKeyPairOptions",
  "SignKeyObjectInput",
  "SignPrivateKeyInput",
  "SigningOptions",
  "VerifyKeyObjectInput",
  "VerifyPublicKeyInput",
  "X509CheckOptions",
]);


export const FETCH_AMBIENT_TYPES = [
  "Response",
  "Request",
  "ResponseInit",
  "RequestInit",
  "Event",
  "CustomEvent",
  "MessageEvent",
  "EventTarget",
  "AddEventListenerOptions",
  "EventListenerOptions",
  "EventInit",
  "CustomEventInit",
  "AbortController",
  "AbortSignal",
  "PerformanceObserver",
  "PerformanceObserverEntryList",
  "Headers",
  "ReadableStream",
  "ReadableStreamDefaultReader",
  "ReadableStreamBYOBReader",
  "ReadableByteStreamController",
  "ReadableStreamBYOBRequest",
  "ReadableStreamDefaultController",
  "ReadableStreamReadResult",
  "ReadableStreamReadValueResult",
  "ReadableStreamReadDoneResult",
  "TransformStream",
  "TransformStreamDefaultController",
  "WritableStream",
  "WritableStreamDefaultWriter",
  "WritableStreamDefaultController",
  "CountQueuingStrategy",
  "ByteLengthQueuingStrategy",
  "TextEncoderStream",
  "TextDecoderStream",
  "QueuingStrategy",
  "Blob",
  "File",
  "BlobPropertyBag",
  "FilePropertyBag",
  "BlobOptions",
  "FileOptions",
] as const;


/** node:crypto's Cipheriv and Decipheriv names in @types/node. */
export const CIPHER_TYPE_NAMES: ReadonlySet<string> = new Set([
  "Cipheriv",
  "Decipheriv",
  "CipherCCM",
  "CipherGCM",
  "CipherOCB",
  "CipherChaCha20Poly1305",
  "DecipherCCM",
  "DecipherGCM",
  "DecipherOCB",
  "DecipherChaCha20Poly1305",
]);


/** node:util.parseArgs's public and @types/node helper type names, plus
 * util.debuglog's DebugLogger (a native function value with an `enabled`
 * accessor) and the DebugLoggerFunction its callback receives. Values
 * behind this surface use the checked-dynamic tree; see mapTypeInner. */
export const PARSE_ARGS_DYN_TYPES = new Set([
  "DebugLogger",
  "DebugLoggerFunction",
  "ParseArgsConfig",
  "ParseArgsOptionDescriptor",
  "ParseArgsOptionsConfig",
  "ParseArgsResult",
  "ParseArgsToken",
  "ParsedResults",
  "PreciseParsedResults",
  "ParsedValues",
  "ParsedPositionals",
  "ParsedTokens",
  "ParsedOptionToken",
  "ParsedPositionalToken",
  "PreciseTokenForOptions",
  "TokenForOptions",
  "OptionToken",
  "Token",
]);


/** True for the parseArgs type family that deliberately rides dyn. Exported
 * for the property-read bridge after TypeScript narrows a token union arm. */
export function isParseArgsDynTypeName(name: string): boolean {
  return PARSE_ARGS_DYN_TYPES.has(name);
}


export interface DeclaredOrderPriorityRef {
  rank: readonly number[];
}


export type DeclaredOrderPriority = readonly number[] | DeclaredOrderPriorityRef;


export function priorityRank(priority: DeclaredOrderPriority): readonly number[] {
  return Array.isArray(priority) ? priority : (priority as DeclaredOrderPriorityRef).rank;
}


export function comparePriority(left: DeclaredOrderPriority, right: DeclaredOrderPriority): number {
  const a = priorityRank(left);
  const b = priorityRank(right);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
