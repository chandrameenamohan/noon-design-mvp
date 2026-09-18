// Pure type-only module: no runtime exports at all after stripping.
export interface Config {
  debug: boolean;
}
export type Mode = "on" | "off";
