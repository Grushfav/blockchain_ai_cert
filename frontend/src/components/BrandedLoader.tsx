import trucertLogo from "../images/trucert_logo.png";

export type BrandedLoaderSize = "sm" | "md" | "lg";

export type BrandedLoaderProps = {
  /** Logo height scales from these presets (width auto). */
  size?: BrandedLoaderSize;
  /** Very slow rotation for large panel overlays only; omit on compact contexts. */
  slowRotate?: boolean;
  className?: string;
};

/**
 * TruCert mark + gentle pulse animation. Pair with visible status text
 * (parent should expose role="status" / aria-live or button aria-busy).
 */
export function BrandedLoader({ size = "md", slowRotate = false, className = "" }: BrandedLoaderProps) {
  const img = (
    <img
      src={trucertLogo}
      alt=""
      aria-hidden
      className="branded-loader__img"
      draggable={false}
    />
  );

  return (
    <div
      className={`branded-loader branded-loader--${size} ${slowRotate ? "branded-loader--slow-rotate" : ""} ${className}`.trim()}
      aria-hidden
    >
      {slowRotate ? <div className="branded-loader__rotate">{img}</div> : img}
    </div>
  );
}
