import { useState } from "react";

export default function Page() {
  const [count, setCount] = useState(0);
  return (
    <div>
      <h1 data-testid="title">Hello v1</h1>
      <button data-testid="inc" onClick={() => setCount((c) => c + 1)}>
        inc
      </button>
      <div data-testid="count">{count}</div>
    </div>
  );
}
