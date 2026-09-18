// Assumption 1: `node file.ts` runs with no flag on Node 24.17, check for warnings.
interface Point {
  x: number;
  y: number;
}

const p: Point = { x: 1, y: 2 };
console.log(`a1-ok sum=${p.x + p.y}`);
