import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
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
    <>
      <header>
        <h1>Portal login</h1>
        <p>Sign in as a platform admin or a verified university issuer account.</p>
      </header>

      <section className="panel narrow">
        <form className="stack" onSubmit={onSubmit}>
          <div>
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div>
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {err && <div className="error">{err}</div>}
          <button type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <p className="muted-inline">
          No university account yet? <Link to="/register">Register</Link> (pending admin
          approval).
        </p>
      </section>
    </>
  );
}
