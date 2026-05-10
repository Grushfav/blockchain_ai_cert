import type { HTMLAttributes } from "react";

export type LoadingSpinnerSize = "sm" | "md";

export type LoadingSpinnerProps = {
  size?: LoadingSpinnerSize;
  /** Used when spinner is the accessible status indicator (not aria-hidden). */
  label?: string;
} & HTMLAttributes<HTMLSpanElement>;

const SIZE_CLASS: Record<LoadingSpinnerSize, string> = {
  sm: "loading-spinner--sm",
  md: "loading-spinner--md",
};

/**
 * CSS-only ring spinner; respects prefers-reduced-motion in App.css.
 */
export function LoadingSpinner({
  size = "md",
  label = "Loading",
  className = "",
  ...rest
}: LoadingSpinnerProps) {
  const decorative = rest["aria-hidden"] === true;
  return (
    <span
      role={decorative ? undefined : "status"}
      aria-busy={decorative ? undefined : true}
      aria-label={decorative ? undefined : label}
      className={`loading-spinner ${SIZE_CLASS[size]} ${className}`.trim()}
      {...rest}
    />
  );
}

type BusyLabelProps = {
  busy: boolean;
  idle: string;
  busyLabel: string;
  spinnerSize?: LoadingSpinnerSize;
};

/** Inline spinner + label for buttons; spinner is decorative when busy (label text remains visible). */
export function BusyLabel({ busy, idle, busyLabel, spinnerSize = "sm" }: BusyLabelProps) {
  return (
    <span className="busy-label">
      {busy && <LoadingSpinner size={spinnerSize} aria-hidden={true} />}
      <span>{busy ? busyLabel : idle}</span>
    </span>
  );
}
