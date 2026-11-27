// `super.m` read as a value is the base chain's method function: unbound,
// so `.bind`, `.call` and a later `.bind` supply the receiver, preset
// arguments prepend, and an override at or below the reading class never
// answers for it.
class Base {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
  greet(prefix: string, punct: string = "!"): string {
    return `${prefix}${this.name}${punct}`;
  }
}
class Mid extends Base {
  greet(prefix: string, punct: string = "!"): string {
    return "mid>" + super.greet(prefix, punct);
  }
}
class Derived extends Mid {
  captureBind() {
    return super.greet.bind(this);
  }
  capturePreset() {
    return super.greet.bind(this, "P");
  }
  captureCall() {
    return super.greet.call(this, "C");
  }
  captureBare() {
    const f = super.greet;
    return f.call(this, "B");
  }
  captureBindLater() {
    const f = super.greet;
    return f.bind(this)("L");
  }
  captureArrow() {
    return () => super.greet.bind(this)("A");
  }
  captureMeta() {
    const bound = super.greet.bind(this, "M");
    return bound.name + "|" + bound.length;
  }
}
const d = new Derived("world");
console.log(d.captureBind()("hi ", "?"));
console.log(d.capturePreset()("?"));
console.log(d.captureCall());
console.log(d.captureBare());
console.log(d.captureBindLater());
console.log(d.captureArrow()());
console.log(d.captureMeta());
// A further-derived receiver still passes the base method's receiver check.
class Leaf extends Derived {}
console.log(new Leaf("leaf").captureBind()("Z"));
// A class that does not override reads its own base's method.
class Plain extends Base {
  cap() {
    return super.greet.bind(this, ">");
  }
}
console.log(new Plain("plain").cap()("P"));
