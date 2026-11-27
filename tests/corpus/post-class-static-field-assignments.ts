// @transform-types
// A static field declared without an initializer (`static x: T;`) is the
// declaration half of a split definition: JavaScript defines it undefined
// at class evaluation, and a later `C.x = v` at module top level (or in a
// function the program calls) is its implementation. Reads before the
// write answer undefined; calls and reads after it see the written value.
class Counter {
  static count: number;
  static label: string;
  static next: () => number;
  static make: <T>(value: T) => T;
  value = 0;
}

// The class statement itself defines every declared static as undefined.
console.log("before writes:", Counter.count, Counter.label, Counter.next);

function install(): void {
  Counter.count = 40;
  Counter.label = "answer";
  Counter.next = () => ++Counter.count;
  Counter.make = function <T>(value: T): T {
    return value;
  };
}
install();

console.log(Counter.count, Counter.label, Counter.next(), Counter.next());
console.log(Counter.make(7), Counter.make("seven"));

// A func-typed static field called through the class name, the ctor-
// assigned-callback pattern with the implementation after the body.
class Node {
  static create: (name: string, next: Node | null) => Node;
  name: string;
  next: Node | null;
  constructor(name: string, next: Node | null) {
    this.name = name;
    this.next = next;
  }
}
Node.create = (name: string, next: Node | null) => new Node(name, next);
const list = Node.create("a", Node.create("b", null));
console.log(list.name, list.next!.name, list.next!.next);

// A static block between the declaration and the assignment reads the
// field's defined-undefined value, in member order.
class Timed {
  static stamp: number;
  static {
    console.log("block reads stamp:", Timed.stamp);
  }
  static epoch = 0;
}
console.log("after class:", Timed.stamp, Timed.epoch);
Timed.stamp = 1729;
console.log(Timed.stamp);

// A subclass reads the inherited declaration through its own name; the
// write stays on the declaring class.
class Base {
  static version: number;
}
class Derived extends Base {}
Base.version = 3;
console.log(Derived.version, Base.version);

// A const alias taken before the write holds undefined; one taken after
// holds the function.
class Late {
  static run: () => string;
}
const early = Late.run;
Late.run = () => "late";
const late = Late.run;
console.log(early, late());

// An `unknown` slot, a class expression, and a generic class hold the same
// defined-undefined value.
class Loose {
  static anything: unknown;
}
console.log(Loose.anything, Loose.anything === undefined);
Loose.anything = "set";
console.log(Loose.anything);
const Expressed = class {
  static count: number;
};
console.log(Expressed.count);
class Holder<T> {
  static total: number;
  constructor(public item: T) {}
}
console.log(Holder.total);
Holder.total = 1;
console.log(Holder.total, new Holder("x").item);

// An earlier initializer that reads a later declaration sees undefined.
class Eager {
  static early = Eager.peek();
  static count: number;
  static peek(): string {
    return `peek:${Eager.count}`;
  }
}
console.log(Eager.early, Eager.count);

// A field whose type cannot hold undefined stays unlowered, and a program
// that never touches it compiles.
class Unused {
  static when: Date;
  static loose: any;
}
console.log(new Unused() instanceof Unused);
