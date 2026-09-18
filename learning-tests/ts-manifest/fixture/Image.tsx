import * as React from 'react';

export interface ImageProps {
  src: string;
  alt?: string;
  width: number;
  height: number;
}

export function Image({ src, alt = '', width, height }: ImageProps) {
  return React.createElement('img', { src, alt, width, height });
}
