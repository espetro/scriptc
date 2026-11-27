// `const Alias = Base` — a const binding that holds exactly one class:
// `extends Alias<T>` is the same generic heritage as `extends Base<T>`,
// for a concrete argument and for the subclass's own type parameter.
class Base<T> {
  v: T;
  constructor(v: T) {
    this.v = v;
  }
  get(): T {
    return this.v;
  }
}
const Alias = Base;
class Concrete extends Alias<number> {
  tag = 1;
}
class Generic<T> extends Alias<T> {
  tag = 2;
}
const c = new Concrete(10);
const g = new Generic<string>("hi");
console.log(c.get(), c.tag, c instanceof Base, c instanceof Alias, c instanceof Concrete);
console.log(g.get(), g.tag, g instanceof Base, g instanceof Generic);
const asBase: Base<string> = g;
console.log(asBase.get(), asBase instanceof Generic);
