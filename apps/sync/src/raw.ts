import type { RawData } from "ws";

/** A frame arrives as a Buffer, an ArrayBuffer, or several Buffers (a fragmented message). Text either way. */
export function frameText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return (data instanceof ArrayBuffer ? Buffer.from(data) : data).toString("utf8");
}
