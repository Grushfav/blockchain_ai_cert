import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../AuthContext";

type Props = { role: "admin" | "university"; children: ReactNode };

export function ProtectedRoute({ role, children }: Props) {
  const { token, role: userRole } = useAuth();
  const location = useLocation();

  if (!token) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  if (userRole !== role) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}
