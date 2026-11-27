// The timer globals read as values in TypeScript: a `const` alias calls
// and clears like the direct spelling, a `||` fallback picks the
// delegate's clear or the global's (the rxjs scheduler-provider shape),
// typeof/name/length answer as Node's do, and queueMicrotask, the clear
// functions and setImmediate work through stored values too.

const log: string[] = [];

// Aliases of the creation and clear functions.
const later = setTimeout;
const sooner = clearTimeout;
const every = setInterval;
const stopEvery = clearInterval;
const immediacy = setImmediate;
const dropImmediacy = clearImmediate;
const laterMicro = queueMicrotask;

console.log(typeof sooner, sooner.name, sooner.length);
console.log(typeof every, every.name);

const fired = later((a: number, b: string) => log.push(`aliased ${a}${b}`), 1, ...[4, "f"]);
sooner(fired);

const cancelled = later(() => log.push("cancelled"), 1);
sooner(cancelled);

// The immediates queue from inside the interval's second tick, so their
// check phase is the one after it — an immediate and the timer it drops
// keep Node's order.
let pending: ReturnType<typeof setImmediate> | undefined;
let ticks = 0;
const iv = every(() => {
  ticks++;
  log.push(`interval ${ticks}`);
  if (ticks === 2) {
    stopEvery(iv);
    immediacy(() => {
      log.push("immediate go");
      dropImmediacy(pending);
    }, "go");
    pending = immediacy(() => log.push("pending immediate"));
  }
}, 1);

laterMicro(() => log.push("microtask value"));

// The delegate-fallback shape: `(delegate?.clearX || clearX)(handle)`.
interface Provider {
  clearTimeout: (handle: unknown) => void;
}
const provider: { delegate: Provider | undefined } = { delegate: undefined };
const doomed = later(() => log.push("doomed"), 30);
(function clearThrough(provider: { delegate: Provider | undefined }, handle: unknown): void {
  const delegate = provider.delegate;
  (delegate?.clearTimeout || clearTimeout)(handle as any);
})(provider, doomed);

provider.delegate = {
  clearTimeout: (handle) => {
    log.push("delegate cleared");
    sooner(handle as any);
  },
};
const doomed2 = later(() => log.push("doomed2"), 30);
(function clearThrough(provider: { delegate: Provider | undefined }, handle: unknown): void {
  const delegate = provider.delegate;
  (delegate?.clearTimeout || clearTimeout)(handle as any);
})(provider, doomed2);

later(() => {
  console.log(log.join("|"));
}, 40);
