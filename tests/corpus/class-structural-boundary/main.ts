// Class instances from an external package consumed through structural types.
// The structural type describes the same public API the class declares,
// so the instance satisfies it without copying or wrapping.
import { of, type Observable, type Subscription } from "observable-lib";

// Structural types that describe the same shapes as the classes.
interface Subscribable<T> {
  subscribe(observer: { next(value: T): void; complete(): void }): Disposable;
}
interface Disposable {
  closed: boolean;
  unsubscribe(): void;
}

// A function that accepts the structural type, not the class.
function collect<T>(source: { subscribe(observer: { next(value: T): void; complete(): void }): { closed: boolean; unsubscribe(): void } }): T[] {
  const result: T[] = [];
  const sub = source.subscribe({
    next(v) { result.push(v); },
    complete() { /* done */ },
  });
  console.log("closed after subscribe:", sub.closed);
  sub.unsubscribe();
  console.log("closed after unsubscribe:", sub.closed);
  return result;
}

// Pass the class instance to the structural-typed function.
const obs = of(1, 2, 3);
const items = collect(obs);
console.log("items:", items.join(", "));

// Assign a class instance to a structurally typed binding.
const subscribable: Subscribable<number> = of(10, 20);
const collected: number[] = [];
const disposable: Disposable = subscribable.subscribe({
  next(v) { collected.push(v); },
  complete() { /* done */ },
});
console.log("collected:", collected.join(", "));
console.log("disposable closed:", disposable.closed);
disposable.unsubscribe();
console.log("after unsubscribe:", disposable.closed);

// Identity: the structural view IS the class instance.
const obs2 = of(42);
const asStructural: { subscribe(observer: { next(value: number): void; complete(): void }): { closed: boolean } } = obs2;
console.log("same object:", obs2 === (asStructural as unknown as Observable<number>));
