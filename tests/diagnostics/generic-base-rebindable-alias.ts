// Only an EXACT class binding spells a generic base: `const Alias = Base`
// pins the class, but a `let` binding can be rebound before the class
// evaluates, so `extends Alias<T>` keeps the generic-class refusal.
class Base<T> {
  v: T;
  constructor(v: T) {
    this.v = v;
  }
}
let Alias = Base;
class Sub<T> extends Alias<T> {
  tag = 1;
}
console.log(new Sub<number>(1).v);
