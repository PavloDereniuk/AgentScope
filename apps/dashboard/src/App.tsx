import { Toaster } from '@/components/ui/sonner';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ProtectedRoute } from './components/ProtectedRoute';
import { TweaksPanel } from './components/TweaksPanel';
import { AdminPage } from './routes/admin';
import { AgentDetailPage } from './routes/agent-detail';
import { AgentsPage } from './routes/agents';
import { AlertsPage } from './routes/alerts';
import { OverviewPage } from './routes/overview';
import { ReasoningPage } from './routes/reasoning';
import { SettingsPage } from './routes/settings';
import { ShareAgentPage, ShareRedirectPage } from './routes/share';

export function App() {
  return (
    <>
      <Routes>
        <Route
          element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }
        >
          <Route index element={<OverviewPage />} />
          <Route path="agents" element={<AgentsPage />} />
          <Route path="agents/:id" element={<AgentDetailPage />} />
          <Route path="reasoning" element={<ReasoningPage />} />
          <Route path="alerts" element={<AlertsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          {/* Owner-only — AdminPage redirects non-owners to / via useIsOwner;
              the API enforces the real 403 boundary regardless. */}
          <Route path="admin" element={<AdminPage />} />
        </Route>
        {/* Public share routes — no auth required, outside ProtectedRoute */}
        <Route path="share" element={<ShareRedirectPage />} />
        <Route path="share/:id" element={<ShareAgentPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <TweaksPanel />
      <Toaster />
    </>
  );
}
