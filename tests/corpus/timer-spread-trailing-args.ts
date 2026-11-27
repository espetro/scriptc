// Spread arguments in the trailing callback positions of the timer
// calls: setTimeout(cb, ms, ...args) delivers the spread elements to the
// callback in place, setInterval delivers them every tick, the
// node:timers named and namespace imports take the same forms, and
// process.nextTick spreads its arguments too. The spread iterates when
// the call evaluates — a non-iterable throws its TypeError synchronously,
// and a later mutation of the source array cannot reach the callback.
import { setTimeout as timersSetTimeout } from "node:timers";
import * as timers from "node:timers";

const log: string[] = [];

// The rxjs forwarding shape: a rest parameter spread into the globals.
function forward(handler: () => void, timeout?: number, ...args: any[]): void {
  setTimeout(handler, timeout, ...args);
}
forward(() => log.push("forward fired"), 1, 7, "x");

// A typed tuple spread delivers typed values to a typed callback.
const pair: [number, string] = [7, "x"];
setTimeout((a: number, b: string) => log.push(`pair ${a} ${b}`), 1, ...pair);

// Fixed arguments around a spread keep their positions.
const middle: string[] = ["m1", "m2"];
setTimeout(
  (...a: any[]) => log.push(`mixed ${a.map(String).join(",")}`),
  1,
  "a",
  ...middle,
  "z",
);

// The spread materializes at the call: mutating the source afterwards
// changes nothing the callback receives.
const snapshot = ["one", "two"];
setTimeout((...a: any[]) => log.push(`snapshot ${a.join("")}`), 1, ...snapshot);
snapshot[0] = "mutated";
snapshot.push("three");

// An interval delivers the spread arguments on every tick.
let ticks = 0;
const iv = setInterval((...a: any[]) => {
  ticks++;
  log.push(`tick ${a.map(String).join(",")} ${ticks}`);
  if (ticks === 2) clearInterval(iv);
}, 1, ...["iv", 3]);

// The node:timers module forms share the globals' lowering.
timersSetTimeout((v: string) => log.push(`named ${v}`), 1, ...["ok"]);
timers.setTimeout((v: string) => log.push(`namespace ${v}`), 1, ...["ok2"]);

// process.nextTick spreads its arguments the same way.
process.nextTick((x: number, y: string) => log.push(`nextTick ${x}${y}`), ...[5, "n"]);

// A non-iterable spread throws synchronously, before the timer exists.
try {
  setTimeout(() => log.push("never"), 0, ...(42 as any));
  log.push("no throw");
} catch (error) {
  log.push(`threw ${(error as Error).name}: ${(error as Error).message}`);
}

setTimeout(() => {
  console.log(log.join("|"));
}, 40);
