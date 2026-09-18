import * as React from 'react';

interface TextOwnProps {
  value: string;
  bold?: boolean;
}

interface TextStyleProps {
  variant: 'body' | 'caption' | 'heading';
  muted?: boolean;
}

// Props type built with Omit<> AND an intersection: 'muted' is omitted from
// TextStyleProps, then merged with TextOwnProps. The checker must resolve
// through both operators to get the flat prop list.
export type TextProps = Omit<TextStyleProps, 'muted'> & TextOwnProps;

export function Text({ value, bold = false, variant }: TextProps) {
  const Tag = variant === 'heading' ? 'h4' : variant === 'caption' ? 'small' : 'span';
  return React.createElement(Tag, { style: { fontWeight: bold ? 700 : 400 } }, value);
}
