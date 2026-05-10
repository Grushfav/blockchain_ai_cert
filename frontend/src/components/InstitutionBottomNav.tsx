import type { ReactNode } from "react";
import { Link } from "react-router-dom";

export type InstitutionNavKey = "mint" | "batch" | "audit" | "wallet" | "settings";

const ITEMS: { key: InstitutionNavKey; icon: string; label: string }[] = [
  { key: "mint", icon: "⛏", label: "Mint" },
  { key: "batch", icon: "☁", label: "Batch" },
  { key: "audit", icon: "🧾", label: "Audit" },
  { key: "wallet", icon: "👛", label: "Wallet" },
  { key: "settings", icon: "⚙", label: "Settings" },
];

export function InstitutionBottomNav({
  active,
  onChange,
  hrefFor,
  rightSlot,
}: {
  active: InstitutionNavKey | null;
  onChange?: (k: InstitutionNavKey) => void;
  /** When set, items navigate (e.g. from dashboard to portal with a `?mode=` query). */
  hrefFor?: (k: InstitutionNavKey) => string;
  rightSlot?: ReactNode;
}) {
  return (
    <nav className="inst-bottom-nav" aria-label="Institution portal navigation">
      {ITEMS.map(({ key, icon, label }) => {
        const isActive = active != null && active === key;
        const className = isActive ? "inst-bottom-nav__item active" : "inst-bottom-nav__item";
        const inner = (
          <>
            <span className="inst-bottom-nav__icon" aria-hidden>
              {icon}
            </span>
            <span className="inst-bottom-nav__label">{label}</span>
          </>
        );
        if (hrefFor) {
          return (
            <Link key={key} to={hrefFor(key)} className={className} replace={false}>
              {inner}
            </Link>
          );
        }
        return (
          <button key={key} type="button" className={className} onClick={() => onChange?.(key)}>
            {inner}
          </button>
        );
      })}

      {rightSlot ? <div className="inst-bottom-nav__right">{rightSlot}</div> : null}
    </nav>
  );
}

