import { useCallback, useEffect, useMemo, useState } from "react";

import { apiJson, getStoredRole, getStoredToken } from "../api/client";
import { getInjectedProvider, readConnectedAddress, readIssuerReadyAddress } from "../utils/browserWallet";

export const ONBOARDING_STORAGE_KEY = "truecert_onboarding_v1";
export const ONBOARDING_VERIFY_FLAG = "truecert_onboarding_verified";
export const ONBOARDING_METRICS_FLAG = "truecert_onboarding_metrics";

export type OnboardingStepId =
  | "wallet"
  | "register"
  | "admin_whitelist"
  | "connect_wallet"
  | "mint"
  | "verify"
  | "actions"
  | "metrics";

export type OnboardingStep = {
  id: OnboardingStepId;
  title: string;
  summary: string;
  to?: string;
  external?: { label: string; href: string }[];
};

export const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    id: "wallet",
    title: "Install a crypto wallet & fund Amoy POL",
    summary:
      "Install MetaMask (or similar), add the Polygon Amoy test network, and request test POL from the faucet. " +
      "Your issuer wallet pays gas for claim, revoke, and other institution actions.",
    external: [
      { label: "Get MetaMask", href: "https://metamask.io/download/" },
      { label: "Polygon Amoy faucet", href: "https://faucet.polygon.technology/" },
    ],
  },
  {
    id: "register",
    title: "Register your institution",
    summary:
      "Submit the registration wizard with your institution profile and paste your public issuer wallet address (never your private key).",
    to: "/register",
  },
  {
    id: "admin_whitelist",
    title: "Admin login & whitelist issuer",
    summary:
      "Sign in as an admin, open the registration queue, and approve the institution. Approval whitelists the issuer wallet on the TrueCert contract.",
    to: "/admin",
  },
  {
    id: "connect_wallet",
    title: "Connect issuer wallet",
    summary:
      "Log in as the institution, open Settings → Wallet (or use the sidebar), and connect the same MetaMask account you registered as issuer. Status should show issuer wallet ready on Polygon Amoy.",
    to: "/university?mode=settings",
  },
  {
    id: "mint",
    title: "Mint a certificate",
    summary:
      "With your issuer wallet connected, prepare a single mint, sign the EIP-712 authorization in MetaMask (no gas), then submit for platform minting.",
    to: "/university",
  },
  {
    id: "verify",
    title: "Verify a certificate",
    summary:
      "Use the public verify page with the on-chain token ID or credential fields. Confirm on-chain status and signed metadata.",
    to: "/verify",
  },
  {
    id: "actions",
    title: "Lifecycle actions on a certificate",
    summary:
      "From Actions, claim the token to a student wallet (soulbound), or practice revoke, burn, and reissue with your issuer wallet.",
    to: "/university?mode=actions",
  },
  {
    id: "metrics",
    title: "View issuance metrics",
    summary:
      "Open Analytics to review mint volume, timing heatmaps, and operational trends for your institution.",
    to: "/university/analytics",
  },
];

function loadManualCompleted(): Set<OnboardingStepId> {
  try {
    const raw = localStorage.getItem(ONBOARDING_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as OnboardingStepId[];
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function saveManualCompleted(set: Set<OnboardingStepId>) {
  localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify([...set]));
}

export function useOnboardingProgress() {
  const [manual, setManual] = useState<Set<OnboardingStepId>>(() => loadManualCompleted());
  const [auto, setAuto] = useState<Set<OnboardingStepId>>(new Set());
  const [checking, setChecking] = useState(false);

  const runAutoCheck = useCallback(async () => {
    setChecking(true);
    const detected = new Set<OnboardingStepId>();
    try {
      if (getInjectedProvider()) {
        detected.add("wallet");
        const addr = await readConnectedAddress();
        if (addr) detected.add("wallet");
      }

      const token = getStoredToken();
      const role = getStoredRole();
      if (token && role === "university") {
        try {
          const uniMe = await apiJson<{
            status?: string;
            wallet_address?: string;
            chain_id?: number;
          }>("/api/university/me");
          detected.add("register");
          if (uniMe.status === "verified") detected.add("admin_whitelist");
          if (uniMe.wallet_address && uniMe.chain_id) {
            const ready = await readIssuerReadyAddress({
              wallet_address: uniMe.wallet_address,
              chain_id: uniMe.chain_id,
              status: uniMe.status,
            });
            if (ready) detected.add("connect_wallet");
          }

          const activity = await apiJson<{ events?: { action?: string }[] }>(
            "/api/university/activity/basic?limit=40"
          ).catch(() => ({ events: [] }));
          const actions = new Set((activity.events || []).map((e) => (e.action || "").toLowerCase()));
          if (actions.has("issued")) detected.add("mint");
          if (actions.has("transferred")) detected.add("actions");
        } catch {
          /* university session not available */
        }
      } else if (token && role === "admin") {
        try {
          const adminList = await apiJson<{ universities?: { status?: string }[] }>(
            "/api/admin/universities?status=verified"
          );
          if ((adminList.universities || []).length > 0) {
            detected.add("admin_whitelist");
          }
          const pending = await apiJson<{ universities?: unknown[] }>(
            "/api/admin/universities?status=pending"
          ).catch(() => ({ universities: [] }));
          if ((pending.universities || []).length > 0) {
            detected.add("register");
          }
        } catch {
          /* admin API unavailable */
        }
      }

      if (sessionStorage.getItem(ONBOARDING_VERIFY_FLAG) === "1") {
        detected.add("verify");
      }
      if (sessionStorage.getItem(ONBOARDING_METRICS_FLAG) === "1") {
        detected.add("metrics");
      }
    } finally {
      setAuto(detected);
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void runAutoCheck();
    const onFocus = () => void runAutoCheck();
    window.addEventListener("focus", onFocus);
    const id = window.setInterval(() => void runAutoCheck(), 8000);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(id);
    };
  }, [runAutoCheck]);

  const completed = useMemo(() => {
    const merged = new Set<OnboardingStepId>();
    for (const id of manual) merged.add(id);
    for (const id of auto) merged.add(id);
    return merged;
  }, [manual, auto]);

  const markComplete = useCallback((id: OnboardingStepId) => {
    setManual((prev) => {
      const next = new Set(prev);
      next.add(id);
      saveManualCompleted(next);
      return next;
    });
  }, []);

  const resetProgress = useCallback(() => {
    const empty = new Set<OnboardingStepId>();
    setManual(empty);
    saveManualCompleted(empty);
    sessionStorage.removeItem(ONBOARDING_VERIFY_FLAG);
    sessionStorage.removeItem(ONBOARDING_METRICS_FLAG);
    void runAutoCheck();
  }, [runAutoCheck]);

  const completedCount = ONBOARDING_STEPS.filter((s) => completed.has(s.id)).length;
  const percent = Math.round((completedCount / ONBOARDING_STEPS.length) * 100);

  return {
    completed,
    completedCount,
    percent,
    checking,
    markComplete,
    resetProgress,
    refresh: runAutoCheck,
    isComplete: (id: OnboardingStepId) => completed.has(id),
    isAuto: (id: OnboardingStepId) => auto.has(id) && !manual.has(id),
  };
}
