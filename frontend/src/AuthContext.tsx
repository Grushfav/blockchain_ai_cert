import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { apiJson, clearAuth, getStoredRole, getStoredToken, persistAuth } from "./api/client";

type Role = "admin" | "university" | null;

type AuthContextValue = {
  token: string | null;
  role: Role;
  loading: boolean;
  login: (email: string, password: string) => Promise<{ role: string }>;
  logout: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => getStoredToken());
  const [role, setRole] = useState<Role>(() => {
    const r = getStoredRole();
    return r === "admin" || r === "university" ? r : null;
  });
  const [loading] = useState(false);

  const login = useCallback(async (email: string, password: string) => {
    const data = await apiJson<{ access_token: string; role: string }>("/api/auth/login", {
      method: "POST",
      json: { email: email.trim().toLowerCase(), password },
    });
    persistAuth(data.access_token, data.role);
    setToken(data.access_token);
    setRole(data.role === "admin" || data.role === "university" ? data.role : null);
    return { role: data.role };
  }, []);

  const logout = useCallback(() => {
    clearAuth();
    setToken(null);
    setRole(null);
  }, []);

  const value = useMemo(
    () => ({ token, role, loading, login, logout }),
    [token, role, loading, login, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
