import * as React from 'react';
import type { Size } from './types.js';

export interface CardProps {
  title: string;
  /** imported type alias prop */
  size?: Size;
  elevated?: boolean;
  /** REQUIRED boolean prop (no `?`, no default) -- used to compare against the
   * OPTIONAL boolean props elsewhere in this fixture (e.g. Button.disabled). */
  bordered: boolean;
  children?: React.ReactNode;
}

export function Card({ title, size = 'md', elevated = false, bordered, children }: CardProps) {
  return React.createElement(
    'div',
    { className: `card card--${size}${elevated ? ' card--elevated' : ''}${bordered ? ' card--bordered' : ''}` },
    React.createElement('h3', null, title),
    children,
  );
}
