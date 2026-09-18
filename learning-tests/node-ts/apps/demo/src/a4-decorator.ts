// Assumption 4: experimental (legacy, TS-only) decorators are non-erasable
// syntax; should fail under plain type stripping.
function log(target: any, key: string, descriptor: PropertyDescriptor) {
  return descriptor;
}

class Greeter {
  @log
  greet() {
    return "hi";
  }
}
console.log(`a4-decorator ${new Greeter().greet()}`);
