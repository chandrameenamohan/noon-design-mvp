export type ImageProps = {
  src: string;
  /** Required: an image without a text alternative is an accessibility bug. Use "" only for decoration. */
  alt: string;
  width?: number;
  height?: number;
};

export function Image({ src, alt, width, height }: ImageProps) {
  return <img className="ds-image" data-component="Image" src={src} alt={alt} width={width} height={height} />;
}
