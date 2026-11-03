import type { CSSProperties, InputHTMLAttributes } from "react";

/** A range input with a thin track that fills with the accent colour up to the handle. */
export function Slider({
  value,
  min = 0,
  max = 100,
  onValue,
  style,
  className = "",
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "min" | "max" | "onChange" | "type"> & {
  value: number;
  min?: number;
  max?: number;
  onValue: (v: number) => void;
}) {
  const fill = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <input
      {...rest}
      type="range"
      className={`slider ${className}`}
      min={min}
      max={max}
      value={value}
      onChange={(e) => onValue(Number(e.target.value))}
      style={{ ...style, "--fill": `${Math.max(0, Math.min(100, fill))}%` } as CSSProperties}
    />
  );
}
