import { Fenced } from "@noon/db";

/**
 * A room's journal append that also tells the server when it was FENCED (E7.3, F22): a newer owner claimed the
 * document, so this room must stop at once and send its peers to that owner. The refusal itself still reaches
 * the room (which answers "unavailable" and applies nothing); any other failure is only an outage, left to
 * E6.1b's read-only mode. `onFenced` runs once, however many queued appends are refused after it.
 */
export function watchFence<A extends unknown[], R>(append: (...args: A) => Promise<R>, onFenced: () => void): (...args: A) => Promise<R> {
  let fenced = false;
  return async (...args) => {
    try {
      return await append(...args);
    } catch (err) {
      if (err instanceof Fenced && !fenced) {
        fenced = true;
        onFenced();
      }
      throw err;
    }
  };
}
