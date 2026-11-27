// A generic subclass whose base type argument is `any`: the base still has
// a concrete layout — each parameter slot is the checked dynamic value — so
// the subclass constructs and its inherited members lower.
class Base<T> {
  value: T;
  constructor(v: T) {
    this.value = v;
  }
  get(): T {
    return this.value;
  }
}
class Sub<U> extends Base<any> {
  tag: U;
  constructor(v: any, tag: U) {
    super(v);
    this.tag = tag;
  }
}
const s = new Sub<string>(123, "ok");
console.log(s.get(), s.tag, s instanceof Base, s instanceof Sub);
const t = new Sub<number>("text", 7);
console.log(t.get(), t.tag, t instanceof Base);
function read(sub: Sub<boolean>): unknown {
  return sub.get();
}
console.log(read(new Sub<boolean>({ deep: true }, false)));
