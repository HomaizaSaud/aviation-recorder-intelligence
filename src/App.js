import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import AuthenticatedLayout from './components/layout/AuthenticatedLayout';
import Dashboard from './pages/Dashboard';
import Cases from './pages/Cases';
import CaseDetails from './pages/CaseDetails';
import FDR from './pages/FDR';
import CVR from './pages/CVR';
import Reports from './pages/Report';
import HelpCenter from './pages/HelpCenter';
import AccountSettings from './pages/AccountSettings';
import LoginPage from './pages/auth/LoginPage';
import SignupPage from './pages/auth/SignupPage';
import ForgotPasswordPage from './pages/auth/ForgotPasswordPage';
import { AuthProvider, useAuth } from './hooks/useAuth';
import AnalysisModuleLauncher from './pages/AnalysisModuleLauncher';
import CorrelationComingSoon from './pages/CorrelationComingSoon';

const ProtectedRoute = ({ children }) => {
  const auth = useAuth();
  const { isAuthenticated = false, isLoading = false } = auth;

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-gray-600">Loading your workspace…</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return children;
};

const AppRoutes = () => (
  <Routes>
    <Route path="/login" element={<LoginPage />} />
    <Route path="/signup" element={<SignupPage />} />
    <Route path="/forgot-password" element={<ForgotPasswordPage />} />
    <Route
      path="/"
      element={(
        <ProtectedRoute>
          <AuthenticatedLayout />
        </ProtectedRoute>
      )}
    >
      <Route index element={<Dashboard />} />
      <Route path="cases" element={<Cases />} />
      <Route path="cases/fdr" element={<AnalysisModuleLauncher moduleKey="fdr" />} />
      <Route path="cases/cvr" element={<CVR />} />
      <Route path="cases/correlate" element={<CorrelationComingSoon />} />
      <Route path="cases/:caseNumber" element={<CaseDetails />} />
      <Route path="cases/:caseNumber/fdr" element={<FDR />} />
      <Route path="cases/:caseNumber/cvr" element={<CVR />} />
      <Route path="cases/:caseNumber/correlate" element={<CorrelationComingSoon />} />
      <Route path="reports" element={<Reports />} />
      <Route path="help" element={<HelpCenter />} />
      <Route path="account" element={<AccountSettings />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Route>
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes>
);

const App = () => (
  <AuthProvider>
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  </AuthProvider>
);

export default App;

