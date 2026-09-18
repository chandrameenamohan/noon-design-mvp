import * as React from 'react';

// Deliberately uses React.ComponentProps<'button'> (not 'input') per the spec's
// exact wording, to test the "hundreds of inherited DOM props" explosion and the
// filter-by-declaration-source-file rule. It layers one own prop, `label`, on top.
export type InputProps = React.ComponentProps<'button'> & {
  label: string;
};

export function Input({ label, ...rest }: InputProps) {
  return React.createElement('button', rest, label);
}
