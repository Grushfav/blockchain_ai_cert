import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { AdminAnalyticsPage } from "./pages/AdminAnalyticsPage";
import { AdminOverviewPage } from "./pages/AdminOverviewPage";
import { AdminPage } from "./pages/AdminPage";
import { AdminRiskBoardPage } from "./pages/AdminRiskBoardPage";
import { HomePage } from "./pages/HomePage";
import { LoginPage } from "./pages/LoginPage";
import { RegisterPage } from "./pages/RegisterPage";
import { UniversityAnalyticsPage } from "./pages/UniversityAnalyticsPage";
import { UniversityPage } from "./pages/UniversityPage";
import { UniversityHubPage } from "./pages/UniversityHubPage";
import { UniversityRiskPage } from "./pages/UniversityRiskPage";
import { VerifyPage } from "./pages/VerifyPage";
import { StudentClaimPage } from "./pages/StudentClaimPage";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/verify" element={<VerifyPage />} />
        <Route path="/claim" element={<StudentClaimPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route
          path="/admin"
          element={
            // <ProtectedRoute role="admin">
            //   <AdminPage />
            // </ProtectedRoute>
            <AdminPage />
          }
        />
        <Route path="/admin/overview" element={<AdminOverviewPage />} />
        <Route path="/admin/risk" element={<AdminRiskBoardPage />} />
        <Route path="/admin/analytics" element={<AdminAnalyticsPage />} />
        <Route path="/university/analytics" element={<UniversityAnalyticsPage />} />
        <Route path="/university/risk" element={<UniversityRiskPage />} />
        <Route path="/university/overview" element={<UniversityHubPage />} />
        <Route
          path="/university"
          element={
            // <ProtectedRoute role="university">
            //   <UniversityPage />
            // </ProtectedRoute>
            <UniversityPage />
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
