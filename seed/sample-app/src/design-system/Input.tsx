import { useId } from "react";

export type InputProps = {
  /** Visible label; it is also the input's accessible name. */
  label: string;
  placeholder?: string;
  type?: "text" | "email" | "password" | "number";
  disabled?: boolean;
};

export function Input({ label, placeholder, type = "text", disabled = false }: InputProps) {
  const id = useId();
  return (
    <div className="ds-input" data-component="Input">
      <label htmlFor={id}>{label}</label>
      <input id={id} type={type} placeholder={placeholder} disabled={disabled} />
    </div>
  );
}
