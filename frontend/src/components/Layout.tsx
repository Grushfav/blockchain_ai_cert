import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { BrowserProvider } from "ethers";
import { useAuth } from "../AuthContext";
import trucertLogo from "../images/trucert_logo.png";
import { apiJson } from "../api/client";
import { BusyLabel } from "./LoadingSpinner";
import {
  connectInjectedWallet,
  friendlyWalletError,
  getInjectedProvider,
  readConnectedAddress,
} from "../utils/browserWallet";

import {
  ShieldCheck,
  BadgeCheck,
  LayoutDashboard,
  BarChart3,
  ShieldAlert,
  Settings,
  LogIn,
  UserPlus,
  GraduationCap,
  Bell,
  ServerCog,
} from "lucide-react";

function sidebarNavClass(active: boolean) {
  return `app-sidebar__link${active ? " app-sidebar__link--active" : ""}`;
}

export function Layout() {
  const { token, role, logout } = useAuth();
  const loc = useLocation();
  const navigate = useNavigate();
  const isInstitution = loc.pathname.startsWith("/university");
  const isWideShell =
    loc.pathname === "/" ||
    loc.pathname === "/verify" ||
    loc.pathname === "/claim" ||
    loc.pathname === "/admin" ||
    loc.pathname.startsWith("/admin/analytics") ||
    loc.pathname.startsWith("/admin/overview") ||
    loc.pathname.startsWith("/admin/risk") ||
    loc.pathname.startsWith("/university/analytics") ||
    loc.pathname === "/university/risk" ||
    loc.pathname === "/university/overview";

  const uniMode = new URLSearchParams(loc.search).get("mode");
  const portalActive = loc.pathname === "/university" && uniMode !== "settings";
  const settingsActive = loc.pathname === "/university" && uniMode === "settings";

  const [notifOpen, setNotifOpen] = useState(false);
  const [notifBusy, setNotifBusy] = useState(false);
  const [notifErr, setNotifErr] = useState<string | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifs, setNotifs] = useState<
    {
      id: number;
      kind: string;
      title: string;
      body: string;
      payload: unknown;
      read_at: string | null;
      created_at: string | null;
    }[]
  >([]);
  const bellWrapRef = useRef<HTMLDivElement | null>(null);
  const notifBellButtonRef = useRef<HTMLButtonElement | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [sidebarWallet, setSidebarWallet] = useState<string | null>(null);
  const [sidebarWalletChainId, setSidebarWalletChainId] = useState<number | null>(null);
  const [sidebarWalletErr, setSidebarWalletErr] = useState<string | null>(null);
  const [sidebarWalletBusy, setSidebarWalletBusy] = useState(false);
  const [institutionPortalFrozen, setInstitutionPortalFrozen] = useState(false);

  const authed = Boolean(token);
  const universityIssuerMode = Boolean(token && role === "university");

  const subtitle =
    role === "admin" ? "Administration" : role === "university" ? "Institutional node" : "Public protocol access";

  async function fetchNotifications() {
    if (!authed) return;
    setNotifErr(null);
    setNotifBusy(true);
    try {
      const data = await apiJson<{
        notifications: {
          id: number;
          kind: string;
          title: string;
          body: string;
          payload: unknown;
          read_at: string | null;
          created_at: string | null;
        }[];
        unread_count: number;
      }>("/api/notifications?limit=30&offset=0");
      setNotifs(data.notifications || []);
      setUnreadCount(Number(data.unread_count || 0));
    } catch (caught: unknown) {
      setNotifErr(caught instanceof Error ? caught.message : "Failed to load notifications");
    } finally {
      setNotifBusy(false);
    }
  }

  async function markRead(id: number) {
    if (!authed) return;
    try {
      const data = await apiJson<{ ok: boolean; unread_count: number }>(`/api/notifications/${id}/read`, {
        method: "POST",
      });
      setUnreadCount(Number(data.unread_count || 0));
      setNotifs((prev) => prev.map((n) => (n.id === id ? { ...n, read_at: n.read_at || new Date().toISOString() } : n)));
    } catch {
      // Non-blocking
    }
  }

  async function markAllRead() {
    if (!authed) return;
    try {
      await apiJson(`/api/notifications/read-all`, { method: "POST" });
      setUnreadCount(0);
      setNotifs((prev) => prev.map((n) => ({ ...n, read_at: n.read_at || new Date().toISOString() })));
    } catch {
      // Non-blocking
    }
  }

  useEffect(() => {
    if (!token || role !== "university") {
      setInstitutionPortalFrozen(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const me = await apiJson<{ is_frozen?: boolean }>("/api/university/me");
        if (!cancelled) setInstitutionPortalFrozen(Boolean(me.is_frozen));
      } catch {
        if (!cancelled) setInstitutionPortalFrozen(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, role, loc.pathname]);

  useEffect(() => {
    if (!authed) {
      setNotifOpen(false);
      setUnreadCount(0);
      setNotifs([]);
      return;
    }
    void fetchNotifications();
    const t = window.setInterval(() => void fetchNotifications(), 45_000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed]);

  /** Deep link from hub: /any?openNotifications=1 opens the bell panel and focuses the trigger. */
  useEffect(() => {
    if (!token) return;
    const params = new URLSearchParams(loc.search);
    if (params.get("openNotifications") !== "1") return;
    setNotifOpen(true);
    void fetchNotifications();
    params.delete("openNotifications");
    const next = params.toString();
    navigate({ pathname: loc.pathname, search: next ? `?${next}` : "" }, { replace: true });
    requestAnimationFrame(() => notifBellButtonRef.current?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot query strip; fetchNotifications is stable enough here
  }, [loc.pathname, loc.search, token, navigate]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!notifOpen) return;
      const el = bellWrapRef.current;
      if (!el) return;
      if (e.target instanceof Node && el.contains(e.target)) return;
      setNotifOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [notifOpen]);

  useEffect(() => {
    if (!notifOpen) return;
    void markAllRead();
  }, [notifOpen]);

  useEffect(() => {
    setSidebarOpen(false);
  }, [loc.pathname, loc.search]);

  useEffect(() => {
    void (async () => {
      const a = await readConnectedAddress();
      if (!a) return;
      setSidebarWallet(a);
      const eth = getInjectedProvider();
      if (!eth) return;
      try {
        const provider = new BrowserProvider(eth);
        const net = await provider.getNetwork();
        setSidebarWalletChainId(Number(net.chainId));
      } catch {
        setSidebarWalletChainId(null);
      }
    })();
  }, []);

  useEffect(() => {
    const eth = getInjectedProvider();
    if (!eth?.on || !eth.removeListener) return;

    const onAccounts = (accs: string[]) => {
      if (!accs?.length) {
        setSidebarWallet(null);
        setSidebarWalletChainId(null);
        return;
      }
      setSidebarWallet(accs[0]);
    };

    const onChain = () => {
      void (async () => {
        try {
          const provider = new BrowserProvider(eth);
          const net = await provider.getNetwork();
          setSidebarWalletChainId(Number(net.chainId));
        } catch {
          setSidebarWalletChainId(null);
        }
      })();
    };

    eth.on("accountsChanged", onAccounts);
    eth.on("chainChanged", onChain);
    return () => {
      eth.removeListener!("accountsChanged", onAccounts);
      eth.removeListener!("chainChanged", onChain);
    };
  }, []);

  async function onSidebarConnectWallet() {
    setSidebarWalletErr(null);
    setSidebarWalletBusy(true);
    try {
      const { address, chainId } = await connectInjectedWallet(universityIssuerMode);
      setSidebarWallet(address);
      setSidebarWalletChainId(Number(chainId));
    } catch (caught: unknown) {
      setSidebarWalletErr(friendlyWalletError(caught));
    } finally {
      setSidebarWalletBusy(false);
    }
  }

  function onSidebarDisconnectWallet() {
    setSidebarWallet(null);
    setSidebarWalletChainId(null);
    setSidebarWalletErr(null);
  }

  function timeAgo(iso: string | null): string {
    if (!iso) return "—";
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return "—";
    const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 60) return "just now";
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
  }

  return (
    <div
      className={`app shell shell--sidebar${isWideShell ? " layout-home" : ""}${isInstitution ? " layout-institution" : ""}`}
    >
      <div
        className={`app-sidebar-backdrop${sidebarOpen ? " app-sidebar-backdrop--visible" : ""}`}
        aria-hidden
        onClick={() => setSidebarOpen(false)}
      />

      <aside className={`app-sidebar${sidebarOpen ? " app-sidebar--open" : ""}`} aria-label="Main navigation">
        <div className="app-sidebar__brand">
          <Link to="/" className="app-sidebar__brand-link" onClick={() => setSidebarOpen(false)}>
            <span className="app-sidebar__logo-wrap">
              <img src={trucertLogo} alt="" className="app-sidebar__logo-img" width={76} height={76} />
            </span>
            <span className="app-sidebar__brand-text">
              <span className="app-sidebar__brand-title">TruCert Protocol</span>
              <span className="app-sidebar__brand-sub">{subtitle}</span>
            </span>
          </Link>
        </div>

        <nav className="app-sidebar__nav" aria-label="Primary">
          <ul className="app-sidebar__list">
            {role !== "admin" && (
              <>
                <li>
                  <NavLink to="/verify" className={({ isActive }) => sidebarNavClass(isActive)} onClick={() => setSidebarOpen(false)}>
                    <span className="app-sidebar__icon" aria-hidden>
                      <ShieldCheck />
                    </span>
                    <span className="app-sidebar__label">Verify</span>
                  </NavLink>
                </li>
                <li>
                  <NavLink to="/claim" className={({ isActive }) => sidebarNavClass(isActive)} onClick={() => setSidebarOpen(false)}>
                    <span className="app-sidebar__icon" aria-hidden>
                      <BadgeCheck />
                    </span>
                    <span className="app-sidebar__label">Claim</span>
                  </NavLink>
                </li>
              </>
            )}

            {!token && (
              <>
                <li>
                  <NavLink to="/login" className={({ isActive }) => sidebarNavClass(isActive)} onClick={() => setSidebarOpen(false)}>
                    <span className="app-sidebar__icon" aria-hidden>
                      <LogIn />
                    </span>
                    <span className="app-sidebar__label">Login</span>
                  </NavLink>
                </li>
                <li>
                  <NavLink
                    to="/register"
                    className={({ isActive }) => sidebarNavClass(isActive)}
                    onClick={() => setSidebarOpen(false)}
                  >
                    <span className="app-sidebar__icon" aria-hidden>
                      <UserPlus />
                    </span>
                    <span className="app-sidebar__label">Register</span>
                  </NavLink>
                </li>
              </>
            )}

            {token && role === "university" && (
              <>
                <li>
                  <NavLink
                    to="/university"
                    className={() => sidebarNavClass(portalActive)}
                    onClick={() => setSidebarOpen(false)}
                  >
                    <span className="app-sidebar__icon" aria-hidden>
                      <GraduationCap />
                    </span>
                    <span className="app-sidebar__label">Issue</span>
                  </NavLink>
                </li>
                <li>
                  <NavLink
                    to="/university/overview"
                    className={({ isActive }) => sidebarNavClass(isActive)}
                    onClick={() => setSidebarOpen(false)}
                  >
                    <span className="app-sidebar__icon" aria-hidden>
                      <LayoutDashboard />
                    </span>
                    <span className="app-sidebar__label">Overview</span>
                  </NavLink>
                </li>
                <li>
                  <NavLink
                    to="/university/analytics"
                    className={({ isActive }) => sidebarNavClass(isActive)}
                    onClick={() => setSidebarOpen(false)}
                  >
                    <span className="app-sidebar__icon" aria-hidden>
                      <BarChart3 />
                    </span>
                    <span className="app-sidebar__label">Analytics</span>
                  </NavLink>
                </li>
                <li>
                  <NavLink
                    to="/university/risk"
                    className={({ isActive }) => sidebarNavClass(isActive)}
                    onClick={() => setSidebarOpen(false)}
                  >
                    <span className="app-sidebar__icon" aria-hidden>
                      <ShieldAlert />
                    </span>
                    <span className="app-sidebar__label">Risk</span>
                  </NavLink>
                </li>
                <li>
                  <NavLink
                    to="/university?mode=settings"
                    className={() => sidebarNavClass(settingsActive)}
                    onClick={() => setSidebarOpen(false)}
                  >
                    <span className="app-sidebar__icon" aria-hidden>
                      <Settings />
                    </span>
                    <span className="app-sidebar__label">Settings</span>
                  </NavLink>
                </li>
              </>
            )}

            {token && role === "admin" && (
              <>
                <li>
                  <NavLink
                    to="/admin/overview"
                    className={({ isActive }) => sidebarNavClass(isActive)}
                    onClick={() => setSidebarOpen(false)}
                  >
                    <span className="app-sidebar__icon" aria-hidden>
                      <LayoutDashboard />
                    </span>
                    <span className="app-sidebar__label">Overview</span>
                  </NavLink>
                </li>
                <li>
                  <NavLink to="/admin" className={({ isActive }) => sidebarNavClass(isActive)} onClick={() => setSidebarOpen(false)}>
                    <span className="app-sidebar__icon" aria-hidden>
                      <ServerCog />
                    </span>
                    <span className="app-sidebar__label">Admin</span>
                  </NavLink>
                </li>
                <li>
                  <NavLink
                    to="/admin/analytics"
                    className={({ isActive }) => sidebarNavClass(isActive)}
                    onClick={() => setSidebarOpen(false)}
                  >
                    <span className="app-sidebar__icon" aria-hidden>
                      <BarChart3 />
                    </span>
                    <span className="app-sidebar__label">Analytics</span>
                  </NavLink>
                </li>
                <li>
                  <NavLink
                    to="/admin/risk"
                    className={({ isActive }) => sidebarNavClass(isActive)}
                    onClick={() => setSidebarOpen(false)}
                  >
                    <span className="app-sidebar__icon" aria-hidden>
                      <ShieldAlert />
                    </span>
                    <span className="app-sidebar__label">Risk</span>
                  </NavLink>
                </li>
              </>
            )}
          </ul>
        </nav>

        <div className="app-sidebar__footer">
          <div className="app-sidebar__wallet">
            {universityIssuerMode && (
              <p className="app-sidebar__wallet-hint">Connect your registered issuer wallet for on-chain actions.</p>
            )}
            {sidebarWalletErr && <div className="error app-sidebar__wallet-error">{sidebarWalletErr}</div>}
            {sidebarWallet ? (
              <>
                <div className="app-sidebar__wallet-status">
                  <span className="app-sidebar__wallet-label">Connected</span>
                  <span className="app-sidebar__wallet-addr mono" title={sidebarWallet}>
                    {`${sidebarWallet.slice(0, 6)}…${sidebarWallet.slice(-4)}`}
                  </span>
                  {sidebarWalletChainId != null && (
                    <span className="app-sidebar__wallet-chain muted-inline small">Chain {sidebarWalletChainId}</span>
                  )}
                </div>
                <button type="button" className="app-sidebar__wallet-disconnect" onClick={onSidebarDisconnectWallet}>
                  Disconnect
                </button>
              </>
            ) : (
              <button
                type="button"
                className="app-sidebar__wallet-connect"
                onClick={() => void onSidebarConnectWallet()}
                disabled={sidebarWalletBusy}
                aria-busy={sidebarWalletBusy}
              >
                <BusyLabel busy={sidebarWalletBusy} idle="Connect wallet" busyLabel="Connecting…" />
              </button>
            )}
          </div>

          {role !== "admin" && (
            <Link to="/verify" className="app-sidebar__cta" onClick={() => setSidebarOpen(false)}>
              New verification
            </Link>
          )}
          {token && (
            <button type="button" className="app-sidebar__logout" onClick={() => logout()}>
              Log out
            </button>
          )}
        </div>
      </aside>

      <div className="app-sidebar-main">
        <header className="app-topbar">
          <button
            type="button"
            className="app-sidebar-toggle"
            aria-label={sidebarOpen ? "Close menu" : "Open menu"}
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen((o) => !o)}
          >
            <span className="app-sidebar-toggle__bars" aria-hidden />
          </button>

          <Link to="/" className="app-topbar__brand-mobile">
            <img src={trucertLogo} alt="" className="app-topbar__logo" />
            TruCert
          </Link>

          <div className="app-topbar__fill" />

          <div className="app-topbar__actions">
            {token && (
              <div ref={bellWrapRef} style={{ position: "relative" }}>
                <button
                  ref={notifBellButtonRef}
                  type="button"
                  className="notif-bell"
                  aria-label="Notifications"
                  aria-haspopup="dialog"
                  aria-expanded={notifOpen}
                  onClick={() => {
                    const next = !notifOpen;
                    setNotifOpen(next);
                    if (next) void fetchNotifications();
                  }}
                >
                  <span aria-hidden style={{ fontSize: "1.05rem" }}>
                    <Bell size={18} />
                  </span>
                  {unreadCount > 0 && <span className="notif-badge">{unreadCount > 99 ? "99+" : unreadCount}</span>}
                </button>

                {notifOpen && (
                  <div className="panel notif-panel" role="dialog" aria-label="Notifications panel">
                    <div className="notif-head">
                      <strong>Notifications</strong>
                      <button type="button" className="btn-text" onClick={() => void fetchNotifications()} disabled={notifBusy}>
                        {notifBusy ? "Loading…" : "Refresh"}
                      </button>
                    </div>
                    {notifErr && <div className="error">{notifErr}</div>}
                    {!notifErr && notifs.length === 0 && <p className="muted-inline">No notifications yet.</p>}
                    <div className="stack">
                      {notifs.map((n) => {
                        const unread = !n.read_at;
                        return (
                          <div key={n.id} className={`notif-item${unread ? " unread" : ""}`}>
                            <div className="notif-title">{n.title}</div>
                            <p className="notif-body">{n.body}</p>
                            <div className="notif-meta">
                              <span className="mono small">{n.kind}</span>
                              <span>{timeAgo(n.created_at)}</span>
                            </div>
                            {unread && (
                              <button type="button" className="btn-text" onClick={() => void markRead(n.id)}>
                                Mark read
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </header>

        <div className={`app-sidebar-main__content${isWideShell ? " app-sidebar-main__content--wide" : ""}`}>
          {institutionPortalFrozen && loc.pathname.startsWith("/university") && (
            <div className="institution-freeze-banner" role="alert">
              Account frozen — issuance disabled. Contact platform support.
            </div>
          )}
          <Outlet />
        </div>
      </div>
    </div>
  );
}
