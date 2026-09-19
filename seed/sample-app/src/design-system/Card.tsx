import type { ReactNode } from "react";

export type CardProps = {
  title?: string;
  /** Inner padding, in pixels. */
  padding?: number;
  children?: ReactNode;
};

export function Card({ title, padding = 16, children }: CardProps) {
  return (
    <section className="ds-card" data-component="Card" style={{ padding }}>
      {title === undefined ? null : <h2 className="ds-card__title">{title}</h2>}
      {children}
    </section>
  );
}
