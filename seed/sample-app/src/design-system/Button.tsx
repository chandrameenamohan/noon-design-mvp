export type ButtonProps = {
  label: string;
  variant?: "primary" | "secondary" | "ghost";
  disabled?: boolean;
};

export function Button({ label, variant = "primary", disabled = false }: ButtonProps) {
  return (
    <button type="button" className={`ds-button ds-button--${variant}`} data-component="Button" disabled={disabled}>
      {label}
    </button>
  );
}
