// @transform-types
// A generic class inside a namespace as a base: `extends ns.Base<T>`
// resolves the member to the family and the type arguments name a concrete
// instantiation, like the named spelling.
namespace ns {
  export class Base<T> {
    v: T;
    constructor(v: T) {
      this.v = v;
    }
    get(): T {
      return this.v;
    }
  }
}
class Concrete extends ns.Base<number> {
  extra = 1;
}
class Generic<T> extends ns.Base<T> {
  extra = 2;
}
const a = new Concrete(10);
const b = new Generic<string>("hi");
console.log(a.get(), a.extra, a instanceof ns.Base, a instanceof Concrete);
console.log(b.get(), b.extra, b instanceof ns.Base, b instanceof Generic);
const asBase: ns.Base<string> = b;
console.log(asBase.get());
