import * as React from 'react';

export interface ButtonProps {
  variant?: 'primary' | 'ghost';
  disabled?: boolean;
  onPress?: () => void;
  children: React.ReactNode;
}

// Default value via destructuring for a string-literal-union prop.
export function Button({ variant = 'primary', disabled = false, onPress, children }: ButtonProps) {
  return React.createElement(
    'button',
    { className: `btn btn--${variant}`, disabled, onClick: onPress },
    children,
  );
}
