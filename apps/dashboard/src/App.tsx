import { Toaster } from '@/components/ui/sonner';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ProtectedRoute } from './components/ProtectedRoute';
import { TweaksPanel } from './components/TweaksPanel';
import { AgentDetailPage } from './routes/agent-detail';
import { AgentsPage } from './routes/agents';
import { AlertsPage } from './routes/alerts';
import { OverviewPage } from './routes/overview';
import { ReasoningPage } from './routes/reasoning';
import { SettingsPage } from './routes/settings';

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
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <TweaksPanel />
      <Toaster />
    </>
  );
}
