export type TextProps = {
  value: string;
  size?: "sm" | "md" | "lg";
  weight?: "regular" | "bold";
  tone?: "default" | "muted";
};

export function Text({ value, size = "md", weight = "regular", tone = "default" }: TextProps) {
  const classes = ["ds-text", `ds-text--${size}`, weight === "bold" ? "ds-text--bold" : "", tone === "muted" ? "ds-text--muted" : ""];
  return (
    <p className={classes.filter(Boolean).join(" ")} data-component="Text">
      {value}
    </p>
  );
}
