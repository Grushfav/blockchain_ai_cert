import { Link, NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../AuthContext";

export function Layout() {
  const { token, role, logout } = useAuth();

  return (
    <div className="app shell">
      <nav className="topnav">
        <Link to="/" className="brand">
          TruCert
        </Link>
        <div className="nav-links">
          <NavLink to="/" end>
            Verify
          </NavLink>
          {!token && (
            <>
              <NavLink to="/login">Login</NavLink>
              <NavLink to="/register">Register university</NavLink>
            </>
          )}
          {token && role === "admin" && <NavLink to="/admin">Admin</NavLink>}
          {token && role === "university" && <NavLink to="/university">University</NavLink>}
          {token && (
            <button type="button" className="btn-text" onClick={logout}>
              Log out
            </button>
          )}
        </div>
      </nav>
      <Outlet />
    </div>
  );
}
