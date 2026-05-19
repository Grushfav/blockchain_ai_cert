import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { BusyLabel } from "../components/LoadingSpinner";
import { useAuth } from "../AuthContext";

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const from = (location.state as { from?: { pathname?: string } })?.from?.pathname;

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);

    try {
      const { role } = await login(email, password);

      if (from && from !== "/login") {
        navigate(from, { replace: true });
        return;
      }

      if (role === "admin") navigate("/admin", { replace: true });
      else if (role === "university") navigate("/university", { replace: true });
      else navigate("/", { replace: true });
    } catch (caught: unknown) {
      setErr(caught instanceof Error ? caught.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="auth-header">
          <h1>PORTAL LOGIN</h1>
          <p>Sign in as a platform admin or verified university issuer.</p>
        </div>

        <form className="auth-form" onSubmit={onSubmit}>
          <div className="form-group">
            <label htmlFor="email">Email address</label>

            <input
              id="email"
              type="email"
              autoComplete="username"
              placeholder="admin@truecert.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <div className="form-group">
            <label htmlFor="password">Password</label>

            <input
              id="password"
              type="password"
              autoComplete="current-password"
              placeholder="Enter your password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          {err && <div className="error">{err}</div>}

          <button
            className="auth-btn"
            type="submit"
            disabled={busy}
            aria-busy={busy}
          >
            <BusyLabel
              busy={busy}
              idle="Sign in"
              busyLabel="Signing in…"
            />
          </button>
        </form>

        <p className="auth-footer">
          No university account yet? <Link to="/register">Register</Link>
        </p>
      </section>
    </main>
  );
}