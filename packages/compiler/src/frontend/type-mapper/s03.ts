// Statement slice of the former frontend/type-mapper.ts (split for
// maintainability; the directory barrel ../type-mapper.ts re-exports the
// original public surface). Statements are verbatim from the original file.
import { InternalCompilerError } from "../../errors.js";
import { accessorSlotProp, BYTES_ELEMENT_NAME, DYN, F64, PERF_ENTRY_MARKER, recordTextCodecClass, STRING, VOID } from "../../ir/ir.js";
import type { IrType } from "../../ir/ir.js";
import { ShapeRegistry } from "./s01.js";
import { UnionRegistry } from "./s02.js";
import { withUndefinedArm } from "./s23.js";



/** Human-readable rendering of an IrType for diagnostics (records expand to
 * their canonical field list, unions to their arms; `checker.typeToString`
 * can't — it never sees IR types). Bound the traversal as well as its output:
 * cycle detection alone still expands a shared acyclic graph exponentially.
 * The same budget covers every sibling, and deep wrapper chains truncate
 * before exhausting the JS stack. Small types retain their full spelling. */
export function formatIrType(
  t: IrType,
  shapes: ShapeRegistry,
  unions: UnionRegistry,
  seen: Set<string> = new Set(),
): string {
  const maxLength = 4096;
  const maxDepth = 32;
  let output = "";
  let truncated = false;
  const append = (text: string): void => {
    if (truncated) return;
    // Reserve the marker so a full buffer can always report truncation.
    const remaining = maxLength - 3 - output.length;
    if (text.length > remaining) {
      output += text.slice(0, remaining) + "...";
      truncated = true;
    } else {
      output += text;
    }
  };
  const list = (types: readonly IrType[], separator: string, depth: number): void => {
    for (let i = 0; i < types.length && !truncated; i++) {
      if (i > 0) append(separator);
      visit(types[i]!, depth);
    }
  };
  const visit = (t: IrType, depth: number): void => {
    if (truncated) return;
    if (depth >= maxDepth) return append("...");
    const child = (type: IrType): void => visit(type, depth + 1);
    switch (t.kind) {
      case "f64":
        return append("number");
      case "string":
        return append("string");
      case "bool":
        return append("boolean");
      case "dyn":
      case "jsval":
        return append("unknown");
      case "caught":
        // What tsc calls the binding; the fence messages carry the real story.
        return append("unknown");
      case "void":
        return append("void");
      case "undefinedT":
        return append("undefined");
      case "nullT":
        return append("null");
      case "array": {
        // Union/func elements need the parens TS syntax would ("(number |
        // string)[]" — without them the [] reads as binding to the last arm).
        const parens = t.elem.kind === "union" || t.elem.kind === "func";
        if (parens) append("(");
        child(t.elem);
        return append(parens ? ")[]" : "[]");
      }
      case "bytes":
        // The u8 kind reads as Uint8Array (Buffer maps here too — one
        // runtime representation; the message stays honest either way).
        return append(BYTES_ELEMENT_NAME[t.elem]);
      case "map":
        append("Map<");
        child(t.key);
        append(", ");
        child(t.value);
        return append(">");
      case "set":
        append("Set<");
        child(t.elem);
        return append(">");
      case "func":
        append("(");
        list(t.params, ", ", depth + 1);
        append(") => ");
        return child(t.ret);
      case "object":
        // Runtime-provided error classes carry '%'-prefixed IR names
        // ("%Error") so user classes can never collide; diagnostics show the
        // source-level name.
        return append(t.className.startsWith("%") ? t.className.slice(1) : t.className);
      case "classval":
        // The static side, in TS's own spelling.
        append("typeof ");
        return append(t.className.startsWith("%") ? t.className.slice(1) : t.className);
      case "record": {
        const shape = shapes.get(t.shapeId);
        if (!shape) return append(`{ /* unknown shape ${t.shapeId} */ }`);
        const codec = recordTextCodecClass(shape);
        if (codec !== null) return append(codec);
        if (seen.has(t.shapeId)) return append("..."); // the recursive knot
        seen.add(t.shapeId);
        try {
          if (shape.tuple) {
            const byIndex = [...shape.fields].sort((a, b) => Number(a.name) - Number(b.name));
            append("[");
            for (let i = 0; i < byIndex.length && !truncated; i++) {
              if (i > 0) append(", ");
              child(byIndex[i]!.type);
            }
            return append("]");
          }
          if (shape.fields.length === 0 && !shape.indexValue) return append("{}");
          append("{ ");
          for (let i = 0; i < shape.fields.length && !truncated; i++) {
            if (i > 0) append("; ");
            const f = shape.fields[i]!;
            // Accessor slots print in TS's accessor spelling, not the
            // reserved '%'-field encoding.
            const slot = accessorSlotProp(f.name);
            if (slot && f.type.kind === "func") {
              append(slot.kind === "get" ? "get " : "set ");
              append(slot.prop);
              if (slot.kind === "get") {
                append("(): ");
                child(f.type.ret);
              } else {
                append("(");
                child(f.type.params[0] ?? VOID);
                append(")");
              }
            } else {
              append(f.name);
              append(": ");
              child(f.type);
            }
          }
          if (shape.indexValue) {
            if (shape.fields.length > 0) append("; ");
            append("[key: string]: ");
            child(shape.indexValue);
          }
          return append(" }");
        } finally {
          seen.delete(t.shapeId); // sibling occurrences still expand
        }
      }
      case "union": {
        const def = unions.get(t.unionId);
        if (!def) return append(`/* union ${t.unionId} */`);
        if (seen.has(t.unionId)) return append("..."); // the recursive knot
        seen.add(t.unionId);
        try {
          return list(def.arms, " | ", depth + 1);
        } finally {
          seen.delete(t.unionId);
        }
      }
      case "regex":
        return append("RegExp");
      case "date":
        return append("Date");
      case "url":
        return append("URL");
      case "searchParams":
        return append("URLSearchParams");
      case "symbol":
        return append("symbol");
      case "bigint":
        return append("bigint");
      case "stats":
        return append("Stats");
      case "bigintStats":
        return append("BigIntStats");
      case "fileHandle":
        return append("FileHandle");
      case "dir":
        return append("Dir");
      case "spawnRes":
        return append("SpawnSyncReturns");
      case "child":
        return append("ChildProcess");
      case "netServer":
        return append("Server");
      case "netSocket":
        return append("Socket");
      case "http2Session":
        return append("Http2Session");
      case "http2Stream":
        return append("Http2Stream");
      case "dgramSocket":
        return append("dgram.Socket");
      case "testCtx":
        return append("TestContext");
      case "httpReq":
        return append("IncomingMessage");
      case "httpRes":
        return append("ServerResponse");
      case "httpClientReq":
        return append("ClientRequest");
      case "secureCtx":
        return append("SecureContext");
      case "cryptoHash":
        return append("Hash");
      case "cryptoHmac":
        return append("Hmac");
      case "fsWatcher":
        return append("FSWatcher");
      case "childStream":
        return append("Readable");
      case "childWriter":
        return append("Writable");
      case "procStream":
        return append("WriteStream");
      case "moduleNs":
        append("module namespace '");
        append(t.moduleId);
        return append("'");
      case "promise":
        append("Promise<");
        child(t.inner);
        return append(">");
      case "generator":
        append(t.async ? "AsyncGenerator<" : "Generator<");
        list([t.yieldT, t.retT, t.nextT], ", ", depth + 1);
        return append(">");
      default: {
        const _exhaustive: never = t;
        void _exhaustive;
        throw new InternalCompilerError("unreachable");
      }
    }
  };
  visit(t, 0);
  return output;
}


/** True when the declaration sits inside `declare module "<name>"` (or
 * its node:-prefixed twin) — the disambiguator for builtin-module type
 * names that repeat across modules (net.Server vs http.Server). Both
 * @types/node and the shipped fallback declare builtins this way. */
/** ES OrdinaryOwnPropertyKeys order over string keys: canonical array
 * indices (the exact string spelling of an integer in [0, 2^32-1)) come
 * first in ascending numeric order, everything else follows in the given
 * (insertion/declaration) order. This is JS's enumeration order for the
 * objects records model — Object.keys, JSON.stringify, spread, inspect. */
export function esOwnKeyOrder(names: string[]): string[] {
  const isArrayIndex = (name: string): boolean => {
    const n = Number(name);
    return Number.isInteger(n) && n >= 0 && n < 4294967295 && String(n) === name;
  };
  const indices = names.filter(isArrayIndex).sort((a, b) => Number(a) - Number(b));
  return indices.length === 0 ? names : [...indices, ...names.filter((n) => !isArrayIndex(n))];
}


/** The hidden field that marks the perf_hooks entry record shape
 * (ir/ir.ts defines it: the backend's dyn conversion needs it too);
 * re-exported here so frontend call sites keep their import path. */
export { PERF_ENTRY_MARKER };


/** PerformanceEntry's toJSON fields, in toJSON's order. */
export const PERF_ENTRY_FIELDS = ["name", "entryType", "startTime", "duration", "detail"];


/** The record shape behind PerformanceEntry, PerformanceMark and
 * PerformanceMeasure values (see mapType). The marker is an always-absent
 * optional, so dyn conversions and key walks never see it. */
export function perfEntryShape(shapes: ShapeRegistry, unions: UnionRegistry): string {
  return shapes.intern(
    [
      { name: PERF_ENTRY_MARKER, type: withUndefinedArm(F64, unions)! },
      { name: "detail", type: DYN },
      { name: "duration", type: F64 },
      { name: "entryType", type: STRING },
      { name: "name", type: STRING },
      { name: "startTime", type: F64 },
    ],
    false,
    undefined,
    PERF_ENTRY_FIELDS,
  );
}


/** The `{ stdout, stderr }` record a promisified exec/execFile call
 * fulfills with (see mapType), in Node's key order. */
export function execResultShape(shapes: ShapeRegistry): string {
  return shapes.intern(
    [
      { name: "stderr", type: STRING },
      { name: "stdout", type: STRING },
    ],
    false,
    undefined,
    ["stdout", "stderr"],
  );
}


/** toJSON()'s plain object over an entry: the same fields without the
 * marker. */
export function perfEntryJsonShape(shapes: ShapeRegistry): string {
  return shapes.intern(
    [
      { name: "detail", type: DYN },
      { name: "duration", type: F64 },
      { name: "entryType", type: STRING },
      { name: "name", type: STRING },
      { name: "startTime", type: F64 },
    ],
    false,
    undefined,
    PERF_ENTRY_FIELDS,
  );
}


/** The fields of performance.nodeTiming's uvMetricsInfo object, in Node's
 * key order. */
export const UV_METRICS_FIELDS = ["loopCount", "events", "eventsWaiting"];


/** The record behind uv_metrics_info: the three counters Node's
 * uvMetricsInfo getter reads off libuv. */
export function uvMetricsShape(shapes: ShapeRegistry): string {
  return shapes.intern(
    [
      { name: "events", type: F64 },
      { name: "eventsWaiting", type: F64 },
      { name: "loopCount", type: F64 },
    ],
    false,
    undefined,
    UV_METRICS_FIELDS,
  );
}


/** performance.nodeTiming's own properties, in Node's key order. */
export const PERF_NODE_TIMING_FIELDS = [
  "name",
  "entryType",
  "startTime",
  "duration",
  "nodeStart",
  "v8Start",
  "environment",
  "loopStart",
  "loopExit",
  "bootstrapComplete",
  "idleTime",
  "uvMetricsInfo",
];
