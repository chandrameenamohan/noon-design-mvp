import * as React from 'react';

export interface StackProps {
  /** layout direction */
  direction: 'row' | 'column';
  /** gap between children, in px */
  gap?: number;
  children: React.ReactNode;
}

// Default value via destructuring: NOT visible in the type, only in the AST.
export function Stack({ direction, gap = 8, children }: StackProps) {
  return React.createElement(
    'div',
    { style: { display: 'flex', flexDirection: direction, gap } },
    children,
  );
}
