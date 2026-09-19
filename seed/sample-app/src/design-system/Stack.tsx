import type { ReactNode } from "react";

export type StackProps = {
  /** Which way the children flow. */
  direction?: "row" | "column";
  /** Space between children, in pixels. */
  gap?: number;
  align?: "start" | "center" | "end" | "stretch";
  children?: ReactNode;
};

const ALIGN = { start: "flex-start", center: "center", end: "flex-end", stretch: "stretch" } as const;

export function Stack({ direction = "column", gap = 8, align = "stretch", children }: StackProps) {
  return (
    <div className="ds-stack" data-component="Stack" style={{ flexDirection: direction, gap, alignItems: ALIGN[align] }}>
      {children}
    </div>
  );
}
