export interface Widget {
  id: number;
  name: string;
}

export function makeWidget(id: number, name: string): Widget {
  return { id, name };
}

// This line is what --watch tests look for. Bump the counter and re-run
// the watch experiment to see the process restart pick up the new value.
export const LIB_VERSION = 1;
