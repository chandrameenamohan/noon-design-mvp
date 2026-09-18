// Assumption 9: Node cannot run .tsx directly (JSX transform unsupported).
function Greeting(props: { name: string }) {
  return <div>Hello {props.name}</div>;
}
console.log(`a9-should-not-print ${JSON.stringify(Greeting({ name: "world" }))}`);
